import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AccountIdSource } from "./types.js";
import {
	showAuthMenu,
	showAccountDetails,
	isTTY,
	type AccountStatus,
} from "./ui/auth-menu.js";
import { confirm } from "./ui/confirm.js";
import { UI_COPY } from "./ui/copy.js";
import {
	resolveAuthAccountDetailSelection,
	resolveAuthDashboardSelection,
	settleAuthConfirmation,
	type AuthConfirmationModalViewModel,
	type AuthDashboardInteractionResolution,
} from "./codex-manager/auth-ui-controller.js";

/**
 * Detect if running in host Desktop/TUI mode where readline prompts don't work.
 * In TUI mode, stdin/stdout are controlled by the TUI renderer, so readline breaks.
 * Exported for testing purposes.
 */
export function isNonInteractiveMode(): boolean {
	if (process.env.FORCE_INTERACTIVE_MODE === "1") return false;
	if (!input.isTTY || !output.isTTY) return true;
	if (process.env.CODEX_TUI === "1") return true;
	if (process.env.CODEX_DESKTOP === "1") return true;
	if ((process.env.TERM_PROGRAM ?? "").trim().toLowerCase() === "codex") return true;
	if (process.env.ELECTRON_RUN_AS_NODE === "1") return true;
	return false;
}

export async function promptAddAnotherAccount(currentCount: number): Promise<boolean> {
	if (isNonInteractiveMode()) {
		return false;
	}

	const rl = createInterface({ input, output });
	try {
		console.log(`\n${UI_COPY.fallback.addAnotherTip}\n`);
		const answer = await rl.question(UI_COPY.fallback.addAnotherQuestion(currentCount));
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}

export type LoginMode =
	| "add"
	| "forecast"
	| "fix"
	| "settings"
	| "fresh"
	| "manage"
	| "check"
	| "deep-check"
	| "verify-flagged"
	| "cancel";

export interface ExistingAccountInfo {
	accountId?: string;
	accountLabel?: string;
	email?: string;
	index: number;
	sourceIndex?: number;
	quickSwitchNumber?: number;
	addedAt?: number;
	lastUsed?: number;
	status?: AccountStatus;
	quotaSummary?: string;
	quota5hLeftPercent?: number;
	quota5hResetAtMs?: number;
	quota7dLeftPercent?: number;
	quota7dResetAtMs?: number;
	quotaRateLimited?: boolean;
	isCurrentAccount?: boolean;
	enabled?: boolean;
	showStatusBadge?: boolean;
	showCurrentBadge?: boolean;
	showLastUsed?: boolean;
	showQuotaCooldown?: boolean;
	showHintsForUnselectedRows?: boolean;
	highlightCurrentRow?: boolean;
	focusStyle?: "row-invert" | "chip";
	statuslineFields?: string[];
}

export interface LoginMenuOptions {
	flaggedCount?: number;
	statusMessage?: string | (() => string | undefined);
}

export interface LoginMenuResult {
	mode: LoginMode;
	deleteAccountIndex?: number;
	refreshAccountIndex?: number;
	toggleAccountIndex?: number;
	switchAccountIndex?: number;
	deleteAll?: boolean;
}

function formatAccountLabel(account: ExistingAccountInfo, index: number): string {
	const num = index + 1;
	const label = account.accountLabel?.trim();
	if (account.email?.trim()) {
		return label ? `${num}. ${label} (${account.email})` : `${num}. ${account.email}`;
	}
	if (label) {
		return `${num}. ${label}`;
	}
	if (account.accountId?.trim()) {
		const suffix = account.accountId.length > 6 ? account.accountId.slice(-6) : account.accountId;
		return `${num}. ${suffix}`;
	}
	return `${num}. Account`;
}

async function promptDeleteAllTypedConfirm(): Promise<boolean> {
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question("Type DELETE to remove all saved accounts: ");
		return answer.trim() === "DELETE";
	} finally {
		rl.close();
	}
}

async function promptAuthConfirmation(modal: AuthConfirmationModalViewModel): Promise<boolean> {
	if (modal.confirmStyle === "typed-delete") {
		return promptDeleteAllTypedConfirm();
	}
	return confirm(modal.message);
}

async function resolveAuthInteraction(
	resolution: AuthDashboardInteractionResolution,
): Promise<AuthDashboardInteractionResolution> {
	if (resolution.type === "detail") {
		const action = await showAccountDetails(resolution.detail.account);
		return resolveAuthAccountDetailSelection(resolution.detail.account, action);
	}
	if (resolution.type === "confirm") {
		const confirmed = await promptAuthConfirmation(resolution.modal);
		if (!confirmed && resolution.modal.cancelMessage) {
			console.log(resolution.modal.cancelMessage);
		}
		return settleAuthConfirmation(resolution.modal, confirmed);
	}
	return resolution;
}

