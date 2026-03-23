export interface RefreshGuardianController {
	stop(): void;
	start(): void;
}

export function ensureRuntimeRefreshGuardian<
	TConfig,
	TGuardian extends RefreshGuardianController,
>(deps: {
	pluginConfig: TConfig;
	getProactiveRefreshGuardian: (config: TConfig) => boolean;
	currentGuardian: TGuardian | null;
	currentConfigKey: string | null;
	currentCleanupRegistered: boolean;
	getCurrentGuardian: () => TGuardian | null;
	getProactiveRefreshIntervalMs: (config: TConfig) => number;
	getProactiveRefreshBufferMs: (config: TConfig) => number;
	createGuardian: (options: {
		intervalMs: number;
		bufferMs: number;
	}) => TGuardian;
	registerCleanup: (cleanup: () => void) => void;
}): {
	guardian: TGuardian | null;
	configKey: string | null;
	cleanupRegistered: boolean;
} {
	if (!deps.getProactiveRefreshGuardian(deps.pluginConfig)) {
		deps.currentGuardian?.stop();
		return {
			guardian: null,
			configKey: null,
			cleanupRegistered: deps.currentCleanupRegistered,
		};
	}

	const intervalMs = deps.getProactiveRefreshIntervalMs(deps.pluginConfig);
	const bufferMs = deps.getProactiveRefreshBufferMs(deps.pluginConfig);
	const configKey = `${intervalMs}:${bufferMs}`;
	if (deps.currentGuardian && deps.currentConfigKey === configKey) {
		return {
			guardian: deps.currentGuardian,
			configKey: deps.currentConfigKey,
			cleanupRegistered: deps.currentCleanupRegistered,
		};
	}

	deps.currentGuardian?.stop();
	const guardian = deps.createGuardian({ intervalMs, bufferMs });
	guardian.start();
	let cleanupRegistered = deps.currentCleanupRegistered;
	if (!cleanupRegistered) {
		deps.registerCleanup(() => {
			deps.getCurrentGuardian()?.stop();
		});
		cleanupRegistered = true;
	}
	return { guardian, configKey, cleanupRegistered };
}
