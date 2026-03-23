import { describe, expect, it, vi } from "vitest";
import { loadExperimentalSyncTargetState } from "../lib/codex-manager/experimental-sync-target.js";
import type { OcChatgptTargetDetectionResult } from "../lib/oc-chatgpt-target-detection.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createTargetDetection(
	accountPath = "/tmp/target.json",
): Extract<OcChatgptTargetDetectionResult, { kind: "target" }> {
	return {
		kind: "target",
		descriptor: {
			scope: "global",
			root: "/tmp",
			accountPath,
			backupRoot: "/tmp/backups",
			source: "explicit",
			resolution: "accounts",
		},
	};
}

describe("experimental sync target helper", () => {
	it("returns blocked ambiguous targets without reading storage", async () => {
		const readJson = vi.fn();
		const result = await loadExperimentalSyncTargetState({
			detectTarget: () => ({
				kind: "ambiguous",
				reason: "multiple roots",
				candidates: [],
			}),
			readJson,
			normalizeAccountStorage: vi.fn(),
		});

		expect(result).toEqual({
			kind: "blocked-ambiguous",
			detection: {
				kind: "ambiguous",
				reason: "multiple roots",
				candidates: [],
			},
		});
		expect(readJson).not.toHaveBeenCalled();
	});

	it("treats a missing destination file as an empty target", async () => {
		const detection = createTargetDetection();
		const result = await loadExperimentalSyncTargetState({
			detectTarget: () => detection,
			readJson: async () => {
				const error = new Error("missing file") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			},
			normalizeAccountStorage: vi.fn(),
		});

		expect(result).toEqual({
			kind: "target",
			detection,
			destination: null,
		});
	});

	it("returns an error when the destination storage cannot be normalized", async () => {
		const detection = createTargetDetection();
		const result = await loadExperimentalSyncTargetState({
			detectTarget: () => detection,
			readJson: async () => ({ version: 999 }),
			normalizeAccountStorage: () => null,
		});

		expect(result).toEqual({
			kind: "error",
			message: "Invalid target account storage format",
		});
	});

	it("returns the normalized destination when target storage is valid", async () => {
		const detection = createTargetDetection();
		const normalized: AccountStorageV3 = {
			version: 3,
			accounts: [],
		};
		const normalizeAccountStorage = vi.fn(() => normalized);
		const result = await loadExperimentalSyncTargetState({
			detectTarget: () => detection,
			readJson: async () => ({ version: 3, accounts: [] }),
			normalizeAccountStorage,
		});

		expect(normalizeAccountStorage).toHaveBeenCalledWith({
			version: 3,
			accounts: [],
		});
		expect(result).toEqual({
			kind: "target",
			detection,
			destination: normalized,
		});
	});
});
