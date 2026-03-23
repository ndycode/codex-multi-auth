import type { OAuthAuthDetails } from "../types.js";

export function invalidateAccountManagerCacheEntry<TManager>(params: {
	invalidateAccountManagerCacheState: () => {
		cachedAccountManager: null;
		accountManagerPromise: null;
	};
	setCachedAccountManager: (manager: TManager | null) => void;
	setAccountManagerPromise: (promise: Promise<TManager> | null) => void;
}): void {
	const next = params.invalidateAccountManagerCacheState();
	params.setCachedAccountManager(next.cachedAccountManager);
	params.setAccountManagerPromise(next.accountManagerPromise);
}

export async function reloadAccountManagerFromDiskEntry<TManager>(params: {
	authFallback?: OAuthAuthDetails;
	currentReloadInFlight: Promise<TManager> | null;
	reloadAccountManagerFromDiskState: (args: {
		currentReloadInFlight: Promise<TManager> | null;
		loadFromDisk: (authFallback?: OAuthAuthDetails) => Promise<TManager>;
		authFallback?: OAuthAuthDetails;
		onLoaded: (manager: TManager) => void;
		onSettled: () => void;
	}) => Promise<TManager>;
	loadFromDisk: (authFallback?: OAuthAuthDetails) => Promise<TManager>;
	onLoaded: (manager: TManager) => void;
	onSettled: () => void;
	setReloadInFlight: (promise: Promise<TManager>) => void;
}): Promise<TManager> {
	const inFlight = params.reloadAccountManagerFromDiskState({
		currentReloadInFlight: params.currentReloadInFlight,
		loadFromDisk: params.loadFromDisk,
		authFallback: params.authFallback,
		onLoaded: params.onLoaded,
		onSettled: params.onSettled,
	});
	params.setReloadInFlight(inFlight);
	return inFlight;
}
