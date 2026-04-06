import type { OAuthAuthDetails } from "../types.js";

type LiveAccountSyncLike = {
	stop: () => void;
	syncToPath: (path: string) => Promise<void>;
};

export async function ensureLiveAccountSyncEntry<
	TSync extends LiveAccountSyncLike,
>(params: {
	pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>;
	authFallback?: OAuthAuthDetails;
	currentSync: TSync | null;
	currentPath: string | null;
	currentConfigKey?: string | null;
	getLiveAccountSync: (
		config: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => boolean;
	getStoragePath: () => string;
	getLiveAccountSyncDebounceMs: (
		config: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => number;
	getLiveAccountSyncPollMs: (
		config: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => number;
	createSync: (authFallback?: OAuthAuthDetails) => TSync;
	registerCleanup: (cleanup: () => void) => void;
	logWarn: (message: string) => void;
	pluginName: string;
	ensureLiveAccountSyncState: (args: {
		enabled: boolean;
		targetPath: string;
		currentSync: TSync | null;
		currentPath: string | null;
		currentConfigKey?: string | null;
		configKey?: string | null;
		authFallback?: OAuthAuthDetails;
		createSync: (authFallback?: OAuthAuthDetails) => TSync;
		registerCleanup: (cleanup: () => void) => void;
		logWarn: (message: string) => void;
		pluginName: string;
	}) => Promise<{
		liveAccountSync: TSync | null;
		liveAccountSyncPath: string | null;
		liveAccountSyncConfigKey: string | null;
	}>;
}): Promise<{
	liveAccountSync: TSync | null;
	liveAccountSyncPath: string | null;
	liveAccountSyncConfigKey: string | null;
}> {
	const debounceMs = params.getLiveAccountSyncDebounceMs(params.pluginConfig);
	const pollIntervalMs = params.getLiveAccountSyncPollMs(params.pluginConfig);
	return params.ensureLiveAccountSyncState({
		enabled: params.getLiveAccountSync(params.pluginConfig),
		targetPath: params.getStoragePath(),
		currentSync: params.currentSync,
		currentPath: params.currentPath,
		currentConfigKey: params.currentConfigKey,
		configKey: `${debounceMs}:${pollIntervalMs}`,
		authFallback: params.authFallback,
		createSync: params.createSync,
		registerCleanup: params.registerCleanup,
		logWarn: params.logWarn,
		pluginName: params.pluginName,
	});
}
