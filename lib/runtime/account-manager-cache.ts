import type { OAuthAuthDetails } from "../types.js";

export function invalidateRuntimeAccountManagerCache(deps: {
	setCachedAccountManager: (value: unknown) => void;
	setAccountManagerPromise: (value: Promise<unknown> | null) => void;
}): void {
	deps.setCachedAccountManager(null);
	deps.setAccountManagerPromise(null);
}

export function invalidateAccountManagerCacheState(): {
	cachedAccountManager: null;
	accountManagerPromise: null;
} {
	return {
		cachedAccountManager: null,
		accountManagerPromise: null,
	};
}

export function reloadRuntimeAccountManager<TAccountManager>(deps: {
	currentReloadInFlight: Promise<TAccountManager> | null;
	loadFromDisk: (authFallback?: OAuthAuthDetails) => Promise<TAccountManager>;
	setCachedAccountManager: (value: TAccountManager) => void;
	setAccountManagerPromise: (value: Promise<TAccountManager> | null) => void;
	setReloadInFlight: (value: Promise<TAccountManager> | null) => void;
	authFallback?: OAuthAuthDetails;
}): Promise<TAccountManager> {
	// The caller must pass a fresh snapshot of the shared in-flight promise.
	// Dedup only holds if setReloadInFlight runs before any awaited work below.
	if (deps.currentReloadInFlight) {
		return deps.currentReloadInFlight;
	}

	const reloadInFlight = (async () => {
		const reloaded = await deps.loadFromDisk(deps.authFallback);
		deps.setCachedAccountManager(reloaded);
		deps.setAccountManagerPromise(Promise.resolve(reloaded));
		return reloaded;
	})().finally(() => {
		deps.setReloadInFlight(null);
	});

	deps.setReloadInFlight(reloadInFlight);
	return reloadInFlight;
}

export async function reloadAccountManagerFromDiskState<TManager>(params: {
	currentReloadInFlight: Promise<TManager> | null;
	loadFromDisk: (authFallback?: OAuthAuthDetails) => Promise<TManager>;
	authFallback?: OAuthAuthDetails;
	onLoaded: (manager: TManager) => void;
	onSettled: () => void;
}): Promise<TManager> {
	if (params.currentReloadInFlight) {
		return params.currentReloadInFlight;
	}

	const inFlight = (async () => {
		const reloaded = await params.loadFromDisk(params.authFallback);
		params.onLoaded(reloaded);
		return reloaded;
	})();

	try {
		return await inFlight;
	} finally {
		params.onSettled();
	}
}
