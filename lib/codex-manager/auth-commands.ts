import { isBrowserLaunchSuppressed } from "../auth/browser.js";
import {
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	sanitizeEmail,
} from "../accounts.js";
import { promptAddAnotherAccount, promptLoginMode, type ExistingAccountInfo } from "../cli.js";
import { ACCOUNT_LIMITS } from "../constants.js";
import {
	loadDashboardDisplaySettings,
	type DashboardDisplaySettings,
} from "../dashboard-settings.js";
import {
	evaluateForecastAccounts,
	recommendForecastAccount,
} from "../forecast.js";
import { loadQuotaCache, type QuotaCacheData } from "../quota-cache.js";
import { fetchCodexQuotaSnapshot } from "../quota-probe.js";
import { queuedRefresh } from "../refresh-queue.js";
import {
	getNamedBackups,
	formatStorageErrorHint,
	loadAccounts,
	loadFlaggedAccounts,
	restoreAccountsFromBackup,
	saveAccounts,
	setStoragePath,
	StorageError,
	type AccountMetadataV3,
	type AccountStorageV3,
	type NamedBackupSummary,
} from "../storage.js";
import type { AccountIdSource, TokenFailure, TokenResult } from "../types.js";
import { setCodexCliActiveSelection } from "../codex-cli/writer.js";
import type { ModelFamily } from "../prompts/codex.js";
import { UI_COPY } from "../ui/copy.js";
import { confirm } from "../ui/confirm.js";
import {
	applyUiThemeFromDashboardSettings,
	configureUnifiedSettings,
} from "./settings-hub.js";
import {
	parseAuthLoginArgs,
	parseBestArgs,
	printBestUsage,
	printUsage,
} from "./help.js";

type PromptTone = "accent" | "success" | "warning" | "danger" | "muted";
type TokenSuccess = Extract<TokenResult, { type: "success" }>;
type TokenSuccessWithAccount = TokenSuccess & {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
};
type OAuthSignInMode = "browser" | "manual" | "restore-backup" | "cancel";
type BackupRestoreMode = "latest" | "manual" | "back";
type LoginMenuResult = Awaited<ReturnType<typeof promptLoginMode>>;
type HealthCheckOptions = { forceRefresh?: boolean; liveProbe?: boolean };

export interface AuthCommandHelpers {
	resolveActiveIndex: (
		storage: AccountStorageV3,
		family?: ModelFamily,
	) => number;
	hasUsableAccessToken: (account: AccountMetadataV3, now: number) => boolean;
	applyTokenAccountIdentity: (
		account: { accountId?: string; accountIdSource?: AccountIdSource },
		tokenAccountId: string | undefined,
	) => boolean;
	normalizeFailureDetail: (
		message: string | undefined,
		reason: string | undefined,
	) => string;
}

export interface AuthLoginCommandDeps extends AuthCommandHelpers {
	stylePromptText: (text: string, tone: PromptTone) => string;
	runActionPanel: (
		title: string,
		stage: string,
		action: () => Promise<void> | void,
		settings?: DashboardDisplaySettings,
	) => Promise<void>;
	toExistingAccountInfo: (
		storage: AccountStorageV3,
		cache: QuotaCacheData,
		settings: DashboardDisplaySettings,
	) => ExistingAccountInfo[];
	countMenuQuotaRefreshTargets: (
		storage: AccountStorageV3,
		cache: QuotaCacheData,
		maxAgeMs: number,
	) => number;
	defaultMenuQuotaRefreshTtlMs: number;
	refreshQuotaCacheForMenu: (
		storage: AccountStorageV3,
		cache: QuotaCacheData,
		maxAgeMs: number,
		onProgress?: (current: number, total: number) => void,
	) => Promise<QuotaCacheData>;
	clearAccountsAndReset: () => Promise<void>;
	handleManageAction: (
		storage: AccountStorageV3,
		menuResult: LoginMenuResult,
	) => Promise<void>;
	promptOAuthSignInMode: (
		backupOption: NamedBackupSummary | null,
		backupDiscoveryWarning?: string | null,
	) => Promise<OAuthSignInMode>;
	promptBackupRestoreMode: (
		latestBackup: NamedBackupSummary,
	) => Promise<BackupRestoreMode>;
	promptManualBackupSelection: (
		namedBackups: NamedBackupSummary[],
	) => Promise<NamedBackupSummary | null>;
	runOAuthFlow: (
		forceNewLogin: boolean,
		signInMode: Extract<OAuthSignInMode, "browser" | "manual">,
	) => Promise<TokenResult>;
	resolveAccountSelection: (tokens: TokenSuccess) => TokenSuccessWithAccount;
	persistAccountPool: (
		tokens: TokenSuccessWithAccount[],
		preserveActiveIndexByFamily: boolean,
	) => Promise<void>;
	syncSelectionToCodex: (tokens: TokenSuccessWithAccount) => Promise<void>;
	runHealthCheck: (options: HealthCheckOptions) => Promise<void>;
	runForecast: (args: string[]) => Promise<number>;
	runFix: (args: string[]) => Promise<number>;
	runVerifyFlagged: (args: string[]) => Promise<number>;
	log: {
		debug: (message: string, meta?: unknown) => void;
	};
}

