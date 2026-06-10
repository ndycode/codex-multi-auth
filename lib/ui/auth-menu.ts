import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ANSI, isTTY } from "./ansi.js";
import { confirm } from "./confirm.js";
import { getUiRuntimeOptions } from "./runtime.js";
import { select, type MenuItem } from "./select.js";
import { paintUiText, formatUiBadge } from "./format.js";
import { UI_COPY, formatCheckFlaggedLabel } from "./ui-copy.js";
import {
	accountRowColor,
	accountSearchText,
	accountTitle,
	authMenuFocusKey,
	currentMarkerLabel,
	formatAccountHint,
	formatDate,
	formatRelativeTime,
	mainMenuTitleWithVersion,
	statusBadge,
	type AccountAction,
	type AccountInfo,
	type AuthMenuAction,
	type AuthMenuOptions,
} from "./auth-menu-builder.js";

export type {
	AccountAction,
	AccountInfo,
	AccountStatus,
	AuthMenuAction,
	AuthMenuOptions,
} from "./auth-menu-builder.js";

async function promptSearchQuery(current: string): Promise<string> {
	if (!input.isTTY || !output.isTTY) {
		return current;
	}

	const rl = createInterface({ input, output });
	try {
		const suffix = current ? ` (${current})` : "";
		const answer = await rl.question(`Search${suffix} (blank clears): `);
		return answer.trim().toLowerCase();
	} finally {
		rl.close();
	}
}

