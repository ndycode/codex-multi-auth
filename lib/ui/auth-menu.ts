import { ANSI, isTTY } from "./ansi.js";
import { confirm } from "./confirm.js";
import { getUiRuntimeOptions } from "./runtime.js";
import { select, type MenuItem } from "./select.js";
import { paintUiText, formatUiBadge } from "./format.js";

export type AccountStatus =
	| "active"
	| "ok"
	| "rate-limited"
	| "cooldown"
	| "disabled"
	| "error"
	| "flagged"
	| "unknown";

export interface AccountInfo {
	index: number;
	accountId?: string;
	accountLabel?: string;
	email?: string;
	addedAt?: number;
	lastUsed?: number;
	status?: AccountStatus;
	isCurrentAccount?: boolean;
	enabled?: boolean;
}

export interface AuthMenuOptions {
	flaggedCount?: number;
}

export type AuthMenuAction =
	| { type: "add" }
	| { type: "fresh" }
	| { type: "check" }
	| { type: "deep-check" }
	| { type: "verify-flagged" }
	| { type: "select-account"; account: AccountInfo }
	| { type: "delete-all" }
	| { type: "cancel" };

export type AccountAction = "back" | "delete" | "refresh" | "toggle" | "cancel";

function formatRelativeTime(timestamp: number | undefined): string {
	if (!timestamp) return "never";
	const days = Math.floor((Date.now() - timestamp) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	return new Date(timestamp).toLocaleDateString();
}

function statusBadge(status: AccountStatus | undefined): string {
	const ui = getUiRuntimeOptions();
	if (ui.v2Enabled) {
		switch (status) {
			case "active":
				return formatUiBadge(ui, "active", "success");
			case "ok":
				return formatUiBadge(ui, "ok", "success");
			case "rate-limited":
				return formatUiBadge(ui, "rate-limited", "warning");
			case "cooldown":
				return formatUiBadge(ui, "cooldown", "warning");
			case "flagged":
				return formatUiBadge(ui, "flagged", "danger");
			case "disabled":
				return formatUiBadge(ui, "disabled", "danger");
			case "error":
				return formatUiBadge(ui, "error", "danger");
			default:
				return "";
		}
	}

	switch (status) {
		case "active":
			return `${ANSI.green}[active]${ANSI.reset}`;
		case "ok":
			return `${ANSI.green}[ok]${ANSI.reset}`;
		case "rate-limited":
			return `${ANSI.yellow}[rate-limited]${ANSI.reset}`;
		case "cooldown":
			return `${ANSI.yellow}[cooldown]${ANSI.reset}`;
		case "flagged":
			return `${ANSI.red}[flagged]${ANSI.reset}`;
		case "disabled":
			return `${ANSI.red}[disabled]${ANSI.reset}`;
		case "error":
			return `${ANSI.red}[error]${ANSI.reset}`;
		default:
			return "";
	}
}

function accountTitle(account: AccountInfo): string {
	const base =
		account.email?.trim() ||
		account.accountLabel?.trim() ||
		account.accountId?.trim() ||
		`Account ${account.index + 1}`;
	return `${account.index + 1}. ${base}`;
}

export async function showAuthMenu(
	accounts: AccountInfo[],
	options: AuthMenuOptions = {},
): Promise<AuthMenuAction> {
	const ui = getUiRuntimeOptions();
	const flaggedCount = options.flaggedCount ?? 0;
	const verifyLabel =
		flaggedCount > 0
			? `Verify flagged accounts (${flaggedCount})`
			: "Verify flagged accounts";

	const items: MenuItem<AuthMenuAction>[] = [
		{ label: "Actions", value: { type: "cancel" }, kind: "heading" },
		{ label: "Add account", value: { type: "add" }, color: "cyan" },
		{ label: "Check quotas", value: { type: "check" }, color: "cyan" },
		{ label: "Deep check accounts", value: { type: "deep-check" }, color: "cyan" },
		{ label: verifyLabel, value: { type: "verify-flagged" }, color: "cyan" },
		{ label: "Start fresh", value: { type: "fresh" }, color: "yellow" },
		{ label: "", value: { type: "cancel" }, separator: true },
		{ label: "Accounts", value: { type: "cancel" }, kind: "heading" },
		...accounts.map((account) => {
			const currentBadge = account.isCurrentAccount
				? (ui.v2Enabled ? ` ${formatUiBadge(ui, "current", "accent")}` : ` ${ANSI.cyan}[current]${ANSI.reset}`)
				: "";
			const badge = statusBadge(account.status);
			const disabledBadge =
				account.enabled === false
					? (ui.v2Enabled ? ` ${formatUiBadge(ui, "disabled", "danger")}` : ` ${ANSI.red}[disabled]${ANSI.reset}`)
					: "";
			const statusSuffix = badge ? ` ${badge}` : "";
			const label = `${accountTitle(account)}${currentBadge}${statusSuffix}${disabledBadge}`;
			return {
				label: ui.v2Enabled ? paintUiText(ui, label, "heading") : label,
				hint: `used ${formatRelativeTime(account.lastUsed)}`,
				value: { type: "select-account" as const, account },
			};
		}),
		{ label: "", value: { type: "cancel" }, separator: true },
		{ label: "Danger zone", value: { type: "cancel" }, kind: "heading" },
		{ label: "Delete all accounts", value: { type: "delete-all" }, color: "red" },
	];

	while (true) {
		const result = await select(items, {
			message: ui.v2Enabled ? "OpenAI accounts (Codex)" : "Codex accounts",
			subtitle: "Select action or account",
			clearScreen: true,
			variant: ui.v2Enabled ? "codex" : "legacy",
			theme: ui.theme,
		});

		if (!result) return { type: "cancel" };
		if (result.type === "delete-all") {
			const confirmed = await confirm("Delete all accounts?");
			if (!confirmed) continue;
		}
		return result;
	}
}

export async function showAccountDetails(account: AccountInfo): Promise<AccountAction> {
	const ui = getUiRuntimeOptions();
	const header =
		`${accountTitle(account)} ${statusBadge(account.status)}` +
		(account.enabled === false
			? (ui.v2Enabled
				? ` ${formatUiBadge(ui, "disabled", "danger")}`
				: ` ${ANSI.red}[disabled]${ANSI.reset}`)
			: "");
	const subtitle = `Added: ${formatDate(account.addedAt)} | Last used: ${formatRelativeTime(account.lastUsed)}`;

	while (true) {
		const action = await select<AccountAction>(
			[
				{ label: "Back", value: "back" },
				{
					label: account.enabled === false ? "Enable account" : "Disable account",
					value: "toggle",
					color: account.enabled === false ? "green" : "yellow",
				},
				{ label: "Refresh account", value: "refresh", color: "cyan" },
				{ label: "Delete this account", value: "delete", color: "red" },
			],
			{
				message: header,
				subtitle,
				clearScreen: true,
				variant: ui.v2Enabled ? "codex" : "legacy",
				theme: ui.theme,
			},
		);

		if (!action) return "cancel";
		if (action === "delete") {
			const confirmed = await confirm(`Delete ${accountTitle(account)}?`);
			if (!confirmed) continue;
		}
		if (action === "refresh") {
			const confirmed = await confirm(`Re-authenticate ${accountTitle(account)}?`);
			if (!confirmed) continue;
		}
		return action;
	}
}

export { isTTY };

