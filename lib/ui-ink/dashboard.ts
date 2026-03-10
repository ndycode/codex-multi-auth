import { createElement, useEffect, useMemo, useState } from "react";
import { createInterface } from "node:readline/promises";
import { Box, Text, render, useApp, useInput, type Instance, type RenderOptions } from "ink";
import type { LoginMenuResult } from "../cli.js";
import type {
	AuthAccountViewModel,
	AuthDashboardActionViewModel,
	AuthDashboardSectionId,
	AuthDashboardViewModel,
} from "../codex-manager/auth-ui-controller.js";
import { UI_COPY } from "../ui/copy.js";
import {
	InkShellFrame,
	InkShellPanel,
	InkShellRow,
	InkShellSectionTab,
	createInkShellTheme,
	type InkShellTone,
} from "./layout.js";
import {
	resolveInkAuthShellBootstrap,
	type InkAuthShellEnvironment,
} from "./bootstrap.js";
import {
	promptInkAccountDetails,
	promptInkConfirmAccountDelete,
	promptInkConfirmAccountRefresh,
	promptInkConfirmDeleteAll,
} from "./detail-flows.js";

interface AuthInkDashboardEntry {
	id: string;
	label: string;
	detail?: string;
	tone: InkShellTone;
	kind: "action" | "account";
	actionId?: AuthDashboardActionViewModel["id"];
	account?: AuthAccountViewModel;
}

interface AuthInkDashboardFocusState {
	sectionIndex: number;
	entryIndex: number;
}

type AuthInkDashboardOutcome =
	| { type: "menu-result"; result: LoginMenuResult }
	| { type: "saved-account"; account: AuthAccountViewModel };

interface AuthInkDashboardResolution {
	result: LoginMenuResult | null;
	statusText?: string;
	statusTone?: InkShellTone;
}

export interface PromptInkAuthDashboardOptions extends InkAuthShellEnvironment {
	dashboard: AuthDashboardViewModel;
	statusTextOverride?: string;
	statusToneOverride?: InkShellTone;
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	stderr?: NodeJS.WriteStream;
	debug?: boolean;
	patchConsole?: boolean;
	exitOnCtrlC?: boolean;
}

function resolveCliVersionLabel(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = (env.CODEX_MULTI_AUTH_CLI_VERSION ?? "").trim();
	if (raw.length === 0) return null;
	return raw.startsWith("v") ? raw : `v${raw}`;
}

function resolveDashboardTitle(env: NodeJS.ProcessEnv = process.env): string {
	const versionLabel = resolveCliVersionLabel(env);
	if (!versionLabel) return UI_COPY.mainMenu.title;
	return `${UI_COPY.mainMenu.title} (${versionLabel})`;
}

function formatRelativeTime(timestamp: number | undefined): string {
	if (!timestamp) return "never";
	const days = Math.floor((Date.now() - timestamp) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return new Date(timestamp).toLocaleDateString();
}

function sanitizeTerminalText(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const ansiPattern = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "g");
	const controlPattern = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
	return value
		.replace(ansiPattern, "")
		.replace(controlPattern, "")
		.trim();
}

function actionTone(action: AuthDashboardActionViewModel): InkShellTone {
	switch (action.tone) {
		case "red":
			return "danger";
		case "yellow":
			return "warning";
		default:
			return "success";
	}
}

