import { stdin as input, stdout as output } from "node:process";
import { sanitizeEmail } from "../accounts.js";
import type { promptLoginMode } from "../cli.js";
import { MODEL_FAMILIES } from "../prompts/codex.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	findMatchingAccountIndex,
	loadAccounts,
	type NamedBackupSummary,
	setStoragePath,
	withAccountStorageTransaction,
} from "../storage.js";
import { UI_COPY } from "../ui/ui-copy.js";
import { getUiRuntimeOptions } from "../ui/runtime.js";
import { type MenuItem, select } from "../ui/select.js";
import { runSwitchCommand } from "./commands/switch.js";
import {
	formatBackupSavedAt,
	stylePromptText,
} from "./formatters/index.js";
import {
	type OAuthSignInMode,
	persistAccountPool,
	resolveAccountSelection,
	runOAuthFlow,
	syncSelectionToCodex,
} from "./login-oauth.js";
import { persistAndSyncSelectedAccount } from "./persist-selected-account.js";

/**
 * Per-menu-item action handlers for the login dashboard: sign-in mode and
 * backup-restore prompts plus the manage actions (switch/delete/toggle/refresh
 * an account row). Moved verbatim out of lib/codex-manager.ts (audit roadmap
 * §4.1.1 phase 4).
 */

/** @internal */
export type BackupRestoreMode = "latest" | "manual" | "back";

/** @internal */
export async function promptOAuthSignInMode(
	backupOption: NamedBackupSummary | null,
	backupDiscoveryWarning: string | null = null,
): Promise<OAuthSignInMode> {
	if (!input.isTTY || !output.isTTY) {
		return "browser";
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<OAuthSignInMode>[] = [
		{
			label: UI_COPY.oauth.signInHeading,
			value: "cancel" as const,
			kind: "heading",
		},
		{ label: UI_COPY.oauth.openBrowser, value: "browser", color: "green" },
		{ label: UI_COPY.oauth.manualMode, value: "manual", color: "yellow" },
		...(backupOption
			? [
					{ separator: true, label: "", value: "cancel" as const },
					{
						label: UI_COPY.oauth.restoreHeading,
						value: "cancel" as const,
						kind: "heading" as const,
					},
					{
						label: UI_COPY.oauth.restoreSavedBackup,
						value: "restore-backup" as const,
						hint: UI_COPY.oauth.loadLastBackupHint(
							backupOption.fileName,
							backupOption.accountCount,
							formatBackupSavedAt(backupOption.mtimeMs),
						),
						color: "cyan" as const,
					},
				]
			: []),
		{ separator: true, label: "", value: "cancel" as const },
		{ label: UI_COPY.oauth.back, value: "cancel", color: "red" },
	];

	const selected = await select<OAuthSignInMode>(items, {
		message: UI_COPY.oauth.chooseModeTitle,
		subtitle: backupDiscoveryWarning
			? `${UI_COPY.oauth.chooseModeSubtitle} ${backupDiscoveryWarning}`
			: UI_COPY.oauth.chooseModeSubtitle,
		help: backupOption
			? UI_COPY.oauth.chooseModeHelpWithBackup
			: UI_COPY.oauth.chooseModeHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return "cancel";
			if (lower === "1") return "browser";
			if (lower === "2") return "manual";
			if (lower === "3" && backupOption) return "restore-backup";
			return undefined;
		},
	});

	return selected ?? "cancel";
}

/** @internal */
export async function promptBackupRestoreMode(
	latestBackup: NamedBackupSummary,
): Promise<BackupRestoreMode> {
	if (!input.isTTY || !output.isTTY) {
		return "latest";
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<BackupRestoreMode>[] = [
		{
			label: UI_COPY.oauth.loadLastBackup,
			value: "latest",
			hint: `${UI_COPY.oauth.restoreBackupLatestHint}\n${UI_COPY.oauth.manualBackupHint(
				latestBackup.accountCount,
				formatBackupSavedAt(latestBackup.mtimeMs),
			)}`,
			color: "cyan",
		},
		{
			label: UI_COPY.oauth.chooseBackupManually,
			value: "manual",
			color: "yellow",
		},
		{ label: UI_COPY.oauth.back, value: "back", color: "red" },
	];

	const selected = await select<BackupRestoreMode>(items, {
		message: UI_COPY.oauth.restoreBackupTitle,
		subtitle: UI_COPY.oauth.restoreBackupSubtitle,
		help: UI_COPY.oauth.restoreBackupHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return "back";
			if (lower === "1") return "latest";
			if (lower === "2") return "manual";
			return undefined;
		},
	});

	return selected ?? "back";
}

