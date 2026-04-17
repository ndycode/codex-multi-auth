import { loadPluginConfig } from "../../config.js";
import type { PluginConfig } from "../../types.js";
import { UI_COPY } from "../../ui/copy.js";
import { getUiRuntimeOptions } from "../../ui/runtime.js";
import { select } from "../../ui/select.js";
import { promptBackendCategorySettingsEntry } from "../backend-category-entry.js";
import {
	applyBackendCategoryDefaults,
	getBackendCategory,
	getBackendCategoryInitialFocus,
	resolveFocusedBackendNumberKey,
} from "../backend-category-helpers.js";
import { promptBackendCategorySettingsMenu } from "../backend-category-prompt.js";
import { configureBackendSettingsController } from "../backend-settings-controller.js";
import { configureBackendSettingsEntry } from "../backend-settings-entry.js";
import {
	backendSettingsEqual,
	buildBackendSettingsPreview,
	cloneBackendPluginConfig,
	formatBackendNumberValue,
} from "../backend-settings-helpers.js";
import { promptBackendSettingsMenu } from "../backend-settings-prompt.js";
import {
	BACKEND_CATEGORY_OPTIONS,
	BACKEND_DEFAULTS,
	BACKEND_NUMBER_OPTION_BY_KEY,
	BACKEND_TOGGLE_OPTION_BY_KEY,
	type BackendCategoryOption,
	type BackendSettingFocusKey,
} from "../backend-settings-schema.js";
import { formatDashboardSettingState } from "../dashboard-formatters.js";
import { highlightPreviewToken } from "../settings-preview.js";
import {
	clampBackendNumber,
	isTtyInteractive,
	persistBackendConfigSelection,
} from "./shared.js";

/* c8 ignore start - interactive prompt flows are covered by integration tests */
export async function promptBackendCategorySettings(
	initial: PluginConfig,
	category: BackendCategoryOption,
	initialFocus: BackendSettingFocusKey,
): Promise<{ draft: PluginConfig; focusKey: BackendSettingFocusKey }> {
	return promptBackendCategorySettingsEntry({
		initial,
		category,
		initialFocus,
		promptBackendCategorySettingsMenu,
		ui: getUiRuntimeOptions(),
		cloneBackendPluginConfig,
		buildBackendSettingsPreview,
		highlightPreviewToken,
		resolveFocusedBackendNumberKey,
		clampBackendNumber,
		formatBackendNumberValue,
		formatDashboardSettingState,
		applyBackendCategoryDefaults: (config, selectedCategory) =>
			applyBackendCategoryDefaults(config, selectedCategory, {
				backendDefaults: BACKEND_DEFAULTS,
				numberOptionByKey: BACKEND_NUMBER_OPTION_BY_KEY,
			}),
		getBackendCategoryInitialFocus,
		backendDefaults: BACKEND_DEFAULTS,
		toggleOptionByKey: BACKEND_TOGGLE_OPTION_BY_KEY,
		numberOptionByKey: BACKEND_NUMBER_OPTION_BY_KEY,
		select,
		copy: UI_COPY.settings,
	});
}

export async function promptBackendSettings(
	initial: PluginConfig,
): Promise<PluginConfig | null> {
	const interactive = isTtyInteractive();
	if (!interactive) {
		return null;
	}

	return promptBackendSettingsMenu({
		initial,
		isInteractive: () => interactive,
		ui: getUiRuntimeOptions(),
		cloneBackendPluginConfig,
		backendCategoryOptions: BACKEND_CATEGORY_OPTIONS,
		getBackendCategoryInitialFocus,
		buildBackendSettingsPreview,
		highlightPreviewToken,
		select,
		getBackendCategory,
		promptBackendCategorySettings,
		backendDefaults: BACKEND_DEFAULTS,
		copy: UI_COPY.settings,
	});
}

export async function configureBackendSettings(
	currentConfig?: PluginConfig,
): Promise<PluginConfig> {
	return configureBackendSettingsEntry(currentConfig, {
		configureBackendSettingsController,
		cloneBackendPluginConfig,
		loadPluginConfig,
		promptBackendSettings,
		backendSettingsEqual,
		persistBackendConfigSelection,
		isInteractive: isTtyInteractive,
		writeLine: (message) => {
			console.log(message);
		},
	});
}
/* c8 ignore stop */