function accountTone(account: AuthAccountViewModel): InkShellTone {
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

function formatAccountLabel(account: AuthAccountViewModel, displayIndex: number): string {
	const number = account.quickSwitchNumber ?? (displayIndex + 1);
	const base =
		sanitizeTerminalText(account.email) ??
		sanitizeTerminalText(account.accountLabel) ??
		sanitizeTerminalText(account.accountId) ??
		`Account ${number}`;
	return `${number}. ${base}`;
}

function formatAccountDetail(account: AuthAccountViewModel): string | undefined {
	const parts: string[] = [];
	if (account.isCurrentAccount) parts.push("current");
	if (account.status) parts.push(`status ${account.status}`);
	if (account.showLastUsed !== false) {
		parts.push(`last used ${formatRelativeTime(account.lastUsed)}`);
	}
	if (account.quotaSummary) {
		const sanitizedQuota = sanitizeTerminalText(account.quotaSummary);
		if (sanitizedQuota) {
			parts.push(sanitizedQuota);
		}
	}
	return parts.length > 0 ? parts.join(" | ") : undefined;
}

export function filterAuthInkDashboardAccounts(
	dashboard: AuthDashboardViewModel,
	searchQuery: string,
): AuthAccountViewModel[] {
	const normalized = searchQuery.trim().toLowerCase();
	if (normalized.length === 0) return dashboard.accounts;
	return dashboard.accounts.filter((account) => {
		const candidates = [
			account.email,
			account.accountLabel,
			account.accountId,
			String(account.quickSwitchNumber ?? (account.index + 1)),
		];
		return candidates.some((candidate) =>
			typeof candidate === "string" && candidate.toLowerCase().includes(normalized)
		);
	});
}

function filteredDashboard(
	dashboard: AuthDashboardViewModel,
	searchQuery: string,
): AuthDashboardViewModel {
	return {
		...dashboard,
		accounts: filterAuthInkDashboardAccounts(dashboard, searchQuery),
	};
}

function entriesForSection(
	dashboard: AuthDashboardViewModel,
	sectionId: AuthDashboardSectionId,
): AuthInkDashboardEntry[] {
	if (sectionId === "saved-accounts") {
		return dashboard.accounts.map((account, index) => ({
			id: `account:${account.sourceIndex ?? index}`,
			label: formatAccountLabel(account, index),
			detail: formatAccountDetail(account),
			tone: accountTone(account),
			kind: "account",
			account,
		}));
	}

	const section = dashboard.sections.find((candidate) => candidate.id === sectionId);
	return (section?.actions ?? []).map((action) => ({
		id: `action:${action.id}`,
		label: action.label,
		tone: actionTone(action),
		kind: "action",
		actionId: action.id,
	}));
}

function normalizeFocus(
	dashboard: AuthDashboardViewModel,
	focus: AuthInkDashboardFocusState,
): AuthInkDashboardFocusState {
	const sectionCount = dashboard.sections.length;
	if (sectionCount === 0) return { sectionIndex: 0, entryIndex: 0 };
	const sectionIndex = Math.max(0, Math.min(focus.sectionIndex, sectionCount - 1));
	const section = dashboard.sections[sectionIndex];
	const entries = section ? entriesForSection(dashboard, section.id) : [];
	const entryIndex = entries.length === 0 ? 0 : Math.max(0, Math.min(focus.entryIndex, entries.length - 1));
	return { sectionIndex, entryIndex };
}

function resolveSelectedEntry(
	dashboard: AuthDashboardViewModel,
	focus: AuthInkDashboardFocusState,
): AuthInkDashboardEntry | null {
	const normalized = normalizeFocus(dashboard, focus);
	const section = dashboard.sections[normalized.sectionIndex];
	if (!section) return null;
	const entries = entriesForSection(dashboard, section.id);
	return entries[normalized.entryIndex] ?? null;
}

function focusSectionById(
	dashboard: AuthDashboardViewModel,
	sectionId: AuthDashboardSectionId,
): AuthInkDashboardFocusState {
	const index = dashboard.sections.findIndex((section) => section.id === sectionId);
	return normalizeFocus(dashboard, {
		sectionIndex: index >= 0 ? index : 0,
		entryIndex: 0,
	});
}

function moveFocus(
	dashboard: AuthDashboardViewModel,
	focus: AuthInkDashboardFocusState,
	action: { type: "move-section"; direction: 1 | -1 } | { type: "move-entry"; direction: 1 | -1 } | { type: "reset" },
): AuthInkDashboardFocusState {
	const normalized = normalizeFocus(dashboard, focus);
	const sectionCount = dashboard.sections.length;
	if (sectionCount === 0) return normalized;
	if (action.type === "reset") {
		return { sectionIndex: 0, entryIndex: 0 };
	}
	if (action.type === "move-section") {
		return normalizeFocus(dashboard, {
			sectionIndex: (normalized.sectionIndex + action.direction + sectionCount) % sectionCount,
			entryIndex: 0,
		});
	}
	const section = dashboard.sections[normalized.sectionIndex];
	const entries = section ? entriesForSection(dashboard, section.id) : [];
	if (entries.length === 0) return normalized;
	return normalizeFocus(dashboard, {
		sectionIndex: normalized.sectionIndex,
		entryIndex: (normalized.entryIndex + action.direction + entries.length) % entries.length,
	});
}

function resolveMenuResultFromAction(actionId: AuthDashboardActionViewModel["id"]): LoginMenuResult {
	switch (actionId) {
		case "add":
			return { mode: "add" };
		case "check":
			return { mode: "check" };
		case "forecast":
			return { mode: "forecast" };
		case "fix":
			return { mode: "fix" };
		case "settings":
			return { mode: "settings" };
		case "deep-check":
			return { mode: "deep-check" };
		case "verify-flagged":
			return { mode: "verify-flagged" };
		case "delete-all":
			return { mode: "fresh" };
	}
	return { mode: "cancel" };
}

function resolveVisibleQuickSwitchMap(accounts: AuthAccountViewModel[]): {
	byNumber: Map<number, AuthAccountViewModel>;
	duplicates: Set<number>;
} {
	const byNumber = new Map<number, AuthAccountViewModel>();
	const duplicates = new Set<number>();
	for (const account of accounts) {
		const quickSwitchNumber = account.quickSwitchNumber ?? (account.index + 1);
		if (byNumber.has(quickSwitchNumber)) {
			duplicates.add(quickSwitchNumber);
			continue;
		}
		byNumber.set(quickSwitchNumber, account);
	}
	return { byNumber, duplicates };
}

export function resolveAuthInkQuickSwitch(
	dashboard: AuthDashboardViewModel,
	searchQuery: string,
	raw: string,
): LoginMenuResult | null {
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 9) return null;
	const visibleAccounts = filterAuthInkDashboardAccounts(dashboard, searchQuery);
	const { byNumber, duplicates } = resolveVisibleQuickSwitchMap(visibleAccounts);
	if (duplicates.has(parsed)) return null;
	const account = byNumber.get(parsed);
	if (!account) return null;
	const sourceIndex = typeof account.sourceIndex === "number" ? account.sourceIndex : account.index;
	return { mode: "manage", switchAccountIndex: sourceIndex };
}


