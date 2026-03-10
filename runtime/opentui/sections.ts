import {
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	normalizeDashboardDisplaySettings,
	type DashboardDisplaySettings,
} from "../../lib/dashboard-settings.js";
import { getAccountHealth } from "../../lib/health.js";
import { UI_COPY } from "../../lib/ui/copy";
import {
	SHELL_WORKSPACE_ACCOUNTS,
	SHELL_WORKSPACE_HEALTH_TIMESTAMP,
	type ShellWorkspaceAccountSeed,
} from "./fixtures";

export type ShellRoute =
	| "dashboard"
	| "add-account"
	| "auth-choice"
	| "workspace"
	| "health"
	| "settings";

export type ShellActionType =
	| "open-section"
	| "cancel-dashboard"
	| "note"
	| "set-current-account"
	| "toggle-status-badges"
	| "save-settings";

export interface ShellAction {
	label: string;
	note: string;
	type: ShellActionType;
	targetSectionIndex?: number;
	targetAccountIndex?: number;
}

export interface ShellSectionMeta {
	id: ShellRoute;
	label: string;
	shortLabel: string;
}

export interface ShellSectionView extends ShellSectionMeta {
	summary: string;
	detail: string;
	detailRows?: readonly string[];
	enterNote: string;
	actions: readonly ShellAction[];
}

export interface ShellStateSlice {
	sectionIndex: number;
	persistedSettings: DashboardDisplaySettings;
	settingsDraft: DashboardDisplaySettings;
	currentAccountIndex: number;
}

export const DASHBOARD_SECTION_INDEX = 0;
export const ADD_ACCOUNT_SECTION_INDEX = 1;
export const AUTH_CHOICE_SECTION_INDEX = 2;
export const WORKSPACE_SECTION_INDEX = 3;
export const HEALTH_SECTION_INDEX = 4;
export const SETTINGS_SECTION_INDEX = 5;

export const SHELL_SECTIONS: readonly ShellSectionMeta[] = [
	{ id: "dashboard", label: "Dashboard", shortLabel: "Dash" },
	{ id: "add-account", label: "Add Account", shortLabel: "Add" },
	{ id: "auth-choice", label: "Auth Choice", shortLabel: "Auth" },
	{ id: "workspace", label: "Account Workspace", shortLabel: "Work" },
	{ id: "health", label: "Health Check", shortLabel: "Check" },
	{ id: "settings", label: UI_COPY.settings.title, shortLabel: "Set" },
] as const;

export function cloneShellSettings(settings: DashboardDisplaySettings): DashboardDisplaySettings {
	return normalizeDashboardDisplaySettings(settings);
}

export function statusBadgesEnabled(settings: DashboardDisplaySettings): boolean {
	return settings.menuShowStatusBadge ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowStatusBadge ?? true);
}

export function settingsDraftDirty(state: Pick<ShellStateSlice, "persistedSettings" | "settingsDraft">): boolean {
	return statusBadgesEnabled(state.persistedSettings) !== statusBadgesEnabled(state.settingsDraft);
}

function formatStatusBadgeState(settings: DashboardDisplaySettings): string {
	return statusBadgesEnabled(settings) ? "On" : "Off";
}

export function buildSettingsToggleNote(settings: DashboardDisplaySettings): string {
	return statusBadgesEnabled(settings)
		? "Draft updated. Status badges are on. Save to keep this change."
		: "Draft updated. Status badges are off. Save to keep this change.";
}

export function buildSettingsSavedNote(settings: DashboardDisplaySettings): string {
	return statusBadgesEnabled(settings)
		? "Settings saved. Status badges are on."
		: "Settings saved. Status badges are off.";
}

export function clampCurrentAccountIndex(index: number): number {
	return clampIndex(index, SHELL_WORKSPACE_ACCOUNTS.length);
}

export function resolveWorkspaceAccount(index: number): ShellWorkspaceAccountSeed {
	const fallback = SHELL_WORKSPACE_ACCOUNTS[0];
	if (!fallback) throw new Error("OpenTUI workspace fixtures are unavailable.");
	return SHELL_WORKSPACE_ACCOUNTS[clampCurrentAccountIndex(index)] ?? fallback;
}

function buildCurrentAccountNote(index: number): string {
	const account = resolveWorkspaceAccount(index);
	return `Current account set to ${account.label} for this shell workspace.`;
}

function buildWorkspaceAccountRows(currentAccountIndex: number): string[] {
	return SHELL_WORKSPACE_ACCOUNTS.map((account, index) => {
		const marker = index === clampCurrentAccountIndex(currentAccountIndex) ? "[current]" : "[saved]";
		return `${index + 1}. ${account.label} ${marker} | ${account.workspace} | ${account.lastUsedLabel}`;
	});
}

