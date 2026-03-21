import type { OAuthAuthDetails } from "../types.js";

export function invalidateAccountManagerCacheState(): {
	cachedAccountManager: null;
	accountManagerPromise: null;
} {
	return {
		cachedAccountManager: null,
		accountManagerPromise: null,
	};
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