function resolveStatusText(dashboard: AuthDashboardViewModel, statusOverride?: string): string | undefined {
	if (statusOverride && statusOverride.trim().length > 0) return statusOverride.trim();
	const raw = dashboard.menuOptions.statusMessage;
	if (typeof raw === "function") {
		const resolved = raw();
		return typeof resolved === "string" && resolved.trim().length > 0 ? resolved.trim() : undefined;
	}
	if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
	return dashboard.accounts.length > 0 ? `${dashboard.accounts.length} saved account(s)` : undefined;
}


function resolveStatusTone(
	dashboard: AuthDashboardViewModel,
	statusOverride?: string,
	statusToneOverride?: InkShellTone,
): InkShellTone {
	if (statusToneOverride) return statusToneOverride;
	const normalized = statusOverride?.trim().toLowerCase() ?? "";
	if (normalized.includes("restored")) return "success";
	if (normalized.includes("cancelled") || normalized.includes("skipping") || normalized.includes("restore")) {
		return "warning";
	}
	return (dashboard.menuOptions.flaggedCount ?? 0) > 0 ? "warning" : "accent";
}

function compactFooter(): string {
	return "Left/Right Sections | Up/Down Move | Enter Select | / Search | 1-9 Switch | Q Back";
}

function detailedFooter(): string {
	return "Arrow keys move, Left/Right switches sections, Enter selects, / filters saved accounts, 1-9 quick switches, Q goes back";
}

function searchFooter(): string {
	return "Search mode: type to filter | Enter apply | Backspace delete | Esc cancel";
}

function resolveSectionTone(sectionId: AuthDashboardSectionId): InkShellTone {
	if (sectionId === "danger-zone") return "danger";
	if (sectionId === "advanced-checks") return "warning";
	if (sectionId === "saved-accounts") return "success";
	return "accent";
}

function resolveAccountSourceIndex(account: AuthAccountViewModel): number {
	if (typeof account.sourceIndex === "number" && Number.isFinite(account.sourceIndex)) {
		return Math.max(0, Math.floor(account.sourceIndex));
	}
	if (typeof account.index === "number" && Number.isFinite(account.index)) {
		return Math.max(0, Math.floor(account.index));
	}
	return -1;
}

function warnUnresolvableAccountSelection(account: AuthAccountViewModel): void {
	const label = account.email?.trim() || account.accountId?.trim() || `index ${account.index + 1}`;
	console.log(`Unable to resolve saved account for action: ${label}`);
}

