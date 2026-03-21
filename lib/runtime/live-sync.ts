import type { OAuthAuthDetails } from "../types.js";

export interface LiveSyncController {
	stop(): void;
	syncToPath(path: string): Promise<void>;
}

export async function ensureRuntimeLiveAccountSync<
	TConfig,
	TSync extends LiveSyncController,
>(deps: {
	pluginConfig: TConfig;
	authFallback?: OAuthAuthDetails;
	getLiveAccountSync: (config: TConfig) => boolean;
	getStoragePath: () => string;
	currentSync: TSync | null;
	currentPath: string | null;
	currentCleanupRegistered: boolean;
	getCurrentSync: () => TSync | null;
	createSync: (
		onChange: () => Promise<void>,
		options: { debounceMs: number; pollIntervalMs: number },
	) => TSync;
	reloadAccountManagerFromDisk: (
		authFallback?: OAuthAuthDetails,
	) => Promise<unknown>;
	getLiveAccountSyncDebounceMs: (config: TConfig) => number;
	getLiveAccountSyncPollMs: (config: TConfig) => number;
	registerCleanup: (cleanup: () => void) => void;
	logWarn: (message: string) => void;
	pluginName: string;
}): Promise<{
	sync: TSync | null;
	path: string | null;
	cleanupRegistered: boolean;
}> {
	if (!deps.getLiveAccountSync(deps.pluginConfig)) {
		deps.currentSync?.stop();
		return {
			sync: null,
			path: null,
			cleanupRegistered: deps.currentCleanupRegistered,
		};
	}

	const targetPath = deps.getStoragePath();
	let sync = deps.currentSync;
	let cleanupRegistered = deps.currentCleanupRegistered;
	if (!sync) {
		sync = deps.createSync(
			async () => {
				await deps.reloadAccountManagerFromDisk(deps.authFallback);
			},
			{
				debounceMs: deps.getLiveAccountSyncDebounceMs(deps.pluginConfig),
				pollIntervalMs: deps.getLiveAccountSyncPollMs(deps.pluginConfig),
			},
		);
		if (!cleanupRegistered) {
			deps.registerCleanup(() => {
				deps.getCurrentSync()?.stop();
			});
			cleanupRegistered = true;
		}
	}

	let nextPath = deps.currentPath;
	if (nextPath !== targetPath) {
		let switched = false;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				await sync.syncToPath(targetPath);
				nextPath = targetPath;
				switched = true;
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | undefined)?.code;
				if (code !== "EBUSY" && code !== "EPERM") throw error;
				await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
			}
		}
		if (!switched) {
			deps.logWarn(
				`[${deps.pluginName}] Live account sync path switch failed due to transient filesystem locks; keeping previous watcher.`,
			);
		}
	}

	return { sync, path: nextPath, cleanupRegistered };
}
