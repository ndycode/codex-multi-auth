import type { PluginConfig } from "../types.js";
import {
	BACKEND_DEFAULTS,
	BACKEND_NUMBER_OPTION_BY_KEY,
	BACKEND_NUMBER_OPTIONS,
	BACKEND_TOGGLE_OPTIONS,
	type BackendNumberSettingKey,
	type BackendNumberSettingOption,
	type BackendSettingFocusKey,
} from "./backend-settings-schema.js";

export function cloneBackendPluginConfig(config: PluginConfig): PluginConfig {
	const fallbackChain = config.unsupportedCodexFallbackChain;
	return {
		...BACKEND_DEFAULTS,
		...config,
		unsupportedCodexFallbackChain:
			fallbackChain && typeof fallbackChain === "object"
				? { ...fallbackChain }
				: {},
	};
}

export function backendSettingsSnapshot(
	config: PluginConfig,
): Record<string, unknown> {
	const snapshot: Record<string, unknown> = {};
	for (const option of BACKEND_TOGGLE_OPTIONS) {
		snapshot[option.key] =
			config[option.key] ?? BACKEND_DEFAULTS[option.key] ?? false;
	}
	for (const option of BACKEND_NUMBER_OPTIONS) {
		snapshot[option.key] =
			config[option.key] ?? BACKEND_DEFAULTS[option.key] ?? option.min;
	}
	return snapshot;
}

export function backendSettingsEqual(
	left: PluginConfig,
	right: PluginConfig,
): boolean {
	return (
		JSON.stringify(backendSettingsSnapshot(left)) ===
		JSON.stringify(backendSettingsSnapshot(right))
	);
}

export function formatBackendNumberValue(
	option: BackendNumberSettingOption,
	value: number,
): string {
	if (option.unit === "percent") return `${Math.round(value)}%`;
	if (option.unit === "count") return `${Math.round(value)}`;
	if (value >= 60_000 && value % 60_000 === 0) {
		return `${Math.round(value / 60_000)}m`;
	}
	if (value >= 1_000 && value % 1_000 === 0) {
		return `${Math.round(value / 1_000)}s`;
	}
	return `${Math.round(value)}ms`;
}

export function clampBackendNumber(
	option: BackendNumberSettingOption,
	value: number,
): number {
	return Math.max(option.min, Math.min(option.max, Math.round(value)));
}

export function buildBackendSettingsPreview(
	config: PluginConfig,
	ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
	focus: BackendSettingFocusKey,
	deps: {
		highlightPreviewToken: (
			text: string,
			ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
		) => string;
	},
): { label: string; hint: string } {
	const liveSync =
		config.liveAccountSync ?? BACKEND_DEFAULTS.liveAccountSync ?? true;
	const affinity =
		config.sessionAffinity ?? BACKEND_DEFAULTS.sessionAffinity ?? true;
	const preemptive =
		config.preemptiveQuotaEnabled ??
		BACKEND_DEFAULTS.preemptiveQuotaEnabled ??
		true;
	const threshold5h =
		config.preemptiveQuotaRemainingPercent5h ??
		BACKEND_DEFAULTS.preemptiveQuotaRemainingPercent5h ??
		5;
	const threshold7d =
		config.preemptiveQuotaRemainingPercent7d ??
		BACKEND_DEFAULTS.preemptiveQuotaRemainingPercent7d ??
		5;
	const fetchTimeout =
		config.fetchTimeoutMs ?? BACKEND_DEFAULTS.fetchTimeoutMs ?? 60_000;
	const stallTimeout =
		config.streamStallTimeoutMs ??
		BACKEND_DEFAULTS.streamStallTimeoutMs ??
		45_000;
	const fetchTimeoutOption = BACKEND_NUMBER_OPTION_BY_KEY.get("fetchTimeoutMs");
	const stallTimeoutOption = BACKEND_NUMBER_OPTION_BY_KEY.get(
		"streamStallTimeoutMs",
	);

	const highlightIfFocused = (
		key: BackendSettingFocusKey,
		text: string,
	): string => {
		if (focus !== key) return text;
		return deps.highlightPreviewToken(text, ui);
	};

	const label = [
		`live sync ${highlightIfFocused("liveAccountSync", liveSync ? "on" : "off")}`,
		`affinity ${highlightIfFocused("sessionAffinity", affinity ? "on" : "off")}`,
		`preemptive ${highlightIfFocused("preemptiveQuotaEnabled", preemptive ? "on" : "off")}`,
	].join(" | ");

	const hint = [
		`thresholds 5h<=${highlightIfFocused("preemptiveQuotaRemainingPercent5h", `${threshold5h}%`)}`,
		`7d<=${highlightIfFocused("preemptiveQuotaRemainingPercent7d", `${threshold7d}%`)}`,
		`timeouts ${highlightIfFocused("fetchTimeoutMs", fetchTimeoutOption ? formatBackendNumberValue(fetchTimeoutOption, fetchTimeout) : `${fetchTimeout}ms`)}/${highlightIfFocused("streamStallTimeoutMs", stallTimeoutOption ? formatBackendNumberValue(stallTimeoutOption, stallTimeout) : `${stallTimeout}ms`)}`,
	].join(" | ");

	return { label, hint };
}

export function buildBackendConfigPatch(
	config: PluginConfig,
): Partial<PluginConfig> {
	const patch: Partial<PluginConfig> = {};
	for (const option of BACKEND_TOGGLE_OPTIONS) {
		const value = config[option.key];
		if (typeof value === "boolean") {
			patch[option.key] = value;
		}
	}
	for (const option of BACKEND_NUMBER_OPTIONS) {
		const value = config[option.key];
		if (typeof value === "number" && Number.isFinite(value)) {
			patch[option.key] = clampBackendNumber(option, value);
		}
	}
	return patch;
}

export function clampBackendNumberForTests(
	settingKey: string,
	value: number,
): number {
	const option = BACKEND_NUMBER_OPTION_BY_KEY.get(
		settingKey as BackendNumberSettingKey,
	);
	if (!option) {
		throw new Error(`Unknown backend numeric setting key: ${settingKey}`);
	}
	return clampBackendNumber(option, value);
}