/** @internal */
export async function promptManualBackupSelection(
	backups: NamedBackupSummary[],
): Promise<NamedBackupSummary | null> {
	if (!input.isTTY || !output.isTTY) {
		return backups[0] ?? null;
	}

	const ui = getUiRuntimeOptions();
	const items: MenuItem<NamedBackupSummary | null>[] = backups.map(
		(backup) => ({
			label: backup.fileName,
			value: backup,
			hint: UI_COPY.oauth.manualBackupHint(
				backup.accountCount,
				formatBackupSavedAt(backup.mtimeMs),
			),
			color: "cyan",
		}),
	);
	items.push({ label: UI_COPY.oauth.back, value: null, color: "red" });

	const selected = await select<NamedBackupSummary | null>(items, {
		message: UI_COPY.oauth.manualBackupTitle,
		subtitle: UI_COPY.oauth.manualBackupSubtitle,
		help: UI_COPY.oauth.manualBackupHelp,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		allowEscape: false,
		onInput: (raw) => {
			if (raw.toLowerCase() === "q") return null;
			return undefined;
		},
	});

	return selected;
}

function adjustManageActionSelectionIndex(
	currentIndex: number | undefined,
	removedIndex: number,
	remainingCount: number,
): number {
	if (remainingCount <= 0) {
		return 0;
	}
	if (typeof currentIndex !== "number" || currentIndex < 0) {
		return 0;
	}
	if (currentIndex < removedIndex) {
		return Math.min(currentIndex, remainingCount - 1);
	}
	if (currentIndex > removedIndex) {
		return currentIndex - 1;
	}
	return Math.min(removedIndex, remainingCount - 1);
}

function resetManageActionSelection(
	storage: AccountStorageV3,
	removedIndex: number,
): void {
	const remainingCount = storage.accounts.length;
	if (remainingCount <= 0) {
		storage.activeIndex = 0;
		storage.activeIndexByFamily = {};
		for (const family of MODEL_FAMILIES) {
			storage.activeIndexByFamily[family] = 0;
		}
		return;
	}

	const previousActiveIndex = storage.activeIndex;
	const previousByFamily = { ...storage.activeIndexByFamily };
	storage.activeIndex = adjustManageActionSelectionIndex(
		previousActiveIndex,
		removedIndex,
		remainingCount,
	);
	storage.activeIndexByFamily = {};
	for (const family of MODEL_FAMILIES) {
		storage.activeIndexByFamily[family] = adjustManageActionSelectionIndex(
			previousByFamily[family] ?? previousActiveIndex,
			removedIndex,
			remainingCount,
		);
	}
}

function replaceManageActionStorage(
	target: AccountStorageV3,
	source: AccountStorageV3,
): void {
	target.version = source.version;
	target.accounts = structuredClone(source.accounts);
	target.activeIndex = source.activeIndex;
	target.activeIndexByFamily = {
		...source.activeIndexByFamily,
	};
}

function resolveManageActionAccountIndex(
	storage: AccountStorageV3,
	fallbackIndex: number,
	account: AccountMetadataV3 | undefined,
): number | null {
	if (account) {
		const matchedIndex = findMatchingAccountIndex(
			storage.accounts,
			{
				accountId: account.accountId,
				email: account.email,
				refreshToken: account.refreshToken,
			},
			{
				allowUniqueAccountIdFallbackWithoutEmail: true,
			},
		);
		if (typeof matchedIndex === "number" && matchedIndex >= 0) {
			return matchedIndex;
		}
		return null;
	}
	return fallbackIndex >= 0 && fallbackIndex < storage.accounts.length
		? fallbackIndex
		: null;
}