async function resolveSavedAccountOutcome(
	account: AuthAccountViewModel,
	options: PromptInkAuthDashboardOptions,
): Promise<AuthInkDashboardResolution> {
	const accountAction = await promptInkAccountDetails({
		...options,
		account,
	});
	if (accountAction === null || accountAction === "back" || accountAction === "cancel") {
		return { result: null };
	}
	const sourceIndex = resolveAccountSourceIndex(account);
	if (sourceIndex < 0) {
		warnUnresolvableAccountSelection(account);
		return {
			result: null,
			statusText: "Could not resolve the selected account.",
			statusTone: "danger",
		};
	}
	if (accountAction === "delete") {
		const confirmed = await promptInkConfirmAccountDelete({
			...options,
			account,
		});
		if (!confirmed) {
			return { result: null, statusText: "Delete cancelled.", statusTone: "warning" };
		}
		return { result: { mode: "manage", deleteAccountIndex: sourceIndex } };
	}
	if (accountAction === "refresh") {
		const confirmed = await promptInkConfirmAccountRefresh({
			...options,
			account,
		});
		if (!confirmed) {
			return { result: null, statusText: "Re-login cancelled.", statusTone: "warning" };
		}
		return { result: { mode: "manage", refreshAccountIndex: sourceIndex } };
	}
	if (accountAction === "toggle") {
		return { result: { mode: "manage", toggleAccountIndex: sourceIndex } };
	}
	if (accountAction === "set-current") {
		return { result: { mode: "manage", switchAccountIndex: sourceIndex } };
	}
	return { result: null };
}

async function promptDeleteAllTypedConfirm(
	stdin: NodeJS.ReadStream,
	stdout: NodeJS.WriteStream,
): Promise<boolean> {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const answer = await rl.question("Type DELETE to remove all saved accounts: ");
		return answer.trim() === "DELETE";
	} finally {
		rl.close();
	}
}

interface AuthInkDashboardAppProps {
	dashboard: AuthDashboardViewModel;
	title: string;
	statusTextOverride?: string;
	statusToneOverride?: InkShellTone;
	onResolve: (outcome: AuthInkDashboardOutcome) => void;
}

