import { describe, expect, it, vi } from "vitest";
import { ensureLiveAccountSyncEntry } from "../lib/runtime/live-sync-entry.js";

describe("live sync entry", () => {
	it("delegates plugin-config-derived arguments into the live sync state helper", async () => {
		const ensureLiveAccountSyncState = vi.fn(async () => ({
			liveAccountSync: { stop: vi.fn(), syncToPath: vi.fn() },
			liveAccountSyncPath: "/tmp/accounts.json",
		}));

		const result = await ensureLiveAccountSyncEntry({
			pluginConfig: {} as never,
			authFallback: {
				type: "oauth",
				accessToken: "a",
				refreshToken: "r",
			} as never,
			currentSync: null,
			currentPath: null,
			getLiveAccountSync: () => true,
			getStoragePath: () => "/tmp/accounts.json",
			createSync: vi.fn(() => ({ stop: vi.fn(), syncToPath: vi.fn() })),
			registerCleanup: vi.fn(),
			logWarn: vi.fn(),
			pluginName: "plugin",
			ensureLiveAccountSyncState,
		});

		expect(ensureLiveAccountSyncState).toHaveBeenCalledWith(
			expect.objectContaining({
				enabled: true,
				targetPath: "/tmp/accounts.json",
				pluginName: "plugin",
			}),
		);
		expect(result.liveAccountSyncPath).toBe("/tmp/accounts.json");
	});
});
