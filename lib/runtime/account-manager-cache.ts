import type { OAuthAuthDetails } from "../types.js";

export function invalidateRuntimeAccountManagerCache(deps: {
	setCachedAccountManager: (value: unknown) => void;
	setAccountManagerPromise: (value: Promise<unknown> | null) => void;
}): void {
	deps.setCachedAccountManager(null);
	deps.setAccountManagerPromise(null);
}

export async function reloadRuntimeAccountManager<TAccountManager>(deps: {
	currentReloadInFlight: Promise<TAccountManager> | null;
	loadFromDisk: (authFallback?: OAuthAuthDetails) => Promise<TAccountManager>;
	setCachedAccountManager: (value: TAccountManager) => void;
	setAccountManagerPromise: (value: Promise<TAccountManager> | null) => void;
	setReloadInFlight: (value: Promise<TAccountManager> | null) => void;
	authFallback?: OAuthAuthDetails;
}): Promise<TAccountManager> {
	if (deps.currentReloadInFlight) {
		return deps.currentReloadInFlight;
	}

	const reloadInFlight = (async () => {
		const reloaded = await deps.loadFromDisk(deps.authFallback);
		deps.setCachedAccountManager(reloaded);
		deps.setAccountManagerPromise(Promise.resolve(reloaded));
		return reloaded;
	})();

	deps.setReloadInFlight(reloadInFlight);
	try {
		return await reloadInFlight;
	} finally {
		deps.setReloadInFlight(null);
	}
}
