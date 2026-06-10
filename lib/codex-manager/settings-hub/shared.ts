import { stdin as input, stdout as output } from "node:process";
import { savePluginConfig } from "../../config.js";
import {
	type DashboardDisplaySettings,
	type DashboardStatuslineField,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	getDashboardSettingsPath,
	loadDashboardDisplaySettings,
	saveDashboardDisplaySettings,
} from "../../dashboard-settings.js";
import type { PluginConfig } from "../../types.js";
import { getUiRuntimeOptions } from "../../ui/runtime.js";
import { sleep } from "../../utils.js";
import {
	buildBackendConfigPatch,
	cloneBackendPluginConfig,
} from "../backend-settings-helpers.js";
import type { BackendNumberSettingOption } from "../backend-settings-schema.js";
import type { DashboardDisplaySettingKey } from "../dashboard-display-panel.js";
import {
	cloneDashboardSettingsData,
	dashboardSettingsDataEqual,
} from "../dashboard-settings-data.js";
import {
	resolvePluginConfigSavePathKey,
	warnPersistFailure,
} from "../settings-persist-utils.js";
import {
	buildAccountListPreview as buildAccountListPreviewBase,
	buildSummaryPreviewText as buildSummaryPreviewTextBase,
	normalizeStatuslineFields,
} from "../settings-preview.js";
import { withQueuedRetry } from "../settings-write-queue.js";

export type SettingsHubAction =
	| { type: "account-list" }
	| { type: "summary-fields" }
	| { type: "behavior" }
	| { type: "theme" }
	| { type: "experimental" }
	| { type: "backend" }
	| { type: "back" };

export type DashboardSettingKey = keyof DashboardDisplaySettings;

export function isTtyInteractive(): boolean {
	return Boolean(input.isTTY && output.isTTY);
}

function copyDashboardSettingValue(
	target: DashboardDisplaySettings,
	source: DashboardDisplaySettings,
	key: DashboardSettingKey,
): void {
	const value = source[key];
	(target as unknown as Record<string, unknown>)[key] = Array.isArray(value)
		? [...value]
		: value;
}

export function applyDashboardDefaultsForKeys(
	draft: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
): DashboardDisplaySettings {
	const next = cloneDashboardSettings(draft);
	const defaults = cloneDashboardSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
	for (const key of keys) {
		copyDashboardSettingValue(next, defaults, key);
	}
	return next;
}

function mergeDashboardSettingsForKeys(
	base: DashboardDisplaySettings,
	selected: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
): DashboardDisplaySettings {
	const next = cloneDashboardSettings(base);
	for (const key of keys) {
		copyDashboardSettingValue(next, selected, key);
	}
	return cloneDashboardSettings(next);
}

export async function persistDashboardSettingsSelection(
	selected: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
	scope: string,
): Promise<DashboardDisplaySettings> {
	const fallback = cloneDashboardSettings(selected);
	try {
		return await withQueuedRetry(
			getDashboardSettingsPath(),
			async () => {
				const latest = cloneDashboardSettings(
					await loadDashboardDisplaySettings(),
				);
				const merged = mergeDashboardSettingsForKeys(latest, selected, keys);
				await saveDashboardDisplaySettings(merged);
				return merged;
			},
			{ sleep },
		);
	} catch (error) {
		warnPersistFailure(scope, error);
		return fallback;
	}
}

export async function persistBackendConfigSelection(
	selected: PluginConfig,
	scope: string,
): Promise<PluginConfig> {
	const fallback = cloneBackendPluginConfig(selected);
	try {
		await withQueuedRetry(
			resolvePluginConfigSavePathKey(),
			async () => {
				await savePluginConfig(buildBackendConfigPatch(selected));
			},
			{ sleep },
		);
		return fallback;
	} catch (error) {
		warnPersistFailure(scope, error);
		return fallback;
	}
}

export function cloneDashboardSettings(
	settings: DashboardDisplaySettings,
): DashboardDisplaySettings {
	return cloneDashboardSettingsData(settings, {
		resolveMenuLayoutMode,
		normalizeStatuslineFields,
	});
}

export function dashboardSettingsEqual(
	left: DashboardDisplaySettings,
	right: DashboardDisplaySettings,
): boolean {
	return dashboardSettingsDataEqual(left, right, {
		resolveMenuLayoutMode,
		normalizeStatuslineFields,
	});
}

export function buildSummaryPreviewText(
	settings: DashboardDisplaySettings,
	ui: ReturnType<typeof getUiRuntimeOptions>,
	focus:
		| DashboardDisplaySettingKey
		| DashboardStatuslineField
		| "menuSortMode"
		| "menuLayoutMode"
		| null = null,
): string {
	return buildSummaryPreviewTextBase(
		settings,
		ui,
		resolveMenuLayoutMode,
		focus,
	);
}

export function buildAccountListPreview(
	settings: DashboardDisplaySettings,
	ui: ReturnType<typeof getUiRuntimeOptions>,
	focus:
		| DashboardDisplaySettingKey
		| DashboardStatuslineField
		| "menuSortMode"
		| "menuLayoutMode"
		| null = null,
): { label: string; hint: string } {
	return buildAccountListPreviewBase(
		settings,
		ui,
		resolveMenuLayoutMode,
		focus,
	);
}

export function clampBackendNumber(
	option: BackendNumberSettingOption,
	value: number,
): number {
	return Math.max(option.min, Math.min(option.max, Math.round(value)));
}

export function resolveMenuLayoutMode(
	settings: DashboardDisplaySettings,
): "compact-details" | "expanded-rows" {
	if (settings.menuLayoutMode === "expanded-rows") {
		return "expanded-rows";
	}
	if (settings.menuLayoutMode === "compact-details") {
		return "compact-details";
	}
	return settings.menuShowDetailsForUnselectedRows === true
		? "expanded-rows"
		: "compact-details";
}

export async function withQueuedRetryForTests<T>(
	pathKey: string,
	task: () => Promise<T>,
): Promise<T> {
	return withQueuedRetry(pathKey, task, { sleep });
}

export async function persistDashboardSettingsSelectionForTests(
	selected: DashboardDisplaySettings,
	keys: ReadonlyArray<keyof DashboardDisplaySettings>,
	scope: string,
): Promise<DashboardDisplaySettings> {
	return persistDashboardSettingsSelection(
		selected,
		keys as readonly DashboardSettingKey[],
		scope,
	);
}

export async function persistBackendConfigSelectionForTests(
	selected: PluginConfig,
	scope: string,
): Promise<PluginConfig> {
	return persistBackendConfigSelection(selected, scope);
}
