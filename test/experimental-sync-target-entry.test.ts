import { describe, expect, it, vi } from "vitest";
import { loadExperimentalSyncTargetEntry } from "../lib/codex-manager/experimental-sync-target-entry.js";

describe("experimental sync target entry", () => {
	it("delegates retrying file read and normalization through the target loader", async () => {
		const loadExperimentalSyncTargetState = vi.fn(async () => ({
			kind: "target",
			detection: { kind: "target" },
			destination: null,
		}));

		const result = await loadExperimentalSyncTargetEntry({
			loadExperimentalSyncTargetState,
			detectTarget: () => ({ kind: "target" }) as never,
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
});
