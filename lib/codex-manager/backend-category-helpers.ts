import type { PluginConfig } from "../types.js";
import type {
	BackendCategoryKey,
	BackendCategoryOption,
	BackendNumberSettingKey,
	BackendNumberSettingOption,
	BackendSettingFocusKey,
	BackendToggleSettingKey,
} from "./backend-settings-schema.js";

export function resolveFocusedBackendNumberKey(
	focus: BackendSettingFocusKey,
	numberOptions: BackendNumberSettingOption[],
): BackendNumberSettingKey {
	const numberKeys = new Set<BackendNumberSettingKey>(
		numberOptions.map((option) => option.key),
	);
	if (focus && numberKeys.has(focus as BackendNumberSettingKey)) {
		return focus as BackendNumberSettingKey;
	}
	return numberOptions[0]?.key ?? "fetchTimeoutMs";
}

export function getBackendCategory(
	key: BackendCategoryKey,
	categoryOptions: readonly BackendCategoryOption[],
): BackendCategoryOption | null {
	return categoryOptions.find((category) => category.key === key) ?? null;
}

export function getBackendCategoryInitialFocus(
	category: BackendCategoryOption,
): BackendSettingFocusKey {
	const firstToggle = category.toggleKeys[0];
	if (firstToggle) return firstToggle;
	return category.numberKeys[0] ?? null;
}

export function applyBackendCategoryDefaults(
	draft: PluginConfig,
	category: BackendCategoryOption,
	deps: {
		backendDefaults: PluginConfig;
		numberOptionByKey: ReadonlyMap<
			BackendNumberSettingKey,
			BackendNumberSettingOption
		>;
	},
): PluginConfig {
	const next = { ...draft };
	for (const key of category.toggleKeys) {
		next[key as BackendToggleSettingKey] = deps.backendDefaults[key] ?? false;
	}
	for (const key of category.numberKeys) {
		const option = deps.numberOptionByKey.get(key);
		const fallback = option?.min ?? 0;
		next[key] = deps.backendDefaults[key] ?? fallback;
	}
	return next;
}
