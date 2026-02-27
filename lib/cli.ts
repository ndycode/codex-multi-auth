import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AccountIdSource } from "./types.js";
import {
	showAuthMenu,
	showAccountDetails,
	isTTY,
	type AccountStatus,
} from "./ui/auth-menu.js";
import { UI_COPY } from "./ui/copy.js";

/**
 * Detect if running in OpenCode Desktop/TUI mode where readline prompts don't work.
 * In TUI mode, stdin/stdout are controlled by the TUI renderer, so readline breaks.
 * Exported for testing purposes.
 */
export function isNonInteractiveMode(): boolean {
	if (process.env.FORCE_INTERACTIVE_MODE === "1") return false;
	if (!input.isTTY || !output.isTTY) return true;
	if (process.env.OPENCODE_TUI === "1") return true;
	if (process.env.OPENCODE_DESKTOP === "1") return true;
	if (process.env.TERM_PROGRAM === "opencode") return true;
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

function resolveAccountSourceIndex(account: ExistingAccountInfo): number {
	const sourceIndex =
		typeof account.sourceIndex === "number" && Number.isFinite(account.sourceIndex)
			? Math.max(0, Math.floor(account.sourceIndex))
			: undefined;
	if (typeof sourceIndex === "number") return sourceIndex;
	if (typeof account.index === "number" && Number.isFinite(account.index)) {
		return Math.max(0, Math.floor(account.index));
	}
	return -1;
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
		const action = await showAuthMenu(existingAccounts, {
			flaggedCount: options.flaggedCount ?? 0,
			statusMessage: options.statusMessage,
		});

		switch (action.type) {
			case "add":
				return { mode: "add" };
			case "forecast":
				return { mode: "forecast" };
			case "fix":
				return { mode: "fix" };
			case "settings":
				return { mode: "settings" };
			case "fresh":
				if (!(await promptDeleteAllTypedConfirm())) {
					console.log("\nDelete all cancelled.\n");
					continue;
				}
				return { mode: "fresh", deleteAll: true };
			case "check":
				return { mode: "check" };
			case "deep-check":
				return { mode: "deep-check" };
			case "verify-flagged":
				return { mode: "verify-flagged" };
			case "select-account": {
				const accountAction = await showAccountDetails(action.account);
				if (accountAction === "delete") {
					const index = resolveAccountSourceIndex(action.account);
					if (index >= 0) return { mode: "manage", deleteAccountIndex: index };
					continue;
				}
				if (accountAction === "set-current") {
					const index = resolveAccountSourceIndex(action.account);
					if (index >= 0) return { mode: "manage", switchAccountIndex: index };
					continue;
				}
				if (accountAction === "refresh") {
					const index = resolveAccountSourceIndex(action.account);
					if (index >= 0) return { mode: "manage", refreshAccountIndex: index };
					continue;
				}
				if (accountAction === "toggle") {
					const index = resolveAccountSourceIndex(action.account);
					if (index >= 0) return { mode: "manage", toggleAccountIndex: index };
					continue;
				}
				continue;
			}
			case "set-current-account": {
				const index = resolveAccountSourceIndex(action.account);
				if (index >= 0) return { mode: "manage", switchAccountIndex: index };
				continue;
			}
			case "refresh-account": {
				const index = resolveAccountSourceIndex(action.account);
				if (index >= 0) return { mode: "manage", refreshAccountIndex: index };
				continue;
			}
			case "toggle-account": {
				const index = resolveAccountSourceIndex(action.account);
				if (index >= 0) return { mode: "manage", toggleAccountIndex: index };
				continue;
			}
			case "delete-account": {
				const index = resolveAccountSourceIndex(action.account);
				if (index >= 0) return { mode: "manage", deleteAccountIndex: index };
				continue;
			}
			case "search":
				continue;
			case "delete-all":
				if (!(await promptDeleteAllTypedConfirm())) {
					console.log("\nDelete all cancelled.\n");
					continue;
				}
				return { mode: "fresh", deleteAll: true };
			case "cancel":
				return { mode: "cancel" };
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
