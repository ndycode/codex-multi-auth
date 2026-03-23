import type { OAuthAuthDetails } from "../types.js";
import { ensureRuntimeRefreshGuardian } from "./refresh-guardian.js";

type LiveAccountSyncLike = {
	stop: () => void;
	syncToPath: (path: string) => Promise<void>;
};

type RefreshGuardianLike = {
	stop: () => void;
	start: () => void;
};

type SessionAffinityStoreLike = unknown;

export async function ensureLiveAccountSyncState<
	TSync extends LiveAccountSyncLike,
>(params: {
	enabled: boolean;
	targetPath: string;
	currentSync: TSync | null;
	currentPath: string | null;
	authFallback?: OAuthAuthDetails;
	createSync: (authFallback?: OAuthAuthDetails) => TSync;
	registerCleanup: (cleanup: () => void) => void;
	logWarn: (message: string) => void;
	pluginName: string;
}): Promise<{
	liveAccountSync: TSync | null;
	liveAccountSyncPath: string | null;
}> {
	let liveAccountSync = params.currentSync;
	let liveAccountSyncPath = params.currentPath;

	if (!params.enabled) {
		if (liveAccountSync) {
			liveAccountSync.stop();
			liveAccountSync = null;
			liveAccountSyncPath = null;
		}
		return { liveAccountSync, liveAccountSyncPath };
	}

	if (!liveAccountSync) {
		liveAccountSync = params.createSync(params.authFallback);
		params.registerCleanup(() => {
			liveAccountSync?.stop();
		});
	}

	if (liveAccountSyncPath !== params.targetPath) {
		let switched = false;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				await liveAccountSync.syncToPath(params.targetPath);
				liveAccountSyncPath = params.targetPath;
				switched = true;
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | undefined)?.code;
				if (code !== "EBUSY" && code !== "EPERM") {
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
			}
		}
		if (!switched) {
			params.logWarn(
				`[${params.pluginName}] Live account sync path switch failed due to transient filesystem locks; keeping previous watcher.`,
			);
		}
	}

	return { liveAccountSync, liveAccountSyncPath };
}

export function ensureRefreshGuardianState<
	TGuardian extends RefreshGuardianLike,
>(params: {
	enabled: boolean;
	intervalMs: number;
	bufferMs: number;
	currentGuardian: TGuardian | null;
	currentConfigKey: string | null;
	currentCleanupRegistered?: boolean;
	getCurrentGuardian?: () => TGuardian | null;
	createGuardian: (options: {
		intervalMs: number;
		bufferMs: number;
	}) => TGuardian;
	registerCleanup: (cleanup: () => void) => void;
}): {
	refreshGuardian: TGuardian | null;
	refreshGuardianConfigKey: string | null;
	refreshGuardianCleanupRegistered: boolean;
} {
	const ensured = ensureRuntimeRefreshGuardian({
		pluginConfig: {
			enabled: params.enabled,
			intervalMs: params.intervalMs,
			bufferMs: params.bufferMs,
		},
		getProactiveRefreshGuardian: (config) => config.enabled,
		currentGuardian: params.currentGuardian,
		currentConfigKey: params.currentConfigKey,
		currentCleanupRegistered: params.currentCleanupRegistered ?? false,
		getCurrentGuardian:
			params.getCurrentGuardian ?? (() => params.currentGuardian),
		getProactiveRefreshIntervalMs: (config) => config.intervalMs,
		getProactiveRefreshBufferMs: (config) => config.bufferMs,
		createGuardian: params.createGuardian,
		registerCleanup: params.registerCleanup,
	});

	return {
		refreshGuardian: ensured.guardian,
		refreshGuardianConfigKey: ensured.configKey,
		refreshGuardianCleanupRegistered: ensured.cleanupRegistered,
	};
}

export function ensureSessionAffinityState<
	TStore extends SessionAffinityStoreLike,
>(params: {
	enabled: boolean;
	ttlMs: number;
	maxEntries: number;
	currentStore: TStore | null;
	currentConfigKey: string | null;
	createStore: (options: { ttlMs: number; maxEntries: number }) => TStore;
}): {
	sessionAffinityStore: TStore | null;
	sessionAffinityConfigKey: string | null;
} {
	if (!params.enabled) {
		return {
			sessionAffinityStore: null,
			sessionAffinityConfigKey: null,
		};
	}

	const configKey = `${params.ttlMs}:${params.maxEntries}`;
	if (params.currentStore && params.currentConfigKey === configKey) {
		return {
			sessionAffinityStore: params.currentStore,
			sessionAffinityConfigKey: params.currentConfigKey,
		};
	}

	return {
		sessionAffinityStore: params.createStore({
			ttlMs: params.ttlMs,
			maxEntries: params.maxEntries,
		}),
		sessionAffinityConfigKey: configKey,
	};
}
