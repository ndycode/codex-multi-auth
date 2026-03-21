import { describe, expect, it, vi } from "vitest";
import { loadFlaggedAccountsFromFile } from "../lib/storage/flagged-storage-file.js";
import { describeFlaggedSnapshot } from "../lib/storage/snapshot-inspectors.js";

describe("loadFlaggedAccountsFromFile", () => {
	it("retries transient Windows read locks before parsing", async () => {
		const normalizeFlaggedStorage = vi.fn((data) => data as never);
		const readFile = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
			.mockRejectedValueOnce(Object.assign(new Error("again"), { code: "EAGAIN" }))
			.mockResolvedValueOnce('{"version":1,"accounts":[]}');
		await expect(
			loadFlaggedAccountsFromFile("flagged.json", {
				readFile,
				normalizeFlaggedStorage,
				sleep: vi.fn(async () => {}),
			}),
		).resolves.toEqual({ version: 1, accounts: [] });
		expect(readFile).toHaveBeenCalledTimes(3);
		expect(normalizeFlaggedStorage).toHaveBeenCalledWith({ version: 1, accounts: [] });
	});

	it("propagates malformed JSON parse errors", async () => {
		await expect(
			loadFlaggedAccountsFromFile("flagged.json", {
				readFile: vi.fn(async () => "{"),
				normalizeFlaggedStorage: vi.fn(),
			}),
		).rejects.toBeInstanceOf(SyntaxError);
	});
});

describe("describeFlaggedSnapshot", () => {
	it("returns invalid existing metadata after transient read retries are exhausted", async () => {
		const logWarn = vi.fn();
		await expect(
			describeFlaggedSnapshot("flagged.json", "flagged-accounts", {
				index: 0,
				statSnapshot: vi.fn(async () => ({ exists: true, bytes: 12, mtimeMs: 34 })),
				loadFlaggedAccountsFromPath: vi.fn(async () => {
					throw Object.assign(new Error("locked"), { code: "EBUSY" });
				}),
				logWarn,
			}),
		).resolves.toEqual({
			kind: "flagged-accounts",
			path: "flagged.json",
			index: 0,
			exists: true,
			valid: false,
			bytes: 12,
			mtimeMs: 34,
		});
		expect(logWarn).toHaveBeenCalledWith(
			"Failed to inspect flagged snapshot",
			expect.objectContaining({ path: "flagged.json" }),
		);
	});
});
