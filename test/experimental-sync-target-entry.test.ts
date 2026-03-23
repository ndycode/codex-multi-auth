import { describe, expect, it, vi } from "vitest";
import { loadExperimentalSyncTargetEntry } from "../lib/codex-manager/experimental-sync-target-entry.js";
import type { OcChatgptTargetDetectionResult } from "../lib/oc-chatgpt-target-detection.js";

function createDetectedTarget(): OcChatgptTargetDetectionResult {
	return {
		kind: "target",
		descriptor: {
			scope: "global",
			root: "C:\\.opencode",
			accountPath: "C:\\.opencode\\openai-codex-accounts.json",
			backupRoot: "C:\\.opencode\\backups",
			source: "default-global",
			resolution: "accounts",
		},
	};
}

describe("experimental sync target entry", () => {
	it("delegates retrying file read and normalization through the target loader", async () => {
		const loadExperimentalSyncTargetState = vi.fn(async () => ({
			kind: "target",
			detection: { kind: "target" },
			destination: null,
		}));

		const result = await loadExperimentalSyncTargetEntry({
			loadExperimentalSyncTargetState,
			detectTarget: createDetectedTarget,
			readFileWithRetry: vi.fn(async () => "{}"),
			normalizeAccountStorage: vi.fn(() => null),
			sleep: vi.fn(async () => undefined),
		});

		expect(loadExperimentalSyncTargetState).toHaveBeenCalled();
		expect(result).toEqual({
			kind: "target",
			detection: { kind: "target" },
			destination: null,
		});
	});

	it("wires windows-safe retry options through readJson", async () => {
		const sleep = vi.fn(async () => undefined);
		const readFileWithRetry = vi.fn(async () => '{"hello":"world"}');
		const normalizeAccountStorage = vi.fn(() => null);
		let capturedReadJson: ((path: string) => Promise<unknown>) | undefined;

		const loadExperimentalSyncTargetState = vi.fn(async (args) => {
			capturedReadJson = args.readJson;
			const parsed = await args.readJson("C:\\state.json");
			args.normalizeAccountStorage(parsed);
			return {
				kind: "target" as const,
				detection: { kind: "target" as const },
				destination: null,
			};
		});

		await loadExperimentalSyncTargetEntry({
			loadExperimentalSyncTargetState,
			detectTarget: createDetectedTarget,
			readFileWithRetry,
			normalizeAccountStorage,
			sleep,
		});

		expect(capturedReadJson).toBeDefined();
		expect(readFileWithRetry).toHaveBeenCalledWith("C:\\state.json", {
			retryableCodes: new Set(["EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"]),
			maxAttempts: 4,
			sleep,
		});
		expect(normalizeAccountStorage).toHaveBeenCalledWith({ hello: "world" });
	});

	it("propagates malformed json parse failures to the caller", async () => {
		const readFileWithRetry = vi.fn(async () => "not-valid-json{{{");
		const normalizeAccountStorage = vi.fn(() => null);

		const loadExperimentalSyncTargetState = vi.fn(async (args) => {
			await args.readJson("C:\\state.json");
			return {
				kind: "target" as const,
				detection: { kind: "target" as const },
				destination: null,
			};
		});

		await expect(
			loadExperimentalSyncTargetEntry({
				loadExperimentalSyncTargetState,
				detectTarget: createDetectedTarget,
				readFileWithRetry,
				normalizeAccountStorage,
				sleep: vi.fn(async () => undefined),
			}),
		).rejects.toThrow(SyntaxError);

		expect(normalizeAccountStorage).not.toHaveBeenCalled();
	});
});
