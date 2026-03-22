import type { PluginConfig } from "../types.js";
import type { UiRuntimeOptions } from "../ui/runtime.js";
import type { MenuItem } from "../ui/select.js";
import type {
	BackendCategoryKey,
	BackendCategoryOption,
	BackendSettingFocusKey,
	BackendSettingsHubAction,
} from "./backend-settings-schema.js";

export async function promptBackendSettingsMenu(params: {
	initial: PluginConfig;
	isInteractive: () => boolean;
	ui: UiRuntimeOptions;
	cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
	backendCategoryOptions: readonly BackendCategoryOption[];
	getBackendCategoryInitialFocus: (
		category: BackendCategoryOption,
	) => BackendSettingFocusKey;
	buildBackendSettingsPreview: (
		config: PluginConfig,
		ui: UiRuntimeOptions,
		focus: BackendSettingFocusKey,
		deps: {
			highlightPreviewToken: (text: string, ui: UiRuntimeOptions) => string;
		},
	) => { label: string; hint: string };
	highlightPreviewToken: (text: string, ui: UiRuntimeOptions) => string;
	select: <T>(
		items: MenuItem<T>[],
		options: {
			message: string;
			subtitle: string;
			help: string;
			clearScreen: boolean;
			theme: UiRuntimeOptions["theme"];
			selectedEmphasis: "minimal";
			initialCursor?: number;
			onCursorChange: (event: { cursor: number }) => void;
			onInput: (raw: string) => T | undefined;
		},
	) => Promise<T | null>;
	getBackendCategory: (
		key: BackendCategoryKey,
		categories: readonly BackendCategoryOption[],
	) => BackendCategoryOption | null;
	promptBackendCategorySettings: (
		initial: PluginConfig,
		category: BackendCategoryOption,
		focus: BackendSettingFocusKey,
	) => Promise<{ draft: PluginConfig; focusKey: BackendSettingFocusKey }>;
	backendDefaults: PluginConfig;
	copy: {
		previewHeading: string;
		backendCategoriesHeading: string;
		resetDefault: string;
		saveAndBack: string;
		backNoSave: string;
		backendTitle: string;
		backendSubtitle: string;
		backendHelp: string;
	};
}): Promise<PluginConfig | null> {
	if (!params.isInteractive()) return null;

	let draft = params.cloneBackendPluginConfig(params.initial);
	let activeCategory = params.backendCategoryOptions[0]?.key ?? "session-sync";
	const focusByCategory: Partial<
		Record<BackendCategoryKey, BackendSettingFocusKey>
	> = {};
	for (const category of params.backendCategoryOptions) {
		focusByCategory[category.key] =
			params.getBackendCategoryInitialFocus(category);
	}

	while (true) {
		const previewFocus = focusByCategory[activeCategory] ?? null;
		const preview = params.buildBackendSettingsPreview(
			draft,
			params.ui,
			previewFocus,
			{
				highlightPreviewToken: params.highlightPreviewToken,
			},
		);
		const categoryItems: MenuItem<BackendSettingsHubAction>[] =
			params.backendCategoryOptions.map((category, index) => ({
				label: `${index + 1}. ${category.label}`,
				hint: category.description,
				value: { type: "open-category", key: category.key },
				color: "green",
			}));

		const items: MenuItem<BackendSettingsHubAction>[] = [
			{
				label: params.copy.previewHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			{
				label: preview.label,
				hint: preview.hint,
				value: { type: "cancel" },
				disabled: true,
				color: "green",
				hideUnavailableSuffix: true,
			},
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: params.copy.backendCategoriesHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			...categoryItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: params.copy.resetDefault,
				value: { type: "reset" },
				color: "yellow",
			},
			{
				label: params.copy.saveAndBack,
				value: { type: "save" },
				color: "green",
			},
			{
				label: params.copy.backNoSave,
				value: { type: "cancel" },
				color: "red",
			},
		];

		const initialCursor = items.findIndex((item) => {
			if (item.separator || item.disabled || item.kind === "heading")
				return false;
			return (
				item.value.type === "open-category" && item.value.key === activeCategory
			);
		});

		const result = await params.select(items, {
			message: params.copy.backendTitle,
			subtitle: params.copy.backendSubtitle,
			help: params.copy.backendHelp,
			clearScreen: true,
			theme: params.ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const focusedItem = items[cursor];
				if (focusedItem?.value.type === "open-category") {
					activeCategory = focusedItem.value.key;
				}
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "cancel" as const };
				if (lower === "s") return { type: "save" as const };
				if (lower === "r") return { type: "reset" as const };
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= params.backendCategoryOptions.length
				) {
					const target = params.backendCategoryOptions[parsed - 1];
					if (target)
						return { type: "open-category" as const, key: target.key };
				}
				return undefined;
			},
		});

		if (!result || result.type === "cancel") return null;
		if (result.type === "save") return draft;
		if (result.type === "reset") {
			draft = params.cloneBackendPluginConfig(params.backendDefaults);
			for (const category of params.backendCategoryOptions) {
				focusByCategory[category.key] =
					params.getBackendCategoryInitialFocus(category);
			}
			activeCategory = params.backendCategoryOptions[0]?.key ?? activeCategory;
			continue;
		}

		const category = params.getBackendCategory(
			result.key,
			params.backendCategoryOptions,
		);
		if (!category) continue;
		activeCategory = category.key;
		const categoryResult = await params.promptBackendCategorySettings(
			draft,
			category,
			focusByCategory[category.key] ??
				params.getBackendCategoryInitialFocus(category),
		);
		draft = categoryResult.draft;
		focusByCategory[category.key] = categoryResult.focusKey;
	}
}