export async function persistAndSyncSelectedAccount({
	storage,
	targetIndex,
	parsed,
	switchReason,
	initialSyncIdToken,
	preserveActiveIndexByFamily = false,
	helpers,
}: {
	storage: AccountStorageV3;
	targetIndex: number;
	parsed: number;
	switchReason: "rotation" | "best" | "restore";
	initialSyncIdToken?: string;
	preserveActiveIndexByFamily?: boolean;
	helpers: AuthCommandHelpers;
}): Promise<{ synced: boolean; wasDisabled: boolean }> {
	const account = storage.accounts[targetIndex];
	if (!account) {
		throw new Error(`Account ${parsed} not found.`);
	}

	const wasDisabled = account.enabled === false;
	if (wasDisabled) {
		account.enabled = true;
	}

	storage.activeIndex = targetIndex;
	if (!storage.activeIndexByFamily || !preserveActiveIndexByFamily) {
		storage.activeIndexByFamily = {};
	}
	storage.activeIndexByFamily.codex = targetIndex;

	const switchNow = Date.now();
	let syncAccessToken = account.accessToken;
	let syncRefreshToken = account.refreshToken;
	let syncExpiresAt = account.expiresAt;
	let syncIdToken = initialSyncIdToken;

	if (!helpers.hasUsableAccessToken(account, switchNow)) {
		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type === "success") {
			const refreshedEmail = sanitizeEmail(
				extractAccountEmail(refreshResult.access, refreshResult.idToken),
			);
			const tokenAccountId = extractAccountId(refreshResult.access);

			account.refreshToken = refreshResult.refresh;
			account.accessToken = refreshResult.access;
			account.expiresAt = refreshResult.expires;
			if (refreshedEmail) account.email = refreshedEmail;
			helpers.applyTokenAccountIdentity(account, tokenAccountId);
			syncAccessToken = refreshResult.access;
			syncRefreshToken = refreshResult.refresh;
			syncExpiresAt = refreshResult.expires;
			syncIdToken = refreshResult.idToken;
		} else {
			console.warn(
				`Switch validation refresh failed for account ${parsed}: ${helpers.normalizeFailureDetail(refreshResult.message, refreshResult.reason)}.`,
			);
		}
	}

	account.lastUsed = switchNow;
	account.lastSwitchReason = switchReason;
	await saveAccounts(storage);

	const synced = await setCodexCliActiveSelection({
		accountId: account.accountId,
		email: account.email,
		accessToken: syncAccessToken,
		refreshToken: syncRefreshToken,
		expiresAt: syncExpiresAt,
		...(syncIdToken ? { idToken: syncIdToken } : {}),
	});
	return { synced, wasDisabled };
}

export async function runSwitch(
	args: string[],
	helpers: AuthCommandHelpers,
): Promise<number> {
	setStoragePath(null);
	const indexArg = args[0];
	if (!indexArg) {
		console.error("Missing index. Usage: codex auth switch <index>");
		return 1;
	}
	const parsed = Number.parseInt(indexArg, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		console.error(`Invalid index: ${indexArg}`);
		return 1;
	}
	const targetIndex = parsed - 1;

	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		console.error("No accounts configured.");
		return 1;
	}
	if (targetIndex < 0 || targetIndex >= storage.accounts.length) {
		console.error(`Index out of range. Valid range: 1-${storage.accounts.length}`);
		return 1;
	}

	const account = storage.accounts[targetIndex];
	if (!account) {
		console.error(`Account ${parsed} not found.`);
		return 1;
	}

	const { synced, wasDisabled } = await persistAndSyncSelectedAccount({
		storage,
		targetIndex,
		parsed,
		switchReason: "rotation",
		helpers,
	});
	if (!synced) {
		console.warn(
			`Switched account ${parsed} locally, but Codex auth sync did not complete. Multi-auth routing will still use this account.`,
		);
	}

	console.log(
		`Switched to account ${parsed}: ${formatAccountLabel(account, targetIndex)}${wasDisabled ? " (re-enabled)" : ""}`,
	);
	return 0;
}

