import { createElement, useMemo, useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import { UI_COPY } from "../ui/copy.js";
import type {
	AuthAccountViewModel,
	AuthDashboardActionViewModel,
	AuthDashboardSectionId,
	AuthDashboardViewModel,
} from "../codex-manager/auth-ui-controller.js";
import {
	InkShellFrame,
	InkShellPanel,
	InkShellRow,
	InkShellSectionTab,
	createInkShellTheme,
	type InkShellTone,
} from "./layout.js";

export interface AuthInkShellEntry {
	id: string;
	label: string;
	detail?: string;
	tone: InkShellTone;
	kind: "action" | "account";
}

export interface AuthInkShellFocusState {
	sectionIndex: number;
	entryIndex: number;
}

export type AuthInkShellFocusAction =
	| { type: "move-section"; direction: 1 | -1 }
	| { type: "move-entry"; direction: 1 | -1 }
	| { type: "reset" };

function mapActionTone(action: AuthDashboardActionViewModel): InkShellTone {
	switch (action.tone) {
		case "red":
			return "danger";
		case "yellow":
			return "warning";
		default:
			return "success";
	}
}

function formatAccountDetail(account: AuthAccountViewModel): string | undefined {
	const parts: string[] = [];
	if (account.isCurrentAccount) parts.push("current");
	if (account.status) parts.push(`status ${account.status}`);
	if (account.quotaSummary) parts.push(account.quotaSummary);
	return parts.length > 0 ? parts.join(" | ") : undefined;
}

function toneForAccount(account: AuthAccountViewModel): InkShellTone {
	switch (account.status) {
		case "active":
		case "ok":
			return "success";
		case "rate-limited":
		case "cooldown":
			return "warning";
		case "disabled":
		case "error":
		case "flagged":
			return "danger";
		default:
			return "muted";
	}
}

function entriesForSection(
	dashboard: AuthDashboardViewModel,
	sectionId: AuthDashboardSectionId,
): AuthInkShellEntry[] {
	if (sectionId === "saved-accounts") {
		return dashboard.accounts.map((account, index) => ({
			id: `account:${account.sourceIndex ?? index}`,
			label: account.email ?? account.accountLabel ?? account.accountId ?? `Account ${index + 1}`,
			detail: formatAccountDetail(account),
			tone: toneForAccount(account),
			kind: "account",
		}));
	}

	const section = dashboard.sections.find((candidate) => candidate.id === sectionId);
	return (section?.actions ?? []).map((action) => ({
		id: `action:${action.id}`,
		label: action.label,
		tone: mapActionTone(action),
		kind: "action",
	}));
}

function normalizeFocus(
	dashboard: AuthDashboardViewModel,
	focus: AuthInkShellFocusState,
): AuthInkShellFocusState {
	const sectionCount = dashboard.sections.length;
	if (sectionCount === 0) {
		return { sectionIndex: 0, entryIndex: 0 };
	}
	const sectionIndex = Math.max(0, Math.min(focus.sectionIndex, sectionCount - 1));
	const section = dashboard.sections[sectionIndex];
	const entries = section ? entriesForSection(dashboard, section.id) : [];
	const entryIndex = entries.length === 0 ? 0 : Math.max(0, Math.min(focus.entryIndex, entries.length - 1));
	return { sectionIndex, entryIndex };
}

export function createAuthInkShellFocusState(
	dashboard: AuthDashboardViewModel,
): AuthInkShellFocusState {
	return normalizeFocus(dashboard, { sectionIndex: 0, entryIndex: 0 });
}

export function reduceAuthInkShellFocus(
	dashboard: AuthDashboardViewModel,
	focus: AuthInkShellFocusState,
	action: AuthInkShellFocusAction,
): AuthInkShellFocusState {
	const normalized = normalizeFocus(dashboard, focus);
	const sectionCount = dashboard.sections.length;
	if (sectionCount === 0) return normalized;
	const currentSection = dashboard.sections[normalized.sectionIndex];
	const currentEntries = currentSection ? entriesForSection(dashboard, currentSection.id) : [];

	switch (action.type) {
		case "reset":
			return createAuthInkShellFocusState(dashboard);
		case "move-section": {
			const sectionIndex = (normalized.sectionIndex + action.direction + sectionCount) % sectionCount;
			return normalizeFocus(dashboard, { sectionIndex, entryIndex: 0 });
		}
		case "move-entry": {
			if (currentEntries.length === 0) return normalized;
			const entryIndex = (normalized.entryIndex + action.direction + currentEntries.length) % currentEntries.length;
			return normalizeFocus(dashboard, { sectionIndex: normalized.sectionIndex, entryIndex });
		}
	}
	return normalized;
}

function resolveStatusText(dashboard: AuthDashboardViewModel, explicitStatus?: string): string | undefined {
	if (explicitStatus && explicitStatus.trim().length > 0) return explicitStatus.trim();
	const raw = dashboard.menuOptions.statusMessage;
	if (typeof raw === "function") {
		const resolved = raw();
		return typeof resolved === "string" && resolved.trim().length > 0 ? resolved.trim() : undefined;
	}
	if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
	return dashboard.accounts.length > 0 ? `${dashboard.accounts.length} saved account(s)` : undefined;
}

function resolveStatusTone(dashboard: AuthDashboardViewModel): InkShellTone {
	return (dashboard.menuOptions.flaggedCount ?? 0) > 0 ? "warning" : "accent";
}

function focusActionFromInput(input: string, key: Key): AuthInkShellFocusAction | null {
	if (key.leftArrow || (key.shift && key.tab)) {
		return { type: "move-section", direction: -1 };
	}
	if (key.rightArrow || key.tab) {
		return { type: "move-section", direction: 1 };
	}
	if (key.upArrow) {
		return { type: "move-entry", direction: -1 };
	}
	if (key.downArrow) {
		return { type: "move-entry", direction: 1 };
	}
	if (input.toLowerCase() === "r") {
		return { type: "reset" };
	}
	return null;
}

export interface AuthInkShellProps {
	dashboard: AuthDashboardViewModel;
	title?: string;
	subtitle?: string;
	statusText?: string;
	footerText?: string;
}

export function AuthInkShell(props: AuthInkShellProps) {
	const theme = createInkShellTheme();
	const [focus, setFocus] = useState<AuthInkShellFocusState>(() => createAuthInkShellFocusState(props.dashboard));
	const normalizedFocus = useMemo(() => normalizeFocus(props.dashboard, focus), [focus, props.dashboard]);
	const activeSection = props.dashboard.sections[normalizedFocus.sectionIndex];
	const activeEntries = activeSection ? entriesForSection(props.dashboard, activeSection.id) : [];

	useInput((input, key) => {
		const action = focusActionFromInput(input, key);
		if (!action) return;
		setFocus((current) => reduceAuthInkShellFocus(props.dashboard, current, action));
	});

	return createElement(
		InkShellFrame,
		{
			title: props.title ?? UI_COPY.mainMenu.title,
			subtitle: props.subtitle ?? "Ink auth shell foundation for dashboard and settings migration",
			status: resolveStatusText(props.dashboard, props.statusText),
			statusTone: resolveStatusTone(props.dashboard),
			footer: props.footerText ?? "Left/Right switch sections | Up/Down move focus | R reset focus",
			theme,
		},
		createElement(
			Box,
			{ marginBottom: 1, flexDirection: "row", columnGap: 1 },
			...props.dashboard.sections.map((section, index) =>
				createElement(InkShellSectionTab, {
					key: section.id,
					label: section.title,
					active: index === normalizedFocus.sectionIndex,
					tone: section.id === "danger-zone" ? "danger" : section.id === "advanced-checks" ? "warning" : "accent",
					theme,
				}),
			),
		),
		createElement(
			InkShellPanel,
			{ title: activeSection?.title ?? UI_COPY.mainMenu.title, theme },
			activeEntries.length > 0
				? createElement(
					Box,
					{ flexDirection: "column" },
					...activeEntries.map((entry, index) =>
						createElement(InkShellRow, {
							key: entry.id,
							label: entry.label,
							detail: entry.detail,
							active: index === normalizedFocus.entryIndex,
							tone: entry.tone,
							theme,
						}),
					),
				)
				: createElement(Text, { color: theme.mutedColor }, "No items yet"),
		),
	);
}
