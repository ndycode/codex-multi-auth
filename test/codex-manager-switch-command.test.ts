import { describe, expect, it, vi } from "vitest";
import {
	runSwitchCommand,
	type SwitchCommandDeps,
} from "../lib/codex-manager/commands/switch.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "one@example.com",
				refreshToken: "refresh-token-1",
				addedAt: 1,
				lastUsed: 1,
			},
			{
				email: "two@example.com",
				refreshToken: "refresh-token-2",
				addedAt: 2,
				lastUsed: 2,
			},
		],
	};
}

function createDeps(
	overrides: Partial<SwitchCommandDeps> = {},
): SwitchCommandDeps {
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		persistAndSyncSelectedAccount: vi.fn(async () => ({
			synced: true,
			wasDisabled: false,
		})),
		logError: vi.fn(),
		logWarn: vi.fn(),
		logInfo: vi.fn(),
		...overrides,
	};
}

describe("runSwitchCommand", () => {
	it("returns an error when index is missing", async () => {
		const deps = createDeps();

		const result = await runSwitchCommand([], deps);

		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Missing index. Usage: codex auth switch <index>",
		);
	});

	it("returns an error when index is out of range", async () => {
		const deps = createDeps();

		const result = await runSwitchCommand(["3"], deps);

		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Index out of range. Valid range: 1-2",
		);
	});

	it("persists and reports the selected account", async () => {
		const deps = createDeps({
			persistAndSyncSelectedAccount: vi.fn(async () => ({
				synced: false,
				wasDisabled: true,
			})),
		});

		const result = await runSwitchCommand(["2"], deps);

		expect(result).toBe(0);
		expect(deps.persistAndSyncSelectedAccount).toHaveBeenCalledWith({
			storage: expect.objectContaining({ accounts: expect.any(Array) }),
			targetIndex: 1,
			parsed: 2,
			switchReason: "rotation",
		});
		expect(deps.logWarn).toHaveBeenCalledWith(
			"Switched account 2 locally, but Codex auth sync did not complete. Multi-auth routing will still use this account.",
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			"Switched to account 2: Account 2 (two@example.com) (re-enabled)",
		);
	});
});