function buildWorkspaceHealth(currentAccountIndex: number) {
	return getAccountHealth(
		SHELL_WORKSPACE_ACCOUNTS.map((account, index) => ({
			index,
			email: account.email,
			accountId: `shell-workspace-${index + 1}`,
			health: account.health,
			cooldownUntil: account.cooldownUntil,
			cooldownReason: account.cooldownReason,
			lastUsedAt:
				SHELL_WORKSPACE_HEALTH_TIMESTAMP -
				(index === clampCurrentAccountIndex(currentAccountIndex) ? 10 : index === 1 ? 45 : 2_880) * 60 * 1000,
		})),
		SHELL_WORKSPACE_HEALTH_TIMESTAMP,
	);
}

function buildHealthRows(currentAccountIndex: number): string[] {
	const health = buildWorkspaceHealth(currentAccountIndex);
	return health.accounts.map((account, index) => {
		const marker = index === clampCurrentAccountIndex(currentAccountIndex) ? "[current]" : "[saved]";
		const flags: string[] = [];
		if (account.isRateLimited) flags.push("rate-limited");
		if (account.isCoolingDown) flags.push(`cooldown:${account.cooldownReason ?? "down"}`);
		if (flags.length === 0) flags.push("ready");
		const label = SHELL_WORKSPACE_ACCOUNTS[index]?.label ?? `Account ${index + 1}`;
		return `${index + 1}. ${label} ${marker} | ${account.health}% | ${flags.join(", ")}`;
	});
}

function resolveSectionMeta(index: number): ShellSectionMeta {
	const fallback = SHELL_SECTIONS[DASHBOARD_SECTION_INDEX] ?? SHELL_SECTIONS[0];
	if (!fallback) throw new Error("OpenTUI shell sections are unavailable.");
	return SHELL_SECTIONS[index] ?? fallback;
}

function buildSettingsSection(state: Pick<ShellStateSlice, "persistedSettings" | "settingsDraft">): ShellSectionView {
	const savedState = formatStatusBadgeState(state.persistedSettings);
	const draftState = formatStatusBadgeState(state.settingsDraft);
	const dirty = settingsDraftDirty(state);
    return {
		id: "settings",
		label: UI_COPY.settings.title,
		shortLabel: "Set",
		summary: "Settings keeps one beginner-safe display choice inside the same shell.",
		detail: dirty
			? `Draft status badges: ${draftState}. Saved status badges: ${savedState}. Save to keep the draft or cancel to keep the saved value.`
			: `Saved status badges: ${savedState}. Toggle the draft here, then save or cancel safely back to the dashboard.`,
		enterNote: dirty ? "Settings actions ready. Draft changes are waiting." : "Settings actions ready.",
		actions: [
			{ label: `Status Badges: ${draftState}`, note: buildSettingsToggleNote(state.settingsDraft), type: "toggle-status-badges" },
			{ label: dirty ? "Save Changes and Return to Dashboard" : "Save and Return to Dashboard", note: buildSettingsSavedNote(state.settingsDraft), type: "save-settings" },
			{ label: "Cancel and Return to Dashboard", note: dirty ? "Settings cancelled. Saved value kept." : "Settings closed. Back on the dashboard.", type: "cancel-dashboard" },
		],
	};
}

function buildWorkspaceSection(state: Pick<ShellStateSlice, "currentAccountIndex">): ShellSectionView {
	const currentAccount = resolveWorkspaceAccount(state.currentAccountIndex);
	return {
		id: "workspace",
		label: "Account Workspace",
		shortLabel: "Work",
		summary: "Account Workspace shows one simple saved-account path inside the shell.",
		detail: `Current account: ${currentAccount.label} <${currentAccount.email}>. Switch safely here, then run the beginner health check if you want a confidence pass.`,
		detailRows: buildWorkspaceAccountRows(state.currentAccountIndex),
		enterNote: `Workspace ready. ${currentAccount.label} is current.`,
		actions: [
			...SHELL_WORKSPACE_ACCOUNTS.map((account, index) => ({
				label: index === clampCurrentAccountIndex(state.currentAccountIndex) ? `${account.label} is Current` : `Set ${account.label} as Current`,
				note: buildCurrentAccountNote(index),
				type: "set-current-account" as const,
				targetAccountIndex: index,
			})),
			{ label: UI_COPY.mainMenu.checkAccounts, note: `Health check opened for ${resolveWorkspaceAccount(state.currentAccountIndex).label}.`, type: "open-section", targetSectionIndex: HEALTH_SECTION_INDEX },
			{ label: "Cancel and Return to Dashboard", note: "Account workspace closed. Back on the dashboard.", type: "cancel-dashboard" },
		],
	};
}