export async function runBest(
	args: string[],
	helpers: AuthCommandHelpers,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printBestUsage();
		return 0;
	}

	const parsedArgs = parseBestArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printBestUsage();
		return 1;
	}
	const options = parsedArgs.options;
	if (options.modelProvided && !options.live) {
		console.error("--model requires --live for codex auth best");
		printBestUsage();
		return 1;
	}

	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ error: "No accounts configured." }, null, 2));
		} else {
			console.log("No accounts configured.");
		}
		return 1;
	}

	const now = Date.now();
	const refreshFailures = new Map<number, TokenFailure>();
	const liveQuotaByIndex = new Map<number, Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>>();
	const probeIdTokenByIndex = new Map<number, string>();
	const probeRefreshedIndices = new Set<number>();
	const probeErrors: string[] = [];
	let changed = false;

	const printProbeNotes = (): void => {
		if (probeErrors.length === 0) return;
		console.log(`Live check notes (${probeErrors.length}):`);
		for (const error of probeErrors) {
			console.log(`  - ${error}`);
		}
	};

	const persistProbeChangesIfNeeded = async (): Promise<void> => {
		if (!changed) return;
		await saveAccounts(storage);
		changed = false;
	};

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account || !options.live) continue;
		if (account.enabled === false) continue;

		let probeAccessToken = account.accessToken;
		let probeAccountId = account.accountId ?? extractAccountId(account.accessToken);
		if (!helpers.hasUsableAccessToken(account, now)) {
			const refreshResult = await queuedRefresh(account.refreshToken);
			if (refreshResult.type !== "success") {
				refreshFailures.set(i, {
					...refreshResult,
					message: helpers.normalizeFailureDetail(refreshResult.message, refreshResult.reason),
				});
				continue;
			}

			const refreshedEmail = sanitizeEmail(
				extractAccountEmail(refreshResult.access, refreshResult.idToken),
			);
			const refreshedAccountId = extractAccountId(refreshResult.access);

			if (account.refreshToken !== refreshResult.refresh) {
				account.refreshToken = refreshResult.refresh;
				changed = true;
			}
			if (account.accessToken !== refreshResult.access) {
				account.accessToken = refreshResult.access;
				changed = true;
			}
			if (account.expiresAt !== refreshResult.expires) {
				account.expiresAt = refreshResult.expires;
				changed = true;
			}
			if (refreshedEmail && refreshedEmail !== account.email) {
				account.email = refreshedEmail;
				changed = true;
			}
			if (refreshedAccountId && refreshedAccountId !== account.accountId) {
				account.accountId = refreshedAccountId;
				account.accountIdSource = "token";
				changed = true;
			}
			if (refreshResult.idToken) {
				probeIdTokenByIndex.set(i, refreshResult.idToken);
			}
			probeRefreshedIndices.add(i);

			probeAccessToken = account.accessToken;
			probeAccountId = account.accountId ?? refreshedAccountId;
		}

		if (!probeAccessToken || !probeAccountId) {
			probeErrors.push(`${formatAccountLabel(account, i)}: missing accountId for live probe`);
			continue;
		}

		try {
			const liveQuota = await fetchCodexQuotaSnapshot({
				accountId: probeAccountId,
				accessToken: probeAccessToken,
				model: options.model,
			});
			liveQuotaByIndex.set(i, liveQuota);
		} catch (error) {
			const message = helpers.normalizeFailureDetail(
				error instanceof Error ? error.message : String(error),
				undefined,
			);
			probeErrors.push(`${formatAccountLabel(account, i)}: ${message}`);
		}
	}

	const forecastInputs = storage.accounts.map((account, index) => ({
		index,
		account,
		isCurrent: index === helpers.resolveActiveIndex(storage, "codex"),
		now,
		refreshFailure: refreshFailures.get(index),
		liveQuota: liveQuotaByIndex.get(index),
	}));

	const forecastResults = evaluateForecastAccounts(forecastInputs);
	const recommendation = recommendForecastAccount(forecastResults);

	if (recommendation.recommendedIndex === null) {
		await persistProbeChangesIfNeeded();
		if (options.json) {
			console.log(JSON.stringify({
				error: recommendation.reason,
				...(probeErrors.length > 0 ? { probeErrors } : {}),
			}, null, 2));
		} else {
			console.log(`No best account available: ${recommendation.reason}`);
			printProbeNotes();
		}
		return 1;
	}

	const bestIndex = recommendation.recommendedIndex;
	const bestAccount = storage.accounts[bestIndex];
	if (!bestAccount) {
		await persistProbeChangesIfNeeded();
		if (options.json) {
			console.log(JSON.stringify({ error: "Best account not found." }, null, 2));
		} else {
			console.log("Best account not found.");
		}
		return 1;
	}

	const currentIndex = helpers.resolveActiveIndex(storage, "codex");
	if (currentIndex === bestIndex) {
		const shouldSyncCurrentBest =
			probeRefreshedIndices.has(bestIndex) || probeIdTokenByIndex.has(bestIndex);
		let alreadyBestSynced: boolean | undefined;
		if (changed) {
			bestAccount.lastUsed = now;
			await persistProbeChangesIfNeeded();
		}
		if (shouldSyncCurrentBest) {
			alreadyBestSynced = await setCodexCliActiveSelection({
				accountId: bestAccount.accountId,
				email: bestAccount.email,
				accessToken: bestAccount.accessToken,
				refreshToken: bestAccount.refreshToken,
				expiresAt: bestAccount.expiresAt,
				...(probeIdTokenByIndex.has(bestIndex)
					? { idToken: probeIdTokenByIndex.get(bestIndex) }
					: {}),
			});
			if (!alreadyBestSynced && !options.json) {
				console.warn("Codex auth sync did not complete. Multi-auth routing will still use this account.");
			}
		}
		if (options.json) {
			console.log(JSON.stringify({
				message: `Already on best account: ${formatAccountLabel(bestAccount, bestIndex)}`,
				accountIndex: bestIndex + 1,
				reason: recommendation.reason,
				...(alreadyBestSynced !== undefined ? { synced: alreadyBestSynced } : {}),
				...(probeErrors.length > 0 ? { probeErrors } : {}),
			}, null, 2));
		} else {
			console.log(`Already on best account ${bestIndex + 1}: ${formatAccountLabel(bestAccount, bestIndex)}`);
			console.log(`Reason: ${recommendation.reason}`);
			printProbeNotes();
		}
		return 0;
	}

	const parsed = bestIndex + 1;
	const { synced, wasDisabled } = await persistAndSyncSelectedAccount({
		storage,
		targetIndex: bestIndex,
		parsed,
		switchReason: "best",
		initialSyncIdToken: probeIdTokenByIndex.get(bestIndex),
		helpers,
	});

	if (options.json) {
		console.log(JSON.stringify({
			message: `Switched to best account: ${formatAccountLabel(bestAccount, bestIndex)}`,
			accountIndex: parsed,
			reason: recommendation.reason,
			synced,
			wasDisabled,
			...(probeErrors.length > 0 ? { probeErrors } : {}),
		}, null, 2));
	} else {
		console.log(`Switched to best account ${parsed}: ${formatAccountLabel(bestAccount, bestIndex)}${wasDisabled ? " (re-enabled)" : ""}`);
		console.log(`Reason: ${recommendation.reason}`);
		printProbeNotes();
		if (!synced) {
			console.warn("Codex auth sync did not complete. Multi-auth routing will still use this account.");
		}
	}
	return 0;
}