function matchesManageActionAccount(
	account: AccountMetadataV3 | undefined,
	candidate: AccountMetadataV3 | undefined,
): boolean {
	if (!account || !candidate) {
		return false;
	}
	if (account.accountId || candidate.accountId) {
		return account.accountId === candidate.accountId;
	}
	return (
		account.refreshToken === candidate.refreshToken &&
		sanitizeEmail(account.email) === sanitizeEmail(candidate.email)
	);
}
/** @internal */
export async function handleManageAction(
	storage: AccountStorageV3,
	menuResult: Awaited<ReturnType<typeof promptLoginMode>>,
): Promise<void> {
	if (typeof menuResult.switchAccountIndex === "number") {
		const index = menuResult.switchAccountIndex;
		await runSwitchCommand([String(index + 1)], {
			setStoragePath,
			loadAccounts,
			persistAndSyncSelectedAccount,
		});
		return;
	}

	if (typeof menuResult.deleteAccountIndex === "number") {
		const idx = menuResult.deleteAccountIndex;
		const selectedAccount = storage.accounts[idx];
		let deleted = false;
		if (selectedAccount) {
			await withAccountStorageTransaction(async (loadedStorage, persist) => {
				const nextStorage = loadedStorage
					? structuredClone(loadedStorage)
					: structuredClone(storage);
				const nextIndex = resolveManageActionAccountIndex(
					nextStorage,
					idx,
					selectedAccount,
				);
				if (nextIndex === null) {
					return;
				}
				const nextAccount = nextStorage.accounts[nextIndex];
				if (!matchesManageActionAccount(selectedAccount, nextAccount)) {
					return;
				}
				nextStorage.accounts.splice(nextIndex, 1);
				resetManageActionSelection(nextStorage, nextIndex);
				await persist(nextStorage);
				replaceManageActionStorage(storage, nextStorage);
				deleted = true;
			});
		}
		if (deleted) {
			console.log(`Deleted account ${idx + 1}.`);
		}
		return;
	}

	if (typeof menuResult.toggleAccountIndex === "number") {
		const idx = menuResult.toggleAccountIndex;
		const selectedAccount = storage.accounts[idx];
		let nextEnabledState: boolean | null = null;
		if (selectedAccount) {
			await withAccountStorageTransaction(async (loadedStorage, persist) => {
				const nextStorage = loadedStorage
					? structuredClone(loadedStorage)
					: structuredClone(storage);
				const nextIndex = resolveManageActionAccountIndex(
					nextStorage,
					idx,
					selectedAccount,
				);
				if (nextIndex === null) {
					return;
				}
				const nextAccount = nextStorage.accounts[nextIndex];
				if (
					!nextAccount ||
					!matchesManageActionAccount(selectedAccount, nextAccount)
				) {
					return;
				}
				nextAccount.enabled = nextAccount.enabled === false;
				await persist(nextStorage);
				replaceManageActionStorage(storage, nextStorage);
				nextEnabledState = nextAccount.enabled !== false;
			});
		}
		if (nextEnabledState !== null) {
			console.log(
				`${nextEnabledState ? "Enabled" : "Disabled"} account ${idx + 1}.`,
			);
		}
		return;
	}

	if (typeof menuResult.refreshAccountIndex === "number") {
		const idx = menuResult.refreshAccountIndex;
		const existing = storage.accounts[idx];
		if (!existing) return;

		const signInMode = await promptOAuthSignInMode(null);
		if (signInMode === "cancel") {
			console.log(stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"));
			return;
		}
		if (signInMode !== "browser" && signInMode !== "manual") {
			return;
		}

		const tokenResult = await runOAuthFlow(true, signInMode);
		if (tokenResult.type !== "success") {
			console.error(
				`Refresh failed: ${tokenResult.message ?? tokenResult.reason ?? "unknown error"}`,
			);
			return;
		}

		const resolved = resolveAccountSelection(tokenResult);
		await persistAccountPool([resolved], false);
		await syncSelectionToCodex(resolved);
		console.log(`Refreshed account ${idx + 1}.`);
	}
}
