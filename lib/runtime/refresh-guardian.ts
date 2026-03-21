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
	getProactiveRefreshIntervalMs: (config: TConfig) => number;
	getProactiveRefreshBufferMs: (config: TConfig) => number;
	createGuardian: (options: {
		intervalMs: number;
		bufferMs: number;
	}) => TGuardian;
	registerCleanup: (cleanup: () => void) => void;
}): { guardian: TGuardian | null; configKey: string | null } {
	if (!deps.getProactiveRefreshGuardian(deps.pluginConfig)) {
		deps.currentGuardian?.stop();
		return { guardian: null, configKey: null };
	}

	const intervalMs = deps.getProactiveRefreshIntervalMs(deps.pluginConfig);
	const bufferMs = deps.getProactiveRefreshBufferMs(deps.pluginConfig);
	const configKey = `${intervalMs}:${bufferMs}`;
	if (deps.currentGuardian && deps.currentConfigKey === configKey) {
		return { guardian: deps.currentGuardian, configKey: deps.currentConfigKey };
	}

	deps.currentGuardian?.stop();
	const guardian = deps.createGuardian({ intervalMs, bufferMs });
	guardian.start();
	deps.registerCleanup(() => {
		guardian.stop();
	});
	return { guardian, configKey };
}
