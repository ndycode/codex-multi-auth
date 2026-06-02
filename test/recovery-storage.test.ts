import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const { MESSAGE_STORAGE, PART_STORAGE } = vi.hoisted(() => ({
	MESSAGE_STORAGE: "C:\\virtual\\message",
	PART_STORAGE: "C:\\virtual\\part",
}));

const fsPromisesMock = vi.hoisted(() => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn(),
	unlink: vi.fn().mockResolvedValue(undefined),
	stat: vi.fn(),
	rename: vi.fn().mockResolvedValue(undefined),
}));

const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	writeFileSync: vi.fn(),
	// AUDIT-M01 / R6 atomic recovery writes: atomicWriteFileSync() stages the
	// payload to a sibling *.tmp.<rand> file and then rename()s over the target.
	// The test suite mocks node:fs as a whole, so the rename must be stubbed
	// too or the recovery helper throws on a missing rename function.
	renameSync: vi.fn(),
}));

vi.mock("fs/promises", () => fsPromisesMock);
vi.mock("node:fs", () => fsMock);
vi.mock("../lib/recovery/constants.js", () => ({
	MESSAGE_STORAGE,
	PART_STORAGE,
	THINKING_TYPES: new Set(["thinking", "redacted_thinking", "reasoning"]),
	META_TYPES: new Set(["step-start", "step-finish"]),
}));

let storage: typeof import("../lib/recovery/storage.js");

beforeEach(async () => {
	vi.resetAllMocks();
	vi.resetModules();
	storage = await import("../lib/recovery/storage.js");
});