async function promptLoginModeFallback(existingAccounts: ExistingAccountInfo[]): Promise<LoginMenuResult> {
	const rl = createInterface({ input, output });
	try {
		if (existingAccounts.length > 0) {
			console.log(`\n${existingAccounts.length} account(s) saved:`);
			for (const account of existingAccounts) {
				console.log(`  ${formatAccountLabel(account, account.index)}`);
			}
			console.log("");
		}

		while (true) {
			const answer = await rl.question(UI_COPY.fallback.selectModePrompt);
			const normalized = answer.trim().toLowerCase();
			if (normalized === "a" || normalized === "add") return { mode: "add" };
			if (normalized === "b" || normalized === "p" || normalized === "forecast") {
				return { mode: "forecast" };
			}
			if (normalized === "x" || normalized === "fix") return { mode: "fix" };
			if (normalized === "s" || normalized === "settings" || normalized === "configure") {
				return { mode: "settings" };
			}
			if (normalized === "f" || normalized === "fresh" || normalized === "clear") {
				return { mode: "fresh", deleteAll: true };
			}
			if (normalized === "c" || normalized === "check") return { mode: "check" };
			if (normalized === "d" || normalized === "deep") {
				return { mode: "deep-check" };
			}
			if (
				normalized === "g" ||
				normalized === "flagged" ||
				normalized === "verify-flagged" ||
				normalized === "verify"
			) {
				return { mode: "verify-flagged" };
			}
			if (normalized === "q" || normalized === "quit") return { mode: "cancel" };
			console.log(UI_COPY.fallback.invalidModePrompt);
		}
	} finally {
		rl.close();
	}
}

export async function promptLoginMode(
	existingAccounts: ExistingAccountInfo[],
	options: LoginMenuOptions = {},
): Promise<LoginMenuResult> {
	if (isNonInteractiveMode()) {
		return { mode: "add" };
	}

	if (!isTTY()) {
		return promptLoginModeFallback(existingAccounts);
	}

	while (true) {
		let resolution = resolveAuthDashboardSelection(await showAuthMenu(existingAccounts, {
			flaggedCount: options.flaggedCount ?? 0,
			statusMessage: options.statusMessage,
		}));

		while (true) {
			resolution = await resolveAuthInteraction(resolution);
			if (resolution.type === "result") {
				return resolution.result;
			}
			if (resolution.type === "warning") {
				console.log(resolution.message);
				break;
			}
			if (resolution.type === "continue") {
				break;
			}
		}
	}
}

export interface AccountSelectionCandidate {
	accountId: string;
	label: string;
	source?: AccountIdSource;
	isDefault?: boolean;
}

export interface AccountSelectionOptions {
	defaultIndex?: number;
	title?: string;
}

export async function promptAccountSelection(
	candidates: AccountSelectionCandidate[],
	options: AccountSelectionOptions = {},
): Promise<AccountSelectionCandidate | null> {
	if (candidates.length === 0) return null;
	const defaultIndex =
		typeof options.defaultIndex === "number" && Number.isFinite(options.defaultIndex)
			? Math.max(0, Math.min(options.defaultIndex, candidates.length - 1))
			: 0;

	if (isNonInteractiveMode()) {
		return candidates[defaultIndex] ?? candidates[0] ?? null;
	}

	const rl = createInterface({ input, output });
	try {
		console.log(`\n${options.title ?? "Multiple workspaces detected for this account:"}`);
		candidates.forEach((candidate, index) => {
			const isDefault = candidate.isDefault ? " (default)" : "";
			console.log(`  ${index + 1}. ${candidate.label}${isDefault}`);
		});
		console.log("");

		while (true) {
			const answer = await rl.question(`Select workspace [${defaultIndex + 1}]: `);
			const normalized = answer.trim().toLowerCase();
			if (!normalized) {
				return candidates[defaultIndex] ?? candidates[0] ?? null;
			}
			if (normalized === "q" || normalized === "quit") {
				return candidates[defaultIndex] ?? candidates[0] ?? null;
			}
			const parsed = Number.parseInt(normalized, 10);
			if (Number.isFinite(parsed)) {
				const idx = parsed - 1;
				if (idx >= 0 && idx < candidates.length) {
					return candidates[idx] ?? null;
				}
			}
			console.log(`Please enter a number between 1 and ${candidates.length}.`);
		}
	} finally {
		rl.close();
	}
}

export { isTTY };
export type { AccountStatus };
