import type { MenuItem } from "../ui/select.js";

export type SettingsHubMenuAction =
	| { type: "account-list" }
	| { type: "summary-fields" }
	| { type: "behavior" }
	| { type: "theme" }
	| { type: "experimental" }
	| { type: "backend" }
	| { type: "back" };

export function buildSettingsHubItems(copy: {
	sectionTitle: string;
	accountList: string;
	summaryFields: string;
	behavior: string;
	theme: string;
	advancedTitle: string;
	experimental: string;
	backend: string;
	exitTitle: string;
	back: string;
}): MenuItem<SettingsHubMenuAction>[] {
	return [
		{ label: copy.sectionTitle, value: { type: "back" }, kind: "heading" },
		{
			label: copy.accountList,
			value: { type: "account-list" },
			color: "green",
		},
		{
			label: copy.summaryFields,
			value: { type: "summary-fields" },
			color: "green",
		},
		{ label: copy.behavior, value: { type: "behavior" }, color: "green" },
		{ label: copy.theme, value: { type: "theme" }, color: "green" },
		{ label: "", value: { type: "back" }, separator: true },
		{ label: copy.advancedTitle, value: { type: "back" }, kind: "heading" },
		{
			label: copy.experimental,
			value: { type: "experimental" },
			color: "yellow",
		},
		{ label: copy.backend, value: { type: "backend" }, color: "green" },
		{ label: "", value: { type: "back" }, separator: true },
		{ label: copy.exitTitle, value: { type: "back" }, kind: "heading" },
		{ label: copy.back, value: { type: "back" }, color: "red" },
	];
}

export function findSettingsHubInitialCursor(
	items: MenuItem<SettingsHubMenuAction>[],
	initialFocus: SettingsHubMenuAction["type"],
): number | undefined {
	const index = items.findIndex((item) => {
		if (item.separator || item.disabled || item.kind === "heading")
			return false;
		return item.value.type === initialFocus;
	});
	return index >= 0 ? index : undefined;
}
