import { describe, expect, it, vi } from "vitest";
import { handleAccountSelectEvent } from "../lib/runtime/account-select-event.js";

describe("handleAccountSelectEvent", () => {
	it("ignores account-select events without properties", async () => {
		const loadAccounts = vi.fn();
		const saveAccounts = vi.fn();
		const syncSelectedAccount = vi.fn();
		const showToast = vi.fn(async () => {});

		const handled = await handleAccountSelectEvent({
			event: { type: "account.select" },
			providerId: "openai",
			loadAccounts,
			saveAccounts,
			modelFamilies: ["codex"],
			syncSelectedAccount,
			shouldReloadAccountManager: () => false,
			reloadAccountManagerFromDisk: vi.fn(async () => null),
			showToast,
		});

		expect(handled).toBe(true);
		expect(loadAccounts).not.toHaveBeenCalled();
		expect(saveAccounts).not.toHaveBeenCalled();
		expect(syncSelectedAccount).not.toHaveBeenCalled();
		expect(showToast).not.toHaveBeenCalled();
	});
});
