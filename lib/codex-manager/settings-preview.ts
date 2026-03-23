import { stdout as output } from "node:process";
import type {
	DashboardDisplaySettings,
	DashboardStatuslineField,
} from "../dashboard-settings.js";
import { ANSI } from "../ui/ansi.js";
import type { UiRuntimeOptions } from "../ui/runtime.js";

export const DEFAULT_STATUSLINE_FIELDS: DashboardStatuslineField[] = [
	"last-used",
	"limits",
	"status",
];

const PREVIEW_ACCOUNT_EMAIL = "demo@example.com";
const PREVIEW_LAST_USED = "today";
const PREVIEW_STATUS = "active";
const PREVIEW_LIMITS = "5h ██████▒▒▒▒ 62% | 7d █████▒▒▒▒▒ 49%";
const PREVIEW_LIMIT_COOLDOWNS = "5h reset 1h 20m | 7d reset 2d 04h";

export type PreviewFocusKey =
	| DashboardStatuslineField
	| "menuShowStatusBadge"
	| "menuShowCurrentBadge"
	| "menuShowLastUsed"
	| "menuShowQuotaSummary"
	| "menuShowQuotaCooldown"
	| "menuShowFetchStatus"
	| "menuShowDetailsForUnselectedRows"
	| "menuHighlightCurrentRow"
	| "menuSortEnabled"
	| "menuSortPinCurrent"
	| "menuSortQuickSwitchVisibleRow"
	| "menuSortMode"
	| "menuLayoutMode"
	| null;

export function highlightPreviewToken(
	text: string,
	ui: UiRuntimeOptions,
): string {
	if (!output.isTTY) return text;
	if (ui.v2Enabled) {
		return `${ui.theme.colors.accent}${ANSI.bold}${text}${ui.theme.colors.reset}`;
	}
	return `${ANSI.cyan}${ANSI.bold}${text}${ANSI.reset}`;
}

function isLastUsedPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowLastUsed" || focus === "last-used";
}

function isLimitsPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowQuotaSummary" || focus === "limits";
}

function isLimitsCooldownPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowQuotaCooldown";
}

function isStatusPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowStatusBadge" || focus === "status";
}

function isCurrentBadgePreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowCurrentBadge";
}

function isCurrentRowPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuHighlightCurrentRow";
}

function isExpandedRowsPreviewFocus(focus: PreviewFocusKey): boolean {
	return (
		focus === "menuShowDetailsForUnselectedRows" || focus === "menuLayoutMode"
	);
}

export function normalizeStatuslineFields(
	fields: DashboardStatuslineField[] | undefined,
): DashboardStatuslineField[] {
	const source = fields ?? DEFAULT_STATUSLINE_FIELDS;
	const seen = new Set<DashboardStatuslineField>();
	const normalized: DashboardStatuslineField[] = [];
	for (const field of source) {
		if (seen.has(field)) continue;
		seen.add(field);
		normalized.push(field);
	}
	if (normalized.length === 0) {
		return [...DEFAULT_STATUSLINE_FIELDS];
	}
	return normalized;
}

export function buildSummaryPreviewText(
	settings: DashboardDisplaySettings,
	ui: UiRuntimeOptions,
	resolveMenuLayoutMode: (
		settings: DashboardDisplaySettings,
	) => "compact-details" | "expanded-rows",
	focus: PreviewFocusKey = null,
): string {
	const partsByField = new Map<DashboardStatuslineField, string>();
	if (settings.menuShowLastUsed !== false) {
		const part = `last used: ${PREVIEW_LAST_USED}`;
		partsByField.set(
			"last-used",
			isLastUsedPreviewFocus(focus) ? highlightPreviewToken(part, ui) : part,
		);
	}
	if (settings.menuShowQuotaSummary !== false) {
		const limitsText =
			settings.menuShowQuotaCooldown === false
				? PREVIEW_LIMITS
				: `${PREVIEW_LIMITS} | ${PREVIEW_LIMIT_COOLDOWNS}`;
		const part = `limits: ${limitsText}`;
		partsByField.set(
			"limits",
			isLimitsPreviewFocus(focus) || isLimitsCooldownPreviewFocus(focus)
				? highlightPreviewToken(part, ui)
				: part,
		);
	}
	if (settings.menuShowStatusBadge === false) {
		const part = `status: ${PREVIEW_STATUS}`;
		partsByField.set(
			"status",
			isStatusPreviewFocus(focus) ? highlightPreviewToken(part, ui) : part,
		);
	}

	const orderedParts = normalizeStatuslineFields(settings.menuStatuslineFields)
		.map((field) => partsByField.get(field))
		.filter(
			(part): part is string => typeof part === "string" && part.length > 0,
		);
	if (orderedParts.length > 0) {
		return orderedParts.join(" | ");
	}

	const showsStatusField = normalizeStatuslineFields(
		settings.menuStatuslineFields,
	).includes("status");
	if (showsStatusField && settings.menuShowStatusBadge !== false) {
		const note = "status text appears only when status badges are hidden";
		return isStatusPreviewFocus(focus) ? highlightPreviewToken(note, ui) : note;
	}
	return "no summary text is visible with current account-list settings";
}

export function buildAccountListPreview(
	settings: DashboardDisplaySettings,
	ui: UiRuntimeOptions,
	resolveMenuLayoutMode: (
		settings: DashboardDisplaySettings,
	) => "compact-details" | "expanded-rows",
	focus: PreviewFocusKey = null,
): { label: string; hint: string } {
	const badges: string[] = [];
	if (settings.menuShowCurrentBadge !== false) {
		const currentBadge = "[current]";
		badges.push(
			isCurrentBadgePreviewFocus(focus)
				? highlightPreviewToken(currentBadge, ui)
				: currentBadge,
		);
	}
	if (settings.menuShowStatusBadge !== false) {
		const statusBadge = "[active]";
		badges.push(
			isStatusPreviewFocus(focus)
				? highlightPreviewToken(statusBadge, ui)
				: statusBadge,
		);
	}
	const badgeSuffix = badges.length > 0 ? ` ${badges.join(" ")}` : "";
	const accountEmail = isCurrentRowPreviewFocus(focus)
		? highlightPreviewToken(PREVIEW_ACCOUNT_EMAIL, ui)
		: PREVIEW_ACCOUNT_EMAIL;
	const rowDetailMode =
		resolveMenuLayoutMode(settings) === "expanded-rows"
			? "details shown on all rows"
			: "details shown on selected row only";
	const detailModeText = isExpandedRowsPreviewFocus(focus)
		? highlightPreviewToken(rowDetailMode, ui)
		: rowDetailMode;
	return {
		label: `1. ${accountEmail}${badgeSuffix}`,
		hint: `${buildSummaryPreviewText(settings, ui, resolveMenuLayoutMode, focus)}\n${detailModeText}`,
	};
}
