import { SessionAffinityStore } from "../session-affinity.js";

export function ensureRuntimeSessionAffinity<TConfig>(deps: {
	pluginConfig: TConfig;
	getSessionAffinity: (config: TConfig) => boolean;
	currentStore: SessionAffinityStore | null;
	currentConfigKey: string | null;
	getSessionAffinityTtlMs: (config: TConfig) => number;
	getSessionAffinityMaxEntries: (config: TConfig) => number;
}): { store: SessionAffinityStore | null; configKey: string | null } {
	if (!deps.getSessionAffinity(deps.pluginConfig)) {
		return { store: null, configKey: null };
	}

	const ttlMs = deps.getSessionAffinityTtlMs(deps.pluginConfig);
	const maxEntries = deps.getSessionAffinityMaxEntries(deps.pluginConfig);
	const configKey = `${ttlMs}:${maxEntries}`;
	if (deps.currentStore && deps.currentConfigKey === configKey) {
		return { store: deps.currentStore, configKey: deps.currentConfigKey };
	}

	return {
		store: new SessionAffinityStore({ ttlMs, maxEntries }),
		configKey,
	};
}