function AuthInkDashboardApp(props: AuthInkDashboardAppProps) {
	const { exit } = useApp();
	const theme = createInkShellTheme();
	const [focus, setFocus] = useState<AuthInkDashboardFocusState>({ sectionIndex: 0, entryIndex: 0 });
	const [searchQuery, setSearchQuery] = useState("");
	const [searchMode, setSearchMode] = useState(false);
	const [showDetailedHelp, setShowDetailedHelp] = useState(false);
	const [, setPulse] = useState(0);

	useEffect(() => {
		if (typeof props.dashboard.menuOptions.statusMessage !== "function") return undefined;
		const timer = setInterval(() => {
			setPulse((current) => current + 1);
		}, 200);
		return () => clearInterval(timer);
	}, [props.dashboard.menuOptions.statusMessage]);

	const visibleDashboard = useMemo(
		() => filteredDashboard(props.dashboard, searchQuery),
		[props.dashboard, searchQuery],
	);
	const normalizedFocus = normalizeFocus(visibleDashboard, focus);
	const activeSection = visibleDashboard.sections[normalizedFocus.sectionIndex];
	const activeEntries = activeSection ? entriesForSection(visibleDashboard, activeSection.id) : [];
	const selectedEntry = resolveSelectedEntry(visibleDashboard, normalizedFocus);
	const subtitle = searchQuery.trim().length > 0
		? `${UI_COPY.mainMenu.searchSubtitlePrefix} ${searchQuery.trim()}`
		: undefined;
	const footer = searchMode ? searchFooter() : showDetailedHelp ? detailedFooter() : compactFooter();

	useInput((input, key) => {
		if (searchMode) {
			if (key.escape) {
				setSearchMode(false);
				return;
			}
			if (key.return) {
				setSearchMode(false);
				return;
			}
			if (key.backspace || key.delete) {
				setSearchQuery((current) => current.slice(0, -1));
				return;
			}
			if (input && !key.ctrl && !key.meta) {
				setSearchQuery((current) => `${current}${input}`.toLowerCase());
			}
			return;
		}

		if (key.leftArrow || (key.shift && key.tab)) {
			setFocus((current) => moveFocus(visibleDashboard, current, { type: "move-section", direction: -1 }));
			return;
		}
		if (key.rightArrow || key.tab) {
			setFocus((current) => moveFocus(visibleDashboard, current, { type: "move-section", direction: 1 }));
			return;
		}
		if (key.upArrow) {
			setFocus((current) => moveFocus(visibleDashboard, current, { type: "move-entry", direction: -1 }));
			return;
		}
		if (key.downArrow) {
			setFocus((current) => moveFocus(visibleDashboard, current, { type: "move-entry", direction: 1 }));
			return;
		}

		const lower = input.toLowerCase();
		if (lower === "?") {
			setShowDetailedHelp((current) => !current);
			return;
		}
		if (lower === "q") {
			props.onResolve({ type: "menu-result", result: { mode: "cancel" } });
			exit();
			return;
		}
		if (lower === "/") {
			setSearchMode(true);
			setFocus(focusSectionById(visibleDashboard, "saved-accounts"));
			return;
		}
		if (lower === "r") {
			setFocus({ sectionIndex: 0, entryIndex: 0 });
			return;
		}

		const quickSwitch = resolveAuthInkQuickSwitch(visibleDashboard, "", input);
		if (quickSwitch) {
			props.onResolve({ type: "menu-result", result: quickSwitch });
			exit();
			return;
		}

		if (!key.return || !selectedEntry) return;
		if (selectedEntry.kind === "account" && selectedEntry.account) {
			props.onResolve({ type: "saved-account", account: selectedEntry.account });
			exit();
			return;
		}
		if (selectedEntry.kind === "action" && selectedEntry.actionId) {
			props.onResolve({
				type: "menu-result",
				result: resolveMenuResultFromAction(selectedEntry.actionId),
			});
			exit();
		}
	});

	return createElement(
		InkShellFrame,
		{
			title: props.title,
			subtitle,
			status: resolveStatusText(visibleDashboard, props.statusTextOverride),
			statusTone: resolveStatusTone(visibleDashboard, props.statusTextOverride, props.statusToneOverride),
			footer,
			theme,
		},
		createElement(
			Box,
			{ marginBottom: 1, flexDirection: "row", columnGap: 1 },
			...visibleDashboard.sections.map((section, index) =>
				createElement(InkShellSectionTab, {
					key: section.id,
					label: section.title,
					active: index === normalizedFocus.sectionIndex,
					tone: resolveSectionTone(section.id),
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
				: createElement(
					Text,
					{ color: theme.mutedColor },
					searchQuery.trim().length > 0 ? UI_COPY.mainMenu.noSearchMatches : "No items yet",
				),
		),
	);
}

async function renderInkDashboardOnce(
	options: PromptInkAuthDashboardOptions,
): Promise<AuthInkDashboardOutcome> {
	return await new Promise<AuthInkDashboardOutcome>((resolve) => {
		let instance: Instance | null = null;
		let settled = false;
		const finish = (outcome: AuthInkDashboardOutcome) => {
			if (settled) return;
			settled = true;
			instance?.unmount();
			instance?.cleanup();
			resolve(outcome);
		};

		const renderOptions: RenderOptions = {
			stdin: options.stdin ?? process.stdin,
			stdout: options.stdout ?? process.stdout,
			stderr: options.stderr ?? process.stderr,
			debug: options.debug ?? false,
			patchConsole: options.patchConsole ?? false,
			exitOnCtrlC: options.exitOnCtrlC ?? false,
		};

		instance = render(
			createElement(AuthInkDashboardApp, {
				dashboard: options.dashboard,
				title: resolveDashboardTitle(options.env ?? process.env),
				statusTextOverride: options.statusTextOverride,
				statusToneOverride: options.statusToneOverride,
				onResolve: finish,
			}),
			renderOptions,
		);
	});
}

export async function promptInkAuthDashboard(
	options: PromptInkAuthDashboardOptions,
): Promise<LoginMenuResult | null> {
	const support = resolveInkAuthShellBootstrap(options);
	if (!support.supported) return null;

	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	let statusTextOverride = options.statusTextOverride;
	let statusToneOverride = options.statusToneOverride;

	while (true) {
		const outcome = await renderInkDashboardOnce({
			...options,
			statusTextOverride,
			statusToneOverride,
		});
		statusTextOverride = undefined;
		statusToneOverride = undefined;
		if (outcome.type === "menu-result") {
			if (outcome.result.mode !== "fresh") {
				return outcome.result;
			}
			const confirmed = await promptInkConfirmDeleteAll({
				...options,
				stdin,
				stdout,
			});
			if (confirmed === null) {
				const fallbackConfirmed = await promptDeleteAllTypedConfirm(stdin, stdout);
				if (fallbackConfirmed) {
					return { mode: "fresh", deleteAll: true };
				}
				statusTextOverride = "Delete all cancelled.";
				statusToneOverride = "warning";
				continue;
			}
			if (confirmed) {
				return { mode: "fresh", deleteAll: true };
			}
			statusTextOverride = "Delete all cancelled.";
			statusToneOverride = "warning";
			continue;
		}

		const savedAccountResolution = await resolveSavedAccountOutcome(outcome.account, options);
		if (savedAccountResolution.result) return savedAccountResolution.result;
		statusTextOverride = savedAccountResolution.statusText;
		statusToneOverride = savedAccountResolution.statusTone;
	}
}
