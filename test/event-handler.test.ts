import { describe, expect, it, vi } from "vitest";
import { handleRuntimeEvent } from "../lib/runtime/event-handler.js";

describe("runtime event handler", () => {
	it("ignores unrelated providers and out-of-range selections", async () => {
		const loadAccounts = vi.fn(async () => ({
			accounts: [{ refreshToken: "a" }],
			activeIndex: 0,
			activeIndexByFamily: {},
		}));

		await handleRuntimeEvent({
			input: {
				event: {
					type: "account.select",
					properties: { provider: "other", index: 0 },
				},
			},
			providerId: "openai",
			modelFamilies: ["codex"],
			loadAccounts,
			saveAccounts: vi.fn(),
			syncSelectedAccount: vi.fn(async () => true),
			shouldReloadAccountManager: () => false,
			reloadAccountManagerFromDisk: vi.fn(),
			showToast: vi.fn(),
			logDebug: vi.fn(),
			pluginName: "plugin",
		});

		expect(loadAccounts).not.toHaveBeenCalled();
	});

	it("updates storage and syncs active selection for valid account events", async () => {
		const storage = {
			accounts: [{ refreshToken: "a" }],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		const saveAccounts = vi.fn(async () => undefined);
		const syncSelectedAccount = vi.fn(async () => true);
		const reload = vi.fn(async () => undefined);
		const showToast = vi.fn(async () => undefined);
		const onSelectionChanged = vi.fn();

		await handleRuntimeEvent({
			input: { event: { type: "account.select", properties: { index: 0 } } },
			providerId: "openai",
			modelFamilies: ["codex"],
			loadAccounts: async () => storage as never,
			saveAccounts,
			syncSelectedAccount,
			shouldReloadAccountManager: () => true,
			reloadAccountManagerFromDisk: reload,
			showToast,
			onSelectionChanged,
			logDebug: vi.fn(),
			pluginName: "plugin",
		});

		expect(saveAccounts).toHaveBeenCalled();
		expect(syncSelectedAccount).toHaveBeenCalledWith(
			0,
			expect.objectContaining({ refreshToken: "a" }),
		);
		expect(reload).toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith("Switched to account 1", "info");
		expect(onSelectionChanged).not.toHaveBeenCalled();
	});
});
