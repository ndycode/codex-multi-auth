import type { MenuItem, SelectOptions } from "../ui/select.js";
import type { SettingsHubActionType } from "./unified-settings-controller.js";

export async function promptSettingsHubEntry<
	TAction extends { type: SettingsHubActionType },
>(params: {
	initialFocus: TAction["type"];
	promptSettingsHubMenu: (
		initialFocus: TAction["type"],
		deps: {
			isInteractive: () => boolean;
			getUiRuntimeOptions: () => ReturnType<
				typeof import("../ui/runtime.js").getUiRuntimeOptions
			>;
			buildItems: () => MenuItem<TAction>[];
			findInitialCursor: (
				items: MenuItem<TAction>[],
				initialFocus: TAction["type"],
			) => number | undefined;
			select: <T>(
				items: MenuItem<T>[],
				options: SelectOptions<T>,
			) => Promise<T | null>;
			copy: {
				title: string;
				subtitle: string;
				help: string;
			};
		},
	) => Promise<TAction | null>;
	isInteractive: () => boolean;
	getUiRuntimeOptions: () => ReturnType<
		typeof import("../ui/runtime.js").getUiRuntimeOptions
	>;
	buildItems: () => MenuItem<TAction>[];
	findInitialCursor: (
		items: MenuItem<TAction>[],
		initialFocus: TAction["type"],
	) => number | undefined;
	select: <T>(
		items: MenuItem<T>[],
		options: SelectOptions<T>,
	) => Promise<T | null>;
	copy: {
		title: string;
		subtitle: string;
		help: string;
	};
}): Promise<TAction | null> {
	return params.promptSettingsHubMenu(params.initialFocus, {
		isInteractive: params.isInteractive,
		getUiRuntimeOptions: params.getUiRuntimeOptions,
		buildItems: params.buildItems,
		findInitialCursor: params.findInitialCursor,
		select: params.select,
		copy: params.copy,
	});
}
