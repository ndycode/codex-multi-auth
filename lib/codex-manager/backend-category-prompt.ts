import type { PluginConfig } from "../types.js";
import type { UiRuntimeOptions } from "../ui/runtime.js";
import type { MenuItem } from "../ui/select.js";
import type {
	BackendCategoryConfigAction,
	BackendCategoryOption,
	BackendNumberSettingKey,
	BackendNumberSettingOption,
	BackendSettingFocusKey,
	BackendToggleSettingKey,
	BackendToggleSettingOption,
} from "./backend-settings-schema.js";

export async function promptBackendCategorySettingsMenu(params: {
	initial: PluginConfig;
	category: BackendCategoryOption;
	initialFocus: BackendSettingFocusKey;
	ui: UiRuntimeOptions;
	cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
	buildBackendSettingsPreview: (
		config: PluginConfig,
		ui: UiRuntimeOptions,
		focusKey: BackendSettingFocusKey,
		deps: {
			highlightPreviewToken: (text: string, ui: UiRuntimeOptions) => string;
		},
	) => { label: string; hint: string };
	highlightPreviewToken: (text: string, ui: UiRuntimeOptions) => string;
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
		category: BackendCategoryOption,
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
	const {
		initial,
		category,
		initialFocus,
		ui,
		cloneBackendPluginConfig,
		buildBackendSettingsPreview,
		highlightPreviewToken,
		resolveFocusedBackendNumberKey,
		clampBackendNumber,
		formatBackendNumberValue,
		formatDashboardSettingState,
		applyBackendCategoryDefaults,
		getBackendCategoryInitialFocus,
		backendDefaults,
		toggleOptionByKey,
		numberOptionByKey,
		select,
		copy,
	} = params;

	let draft = cloneBackendPluginConfig(initial);
	let focusKey: BackendSettingFocusKey = initialFocus;
	if (
		!focusKey ||
		(!category.toggleKeys.includes(focusKey as BackendToggleSettingKey) &&
			!category.numberKeys.includes(focusKey as BackendNumberSettingKey))
	) {
		focusKey = getBackendCategoryInitialFocus(category);
	}

	const toggleOptions = category.toggleKeys
		.map((key) => toggleOptionByKey.get(key))
		.filter((option): option is BackendToggleSettingOption => !!option);
	const numberOptions = category.numberKeys
		.map((key) => numberOptionByKey.get(key))
		.filter((option): option is BackendNumberSettingOption => !!option);

	while (true) {
		const preview = buildBackendSettingsPreview(draft, ui, focusKey, {
			highlightPreviewToken,
		});
		const toggleItems: MenuItem<BackendCategoryConfigAction>[] =
			toggleOptions.map((option, index) => {
				const enabled =
					draft[option.key] ?? backendDefaults[option.key] ?? false;
				return {
					label: `${formatDashboardSettingState(enabled)} ${index + 1}. ${option.label}`,
					hint: option.description,
					value: { type: "toggle", key: option.key },
					color: enabled ? "green" : "yellow",
				};
			});
		const numberItems: MenuItem<BackendCategoryConfigAction>[] =
			numberOptions.map((option) => {
				const rawValue =
					draft[option.key] ?? backendDefaults[option.key] ?? option.min;
				const numericValue =
					typeof rawValue === "number" && Number.isFinite(rawValue)
						? rawValue
						: option.min;
				const clampedValue = clampBackendNumber(option, numericValue);
				const valueLabel = formatBackendNumberValue(option, clampedValue);
				return {
					label: `${option.label}: ${valueLabel}`,
					hint: `${option.description} Step ${formatBackendNumberValue(option, option.step)}.`,
					value: { type: "bump", key: option.key, direction: 1 },
					color: "yellow",
				};
			});

		const focusedNumberKey = resolveFocusedBackendNumberKey(
			focusKey,
			numberOptions,
		);
		const items: MenuItem<BackendCategoryConfigAction>[] = [
			{ label: copy.previewHeading, value: { type: "back" }, kind: "heading" },
			{
				label: preview.label,
				hint: preview.hint,
				value: { type: "back" },
				disabled: true,
				color: "green",
				hideUnavailableSuffix: true,
			},
			{ label: "", value: { type: "back" }, separator: true },
			{
				label: copy.backendToggleHeading,
				value: { type: "back" },
				kind: "heading",
			},
			...toggleItems,
			{ label: "", value: { type: "back" }, separator: true },
			{
				label: copy.backendNumberHeading,
				value: { type: "back" },
				kind: "heading",
			},
			...numberItems,
		];

		if (numberOptions.length > 0) {
			items.push({ label: "", value: { type: "back" }, separator: true });
			items.push({
				label: copy.backendDecrease,
				value: { type: "bump", key: focusedNumberKey, direction: -1 },
				color: "yellow",
			});
			items.push({
				label: copy.backendIncrease,
				value: { type: "bump", key: focusedNumberKey, direction: 1 },
				color: "green",
			});
		}

		items.push({ label: "", value: { type: "back" }, separator: true });
		items.push({
			label: copy.backendResetCategory,
			value: { type: "reset-category" },
			color: "yellow",
		});
		items.push({
			label: copy.backendBackToCategories,
			value: { type: "back" },
			color: "red",
		});

		const initialCursor = items.findIndex((item) => {
			if (item.separator || item.disabled || item.kind === "heading")
				return false;
			if (item.value.type === "toggle" && focusKey === item.value.key)
				return true;
			if (item.value.type === "bump" && focusKey === item.value.key)
				return true;
			return false;
		});

		const result = await select(items, {
			message: `${copy.backendCategoryTitle}: ${category.label}`,
			subtitle: category.description,
			help: copy.backendCategoryHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const focusedItem = items[cursor];
				if (
					focusedItem?.value.type === "toggle" ||
					focusedItem?.value.type === "bump"
				) {
					focusKey = focusedItem.value.key;
				}
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "back" as const };
				if (lower === "r") return { type: "reset-category" as const };
				if (
					numberOptions.length > 0 &&
					(lower === "+" || lower === "=" || lower === "]" || lower === "d")
				) {
					return {
						type: "bump" as const,
						key: resolveFocusedBackendNumberKey(focusKey, numberOptions),
						direction: 1 as const,
					};
				}
				if (
					numberOptions.length > 0 &&
					(lower === "-" || lower === "[" || lower === "a")
				) {
					return {
						type: "bump" as const,
						key: resolveFocusedBackendNumberKey(focusKey, numberOptions),
						direction: -1 as const,
					};
				}
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= toggleOptions.length
				) {
					const target = toggleOptions[parsed - 1];
					if (target) return { type: "toggle" as const, key: target.key };
				}
				return undefined;
			},
		});

		if (!result || result.type === "back") {
			return { draft, focusKey };
		}
		if (result.type === "reset-category") {
			draft = applyBackendCategoryDefaults(draft, category);
			focusKey = getBackendCategoryInitialFocus(category);
			continue;
		}
		if (result.type === "toggle") {
			const currentValue =
				draft[result.key] ?? backendDefaults[result.key] ?? false;
			draft = { ...draft, [result.key]: !currentValue };
			focusKey = result.key;
			continue;
		}

		const option = numberOptionByKey.get(result.key);
		if (!option) continue;
		const currentValue =
			draft[result.key] ?? backendDefaults[result.key] ?? option.min;
		const numericCurrent =
			typeof currentValue === "number" && Number.isFinite(currentValue)
				? currentValue
				: option.min;
		draft = {
			...draft,
			[result.key]: clampBackendNumber(
				option,
				numericCurrent + option.step * result.direction,
			),
		};
		focusKey = result.key;
	}
}