export async function runAuthLogin(
	args: string[],
	deps: AuthLoginCommandDeps,
): Promise<number> {
	const parsedArgs = parseAuthLoginArgs(args);
	if (!parsedArgs.ok) {
		if (parsedArgs.message) {
			console.error(parsedArgs.message);
			printUsage();
			return 1;
		}
		return 0;
	}

	const loginOptions = parsedArgs.options;
	setStoragePath(null);
	let pendingMenuQuotaRefresh: Promise<void> | null = null;
	let menuQuotaRefreshStatus: string | undefined;
	loginFlow:
	while (true) {
		let existingStorage = await loadAccounts();
		if (existingStorage && existingStorage.accounts.length > 0) {
			while (true) {
				existingStorage = await loadAccounts();
				if (!existingStorage || existingStorage.accounts.length === 0) {
					break;
				}
				const currentStorage = existingStorage;
				const displaySettings = await loadDashboardDisplaySettings();
				applyUiThemeFromDashboardSettings(displaySettings);
				const quotaCache = await loadQuotaCache();
				const shouldAutoFetchLimits = displaySettings.menuAutoFetchLimits ?? true;
				const showFetchStatus = displaySettings.menuShowFetchStatus ?? true;
				const quotaTtlMs =
					displaySettings.menuQuotaTtlMs ?? deps.defaultMenuQuotaRefreshTtlMs;
				if (shouldAutoFetchLimits && !pendingMenuQuotaRefresh) {
					const staleCount = deps.countMenuQuotaRefreshTargets(
						currentStorage,
						quotaCache,
						quotaTtlMs,
					);
					if (staleCount > 0) {
						if (showFetchStatus) {
							menuQuotaRefreshStatus = `${UI_COPY.mainMenu.loadingLimits} [0/${staleCount}]`;
						}
						pendingMenuQuotaRefresh = deps.refreshQuotaCacheForMenu(
							currentStorage,
							quotaCache,
							quotaTtlMs,
							(current, total) => {
								if (!showFetchStatus) return;
								menuQuotaRefreshStatus = `${UI_COPY.mainMenu.loadingLimits} [${current}/${total}]`;
							},
						)
							.then(() => undefined)
							.catch(() => undefined)
							.finally(() => {
								menuQuotaRefreshStatus = undefined;
								pendingMenuQuotaRefresh = null;
							});
					}
				}
				const flaggedStorage = await loadFlaggedAccounts();

				const menuResult = await promptLoginMode(
					deps.toExistingAccountInfo(currentStorage, quotaCache, displaySettings),
					{
						flaggedCount: flaggedStorage.accounts.length,
						statusMessage: showFetchStatus ? () => menuQuotaRefreshStatus : undefined,
					},
				);

				if (menuResult.mode === "cancel") {
					console.log("Cancelled.");
					return 0;
				}
				if (menuResult.mode === "check") {
					await deps.runActionPanel("Quick Check", "Checking local session + live status", async () => {
						await deps.runHealthCheck({ forceRefresh: false, liveProbe: true });
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "deep-check") {
					await deps.runActionPanel("Deep Check", "Refreshing and testing all accounts", async () => {
						await deps.runHealthCheck({ forceRefresh: true, liveProbe: true });
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "forecast") {
					await deps.runActionPanel("Best Account", "Comparing accounts", async () => {
						await deps.runForecast(["--live"]);
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "fix") {
					await deps.runActionPanel("Auto-Fix", "Checking and fixing common issues", async () => {
						await deps.runFix(["--live"]);
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "settings") {
					await configureUnifiedSettings(displaySettings);
					continue;
				}
				if (menuResult.mode === "verify-flagged") {
					await deps.runActionPanel("Problem Account Check", "Checking problem accounts", async () => {
						await deps.runVerifyFlagged([]);
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "fresh" && menuResult.deleteAll) {
					await deps.runActionPanel("Reset Accounts", "Deleting all saved accounts", async () => {
						await deps.clearAccountsAndReset();
						console.log("Cleared saved accounts from active storage. Recovery snapshots remain available.");
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "manage") {
					const requiresInteractiveOAuth = typeof menuResult.refreshAccountIndex === "number";
					if (requiresInteractiveOAuth) {
						await deps.handleManageAction(currentStorage, menuResult);
						continue;
					}
					await deps.runActionPanel("Applying Change", "Updating selected account", async () => {
						await deps.handleManageAction(currentStorage, menuResult);
					}, displaySettings);
					continue;
				}
				if (menuResult.mode === "add") {
					break;
				}
			}
		}

		const refreshedStorage = await loadAccounts();
		let existingCount = refreshedStorage?.accounts.length ?? 0;
		let forceNewLogin = existingCount > 0;
		let onboardingBackupDiscoveryWarning: string | null = null;
		const loadNamedBackupsForOnboarding = async (): Promise<NamedBackupSummary[]> => {
			if (existingCount > 0) {
				onboardingBackupDiscoveryWarning = null;
				return [];
			}
			try {
				onboardingBackupDiscoveryWarning = null;
				return await getNamedBackups();
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				deps.log.debug("getNamedBackups failed, skipping restore option", {
					code,
					error: error instanceof Error ? error.message : String(error),
				});
				if (code && code !== "ENOENT") {
					onboardingBackupDiscoveryWarning =
						"Named backup discovery failed. Continuing with browser or manual sign-in only.";
					console.warn(onboardingBackupDiscoveryWarning);
				} else {
					onboardingBackupDiscoveryWarning = null;
				}
				return [];
			}
		};
		let namedBackups = await loadNamedBackupsForOnboarding();
		while (true) {
			const latestNamedBackup = namedBackups[0] ?? null;
			const preferManualMode = loginOptions.manual || isBrowserLaunchSuppressed();
			const signInMode = preferManualMode
				? "manual"
				: await deps.promptOAuthSignInMode(
					latestNamedBackup,
					onboardingBackupDiscoveryWarning,
				);
			if (signInMode === "cancel") {
				if (existingCount > 0) {
					console.log(deps.stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"));
					continue loginFlow;
				}
				console.log("Cancelled.");
				return 0;
			}
			if (signInMode === "restore-backup") {
				const latestAvailableBackup = namedBackups[0] ?? null;
				if (!latestAvailableBackup) {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}
				const restoreMode = await deps.promptBackupRestoreMode(latestAvailableBackup);
				if (restoreMode === "back") {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const selectedBackup = restoreMode === "manual"
					? await deps.promptManualBackupSelection(namedBackups)
					: latestAvailableBackup;
				if (!selectedBackup) {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const confirmed = await confirm(
					UI_COPY.oauth.restoreBackupConfirm(
						selectedBackup.fileName,
						selectedBackup.accountCount,
					),
				);
				if (!confirmed) {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const displaySettings = await loadDashboardDisplaySettings();
				applyUiThemeFromDashboardSettings(displaySettings);
				try {
					await deps.runActionPanel(
						"Load Backup",
						`Loading ${selectedBackup.fileName}`,
						async () => {
							const restoredStorage = await restoreAccountsFromBackup(
								selectedBackup.path,
								{ persist: false },
							);
							const targetIndex = deps.resolveActiveIndex(restoredStorage);
							const { synced } = await persistAndSyncSelectedAccount({
								storage: restoredStorage,
								targetIndex,
								parsed: targetIndex + 1,
								switchReason: "restore",
								preserveActiveIndexByFamily: true,
								helpers: deps,
							});
							console.log(
								UI_COPY.oauth.restoreBackupLoaded(
									selectedBackup.fileName,
									restoredStorage.accounts.length,
								),
							);
							if (!synced) {
								console.warn(UI_COPY.oauth.restoreBackupSyncWarning);
							}
						},
						displaySettings,
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (error instanceof StorageError) {
						console.error(formatStorageErrorHint(error, selectedBackup.path));
					} else {
						console.error(`Backup restore failed: ${message}`);
					}
					const storageAfterRestoreAttempt = await loadAccounts().catch(() => null);
					if ((storageAfterRestoreAttempt?.accounts.length ?? 0) > 0) {
						continue loginFlow;
					}
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}
				continue loginFlow;
			}

			if (signInMode !== "browser" && signInMode !== "manual") {
				continue;
			}

			const tokenResult = await deps.runOAuthFlow(forceNewLogin, signInMode);
			if (tokenResult.type !== "success") {
				const message = tokenResult.message ?? tokenResult.reason ?? "unknown error";
				if (message.toLowerCase().includes("cancelled")) {
					if (existingCount > 0) {
						console.log(deps.stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"));
						continue loginFlow;
					}
					console.log("Cancelled.");
					return 0;
				}
				console.error(`Login failed: ${message}`);
				return 1;
			}

			const resolved = deps.resolveAccountSelection(tokenResult);
			await deps.persistAccountPool([resolved], false);
			await deps.syncSelectionToCodex(resolved);

			const latestStorage = await loadAccounts();
			const count = latestStorage?.accounts.length ?? 1;
			existingCount = count;
			namedBackups = [];
			onboardingBackupDiscoveryWarning = null;
			console.log(`Added account. Total: ${count}`);
			console.log("Next steps:");
			console.log("  codex auth status  Check that the wrapper is active.");
			console.log("  codex auth check   Confirm your saved accounts look healthy.");
			console.log("  codex auth list    Review saved accounts before switching.");
			if (count >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
				console.log(`Reached maximum account limit (${ACCOUNT_LIMITS.MAX_ACCOUNTS}).`);
				break;
			}

			const addAnother = await promptAddAnotherAccount(count);
			if (!addAnother) break;
			forceNewLogin = true;
		}
		continue loginFlow;
	}
}
