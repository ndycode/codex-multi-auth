import type { PluginConfig } from "../types.js";
import type {
	BackendCategoryOption,
	BackendNumberSettingKey,
	BackendNumberSettingOption,
	BackendSettingFocusKey,
	BackendToggleSettingKey,
	BackendToggleSettingOption,
} from "./backend-settings-schema.js";

export async function promptBackendCategorySettingsEntry(params: {
	initial: PluginConfig;
	category: BackendCategoryOption;
	initialFocus: BackendSettingFocusKey;
	promptBackendCategorySettingsMenu: (args: {
		initial: PluginConfig;
		category: BackendCategoryOption;
		initialFocus: BackendSettingFocusKey;
		ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>;
		cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
		buildBackendSettingsPreview: (
			config: PluginConfig,
			ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
			focusKey: BackendSettingFocusKey,
			deps: {
				highlightPreviewToken: (
					text: string,
					ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
				) => string;
			},
		) => { label: string; hint: string };
		highlightPreviewToken: (
			text: string,
			ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
		) => string;
		resolveFocusedBackendNumberKey: (
			focus: BackendSettingFocusKey,
			numberOptions: BackendNumberSettingOption[],
		) => BackendNumberSettingKey;
		clampBackendNumber: (
			option: BackendNumberSettingOption,
			value: number,
		) => number;
		formatBackendNumberValue: (
			option: BackendNumberSettingOption,
			value: number,
		) => string;
		formatDashboardSettingState: (enabled: boolean) => string;
		applyBackendCategoryDefaults: (
			config: PluginConfig,
			selectedCategory: BackendCategoryOption,
		) => PluginConfig;
		getBackendCategoryInitialFocus: (
			category: BackendCategoryOption,
		) => BackendSettingFocusKey;
		backendDefaults: PluginConfig;
		toggleOptionByKey: ReadonlyMap<
			BackendToggleSettingKey,
			BackendToggleSettingOption
		>;
		numberOptionByKey: ReadonlyMap<
			BackendNumberSettingKey,
			BackendNumberSettingOption
		>;
		select: <T>(
			items: import("../ui/select.js").MenuItem<T>[],
			options: {
				message: string;
				subtitle: string;
				help: string;
				clearScreen: boolean;
				theme: ReturnType<
					typeof import("../ui/runtime.js").getUiRuntimeOptions
				>["theme"];
				selectedEmphasis: "minimal";
				initialCursor?: number;
				onCursorChange: (event: { cursor: number }) => void;
				onInput: (raw: string) => T | undefined;
			},
		) => Promise<T | null>;
		copy: {
			previewHeading: string;
			backendToggleHeading: string;
			backendNumberHeading: string;
			backendDecrease: string;
			backendIncrease: string;
			backendResetCategory: string;
			backendBackToCategories: string;
			backendCategoryTitle: string;
			backendCategoryHelp: string;
		};
	}) => Promise<{ draft: PluginConfig; focusKey: BackendSettingFocusKey }>;
	ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>;
	cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
	buildBackendSettingsPreview: (
		config: PluginConfig,
		ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
		focusKey: BackendSettingFocusKey,
		deps: {
			highlightPreviewToken: (
				text: string,
				ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
			) => string;
		},
	) => { label: string; hint: string };
	highlightPreviewToken: (
		text: string,
		ui: ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
	) => string;
	resolveFocusedBackendNumberKey: (
		focus: BackendSettingFocusKey,
		numberOptions: BackendNumberSettingOption[],
	) => BackendNumberSettingKey;
	clampBackendNumber: (
		option: BackendNumberSettingOption,
		value: number,
	) => number;
	formatBackendNumberValue: (
		option: BackendNumberSettingOption,
		value: number,
	) => string;
	formatDashboardSettingState: (enabled: boolean) => string;
	applyBackendCategoryDefaults: (
		config: PluginConfig,
		selectedCategory: BackendCategoryOption,
	) => PluginConfig;
	getBackendCategoryInitialFocus: (
		category: BackendCategoryOption,
	) => BackendSettingFocusKey;
	backendDefaults: PluginConfig;
	toggleOptionByKey: ReadonlyMap<
		BackendToggleSettingKey,
		BackendToggleSettingOption
	>;
	numberOptionByKey: ReadonlyMap<
		BackendNumberSettingKey,
		BackendNumberSettingOption
	>;
	select: <T>(
		items: import("../ui/select.js").MenuItem<T>[],
		options: {
			message: string;
			subtitle: string;
			help: string;
			clearScreen: boolean;
			theme: ReturnType<
				typeof import("../ui/runtime.js").getUiRuntimeOptions
			>["theme"];
			selectedEmphasis: "minimal";
			initialCursor?: number;
			onCursorChange: (event: { cursor: number }) => void;
			onInput: (raw: string) => T | undefined;
		},
	) => Promise<T | null>;
	copy: {
		previewHeading: string;
		backendToggleHeading: string;
		backendNumberHeading: string;
		backendDecrease: string;
		backendIncrease: string;
		backendResetCategory: string;
		backendBackToCategories: string;
		backendCategoryTitle: string;
		backendCategoryHelp: string;
	};
}): Promise<{ draft: PluginConfig; focusKey: BackendSettingFocusKey }> {
	return params.promptBackendCategorySettingsMenu({
		initial: params.initial,
		category: params.category,
		initialFocus: params.initialFocus,
		ui: params.ui,
		cloneBackendPluginConfig: params.cloneBackendPluginConfig,
		buildBackendSettingsPreview: params.buildBackendSettingsPreview,
		highlightPreviewToken: params.highlightPreviewToken,
		resolveFocusedBackendNumberKey: params.resolveFocusedBackendNumberKey,
		clampBackendNumber: params.clampBackendNumber,
		formatBackendNumberValue: params.formatBackendNumberValue,
		formatDashboardSettingState: params.formatDashboardSettingState,
		applyBackendCategoryDefaults: params.applyBackendCategoryDefaults,
		getBackendCategoryInitialFocus: params.getBackendCategoryInitialFocus,
		backendDefaults: params.backendDefaults,
		toggleOptionByKey: params.toggleOptionByKey,
		numberOptionByKey: params.numberOptionByKey,
		select: params.select,
		copy: params.copy,
	});
}