describe("RecoveryStorage", () => {
	describe("generatePartId", () => {
		it("should include prefix, timestamp, and random", () => {
			const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.123456789);

			const id = storage.generatePartId();

			expect(id).toMatch(/^prt_[0-9a-f]+[a-z0-9]{8}$/);
			expect(id).toContain((1700000000000).toString(16));

			nowSpy.mockRestore();
			randomSpy.mockRestore();
		});
	});

	describe("getMessageDir", () => {
		it("should return empty string when base dir missing", () => {
			fsMock.existsSync.mockImplementation(
				(path: string) => path !== MESSAGE_STORAGE,
			);

			expect(storage.getMessageDir("sess")).toBe("");
		});

		it("should return direct session path when present", () => {
			const sessionID = "sess";
			const directPath = join(MESSAGE_STORAGE, sessionID);

			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE || path === directPath,
			);

			expect(storage.getMessageDir(sessionID)).toBe(directPath);
		});

		it("should search subdirectories for session", () => {
			const sessionID = "sess";
			const foundPath = join(MESSAGE_STORAGE, "alpha", sessionID);

			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === join(MESSAGE_STORAGE, sessionID)) return false;
				return path === foundPath;
			});
			fsMock.readdirSync.mockReturnValue(["alpha", "beta"]);

			expect(storage.getMessageDir(sessionID)).toBe(foundPath);
		});

		it("should return empty string on read errors", () => {
			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE,
			);
			fsMock.readdirSync.mockImplementation(() => {
				throw new Error("nope");
			});

			expect(storage.getMessageDir("sess")).toBe("");
		});
	});

	describe("readMessages", () => {
		it("should return empty array when message dir missing", () => {
			fsMock.existsSync.mockReturnValue(false);

			expect(storage.readMessages("sess")).toEqual([]);
		});

		it("should sort messages and skip invalid files", () => {
			const sessionID = "sess";
			const messageDir = join(MESSAGE_STORAGE, sessionID);

			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE || path === messageDir,
			);
			fsMock.readdirSync.mockReturnValue([
				"b.json",
				"a.json",
				"note.txt",
				"bad.json",
			]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(messageDir, "b.json")) {
					return JSON.stringify({
						id: "b",
						sessionID,
						role: "assistant",
						time: { created: 2 },
					});
				}
				if (path === join(messageDir, "a.json")) {
					return JSON.stringify({
						id: "a",
						sessionID,
						role: "assistant",
						time: { created: 1 },
					});
				}
				if (path === join(messageDir, "bad.json")) {
					throw new Error("bad");
				}
				return "";
			});

			const result = storage.readMessages(sessionID);
			expect(result.map((msg) => msg.id)).toEqual(["a", "b"]);

			// recovery-10: the corrupt file is quarantined (renamed to .corrupt-*),
			// not silently dropped, and the corruption stats reflect it.
			expect(fsMock.renameSync).toHaveBeenCalledWith(
				join(messageDir, "bad.json"),
				expect.stringContaining(".corrupt-"),
			);
			const stats = storage.getRecoveryCorruptionStats();
			expect(stats.corruptFileCount).toBeGreaterThanOrEqual(1);
			expect(stats.quarantinedPaths.some((p) => p.includes("bad.json"))).toBe(true);
		});

		it("does NOT quarantine a file on a transient EBUSY read race", () => {
			// recovery-10: a Windows lock (AV/indexer/concurrent writer) surfaces as
			// EBUSY on read — a transient race, not corruption. The file must be
			// skipped this pass and left in place, never renamed to .corrupt-*.
			storage.__resetRecoveryCorruptionStats();
			const sessionID = "sess";
			const messageDir = join(MESSAGE_STORAGE, sessionID);

			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE || path === messageDir,
			);
			fsMock.readdirSync.mockReturnValue(["good.json", "locked.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(messageDir, "good.json")) {
					return JSON.stringify({
						id: "good",
						sessionID,
						role: "assistant",
						time: { created: 1 },
					});
				}
				if (path === join(messageDir, "locked.json")) {
					throw Object.assign(new Error("EBUSY: resource busy or locked"), {
						code: "EBUSY",
					});
				}
				return "";
			});

			const result = storage.readMessages(sessionID);
			expect(result.map((msg) => msg.id)).toEqual(["good"]);
			expect(fsMock.renameSync).not.toHaveBeenCalled();
			const transientStats = storage.getRecoveryCorruptionStats();
			expect(transientStats.corruptFileCount).toBe(0);
			expect(transientStats.quarantinedPaths).toHaveLength(0);
		});

		it("quarantines a parseable-but-invalid message record (recovery-02)", () => {
			// A file can be valid JSON yet structurally invalid (missing/non-string
			// id). It must be quarantined like corruption, not pushed into messages
			// where a later id-based sort/index would crash.
			storage.__resetRecoveryCorruptionStats();
			const sessionID = "sess";
			const messageDir = join(MESSAGE_STORAGE, sessionID);

			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE || path === messageDir,
			);
			fsMock.readdirSync.mockReturnValue(["good.json", "noid.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(messageDir, "good.json")) {
					return JSON.stringify({
						id: "good",
						sessionID,
						role: "assistant",
						time: { created: 1 },
					});
				}
				if (path === join(messageDir, "noid.json")) {
					// Parses fine, but no string id — must be quarantined, not kept.
					return JSON.stringify({ sessionID, role: "assistant", time: { created: 2 } });
				}
				return "";
			});

			const result = storage.readMessages(sessionID);
			expect(result.map((msg) => msg.id)).toEqual(["good"]);
			expect(fsMock.renameSync).toHaveBeenCalledWith(
				join(messageDir, "noid.json"),
				expect.stringContaining(".corrupt-"),
			);
			const stats = storage.getRecoveryCorruptionStats();
			expect(stats.quarantinedPaths.some((p) => p.includes("noid.json"))).toBe(true);
		});

		it("quarantines a parseable record whose string id is path-unsafe (recovery-02)", () => {
			// `{ "id": "../poison" }` parses and is a string, but the id is later used
			// to build filesystem paths (readParts(msg.id)). A traversal id must be
			// quarantined here, never allowed to escape into a path-traversal read.
			storage.__resetRecoveryCorruptionStats();
			const sessionID = "sess";
			const messageDir = join(MESSAGE_STORAGE, sessionID);

			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE || path === messageDir,
			);
			fsMock.readdirSync.mockReturnValue(["good.json", "poison.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(messageDir, "good.json")) {
					return JSON.stringify({ id: "good", sessionID, role: "assistant", time: { created: 1 } });
				}
				if (path === join(messageDir, "poison.json")) {
					return JSON.stringify({ id: "../poison", sessionID, role: "assistant", time: { created: 2 } });
				}
				return "";
			});

			const result = storage.readMessages(sessionID);
			// The traversal record is dropped; only the safe one survives.
			expect(result.map((msg) => msg.id)).toEqual(["good"]);
			expect(fsMock.renameSync).toHaveBeenCalledWith(
				join(messageDir, "poison.json"),
				expect.stringContaining(".corrupt-"),
			);
		});

		it("quarantines a record with a non-numeric time.created (recovery-02)", () => {
			// readMessages sorts on time.created; a parseable record with a non-numeric
			// created (e.g. "oops") makes the comparator return NaN and falls back to
			// scan order, mis-pointing index-based recovery. It must be quarantined.
			storage.__resetRecoveryCorruptionStats();
			const sessionID = "sess";
			const messageDir = join(MESSAGE_STORAGE, sessionID);

			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE || path === messageDir,
			);
			fsMock.readdirSync.mockReturnValue(["good.json", "badtime.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(messageDir, "good.json")) {
					return JSON.stringify({ id: "good", sessionID, role: "assistant", time: { created: 1 } });
				}
				if (path === join(messageDir, "badtime.json")) {
					return JSON.stringify({ id: "msg_1", sessionID, role: "assistant", time: { created: "oops" } });
				}
				return "";
			});

			const result = storage.readMessages(sessionID);
			expect(result.map((msg) => msg.id)).toEqual(["good"]);
			expect(fsMock.renameSync).toHaveBeenCalledWith(
				join(messageDir, "badtime.json"),
				expect.stringContaining(".corrupt-"),
			);
		});

		it("quarantines a part whose string id is path-unsafe (recovery-02)", () => {
			storage.__resetRecoveryCorruptionStats();
			const messageID = "msg";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockImplementation((path: string) => path === partDir);
			fsMock.readdirSync.mockReturnValue(["ok.json", "evil.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(partDir, "ok.json")) {
					return JSON.stringify({ id: "1", messageID, sessionID: "s", type: "text", text: "hi" });
				}
				if (path === join(partDir, "evil.json")) {
					return JSON.stringify({ id: "../../etc", messageID, sessionID: "s", type: "text" });
				}
				return "";
			});

			const result = storage.readParts(messageID);
			expect(result.map((p) => p.id)).toEqual(["1"]);
			expect(fsMock.renameSync).toHaveBeenCalledWith(
				join(partDir, "evil.json"),
				expect.stringContaining(".corrupt-"),
			);
		});

		it("retries a transient EBUSY on the quarantine rename, then succeeds", () => {
			// recovery-10 / windows fs: genuine corruption is quarantined, and the
			// quarantine rename routes through renameSyncWithRetry so a transient
			// EBUSY on the rename is retried rather than abandoning the move.
			storage.__resetRecoveryCorruptionStats();
			const sessionID = "sess";
			const messageDir = join(MESSAGE_STORAGE, sessionID);

			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE || path === messageDir,
			);
			fsMock.readdirSync.mockReturnValue(["bad.json"]);
			fsMock.readFileSync.mockImplementation(() => "not json {{{");
			let renameCalls = 0;
			fsMock.renameSync.mockImplementation(() => {
				renameCalls += 1;
				if (renameCalls === 1) {
					throw Object.assign(new Error("EBUSY: locked"), { code: "EBUSY" });
				}
				return undefined;
			});

			const result = storage.readMessages(sessionID);
			expect(result).toEqual([]);
			// First rename threw EBUSY; the retry path must have called it again.
			expect(renameCalls).toBeGreaterThanOrEqual(2);
			const corruptStats = storage.getRecoveryCorruptionStats();
			expect(corruptStats.corruptFileCount).toBeGreaterThanOrEqual(1);
			expect(corruptStats.quarantinedPaths.some((p) => p.includes("bad.json"))).toBe(
				true,
			);
		});

		it("should return empty array on read failure", () => {
			const sessionID = "sess";
			const messageDir = join(MESSAGE_STORAGE, sessionID);

			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE || path === messageDir,
			);
			fsMock.readdirSync.mockImplementation(() => {
				throw new Error("fail");
			});

			expect(storage.readMessages(sessionID)).toEqual([]);
		});

		// recovery-02: a parseable record missing `id` is quarantined (it would
		// otherwise crash the id-based sort that runs outside the per-file
		// try/catch). It must not throw and must not survive into the result.
		it("does not throw when a record is missing its id (quarantines it)", () => {
			storage.__resetRecoveryCorruptionStats();
			const sessionID = "sess";
			const messageDir = join(MESSAGE_STORAGE, sessionID);

			fsMock.existsSync.mockImplementation(
				(path: string) => path === MESSAGE_STORAGE || path === messageDir,
			);
			fsMock.readdirSync.mockReturnValue(["good.json", "noid.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(messageDir, "good.json")) {
					return JSON.stringify({ id: "g", sessionID, role: "assistant", time: { created: 1 } });
				}
				// Parseable but malformed: no `id` field.
				return JSON.stringify({ sessionID, role: "assistant", time: { created: 2 } });
			});

			let result: ReturnType<typeof storage.readMessages> = [];
			expect(() => {
				result = storage.readMessages(sessionID);
			}).not.toThrow();
			// The malformed record is dropped (quarantined), only the valid one remains.
			expect(result.map((m) => m.id)).toEqual(["g"]);
			expect(fsMock.renameSync).toHaveBeenCalledWith(
				join(messageDir, "noid.json"),
				expect.stringContaining(".corrupt-"),
			);
		});
	});

	describe("readParts", () => {
		it("should return empty array when part dir missing", () => {
			fsMock.existsSync.mockReturnValue(false);

			expect(storage.readParts("msg")).toEqual([]);
		});

		it("should parse part files and skip invalid JSON", () => {
			const messageID = "msg";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockImplementation((path: string) => path === partDir);
			fsMock.readdirSync.mockReturnValue(["one.json", "bad.json", "two.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(partDir, "one.json")) {
					return JSON.stringify({
						id: "1",
						messageID,
						sessionID: "s",
						type: "text",
						text: "hi",
					});
				}
				if (path === join(partDir, "two.json")) {
					return JSON.stringify({
						id: "2",
						messageID,
						sessionID: "s",
						type: "tool",
					});
				}
				if (path === join(partDir, "bad.json")) {
					throw new Error("bad");
				}
				return "";
			});

			const result = storage.readParts(messageID);
			expect(result).toHaveLength(2);
		});

		it("quarantines a parseable part missing id/type (recovery-02)", () => {
			// findMessagesWithOrphanThinking sorts parts via a.id.localeCompare(b.id);
			// a parseable record without a string id/type would crash that pass, so it
			// must be quarantined here rather than pushed into parts.
			storage.__resetRecoveryCorruptionStats();
			const messageID = "msg";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockImplementation((path: string) => path === partDir);
			fsMock.readdirSync.mockReturnValue(["ok.json", "noid.json", "notype.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(partDir, "ok.json")) {
					return JSON.stringify({
						id: "1",
						messageID,
						sessionID: "s",
						type: "text",
						text: "hi",
					});
				}
				if (path === join(partDir, "noid.json")) {
					// No string id.
					return JSON.stringify({ messageID, sessionID: "s", type: "text" });
				}
				if (path === join(partDir, "notype.json")) {
					// No string type.
					return JSON.stringify({ id: "3", messageID, sessionID: "s" });
				}
				return "";
			});

			const result = storage.readParts(messageID);
			expect(result.map((p) => p.id)).toEqual(["1"]);
			expect(fsMock.renameSync).toHaveBeenCalledWith(
				join(partDir, "noid.json"),
				expect.stringContaining(".corrupt-"),
			);
			expect(fsMock.renameSync).toHaveBeenCalledWith(
				join(partDir, "notype.json"),
				expect.stringContaining(".corrupt-"),
			);
		});

		it("should return empty array on read failure", () => {
			const messageID = "msg";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockImplementation((path: string) => path === partDir);
			fsMock.readdirSync.mockImplementation(() => {
				throw new Error("fail");
			});

			expect(storage.readParts(messageID)).toEqual([]);
		});
	});

	describe("hasContent", () => {
		it("should ignore thinking and meta types", () => {
			expect(
				storage.hasContent({
					id: "1",
					sessionID: "s",
					messageID: "m",
					type: "thinking",
				}),
			).toBe(false);
			expect(
				storage.hasContent({
					id: "1",
					sessionID: "s",
					messageID: "m",
					type: "step-start",
				}),
			).toBe(false);
		});

		it("should treat text parts with content as true", () => {
			expect(
				storage.hasContent({
					id: "1",
					sessionID: "s",
					messageID: "m",
					type: "text",
					text: "",
				}),
			).toBe(false);
			expect(
				storage.hasContent({
					id: "1",
					sessionID: "s",
					messageID: "m",
					type: "text",
					text: " hi ",
				}),
			).toBe(true);
		});

		it("should treat tool parts as true", () => {
			expect(
				storage.hasContent({
					id: "1",
					sessionID: "s",
					messageID: "m",
					type: "tool",
				}),
			).toBe(true);
			expect(
				storage.hasContent({
					id: "1",
					sessionID: "s",
					messageID: "m",
					type: "tool_use",
				}),
			).toBe(true);
			expect(
				storage.hasContent({
					id: "1",
					sessionID: "s",
					messageID: "m",
					type: "tool_result",
				}),
			).toBe(true);
		});

		it("should treat unknown types as false", () => {
			expect(
				storage.hasContent({
					id: "1",
					sessionID: "s",
					messageID: "m",
					type: "custom",
				}),
			).toBe(false);
		});
	});

	describe("messageHasContent", () => {
		it("should return true when any part has content", () => {
			const partDir = join(PART_STORAGE, "m");
			fsMock.existsSync.mockImplementation((path: string) => path === partDir);
			fsMock.readdirSync.mockReturnValue(["p1.json", "p2.json", "p3.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("p1.json"))
					return JSON.stringify({
						id: "1",
						sessionID: "s",
						messageID: "m",
						type: "reasoning",
						text: "",
					});
				if (path.includes("p2.json"))
					return JSON.stringify({
						id: "2",
						sessionID: "s",
						messageID: "m",
						type: "text",
						text: "",
					});
				if (path.includes("p3.json"))
					return JSON.stringify({
						id: "3",
						sessionID: "s",
						messageID: "m",
						type: "text",
						text: " ok ",
					});
				return "{}";
			});

			expect(storage.messageHasContent("m")).toBe(true);
		});
	});

	describe("injectTextPart", () => {
		it("should create directory and write synthetic text part", () => {
			const sessionID = "sess";
			const messageID = "msg";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockReturnValue(false);

			const result = storage.injectTextPart(sessionID, messageID, "hello");

			expect(result).toBe(true);
			expect(fsMock.mkdirSync).toHaveBeenCalledWith(partDir, {
				recursive: true,
			});
			// AUDIT-M01 / R6 atomic recovery writes: injectTextPart now stages
			// the payload to a .tmp.<rand> sibling and renames it over the
			// final prt_*.json target. writeFileSync lands on the temp path;
			// renameSync moves it onto the final part filename.
			expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
			expect(fsMock.renameSync).toHaveBeenCalledTimes(1);

			const [tempPath, payload] = fsMock.writeFileSync.mock.calls[0] ?? [];
			expect(tempPath).toMatch(/prt_[0-9a-f]+[a-z0-9]+\.json\.tmp\./);
			const [renameFrom, renameTo] = fsMock.renameSync.mock.calls[0] ?? [];
			expect(renameFrom).toBe(tempPath);
			expect(renameTo).toMatch(/prt_[0-9a-f]+[a-z0-9]+\.json$/);
			const parsed = JSON.parse(payload);
			expect(parsed).toMatchObject({
				sessionID,
				messageID,
				type: "text",
				text: "hello",
				synthetic: true,
			});
			expect(parsed.id).toMatch(/^prt_/);
		});

		it("should return false on write error", () => {
			fsMock.existsSync.mockReturnValue(true);
			fsMock.writeFileSync.mockImplementation(() => {
				throw new Error("fail");
			});

			expect(storage.injectTextPart("s", "m", "hi")).toBe(false);
		});
	});

	describe("thinking block recovery", () => {
		it("should find messages with thinking blocks", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path === join(PART_STORAGE, "m1")) return true;
				if (path === join(PART_STORAGE, "m2")) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m1.json", "m2.json"];
				if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
				if (path === join(PART_STORAGE, "m2")) return ["p2.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m1.json") && path.includes("message"))
					return JSON.stringify({
						id: "m1",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("m2.json") && path.includes("message"))
					return JSON.stringify({ id: "m2", sessionID: "s", role: "user" });
				if (path.includes("p1.json"))
					return JSON.stringify({
						id: "p1",
						sessionID: "s",
						messageID: "m1",
						type: "thinking",
					});
				if (path.includes("p2.json"))
					return JSON.stringify({
						id: "p2",
						sessionID: "s",
						messageID: "m2",
						type: "text",
						text: "hi",
					});
				return "{}";
			});

			expect(storage.findMessagesWithThinkingBlocks("s")).toEqual(["m1"]);
		});

		it("should find messages with thinking only", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path.startsWith(PART_STORAGE)) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m1.json", "m2.json", "m3.json"];
				if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
				if (path === join(PART_STORAGE, "m2")) return ["p2.json", "p3.json"];
				if (path === join(PART_STORAGE, "m3")) return [];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m1.json") && path.includes("message"))
					return JSON.stringify({
						id: "m1",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("m2.json") && path.includes("message"))
					return JSON.stringify({
						id: "m2",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("m3.json") && path.includes("message"))
					return JSON.stringify({
						id: "m3",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("p1.json"))
					return JSON.stringify({
						id: "p1",
						sessionID: "s",
						messageID: "m1",
						type: "thinking",
					});
				if (path.includes("p2.json"))
					return JSON.stringify({
						id: "p2",
						sessionID: "s",
						messageID: "m2",
						type: "thinking",
					});
				if (path.includes("p3.json"))
					return JSON.stringify({
						id: "p3",
						sessionID: "s",
						messageID: "m2",
						type: "text",
						text: "hi",
					});
				return "{}";
			});

			expect(storage.findMessagesWithThinkingOnly("s")).toEqual(["m1"]);
		});

		it("should find messages with orphan thinking", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path.startsWith(PART_STORAGE)) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m1.json", "m2.json"];
				if (path === join(PART_STORAGE, "m1")) return ["a.json", "b.json"];
				if (path === join(PART_STORAGE, "m2")) return ["a.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m1.json") && path.includes("message"))
					return JSON.stringify({
						id: "m1",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("m2.json") && path.includes("message"))
					return JSON.stringify({
						id: "m2",
						sessionID: "s",
						role: "assistant",
					});
				// m1: first part alphabetically is "a" which is TEXT (not thinking) = orphan
				if (path.includes(join(PART_STORAGE, "m1")) && path.includes("a.json"))
					return JSON.stringify({
						id: "a",
						sessionID: "s",
						messageID: "m1",
						type: "text",
						text: "hi",
					});
				if (path.includes(join(PART_STORAGE, "m1")) && path.includes("b.json"))
					return JSON.stringify({
						id: "b",
						sessionID: "s",
						messageID: "m1",
						type: "thinking",
					});
				// m2: first part alphabetically is "a" which is THINKING = not orphan
				if (path.includes(join(PART_STORAGE, "m2")) && path.includes("a.json"))
					return JSON.stringify({
						id: "a",
						sessionID: "s",
						messageID: "m2",
						type: "thinking",
					});
				return "{}";
			});

			expect(storage.findMessagesWithOrphanThinking("s")).toEqual(["m1"]);
		});
	});

	describe("prependThinkingPart", () => {
		it("should create directory and write thinking part", () => {
			const sessionID = "s";
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockReturnValue(false);

			const result = storage.prependThinkingPart(sessionID, messageID);

			expect(result).toBe(true);
			expect(fsMock.mkdirSync).toHaveBeenCalledWith(partDir, {
				recursive: true,
			});
			// AUDIT-M01 / R6 atomic recovery writes: prependThinkingPart now
			// stages the payload to a .tmp.<rand> sibling and renames it over
			// the final prt_0000000000_thinking_<timestamp>_<counter>_<random>.json
			// target. RPTU-001: the id is unique per invocation so repeat
			// recovery passes on the same messageID no longer clobber the prior
			// synthetic part.
			expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
			expect(fsMock.renameSync).toHaveBeenCalledTimes(1);

			const [tempPath, payload] = fsMock.writeFileSync.mock.calls[0] ?? [];
			expect(tempPath).toMatch(
				/prt_0000000000_thinking_[0-9a-f]+_[0-9a-z]+_[0-9a-z]+\.json\.tmp\./,
			);
			const [renameFrom, renameTo] = fsMock.renameSync.mock.calls[0] ?? [];
			expect(renameFrom).toBe(tempPath);
			expect(renameTo).toMatch(
				new RegExp(
					`^${partDir.replace(/\\/g, "\\\\")}[\\\\/]prt_0000000000_thinking_[0-9a-f]+_[0-9a-z]+_[0-9a-z]+\\.json$`,
				),
			);
			const parsed = JSON.parse(payload);
			expect(parsed).toMatchObject({
				sessionID,
				messageID,
				type: "thinking",
				thinking: "",
				synthetic: true,
			});
			expect(parsed.id).toMatch(
				/^prt_0000000000_thinking_[0-9a-f]+_[0-9a-z]+_[0-9a-z]+$/,
			);
		});

		it("should generate unique ids on repeat calls so retries do not overwrite (RPTU-001)", () => {
			// Simulate two recovery passes on the same messageID: each invocation
			// must stage and rename a DISTINCT target file, proving the synthetic
			// thinking part from the first pass is preserved.
			const sessionID = "s";
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);
			fsMock.existsSync.mockReturnValue(true);

			expect(storage.prependThinkingPart(sessionID, messageID)).toBe(true);
			expect(storage.prependThinkingPart(sessionID, messageID)).toBe(true);

			expect(fsMock.writeFileSync).toHaveBeenCalledTimes(2);
			expect(fsMock.renameSync).toHaveBeenCalledTimes(2);

			const [firstTemp, firstPayload] =
				fsMock.writeFileSync.mock.calls[0] ?? [];
			const [secondTemp, secondPayload] =
				fsMock.writeFileSync.mock.calls[1] ?? [];
			const [, firstTarget] = fsMock.renameSync.mock.calls[0] ?? [];
			const [, secondTarget] = fsMock.renameSync.mock.calls[1] ?? [];

			// Temp staging paths must differ (otherwise two writers would race).
			expect(firstTemp).not.toBe(secondTemp);
			// Final target paths MUST differ so the second pass does not
			// overwrite the first synthetic thinking part.
			expect(firstTarget).not.toBe(secondTarget);

			// Both payloads must carry their own unique id matching their final
			// target filename, so readers see two distinct parts on disk.
			const firstParsed = JSON.parse(firstPayload);
			const secondParsed = JSON.parse(secondPayload);
			expect(firstParsed.id).toMatch(/^prt_0000000000_thinking_[0-9a-f]+_[0-9a-z]+_[0-9a-z]+$/);
			expect(secondParsed.id).toMatch(/^prt_0000000000_thinking_[0-9a-f]+_[0-9a-z]+_[0-9a-z]+$/);
			expect(firstParsed.id).not.toBe(secondParsed.id);
			expect(firstTarget).toContain(`${firstParsed.id}.json`);
			expect(secondTarget).toContain(`${secondParsed.id}.json`);
		});

		it("should generate ids that sort before real generatePartId ids so orphan detection still sees thinking first", () => {
			// findMessagesWithOrphanThinking sorts parts by id and checks the
			// first element. Synthetic thinking ids MUST sort lexicographically
			// before any id from generatePartId(), which starts with
			// `prt_<hex_timestamp>` where the hex timestamp's leading digit is
			// non-zero for any real-world time.
			const thinkingId = storage.generateThinkingPartId();
			const realId = storage.generatePartId();

			expect(thinkingId.startsWith("prt_0000000000_thinking_")).toBe(true);
			expect([thinkingId, realId].sort()).toEqual([thinkingId, realId]);
		});

		it("should return false on write error", () => {
			fsMock.existsSync.mockReturnValue(true);
			fsMock.writeFileSync.mockImplementation(() => {
				throw new Error("fail");
			});

			expect(storage.prependThinkingPart("s", "m")).toBe(false);
		});
	});

	describe("stripThinkingParts", () => {
		it("should return false when part dir missing", () => {
			fsMock.existsSync.mockReturnValue(false);

			expect(storage.stripThinkingParts("m")).toBe(false);
		});

		it("should remove thinking parts and ignore others", () => {
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockReturnValue(true);
			fsMock.readdirSync.mockReturnValue(["a.json", "b.json", "bad.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(partDir, "a.json")) {
					return JSON.stringify({
						id: "a",
						sessionID: "s",
						messageID,
						type: "thinking",
					});
				}
				if (path === join(partDir, "b.json")) {
					return JSON.stringify({
						id: "b",
						sessionID: "s",
						messageID,
						type: "text",
						text: "hi",
					});
				}
				if (path === join(partDir, "bad.json")) {
					throw new Error("bad");
				}
				return "";
			});

			expect(storage.stripThinkingParts(messageID)).toBe(true);
			expect(fsMock.unlinkSync).toHaveBeenCalledWith(join(partDir, "a.json"));
			expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
		});

		it("should return false on directory read error", () => {
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockImplementation((path: string) => path === partDir);
			fsMock.readdirSync.mockImplementation(() => {
				throw new Error("fail");
			});

			expect(storage.stripThinkingParts(messageID)).toBe(false);
		});

		// recovery-05: if a targeted thinking part cannot be deleted, the function
		// must NOT report success (a false "clean" makes auto-resume retry forever).
		it("returns false when a targeted thinking part cannot be removed", () => {
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockReturnValue(true);
			fsMock.readdirSync.mockReturnValue(["t.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(partDir, "t.json")) {
					return JSON.stringify({ id: "t", sessionID: "s", messageID, type: "thinking" });
				}
				return "";
			});
			// Deletion fails with a non-retryable error.
			fsMock.unlinkSync.mockImplementation(() => {
				const err = new Error("EACCES") as NodeJS.ErrnoException;
				err.code = "EISDIR"; // non-retryable -> safeUnlinkWithRetry returns false
				throw err;
			});

			expect(storage.stripThinkingParts(messageID)).toBe(false);
		});

		// recovery-03: write/mutate helpers validate the messageID path component.
		it("rejects an unsafe messageID (path traversal) on mutate helpers", () => {
			expect(() => storage.stripThinkingParts("../escape")).toThrow(/unsafe/i);
			expect(() => storage.injectTextPart("s", "../escape", "x")).toThrow(/unsafe/i);
			expect(() => storage.prependThinkingPart("s", "../escape")).toThrow(/unsafe/i);
			expect(() => storage.replaceEmptyTextParts("../escape", "x")).toThrow(/unsafe/i);
		});

		it("should skip non-JSON files in part directory (line 275 coverage)", () => {
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockReturnValue(true);
			fsMock.readdirSync.mockReturnValue(["readme.txt", ".DS_Store", "a.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(partDir, "a.json")) {
					return JSON.stringify({
						id: "a",
						sessionID: "s",
						messageID,
						type: "thinking",
					});
				}
				throw new Error("Should not read non-JSON files");
			});

			expect(storage.stripThinkingParts(messageID)).toBe(true);
			expect(fsMock.unlinkSync).toHaveBeenCalledWith(join(partDir, "a.json"));
			expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
		});
	});

	describe("empty message recovery", () => {
		it("should find empty messages", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path === join(PART_STORAGE, "m1")) return true;
				if (path === join(PART_STORAGE, "m2")) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m1.json", "m2.json"];
				if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
				if (path === join(PART_STORAGE, "m2")) return ["p2.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m1.json") && path.includes("message"))
					return JSON.stringify({
						id: "m1",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("m2.json") && path.includes("message"))
					return JSON.stringify({
						id: "m2",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("p1.json"))
					return JSON.stringify({
						id: "p1",
						sessionID: "s",
						messageID: "m1",
						type: "text",
						text: "",
					});
				if (path.includes("p2.json"))
					return JSON.stringify({
						id: "p2",
						sessionID: "s",
						messageID: "m2",
						type: "text",
						text: "content",
					});
				return "{}";
			});

			expect(storage.findEmptyMessages("s")).toEqual(["m1"]);
		});

		it("should find empty message by index using fallback", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path.startsWith(PART_STORAGE)) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m0.json", "m1.json", "m2.json"];
				if (path === join(PART_STORAGE, "m0")) return ["p0.json"];
				if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
				if (path === join(PART_STORAGE, "m2")) return ["p2.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m0.json") && path.includes("message"))
					return JSON.stringify({
						id: "m0",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("m1.json") && path.includes("message"))
					return JSON.stringify({
						id: "m1",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("m2.json") && path.includes("message"))
					return JSON.stringify({
						id: "m2",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("p0.json"))
					return JSON.stringify({
						id: "p0",
						sessionID: "s",
						messageID: "m0",
						type: "text",
						text: "content",
					});
				if (path.includes("p1.json"))
					return JSON.stringify({
						id: "p1",
						sessionID: "s",
						messageID: "m1",
						type: "text",
						text: "",
					});
				if (path.includes("p2.json"))
					return JSON.stringify({
						id: "p2",
						sessionID: "s",
						messageID: "m2",
						type: "text",
						text: "content",
					});
				return "{}";
			});

			expect(storage.findEmptyMessageByIndex("s", 2)).toBe("m1");
		});

		it("should return null when no empty message found", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path.startsWith(PART_STORAGE)) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m0.json"];
				if (path === join(PART_STORAGE, "m0")) return ["p0.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m0.json") && path.includes("message"))
					return JSON.stringify({
						id: "m0",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("p0.json"))
					return JSON.stringify({
						id: "p0",
						sessionID: "s",
						messageID: "m0",
						type: "text",
						text: "content",
					});
				return "{}";
			});

			expect(storage.findEmptyMessageByIndex("s", 0)).toBeNull();
		});
	});

	describe("findMessageByIndexNeedingThinking", () => {
		it("should return null for out-of-bounds index (line 335 coverage)", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m.json") && path.includes("message"))
					return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
				return "{}";
			});

			expect(storage.findMessageByIndexNeedingThinking("s", -1)).toBeNull();
			expect(storage.findMessageByIndexNeedingThinking("s", 5)).toBeNull();
		});

		it("should return null for non-assistant", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m.json") && path.includes("message"))
					return JSON.stringify({ id: "m", sessionID: "s", role: "user" });
				return "{}";
			});

			expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBeNull();
		});

		it("should return message id when first part is not thinking", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path === join(PART_STORAGE, "m")) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m.json"];
				if (path === join(PART_STORAGE, "m")) return ["a.json", "b.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m.json") && path.includes("message"))
					return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
				// "a" is text (comes first alphabetically), "b" is thinking -> firstIsThinking=false -> returns messageID
				if (path.includes("a.json"))
					return JSON.stringify({
						id: "a",
						sessionID: "s",
						messageID: "m",
						type: "text",
						text: "hi",
					});
				if (path.includes("b.json"))
					return JSON.stringify({
						id: "b",
						sessionID: "s",
						messageID: "m",
						type: "thinking",
					});
				return "{}";
			});

			expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBe("m");
		});
	});

	describe("replaceEmptyTextParts", () => {
		it("should return false when part dir missing", () => {
			fsMock.existsSync.mockReturnValue(false);

			expect(storage.replaceEmptyTextParts("m", "replacement")).toBe(false);
		});

		it("should replace empty text parts and mark synthetic", () => {
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockReturnValue(true);
			fsMock.readdirSync.mockReturnValue(["a.json", "b.json", "c.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(partDir, "a.json")) {
					return JSON.stringify({
						id: "a",
						sessionID: "s",
						messageID,
						type: "text",
						text: "",
					});
				}
				if (path === join(partDir, "b.json")) {
					return JSON.stringify({
						id: "b",
						sessionID: "s",
						messageID,
						type: "text",
						text: "hi",
					});
				}
				if (path === join(partDir, "c.json")) {
					return JSON.stringify({
						id: "c",
						sessionID: "s",
						messageID,
						type: "tool",
					});
				}
				return "";
			});

			expect(storage.replaceEmptyTextParts(messageID, "replacement")).toBe(
				true,
			);
			// AUDIT-M01 / R6 atomic recovery writes: replaceEmptyTextParts now
			// stages the payload to a .tmp.<rand> sibling and renames it over
			// the target, so the writeFileSync call lands on the temp path and
			// renameSync moves it onto "a.json". Assertions check both halves.
			expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
			expect(fsMock.renameSync).toHaveBeenCalledTimes(1);

			const [tempPath, payload] = fsMock.writeFileSync.mock.calls[0] ?? [];
			expect(tempPath).toMatch(/a\.json\.tmp\./);
			const [renameFrom, renameTo] = fsMock.renameSync.mock.calls[0] ?? [];
			expect(renameFrom).toBe(tempPath);
			expect(renameTo).toBe(join(partDir, "a.json"));
			expect(JSON.parse(payload)).toMatchObject({
				id: "a",
				type: "text",
				text: "replacement",
				synthetic: true,
			});
		});

		it("should return false on directory read error", () => {
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockImplementation((path: string) => path === partDir);
			fsMock.readdirSync.mockImplementation(() => {
				throw new Error("fail");
			});

			expect(storage.replaceEmptyTextParts(messageID, "replacement")).toBe(
				false,
			);
		});
	});

	describe("findMessagesWithEmptyTextParts", () => {
		it("should return messages containing empty text parts", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path === join(PART_STORAGE, "m1")) return true;
				if (path === join(PART_STORAGE, "m2")) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m1.json", "m2.json"];
				if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
				if (path === join(PART_STORAGE, "m2")) return ["p2.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m1.json") && path.includes("message"))
					return JSON.stringify({
						id: "m1",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("m2.json") && path.includes("message"))
					return JSON.stringify({
						id: "m2",
						sessionID: "s",
						role: "assistant",
					});
				if (path.includes("p1.json"))
					return JSON.stringify({
						id: "p1",
						sessionID: "s",
						messageID: "m1",
						type: "text",
						text: "",
					});
				if (path.includes("p2.json"))
					return JSON.stringify({
						id: "p2",
						sessionID: "s",
						messageID: "m2",
						type: "text",
						text: "ok",
					});
				return "{}";
			});

			expect(storage.findMessagesWithEmptyTextParts("s")).toEqual(["m1"]);
		});
	});

	describe("validatePathId (via getMessageDir)", () => {
		it("should throw on unsafe session ID characters", () => {
			expect(() => storage.getMessageDir("sess/../hack")).toThrow(
				"Invalid sessionID: contains unsafe characters",
			);
		});

		it("should throw on ID with special characters", () => {
			expect(() => storage.getMessageDir("sess/evil")).toThrow(
				"Invalid sessionID: contains unsafe characters",
			);
		});
	});

	describe("findMessageByIndexNeedingThinking - line 353", () => {
		it("should return null when first part is thinking", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path === join(PART_STORAGE, "m")) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m.json"];
				if (path === join(PART_STORAGE, "m")) return ["a.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m.json") && path.includes("message"))
					return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
				if (path.includes("a.json"))
					return JSON.stringify({
						id: "a",
						sessionID: "s",
						messageID: "m",
						type: "thinking",
					});
				return "{}";
			});

			expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBeNull();
		});
	});

	describe("replaceEmptyTextParts parse error - line 379", () => {
		it("should continue on JSON parse error for individual parts", () => {
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockReturnValue(true);
			fsMock.readdirSync.mockReturnValue(["bad.json", "good.json"]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(partDir, "bad.json")) {
					return "not valid json";
				}
				if (path === join(partDir, "good.json")) {
					return JSON.stringify({
						id: "good",
						sessionID: "s",
						messageID,
						type: "text",
						text: "",
					});
				}
				return "";
			});

			expect(storage.replaceEmptyTextParts(messageID, "replacement")).toBe(
				true,
			);
			expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
		});
	});

	describe("replaceEmptyTextParts - line 363 non-json files", () => {
		it("should skip non-json files in directory", () => {
			const messageID = "m";
			const partDir = join(PART_STORAGE, messageID);

			fsMock.existsSync.mockReturnValue(true);
			fsMock.readdirSync.mockReturnValue([
				"readme.txt",
				"backup.bak",
				"good.json",
			]);
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path === join(partDir, "good.json")) {
					return JSON.stringify({
						id: "good",
						sessionID: "s",
						messageID,
						type: "text",
						text: "",
					});
				}
				return "";
			});

			expect(storage.replaceEmptyTextParts(messageID, "replacement")).toBe(
				true,
			);
			expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
		});
	});

	describe("findMessagesWithEmptyTextParts - line 396 non-text types", () => {
		it("should not include messages where parts are non-text type", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path === join(PART_STORAGE, "m")) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m.json"];
				if (path === join(PART_STORAGE, "m")) return ["a.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m.json") && path.includes("message")) {
					return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
				}
				if (path.includes("a.json")) {
					return JSON.stringify({
						id: "a",
						sessionID: "s",
						messageID: "m",
						type: "tool",
					});
				}
				return "{}";
			});

			const result = storage.findMessagesWithEmptyTextParts("s");
			expect(result).toEqual([]);
		});
	});

	describe("findMessageByIndexNeedingThinking - lines 341-345 edge cases", () => {
		it("should return null when parts array is empty", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				if (path === join(PART_STORAGE, "m")) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m.json"];
				if (path === join(PART_STORAGE, "m")) return [];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m.json") && path.includes("message")) {
					return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
				}
				return "{}";
			});

			expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBeNull();
		});

		it("should return null when target message is not assistant role", () => {
			const msgDir = join(MESSAGE_STORAGE, "s");
			fsMock.existsSync.mockImplementation((path: string) => {
				if (path === MESSAGE_STORAGE) return true;
				if (path === msgDir) return true;
				return false;
			});
			fsMock.readdirSync.mockImplementation((path: string) => {
				if (path === msgDir) return ["m.json"];
				return [];
			});
			fsMock.readFileSync.mockImplementation((path: string) => {
				if (path.includes("m.json") && path.includes("message")) {
					return JSON.stringify({ id: "m", sessionID: "s", role: "user" });
				}
				return "{}";
			});

			expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBeNull();
		});
	});
});
