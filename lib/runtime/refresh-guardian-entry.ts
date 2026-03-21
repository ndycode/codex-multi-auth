export function ensureRefreshGuardianEntry<TGuardian>(params: {
	pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>;
	currentGuardian: TGuardian | null;
	currentConfigKey: string | null;
	getProactiveRefreshGuardian: (
		config: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => boolean;
	getProactiveRefreshIntervalMs: (
		config: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => number;
	getProactiveRefreshBufferMs: (
		config: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => number;
	createGuardian: (options: {
		intervalMs: number;
		bufferMs: number;
	}) => TGuardian;
	registerCleanup: (cleanup: () => void) => void;
	ensureRefreshGuardianState: (args: {
		enabled: boolean;
		intervalMs: number;
		bufferMs: number;
		currentGuardian: TGuardian | null;
		currentConfigKey: string | null;
		createGuardian: (options: {
			intervalMs: number;
			bufferMs: number;
		}) => TGuardian;
		registerCleanup: (cleanup: () => void) => void;
	}) => {
		refreshGuardian: TGuardian | null;
		refreshGuardianConfigKey: string | null;
	};
}): {
	refreshGuardian: TGuardian | null;
	refreshGuardianConfigKey: string | null;
} {
	return params.ensureRefreshGuardianState({
		enabled: params.getProactiveRefreshGuardian(params.pluginConfig),
		intervalMs: params.getProactiveRefreshIntervalMs(params.pluginConfig),
		bufferMs: params.getProactiveRefreshBufferMs(params.pluginConfig),
		currentGuardian: params.currentGuardian,
		currentConfigKey: params.currentConfigKey,
		createGuardian: params.createGuardian,
		registerCleanup: params.registerCleanup,
	});
}
