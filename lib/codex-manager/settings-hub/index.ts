import { loadPluginConfig } from "../../config.js";
import {
	type DashboardDisplaySettings,
	loadDashboardDisplaySettings,
} from "../../dashboard-settings.js";
import { UI_COPY } from "../../ui/ui-copy.js";
import { getUiRuntimeOptions } from "../../ui/runtime.js";
import { select } from "../../ui/select.js";
import {
	backendSettingsEqual,
	clampBackendNumberForTests,
	cloneBackendPluginConfig,
} from "../backend-settings-helpers.js";
import { formatMenuLayoutMode } from "../dashboard-formatters.js";
import {
	mapExperimentalMenuHotkey,
	mapExperimentalStatusHotkey,
} from "../experimental-settings-schema.js";
import { promptSettingsHubEntry } from "../settings-hub-entry.js";
import {
	buildSettingsHubItems,
	findSettingsHubInitialCursor,
} from "../settings-hub-menu.js";
import { promptSettingsHubMenu } from "../settings-hub-prompt.js";
import { reorderStatuslineField } from "../settings-panels.js";
import { normalizeStatuslineFields } from "../settings-preview.js";
import {
	configureUnifiedSettingsController,
	type SettingsHubActionType,
} from "../unified-settings-controller.js";
import { configureUnifiedSettingsEntry } from "../unified-settings-entry.js";
import { configureBackendSettings, promptBackendSettings } from "./backend.js";
import {
	applyUiThemeFromDashboardSettings,
	BEHAVIOR_PANEL_KEYS,
	configureDashboardDisplaySettings,
	configureStatuslineSettings,
	promptBehaviorSettings,
	promptDashboardDisplaySettings,
	promptStatuslineSettings,
	promptThemeSettings,
	THEME_PANEL_KEYS,
} from "./dashboard.js";
import {
	loadExperimentalSyncTarget,
	promptExperimentalSettings,
} from "./experimental.js";
import {
	buildAccountListPreview,
	buildSummaryPreviewText,
	cloneDashboardSettings,
	dashboardSettingsEqual,
	isTtyInteractive,
	persistBackendConfigSelection,
	persistBackendConfigSelectionForTests,
	persistDashboardSettingsSelection,
	persistDashboardSettingsSelectionForTests,
	resolveMenuLayoutMode,
	type SettingsHubAction,
	withQueuedRetryForTests,
} from "./shared.js";

async function promptSettingsHub(
	initialFocus: SettingsHubAction["type"] = "account-list",
): Promise<SettingsHubAction | null> {
	return promptSettingsHubEntry({
		initialFocus,
		promptSettingsHubMenu,
		isInteractive: isTtyInteractive,
		getUiRuntimeOptions,
		buildItems: () => buildSettingsHubItems(UI_COPY.settings),
		findInitialCursor: findSettingsHubInitialCursor,
		select,
		copy: {
			title: UI_COPY.settings.title,
			subtitle: UI_COPY.settings.subtitle,
			help: UI_COPY.settings.help,
		},
	});
}

async function configureUnifiedSettings(
	initialSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	return configureUnifiedSettingsEntry(initialSettings, {
		configureUnifiedSettingsController,
		cloneDashboardSettings,
		cloneBackendPluginConfig,
		loadDashboardDisplaySettings,
		loadPluginConfig,
		applyUiThemeFromDashboardSettings,
		promptSettingsHub: async (focus) =>
			promptSettingsHub(focus as SettingsHubActionType),
		configureDashboardDisplaySettings,
		configureStatuslineSettings,
		promptBehaviorSettings,
		promptThemeSettings,
		dashboardSettingsEqual,
		persistDashboardSettingsSelection,
		promptExperimentalSettings,
		backendSettingsEqual,
		persistBackendConfigSelection,
		configureBackendSettings,
		BEHAVIOR_PANEL_KEYS,
		THEME_PANEL_KEYS,
	});
}

const __testOnly = {
	clampBackendNumber: clampBackendNumberForTests,
	formatMenuLayoutMode,
	cloneDashboardSettings,
	withQueuedRetry: withQueuedRetryForTests,
	loadExperimentalSyncTarget,
	mapExperimentalMenuHotkey,
	mapExperimentalStatusHotkey,
	promptExperimentalSettings,
	persistDashboardSettingsSelection: persistDashboardSettingsSelectionForTests,
	persistBackendConfigSelection: persistBackendConfigSelectionForTests,
	buildAccountListPreview,
	buildSummaryPreviewText,
	normalizeStatuslineFields,
	reorderField: reorderStatuslineField,
	promptDashboardDisplaySettings,
	promptStatuslineSettings,
	promptBehaviorSettings,
	promptThemeSettings,
	promptBackendSettings,
};

export {
	configureUnifiedSettings,
	applyUiThemeFromDashboardSettings,
	resolveMenuLayoutMode,
	__testOnly,
};
