import { describe, expect, it, vi } from "vitest";
import { handleAccountSelectEvent } from "../lib/runtime/account-select-event.js";

describe("handleAccountSelectEvent", () => {
	it("ignores account-select events without properties", async () => {
		const loadAccounts = vi.fn();
		const saveAccounts = vi.fn();
		const cachedAccountManager = {
			syncCodexCliActiveSelectionForIndex: vi.fn(),
		};
		const showToast = vi.fn(async () => {});

		const handled = await handleAccountSelectEvent({
			event: { type: "account.select" },
			providerId: "openai",
			loadAccounts,
			saveAccounts,
			modelFamilies: ["codex"],
			getCachedAccountManager: () => cachedAccountManager,
			reloadAccountManagerFromDisk: vi.fn(async () => null),
			setLastCodexCliActiveSyncIndex: vi.fn(),
			showToast,
		});

		expect(handled).toBe(true);
		expect(loadAccounts).not.toHaveBeenCalled();
		expect(saveAccounts).not.toHaveBeenCalled();
		expect(cachedAccountManager.syncCodexCliActiveSelectionForIndex).not.toHaveBeenCalled();
		expect(showToast).not.toHaveBeenCalled();
	});
});