function buildHealthSection(state: Pick<ShellStateSlice, "currentAccountIndex">): ShellSectionView {
	const health = buildWorkspaceHealth(state.currentAccountIndex);
	const currentAccount = resolveWorkspaceAccount(state.currentAccountIndex);
	return {
		id: "health",
		label: "Health Check",
		shortLabel: "Check",
		summary: "Health Check gives one beginner-safe readout before deeper repair or doctor flows exist.",
		detail: `Shell status: ${health.status.toUpperCase()}. Healthy accounts: ${health.healthyAccountCount}/${health.accountCount}. Current account: ${currentAccount.label}.`,
		detailRows: [`Rate limited: ${health.rateLimitedCount} | Cooling down: ${health.coolingDownCount}`, ...buildHealthRows(state.currentAccountIndex)],
		enterNote: "Health check ready. Review the current account and safe next step.",
		actions: [
			{ label: "Open Account Workspace", note: `Workspace opened. ${currentAccount.label} stays current.`, type: "open-section", targetSectionIndex: WORKSPACE_SECTION_INDEX },
			{ label: "Return to Dashboard", note: "Health check closed. Back on the dashboard.", type: "cancel-dashboard" },
		],
	};
}

export function resolveSection(state: ShellStateSlice): ShellSectionView {
	const meta = resolveSectionMeta(state.sectionIndex);
	if (meta.id === "add-account") {
		return {
			...meta,
			summary: "Add account is the first guided step after the dashboard.",
			detail: "This slice stops before browser success. Open the sign-in method picker or cancel safely back to the dashboard.",
			enterNote: "Add account actions ready.",
			actions: [
				{ label: "Choose Sign-In Method", note: "Sign-in choices opened. Browser and manual options are now visible.", type: "open-section", targetSectionIndex: AUTH_CHOICE_SECTION_INDEX },
				{ label: "Cancel and Return to Dashboard", note: "Add account cancelled. Back on the dashboard.", type: "cancel-dashboard" },
			],
		};
	}
	if (meta.id === "auth-choice") {
		return {
			...meta,
			summary: UI_COPY.oauth.chooseModeSubtitle,
			detail: "Pick the visible method you want to use later. Browser success is intentionally out of scope for this proof slice.",
			enterNote: "Auth choice actions ready.",
			actions: [
				{ label: UI_COPY.oauth.openBrowser, note: "Browser sign-in is visible, but this slice stops before OAuth success.", type: "note" },
				{ label: UI_COPY.oauth.manualMode, note: "Manual sign-in is visible, but callback completion is not wired in this slice.", type: "note" },
				{ label: "Cancel and Return to Dashboard", note: "Sign-in cancelled. Back on the dashboard.", type: "cancel-dashboard" },
			],
		};
	}
	if (meta.id === "workspace") return buildWorkspaceSection(state);
	if (meta.id === "health") return buildHealthSection(state);
	if (meta.id === "settings") return buildSettingsSection(state);
	const currentAccount = resolveWorkspaceAccount(state.currentAccountIndex);
	return {
		...meta,
		summary: `${UI_COPY.mainMenu.title} keeps first-time actions visible inside the shell.`,
		detail: `Start the next beginner slices here: add an account, open the account workspace for ${currentAccount.label}, run one health check, or open settings before OAuth success exists.`,
		enterNote: "Dashboard actions ready.",
		actions: [
			{ label: UI_COPY.mainMenu.addAccount, note: "Add account opened. Choose a sign-in method next.", type: "open-section", targetSectionIndex: ADD_ACCOUNT_SECTION_INDEX },
			{ label: `Account Workspace (${currentAccount.label})`, note: `Workspace opened. ${currentAccount.label} is current.`, type: "open-section", targetSectionIndex: WORKSPACE_SECTION_INDEX },
			{ label: UI_COPY.mainMenu.checkAccounts, note: `Health check opened for ${currentAccount.label}.`, type: "open-section", targetSectionIndex: HEALTH_SECTION_INDEX },
			{ label: UI_COPY.mainMenu.settings, note: "Settings opened. One safe display setting is ready to change.", type: "open-section", targetSectionIndex: SETTINGS_SECTION_INDEX },
			{ label: "Review Shell Landmarks", note: "Header, navigation, content, and help stay visible through the dashboard slice.", type: "note" },
		],
	};
}

function clampIndex(index: number, total: number): number {
	if (total <= 0) return 0;
	if (index < 0) return total - 1;
	if (index >= total) return 0;
	return index;
}
