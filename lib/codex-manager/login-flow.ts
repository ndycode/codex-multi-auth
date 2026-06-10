import { isBrowserLaunchSuppressed } from "../auth/browser.js";
import { promptAddAnotherAccount, promptLoginMode } from "../cli.js";
import { ACCOUNT_LIMITS } from "../constants.js";
import { loadDashboardDisplaySettings } from "../dashboard-settings.js";
import { createLogger } from "../logger.js";
import { loadQuotaCache } from "../quota-cache.js";
import { resolveActiveIndex } from "../runtime/account-status.js";
import {
	clearAccounts,
	formatStorageErrorHint,
	getNamedBackups,
	loadAccounts,
	loadFlaggedAccounts,
	type NamedBackupSummary,
	restoreAccountsFromBackup,
	setStoragePath,
	StorageError,
} from "../storage.js";
import { UI_COPY } from "../ui/ui-copy.js";
import { confirm } from "../ui/confirm.js";
import { stylePromptText } from "./formatters/index.js";
import { runHealthCheck } from "./health-check.js";
import {
	type AuthLoginOptions,
	parseAuthLoginArgs,
	printUsage,
} from "./help.js";
import { runActionPanel } from "./login-action-panel.js";
import {
	handleManageAction,
	promptBackupRestoreMode,
	promptManualBackupSelection,
	promptOAuthSignInMode,
} from "./login-menu-actions.js";
import {
	countMenuQuotaRefreshTargets,
	DEFAULT_MENU_QUOTA_REFRESH_TTL_MS,
	loadRuntimeCurrentSelectionForStorage,
	refreshQuotaCacheForMenu,
	syncCodexCliActiveSelectionIfDrifted,
	toExistingAccountInfo,
} from "./login-menu-data.js";
import {
	isOAuthCancellation,
	type OAuthSignInMode,
	persistAccountPool,
	resolveAccountSelection,
	runSignInFlow,
	syncSelectionToCodex,
} from "./login-oauth.js";
import { persistAndSyncSelectedAccount } from "./persist-selected-account.js";
import {
	type RepairCommandDeps,
	runFix as runRepairFix,
	runVerifyFlagged as runRepairVerifyFlagged,
} from "./repair-commands.js";
import {
	applyUiThemeFromDashboardSettings,
	configureUnifiedSettings,
} from "./settings-hub.js";

/**
 * Interactive control loop for the `login` command: the account dashboard menu
 * and the add-account/onboarding flow. Moved verbatim out of
 * lib/codex-manager.ts (audit roadmap §4.1.1 phase 4); the menu quota-refresh
 * bookkeeping that previously lived in closure-mutable variables is now an
 * explicit {@link MenuQuotaRefreshState} created in runAuthLoginFlow and passed
 * through.
 */

/** @internal */
export interface LoginFlowDeps {
	runForecast(args: string[]): Promise<number>;
	createRepairCommandDeps(): RepairCommandDeps;
}

interface MenuQuotaRefreshState {
	pendingMenuQuotaRefresh: Promise<void> | null;
	menuQuotaRefreshStatus: string | undefined;
	skipNextMenuQuotaAutoRefresh: boolean;
	menuQuotaRefreshGeneration: number;
}

function clearMenuQuotaAutoRefreshSkip(state: MenuQuotaRefreshState): void {
	state.skipNextMenuQuotaAutoRefresh = false;
	state.menuQuotaRefreshGeneration += 1;
}

// The menu quota refresh runs fire-and-forget behind the dashboard. On the
// paths that leave the loop (add-account's storage write, process exit) an
// in-flight refresh must finish first so its cache save cannot race the
// account-pool write (Windows EBUSY/EPERM on sibling files) or be orphaned
// mid-write. The chain never rejects (it ends in .catch/.finally), and the
// wait is bounded by the per-probe HTTP timeouts.
async function drainPendingMenuQuotaRefresh(
	state: MenuQuotaRefreshState,
): Promise<void> {
	if (state.pendingMenuQuotaRefresh) {
		await state.pendingMenuQuotaRefresh;
	}
}

const log = createLogger("codex-manager");

async function clearAccountsAndReset(): Promise<void> {
	await clearAccounts();
}

