import { describe, expect, it, vi } from "vitest";
import { loadFlaggedAccountsEntry } from "../lib/storage/flagged-load-entry.js";

describe("flagged load entry", () => {
	it("passes paths and deps through to flagged load state helper", async () => {
		const loadFlaggedAccountsState = vi.fn(async () => ({
			version: 1,
			accounts: [],
		}));
		const saveFlaggedAccounts = vi.fn(async () => undefined);

		const result = await loadFlaggedAccountsEntry({
			getFlaggedAccountsPath: () => "/tmp/flagged.json",
			getLegacyFlaggedAccountsPath: () => "/tmp/legacy-flagged.json",
			getIntentionalResetMarkerPath: (path) => `${path}.reset-intent`,
			normalizeFlaggedStorage: vi.fn((data) => data as never),
			saveFlaggedAccounts,
			loadFlaggedAccountsState,
			logError: vi.fn(),
			logInfo: vi.fn(),
		});

		expect(loadFlaggedAccountsState).toHaveBeenCalledWith({
			path: "/tmp/flagged.json",
			legacyPath: "/tmp/legacy-flagged.json",
			resetMarkerPath: "/tmp/flagged.json.reset-intent",
			normalizeFlaggedStorage: expect.any(Function),
			saveFlaggedAccounts,
			logError: expect.any(Function),
			logInfo: expect.any(Function),
		});
		expect(result).toEqual({ version: 1, accounts: [] });
	});
});
