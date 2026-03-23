import { describe, expect, it, vi } from "vitest";
import {
	invalidateAccountManagerCacheEntry,
	reloadAccountManagerFromDiskEntry,
} from "../lib/runtime/account-manager-cache-entry.js";

describe("account manager cache entry", () => {
	it("delegates cache invalidation state into the setter callbacks", () => {
		const setCachedAccountManager = vi.fn();
		const setAccountManagerPromise = vi.fn();

		invalidateAccountManagerCacheEntry({
			invalidateAccountManagerCacheState: () => ({
				cachedAccountManager: null,
				accountManagerPromise: null,
			}),
			setCachedAccountManager,
			setAccountManagerPromise,
		});

		expect(setCachedAccountManager).toHaveBeenCalledWith(null);
		expect(setAccountManagerPromise).toHaveBeenCalledWith(null);
	});

	it("delegates reload state into the injected runtime callbacks", async () => {
		const reloadState = vi.fn(async () => ({ id: 1 }));
		const setReloadInFlight = vi.fn();

		const result = await reloadAccountManagerFromDiskEntry({
			currentReloadInFlight: null,
			reloadAccountManagerFromDiskState: reloadState,
			loadFromDisk: vi.fn(async () => ({ id: 1 })),
			onLoaded: vi.fn(),
			onSettled: vi.fn(),
			setReloadInFlight,
		});

		expect(reloadState).toHaveBeenCalled();
		expect(setReloadInFlight).toHaveBeenCalledWith(expect.any(Promise));
		expect(result).toEqual({ id: 1 });
	});
});
