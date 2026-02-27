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

/**
 * Prompt the user whether to add another account.
 *
 * Prompts with a contextual question based on `currentCount` and returns the user's yes/no choice. In non-interactive mode this resolves to `false`.
 *
 * Concurrency: safe to call concurrently — each invocation creates its own readline interface. Terminal behavior: works with Windows terminals and POSIX TTYs. Privacy: raw input is not persisted or logged; only the normalized yes/no result is used.
 *
 * @param currentCount - The current number of saved accounts; used to format the prompt.
 * @returns `true` if the user answered "y" or "yes", `false` otherwise.
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
 * Builds a user-facing label for an account prefixed with a 1-based index.
 *
 * Prefers `account.accountLabel` combined with `account.email` when available, falls back to `account.email`,
 * then to the last six characters of `account.accountId`, and finally to the literal `"Account"` if no identifying
 * fields exist.
 *
 * Concurrency: pure and side-effect free — safe to call from concurrent contexts. Windows filesystem behavior:
 * label generation is platform-agnostic and does not depend on filesystem semantics. Token redaction:
 * this function does not attempt to redact or mask sensitive tokens; only uses provided fields and will include
 * email or accountId suffix when present.
 *
 * @param account - Account data from which to derive the display label
 * @param index - Zero-based account index used to produce the leading 1-based numeric prefix
 * @returns The formatted label, e.g. "1. Personal (you@example.com)", "2. 123abc", or "3. Account"
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
 * Resolve the effective source index for an account.
 *
 * This returns the account's explicit `sourceIndex` when present and numeric, otherwise falls back to `index`.
 * The function is synchronous and safe to call concurrently. It performs no filesystem I/O (no Windows-specific behavior),
 * and it does not read or expose authentication tokens (only numeric indices are returned).
 *
 * @param account - Account object to resolve the source index from
 * @returns The numeric source index to use for this account
 */
function resolveAccountSourceIndex(account: ExistingAccountInfo): number {
	return typeof account.sourceIndex === "number" ? account.sourceIndex : account.index;
}

/**
 * Prompt the user to type DELETE to confirm removal of all saved accounts.
 *
 * Reads a single line from stdin, trims surrounding whitespace (handles Windows CR line endings),
 * and returns whether the exact, case-sensitive string "DELETE" was provided. Assumes exclusive
 * access to the process stdin/stdout (not safe for concurrent prompts). The entered text is
 * compared transiently and is not persisted; avoid logging the raw input to prevent leaking tokens.
 *
 * @returns `true` if the user entered `DELETE` exactly (case-sensitive), `false` otherwise.
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
 * Prompt the user to choose a login mode from a simple textual fallback menu.
 *
 * Displays saved accounts (if any), repeatedly asks for a selection using the fallback prompts,
 * and returns the mapped LoginMenuResult for the first recognized command.
 *
 * @param existingAccounts - Saved account entries displayed to the user to aid selection; used only for presentation and to derive labels/indices.
 * @returns The selected LoginMenuResult describing the chosen mode (and `deleteAll: true` for the "fresh/clear" choice when confirmed).
 *
 * Concurrency: intended to run in a single CLI flow; do not invoke concurrently from multiple tasks/processes.
 * Windows behavior: accepts input with CRLF and LF line endings interchangeably.
 * Token handling: the function does not persist raw typed input beyond producing the decision result; do not type long-lived secrets into this prompt.
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
 * Presents an interactive login/menu UI and returns the selected login or management action.
 *
 * Displays an authentication menu when running in a TTY; falls back to a non-TTY prompt flow or returns `{ mode: "add" }` in non-interactive mode. Continues to prompt until the user selects an actionable mode (e.g., add, forecast, check, manage) or cancels.
 *
 * Concurrency: callers should not invoke this function concurrently from the same process/TTY because it reads from stdin/stdout. It is safe to call again after the returned promise resolves.
 *
 * Windows filesystem note: menu flow may read/write transient UI state to temporary files on Windows when rendering complex prompts; callers should not rely on persistent files being created.
 *
 * Token redaction: interactive prompts and UI functions invoked by this routine will not print raw authentication tokens; displayed account information is limited to account labels/IDs and status fields.
 *
 * @param existingAccounts - List of known accounts to show in the menu (used for selection and account-specific management actions)
 * @param options - Optional menu settings; `flaggedCount` influences UI badges and `statusMessage` (string or function) is shown in the menu
 * @returns The chosen LoginMenuResult describing the mode to execute and any associated account index or management flags
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
