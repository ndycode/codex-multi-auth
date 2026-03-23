import { describe, expect, it, vi } from "vitest";
import {
	invalidateAccountManagerCacheState,
	reloadAccountManagerFromDiskState,
} from "../lib/runtime/account-manager-cache.js";

describe("account manager cache helpers", () => {
	it("invalidates cache state", () => {
		expect(invalidateAccountManagerCacheState()).toEqual({
			cachedAccountManager: null,
			accountManagerPromise: null,
		});
	});

	it("reuses in-flight reload and updates callbacks on success", async () => {
		const onLoaded = vi.fn();
		const onSettled = vi.fn();
		const inFlight = Promise.resolve({ id: 1 });
		await expect(
			reloadAccountManagerFromDiskState({
				currentReloadInFlight: inFlight,
				loadFromDisk: vi.fn(),
				onLoaded,
				onSettled,
			}),
		).resolves.toEqual({ id: 1 });

		expect(onLoaded).not.toHaveBeenCalled();
		expect(onSettled).not.toHaveBeenCalled();

		const loadFromDisk = vi.fn(async () => ({ id: 2 }));
		await expect(
			reloadAccountManagerFromDiskState({
				currentReloadInFlight: null,
				loadFromDisk,
				onLoaded,
				onSettled,
			}),
		).resolves.toEqual({ id: 2 });
		expect(onLoaded).toHaveBeenCalledWith({ id: 2 });
		expect(onSettled).toHaveBeenCalled();
	});
});