export async function showAuthMenu(
	accounts: AccountInfo[],
	options: AuthMenuOptions = {},
): Promise<AuthMenuAction> {
	const flaggedCount = options.flaggedCount ?? 0;
	const verifyLabel = formatCheckFlaggedLabel(flaggedCount);
	const ui = getUiRuntimeOptions();
	let showDetailedHelp = false;
	let searchQuery = "";
	let focusKey = "action:add";
	while (true) {
		const normalizedSearch = searchQuery.trim().toLowerCase();
		const visibleAccounts = normalizedSearch.length > 0
			? accounts.filter((account) => accountSearchText(account).includes(normalizedSearch))
			: accounts;
		const visibleByNumber = new Map<number, AccountInfo>();
		const duplicateQuickSwitchNumbers = new Set<number>();
		for (const account of visibleAccounts) {
			const quickSwitchNumber = account.quickSwitchNumber ?? (account.index + 1);
			if (visibleByNumber.has(quickSwitchNumber)) {
				duplicateQuickSwitchNumbers.add(quickSwitchNumber);
				continue;
			}
			visibleByNumber.set(quickSwitchNumber, account);
		}

		const items: MenuItem<AuthMenuAction>[] = [
			{ label: UI_COPY.mainMenu.quickStart, value: { type: "cancel" }, kind: "heading" },
			{ label: UI_COPY.mainMenu.addAccount, value: { type: "add" }, color: "green" },
			{ label: UI_COPY.mainMenu.checkAccounts, value: { type: "check" }, color: "green" },
			{ label: UI_COPY.mainMenu.bestAccount, value: { type: "forecast" }, color: "green" },
			{ label: UI_COPY.mainMenu.fixIssues, value: { type: "fix" }, color: "green" },
			{ label: UI_COPY.mainMenu.settings, value: { type: "settings" }, color: "green" },
			{ label: "", value: { type: "cancel" }, separator: true },
			{ label: UI_COPY.mainMenu.moreChecks, value: { type: "cancel" }, kind: "heading" },
			{ label: UI_COPY.mainMenu.refreshChecks, value: { type: "deep-check" }, color: "green" },
			{ label: verifyLabel, value: { type: "verify-flagged" }, color: flaggedCount > 0 ? "red" : "yellow" },
			{ label: "", value: { type: "cancel" }, separator: true },
			{ label: UI_COPY.mainMenu.accounts, value: { type: "cancel" }, kind: "heading" },
		];

		if (visibleAccounts.length === 0) {
			items.push({
				label: UI_COPY.mainMenu.noSearchMatches,
				value: { type: "cancel" },
				disabled: true,
			});
		} else {
			items.push(
				...visibleAccounts.map((account) => {
					const currentMarkers = account.currentMarkers ??
						(account.isCurrentAccount ? ["current" as const] : []);
					const currentBadge = account.showCurrentBadge !== false
						? currentMarkers
								.map((marker) =>
									ui.v2Enabled
										? ` ${formatUiBadge(ui, currentMarkerLabel(marker), marker === "current" ? "accent" : "muted")}`
										: ` ${ANSI.cyan}[${currentMarkerLabel(marker)}]${ANSI.reset}`,
								)
								.join("")
						: "";
					const badge = account.showStatusBadge === false ? "" : statusBadge(account.status);
					const statusSuffix = badge ? ` ${badge}` : "";
					const title = ui.v2Enabled
						? paintUiText(ui, accountTitle(account), account.isCurrentAccount ? "accent" : "heading")
						: accountTitle(account);
					const label = `${title}${currentBadge}${statusSuffix}`;
					const hint = formatAccountHint(account, ui);
					const hasHint = hint.length > 0;
					const hintText = ui.v2Enabled
						? (hasHint ? hint : undefined)
						: (hasHint ? hint : undefined);
					return {
						label,
						hint: hintText,
						color: accountRowColor(account),
						value: { type: "select-account" as const, account },
					};
				}),
			);
		}

		items.push({ label: "", value: { type: "cancel" }, separator: true });
		items.push({ label: UI_COPY.mainMenu.dangerZone, value: { type: "cancel" }, kind: "heading" });
		items.push({ label: UI_COPY.mainMenu.removeAllAccounts, value: { type: "delete-all" }, color: "red" });

		const compactHelp = UI_COPY.mainMenu.helpCompact;
		const detailedHelp = UI_COPY.mainMenu.helpDetailed;
		const showHintsForUnselectedRows = visibleAccounts[0]?.showHintsForUnselectedRows ??
			accounts[0]?.showHintsForUnselectedRows ??
			false;
		const focusStyle = visibleAccounts[0]?.focusStyle ??
			accounts[0]?.focusStyle ??
			"row-invert";
		const resolveStatusMessage = (): string | undefined => {
			const raw = typeof options.statusMessage === "function"
				? options.statusMessage()
				: options.statusMessage;
			return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
		};
		const buildSubtitle = (): string | undefined => {
			const parts: string[] = [];
			if (normalizedSearch.length > 0) {
				parts.push(`${UI_COPY.mainMenu.searchSubtitlePrefix} ${normalizedSearch}`);
			}
			const statusText = resolveStatusMessage();
			if (statusText) {
				parts.push(statusText);
			}
			if (parts.length === 0) return undefined;
			return parts.join(" | ");
		};
		const initialCursor = items.findIndex((item) => {
			if (item.separator || item.disabled || item.kind === "heading") return false;
			return authMenuFocusKey(item.value) === focusKey;
		});

		const result = await select(items, {
			message: mainMenuTitleWithVersion(),
			subtitle: buildSubtitle(),
			dynamicSubtitle: buildSubtitle,
			help: showDetailedHelp ? detailedHelp : compactHelp,
			clearScreen: true,
			selectedEmphasis: "minimal",
			focusStyle,
			showHintsForUnselected: showHintsForUnselectedRows,
			refreshIntervalMs: 200,
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			theme: ui.theme,
			onInput: (input, context) => {
				const lower = input.toLowerCase();
				if (lower === "?") {
					showDetailedHelp = !showDetailedHelp;
					context.requestRerender();
					return undefined;
				}
				if (lower === "q") {
					return { type: "cancel" as const };
				}
				if (lower === "/") {
					return { type: "search" as const };
				}
				const parsed = Number.parseInt(input, 10);
				if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 9) {
					if (duplicateQuickSwitchNumbers.has(parsed)) {
						return undefined;
					}
					const direct = visibleByNumber.get(parsed);
					if (direct) {
						return { type: "set-current-account" as const, account: direct };
					}
				}

				const selected = context.items[context.cursor];
				if (!selected || selected.separator || selected.disabled || selected.kind === "heading") {
					return undefined;
				}
				if (selected.value.type !== "select-account") return undefined;
				return undefined;
			},
			onCursorChange: ({ cursor }) => {
				const selected = items[cursor];
				if (!selected || selected.separator || selected.disabled || selected.kind === "heading") return;
				focusKey = authMenuFocusKey(selected.value);
			},
		});

		if (!result) return { type: "cancel" };
		if (result.type === "search") {
			searchQuery = await promptSearchQuery(searchQuery);
			focusKey = "action:search";
			continue;
		}
		if (result.type === "delete-all") {
			const confirmed = await confirm("Delete all accounts?");
			if (!confirmed) continue;
		}
		if (result.type === "delete-account") {
			const confirmed = await confirm(`Delete ${accountTitle(result.account)}?`);
			if (!confirmed) continue;
		}
		if (result.type === "refresh-account") {
			const confirmed = await confirm(`Re-authenticate ${accountTitle(result.account)}?`);
			if (!confirmed) continue;
		}
		focusKey = authMenuFocusKey(result);
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
	const statusLabel = account.status ?? "unknown";
	const subtitle = `Added: ${formatDate(account.addedAt)} | Used: ${formatRelativeTime(account.lastUsed)} | Status: ${statusLabel}`;
	let focusAction: AccountAction = "back";

	while (true) {
		const items: MenuItem<AccountAction>[] = [
			{ label: UI_COPY.accountDetails.back, value: "back" },
			{
				label: account.enabled === false ? UI_COPY.accountDetails.enable : UI_COPY.accountDetails.disable,
				value: "toggle",
				color: account.enabled === false ? "green" : "yellow",
			},
			{
				label: UI_COPY.accountDetails.setCurrent,
				value: "set-current",
				color: "green",
			},
			{ label: UI_COPY.accountDetails.refresh, value: "refresh", color: "green" },
			{ label: UI_COPY.accountDetails.remove, value: "delete", color: "red" },
		];
		const initialCursor = items.findIndex((item) => item.value === focusAction);
		const action = await select<AccountAction>(items, {
			message: header,
			subtitle,
			help: UI_COPY.accountDetails.help,
			clearScreen: true,
			selectedEmphasis: "minimal",
			focusStyle: account.focusStyle ?? "row-invert",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			theme: ui.theme,
			onInput: (input) => {
				const lower = input.toLowerCase();
				if (lower === "q") return "cancel";
				if (lower === "s") return "set-current";
				if (lower === "r") return "refresh";
				if (lower === "t" || lower === "e" || lower === "x") return "toggle";
				if (lower === "d") return "delete";
				return undefined;
			},
			onCursorChange: ({ cursor }) => {
				const selected = items[cursor];
				if (!selected || selected.separator || selected.disabled || selected.kind === "heading") return;
				focusAction = selected.value;
			},
		});

		if (!action) return "cancel";
		focusAction = action;
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