/** @internal */
export async function runAuthLogin(
	args: string[],
	deps: LoginFlowDeps,
): Promise<number> {
	const parsedArgs = parseAuthLoginArgs(args);
	if (!parsedArgs.ok) {
		if (parsedArgs.reason === "error") {
			console.error(parsedArgs.message);
			printUsage();
			return 1;
		}
		return 0;
	}

	const loginOptions = parsedArgs.options;
	// `--org <id>` binds this login to a specific workspace/org so the same
	// email's personal vs business/team workspace can be registered on demand
	// (issue #491). The org is threaded explicitly into resolveAccountSelection
	// (no process.env mutation), so concurrent re-entry (menu re-entry, a reused
	// test worker) can never bind a login to a stale org via a shared global.
	if (loginOptions.org) {
		console.log(`Binding this login to workspace org id: ${loginOptions.org}`);
	}
	return runAuthLoginFlow(loginOptions, deps);
}

async function runLoginDashboardLoop(
	menuState: MenuQuotaRefreshState,
	deps: LoginFlowDeps,
): Promise<"add-account" | "exit"> {
	while (true) {
		const existingStorage = await loadAccounts();
		if (!existingStorage || existingStorage.accounts.length === 0) {
			await drainPendingMenuQuotaRefresh(menuState);
			return "add-account";
		}
		const currentStorage = existingStorage;
		const displaySettings = await loadDashboardDisplaySettings();
		applyUiThemeFromDashboardSettings(displaySettings);
		const quotaCache = await loadQuotaCache();
		const shouldAutoFetchLimits =
			displaySettings.menuAutoFetchLimits ?? true;
		const showFetchStatus = displaySettings.menuShowFetchStatus ?? true;
		const quotaTtlMs =
			displaySettings.menuQuotaTtlMs ?? DEFAULT_MENU_QUOTA_REFRESH_TTL_MS;
		const shouldSkipAutoFetchThisPass =
			!menuState.pendingMenuQuotaRefresh &&
			menuState.skipNextMenuQuotaAutoRefresh;
		if (shouldSkipAutoFetchThisPass) {
			menuState.skipNextMenuQuotaAutoRefresh = false;
		}
		if (
			shouldAutoFetchLimits &&
			!menuState.pendingMenuQuotaRefresh &&
			!shouldSkipAutoFetchThisPass
		) {
			const staleCount = countMenuQuotaRefreshTargets(
				currentStorage,
				quotaCache,
				quotaTtlMs,
			);
			if (staleCount > 0) {
				if (showFetchStatus) {
					menuState.menuQuotaRefreshStatus = `${UI_COPY.mainMenu.loadingLimits} [0/${staleCount}]`;
				}
				const refreshGeneration = menuState.menuQuotaRefreshGeneration;
				menuState.pendingMenuQuotaRefresh = refreshQuotaCacheForMenu(
					currentStorage,
					quotaCache,
					quotaTtlMs,
					(current, total) => {
						if (!showFetchStatus) return;
						menuState.menuQuotaRefreshStatus = `${UI_COPY.mainMenu.loadingLimits} [${current}/${total}]`;
					},
				)
					.then(() => {
						if (refreshGeneration === menuState.menuQuotaRefreshGeneration) {
							menuState.skipNextMenuQuotaAutoRefresh = true;
						}
						return undefined;
					})
					.catch(() => undefined)
					.finally(() => {
						menuState.menuQuotaRefreshStatus = undefined;
						menuState.pendingMenuQuotaRefresh = null;
					});
			}
		}
		const flaggedStorage = await loadFlaggedAccounts();
		await syncCodexCliActiveSelectionIfDrifted(currentStorage);
		const runtimeCurrent = await loadRuntimeCurrentSelectionForStorage(
			currentStorage,
		);

		const menuResult = await promptLoginMode(
			toExistingAccountInfo(
				currentStorage,
				quotaCache,
				displaySettings,
				runtimeCurrent,
			),
			{
				flaggedCount: flaggedStorage.accounts.length,
				statusMessage: showFetchStatus
					? () => menuState.menuQuotaRefreshStatus
					: undefined,
			},
		);

		if (menuResult.mode === "cancel") {
			console.log("Cancelled.");
			await drainPendingMenuQuotaRefresh(menuState);
			return "exit";
		}
		if (menuResult.mode === "check") {
			clearMenuQuotaAutoRefreshSkip(menuState);
			await runActionPanel(
				"Quick Check",
				"Checking local session + live status",
				async () => {
					await runHealthCheck({ forceRefresh: false, liveProbe: true });
				},
				displaySettings,
			);
			continue;
		}
		if (menuResult.mode === "deep-check") {
			clearMenuQuotaAutoRefreshSkip(menuState);
			await runActionPanel(
				"Deep Check",
				"Refreshing and testing all accounts",
				async () => {
					await runHealthCheck({ forceRefresh: true, liveProbe: true });
				},
				displaySettings,
			);
			continue;
		}
		if (menuResult.mode === "forecast") {
			clearMenuQuotaAutoRefreshSkip(menuState);
			await runActionPanel(
				"Best Account",
				"Comparing accounts",
				async () => {
					await deps.runForecast(["--live"]);
				},
				displaySettings,
			);
			continue;
		}
		if (menuResult.mode === "fix") {
			clearMenuQuotaAutoRefreshSkip(menuState);
			await runActionPanel(
				"Auto-Fix",
				"Checking and fixing common issues",
				async () => {
					await runRepairFix(["--live"], deps.createRepairCommandDeps());
				},
				displaySettings,
			);
			continue;
		}
		if (menuResult.mode === "settings") {
			clearMenuQuotaAutoRefreshSkip(menuState);
			await configureUnifiedSettings(displaySettings);
			continue;
		}
		if (menuResult.mode === "verify-flagged") {
			clearMenuQuotaAutoRefreshSkip(menuState);
			await runActionPanel(
				"Problem Account Check",
				"Checking problem accounts",
				async () => {
					await runRepairVerifyFlagged([], deps.createRepairCommandDeps());
				},
				displaySettings,
			);
			continue;
		}
		if (menuResult.mode === "fresh" && menuResult.deleteAll) {
			clearMenuQuotaAutoRefreshSkip(menuState);
			await runActionPanel(
				"Reset Accounts",
				"Deleting all saved accounts",
				async () => {
					await clearAccountsAndReset();
					console.log(
						"Cleared saved accounts from active storage. Recovery snapshots remain available.",
					);
				},
				displaySettings,
			);
			continue;
		}
		if (menuResult.mode === "manage") {
			clearMenuQuotaAutoRefreshSkip(menuState);
			const requiresInteractiveOAuth =
				typeof menuResult.refreshAccountIndex === "number";
			if (requiresInteractiveOAuth) {
				await handleManageAction(currentStorage, menuResult);
				continue;
			}
			await runActionPanel(
				"Applying Change",
				"Updating selected account",
				async () => {
					await handleManageAction(currentStorage, menuResult);
				},
				displaySettings,
			);
			continue;
		}
		if (menuResult.mode === "add") {
			await drainPendingMenuQuotaRefresh(menuState);
			return "add-account";
		}
	}
}

