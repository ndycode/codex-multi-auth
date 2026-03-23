export function ensureSessionAffinityEntry<TStore>(params: {
	pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>;
	currentStore: TStore | null;
	currentConfigKey: string | null;
	getSessionAffinity: (
		config: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => boolean;
	getSessionAffinityTtlMs: (
		config: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => number;
	getSessionAffinityMaxEntries: (
		config: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => number;
	createStore: (options: { ttlMs: number; maxEntries: number }) => TStore;
	ensureSessionAffinityState: (args: {
		enabled: boolean;
		ttlMs: number;
		maxEntries: number;
		currentStore: TStore | null;
		currentConfigKey: string | null;
		createStore: (options: { ttlMs: number; maxEntries: number }) => TStore;
	}) => {
		sessionAffinityStore: TStore | null;
		sessionAffinityConfigKey: string | null;
	};
}): {
	sessionAffinityStore: TStore | null;
	sessionAffinityConfigKey: string | null;
} {
	return params.ensureSessionAffinityState({
		enabled: params.getSessionAffinity(params.pluginConfig),
		ttlMs: params.getSessionAffinityTtlMs(params.pluginConfig),
		maxEntries: params.getSessionAffinityMaxEntries(params.pluginConfig),
		currentStore: params.currentStore,
		currentConfigKey: params.currentConfigKey,
		createStore: params.createStore,
	});
}
