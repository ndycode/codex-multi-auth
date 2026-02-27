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
 * Determines whether the environment should be treated as non-interactive (disable readline prompts).
 *
 * @returns `true` if interactive prompts are unreliable or controlled by an external TUI/desktop runtime, `false` otherwise.
 *
 * @remarks
 * - Safe for concurrent use; has no side effects and performs no filesystem I/O.
 * - Does not read or expose any sensitive tokens.
export function isNonInteractiveMode(): boolean {
	if (process.env.FORCE_INTERACTIVE_MODE === "1") return false;
	if (!input.isTTY || !output.isTTY) return true;
	if (process.env.OPENCODE_TUI === "1") return true;
	if (process.env.OPENCODE_DESKTOP === "1") return true;
	if (process.env.TERM_PROGRAM === "opencode") return true;
	if (process.env.ELECTRON_RUN_AS_NODE === "1") return true;
	return false;
}

/**
 * Ask the user whether to add another account.
 *
 * @param currentCount - The current number of accounts; used to format the prompt message.
 * @returns `true` if the user responded with "y" or "yes", `false` otherwise.
 *
 * Concurrency: uses the global stdin/stdout and is not safe to run concurrently with other interactive prompts.
 * Windows: input normalization trims CRLF and is case-insensitive.
 * Token redaction: input is read verbatim; do not enter secrets or tokens into this prompt as it is not redaction-aware.
 */
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

/**
 * Produce a human-readable, 1-based numbered label for an account.
 *
 * Formats as:
 * - "N. {label} ({email})" when both label and email are present,
 * - "N. {email}" when only email is present,
 * - "N. {label}" when only label is present,
 * - "N. {last6-accountId}" when only accountId is present (uses last 6 characters when longer),
 * - "N. Account" as a final fallback.
 *
 * Safe for concurrent use; does not perform filesystem I/O and is platform-independent (Windows behavior is unaffected).
 * Note: when falling back to accountId the value is truncated to the last 6 characters to avoid exposing the full token.
 *
 * @param account - Stored account metadata used to build the label
 * @param index - Zero-based index of the account; displayed as a 1-based number in the label
 * @returns The formatted account label string
 */
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

/**
 * Determine the effective source index for an account.
 *
 * Prefers `account.sourceIndex` when it is a number; otherwise uses `account.index`.
 * This function is pure, safe to call concurrently, performs no filesystem I/O (no Windows-specific behavior),
 * and does not expose or redact tokens or other sensitive fields.
 *
 * @param account - Account metadata object which may include `sourceIndex` and `index`
 * @returns The numeric source index to use for account operations
 */
function resolveAccountSourceIndex(account: ExistingAccountInfo): number {
	return typeof account.sourceIndex === "number" ? account.sourceIndex : account.index;
}

/**
 * Prompts the user to type `DELETE` to confirm removing all saved accounts.
 *
 * This is an interactive prompt; callers should avoid invoking it concurrently from multiple processes or threads.
 * The function itself performs no filesystem operations; it only returns the user's confirmation.
 * Be careful to redact or avoid logging the raw input when capturing responses.
 *
 * @returns `true` if the trimmed user input is exactly `DELETE` (case-sensitive), `false` otherwise.
 */
async function promptDeleteAllTypedConfirm(): Promise<boolean> {
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question("Type DELETE to remove all saved accounts: ");
		return answer.trim() === "DELETE";
	} finally {
		rl.close();
	}
}

/**
 * Present a non-TTY fallback prompt that asks the user to choose a login mode when interactive menus are unavailable.
 *
 * Prints saved accounts (using formatted labels) when `existingAccounts` is non-empty, then repeatedly prompts until a valid mode is entered.
 *
 * @param existingAccounts - Saved account metadata to display as a numbered list when present
 * @returns The chosen LoginMenuResult describing the selected mode and any associated action indices (e.g., deleteAll or account indices)
 *
 * Concurrency: prompts are sequential and must not be invoked concurrently in the same process.
 * Windows behavior: prompt I/O uses the process stdio and is expected to behave consistently on Windows consoles.
 * Security: user input may contain sensitive tokens; callers should redact or sanitize such values before logging or persisting.
 */
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

/**
 * Prompt the user to choose an authentication or account management mode via an interactive menu.
 *
 * If running in forced non-interactive mode the function selects the "add" mode. If the process
 * is not attached to a TTY it delegates to a non-interactive fallback prompt. In an interactive
 * TTY it displays the auth menu and returns a concrete LoginMenuResult based on the user's action;
 * destructive "delete all" actions require typing the confirmation token before proceeding.
 *
 * Concurrency: intended for single-threaded use in the CLI — do not call concurrently from multiple
 * tasks that share stdin/stdout.
 *
 * Windows filesystem: this function performs no filesystem operations and is unaffected by Windows
 * path/encoding semantics.
 *
 * Token redaction: this function does not redact or sanitize fields on ExistingAccountInfo — callers
 * must redact any secrets or tokens before passing account objects if they must not be displayed.
 *
 * @param existingAccounts - Accounts used to populate the menu and account-detail actions.
 * @param options - Optional menu hints (e.g., flaggedCount, statusMessage) that influence displayed UI.
 * @returns A LoginMenuResult describing the selected mode and any associated account indices or flags.
 */
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
					return { mode: "manage", deleteAccountIndex: resolveAccountSourceIndex(action.account) };
				}
				if (accountAction === "set-current") {
					return { mode: "manage", switchAccountIndex: resolveAccountSourceIndex(action.account) };
				}
				if (accountAction === "refresh") {
					return { mode: "manage", refreshAccountIndex: resolveAccountSourceIndex(action.account) };
				}
				if (accountAction === "toggle") {
					return { mode: "manage", toggleAccountIndex: resolveAccountSourceIndex(action.account) };
				}
				continue;
			}
			case "set-current-account":
				return { mode: "manage", switchAccountIndex: resolveAccountSourceIndex(action.account) };
			case "refresh-account":
				return { mode: "manage", refreshAccountIndex: resolveAccountSourceIndex(action.account) };
			case "toggle-account":
				return { mode: "manage", toggleAccountIndex: resolveAccountSourceIndex(action.account) };
			case "delete-account":
				return { mode: "manage", deleteAccountIndex: resolveAccountSourceIndex(action.account) };
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