async function runAuthLoginFlow(
	loginOptions: AuthLoginOptions,
	deps: LoginFlowDeps,
): Promise<number> {
	setStoragePath(null);
	const menuState: MenuQuotaRefreshState = {
		pendingMenuQuotaRefresh: null,
		menuQuotaRefreshStatus: undefined,
		skipNextMenuQuotaAutoRefresh: false,
		menuQuotaRefreshGeneration: 0,
	};
	// When the user explicitly picks a sign-in transport on the command line
	// (--device-auth, --manual, --no-browser), they want to add a new account
	// directly. Skipping the dashboard menu keeps `login --device-auth`
	// usable from scripts and matches the documented behavior of the help text.
	const explicitSignInMode = loginOptions.deviceAuth || loginOptions.manual;
	loginFlow: while (true) {
		const existingStorage = await loadAccounts();
		if (
			!explicitSignInMode &&
			existingStorage &&
			existingStorage.accounts.length > 0
		) {
			const dashboardOutcome = await runLoginDashboardLoop(menuState, deps);
			if (dashboardOutcome === "exit") {
				return 0;
			}
		}

		const refreshedStorage = await loadAccounts();
		let existingCount = refreshedStorage?.accounts.length ?? 0;
		let forceNewLogin = existingCount > 0;
		let onboardingBackupDiscoveryWarning: string | null = null;
		const loadNamedBackupsForOnboarding = async (): Promise<
			NamedBackupSummary[]
		> => {
			if (existingCount > 0) {
				onboardingBackupDiscoveryWarning = null;
				return [];
			}
			try {
				onboardingBackupDiscoveryWarning = null;
				return await getNamedBackups();
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				log.debug("getNamedBackups failed, skipping restore option", {
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
			const preferManualMode =
				loginOptions.manual || isBrowserLaunchSuppressed();
			const signInMode: OAuthSignInMode = loginOptions.deviceAuth
				? "device"
				: preferManualMode
					? "manual"
					: await promptOAuthSignInMode(
							latestNamedBackup,
							onboardingBackupDiscoveryWarning,
						);
			if (signInMode === "cancel") {
				if (existingCount > 0) {
					console.log(
						stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"),
					);
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
				const restoreMode = await promptBackupRestoreMode(
					latestAvailableBackup,
				);
				if (restoreMode === "back") {
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}

				const selectedBackup =
					restoreMode === "manual"
						? await promptManualBackupSelection(namedBackups)
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
					await runActionPanel(
						"Load Backup",
						`Loading ${selectedBackup.fileName}`,
						async () => {
							const restoredStorage = await restoreAccountsFromBackup(
								selectedBackup.path,
								{ persist: false },
							);
							const targetIndex = resolveActiveIndex(restoredStorage);
							const { synced } = await persistAndSyncSelectedAccount({
								storage: restoredStorage,
								targetIndex,
								parsed: targetIndex + 1,
								switchReason: "restore",
								preserveActiveIndexByFamily: true,
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
					const message =
						error instanceof Error ? error.message : String(error);
					if (error instanceof StorageError) {
						console.error(formatStorageErrorHint(error, selectedBackup.path));
					} else {
						console.error(`Backup restore failed: ${message}`);
					}
					const storageAfterRestoreAttempt = await loadAccounts().catch(
						() => null,
					);
					if ((storageAfterRestoreAttempt?.accounts.length ?? 0) > 0) {
						continue loginFlow;
					}
					namedBackups = await loadNamedBackupsForOnboarding();
					continue;
				}
				continue loginFlow;
			}

			if (
				signInMode !== "browser" &&
				signInMode !== "manual" &&
				signInMode !== "device"
			) {
				continue;
			}

			const tokenResult = await runSignInFlow(forceNewLogin, signInMode);
			if (tokenResult.type !== "success") {
				if (isOAuthCancellation(tokenResult)) {
					// In explicit-mode invocations the dashboard was bypassed,
					// so falling back to it on cancel would re-enter the same
					// transport flow and trap the user. Exit cleanly instead.
					if (explicitSignInMode) {
						console.log("Cancelled.");
						return 0;
					}
					if (existingCount > 0) {
						console.log(
							stylePromptText(UI_COPY.oauth.cancelledBackToMenu, "muted"),
						);
						continue loginFlow;
					}
					console.log("Cancelled.");
					return 0;
				}
				console.error(
					`Login failed: ${tokenResult.message ?? tokenResult.reason ?? "unknown error"}`,
				);
				return 1;
			}

			const resolved = resolveAccountSelection(tokenResult, loginOptions.org);
			const persistOutcome = await persistAccountPool([resolved], false);
			await syncSelectionToCodex(resolved);

			const latestStorage = await loadAccounts();
			const count = latestStorage?.accounts.length ?? 1;
			existingCount = count;
			namedBackups = [];
			onboardingBackupDiscoveryWarning = null;
			// Only claim a new saved slot when one was actually appended. A
			// same-email login that maps onto an existing entry updates or
			// rebinds it instead of growing the pool (issue #512).
			const outcomeMessage =
				persistOutcome === "rebound"
					? `Rebound workspace for existing account. Total: ${count}`
					: persistOutcome === "updated"
						? `Updated existing account. Total: ${count}`
						: `Added account. Total: ${count}`;
			console.log(outcomeMessage);
			console.log("Next steps:");
			console.log("  codex-multi-auth status  Check that the wrapper is active.");
			console.log(
				"  codex-multi-auth check   Confirm your saved accounts look healthy.",
			);
			console.log(
				"  codex-multi-auth list    Review saved accounts before switching.",
			);
			if (count >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
				console.log(
					`Reached maximum account limit (${ACCOUNT_LIMITS.MAX_ACCOUNTS}).`,
				);
				// Same reasoning as the addAnother=false branch below: in
				// explicit mode the dashboard is bypassed, so falling out of
				// the inner loop would re-enter loginFlow and silently start
				// another sign-in session despite the cap.
				if (explicitSignInMode) {
					return 0;
				}
				break;
			}

			const addAnother = await promptAddAnotherAccount(count);
			if (!addAnother) {
				// With an explicit transport flag the dashboard was bypassed,
				// so falling back to it after declining would loop into a fresh
				// sign-in instead of exiting. Return directly in that case.
				if (explicitSignInMode) {
					return 0;
				}
				break;
			}
			forceNewLogin = true;
		}
	}
}
