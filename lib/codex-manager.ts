import {
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	formatWaitTime,
	sanitizeEmail,
} from "./accounts.js";
import { loadCodexCliState } from "./codex-cli/state.js";
import { setCodexCliActiveSelection } from "./codex-cli/writer.js";
import {
	parseBestArgs,
	printBestUsage,
	runBestCommand,
} from "./codex-manager/commands/best.js";
import {
	applyTokenAccountIdentity,
	hasLikelyInvalidRefreshToken,
	hasUsableAccessToken,
	resolveStoredAccountIdentity,
} from "./codex-manager/account-credentials.js";
import { runHealthCheck } from "./codex-manager/health-check.js";
import { runAuthLogin } from "./codex-manager/login-flow.js";
import { persistAndSyncSelectedAccount } from "./codex-manager/persist-selected-account.js";
import {
	cloneQuotaCacheData,
	pruneUnsafeQuotaEmailCacheEntry,
	updateQuotaCacheForAccount,
} from "./codex-manager/quota-cache-helpers.js";
import { runAccountCommand } from "./codex-manager/commands/account.js";
import { ACCOUNT_MANAGER_COMMANDS } from "./codex-manager/account-manager-commands.js";
import { ensureFirstRunSetup } from "./runtime/first-run.js";
import { runBudgetCommand } from "./codex-manager/commands/budget.js";
import { runBridgeCommand } from "./codex-manager/commands/bridge.js";
import { runCheckCommand } from "./codex-manager/commands/check.js";
import { runIntegrationsCommand } from "./codex-manager/commands/integrations.js";
import { runModelsCommand } from "./codex-manager/commands/models.js";
import { runMonitorCommand } from "./codex-manager/commands/monitor.js";
import { runConfigExplainCommand } from "./codex-manager/commands/config-explain.js";
import { runDebugBundleCommand } from "./codex-manager/commands/debug-bundle.js";
import {
	parseWhySelectedArgs,
	printWhySelectedUsage,
	runWhySelectedCommand,
} from "./codex-manager/commands/why-selected.js";
import {
	parseVerifyArgs,
	printVerifyUsage,
	runVerifyCommand,
} from "./codex-manager/commands/verify.js";
import {
	findProjectRoot,
	getProjectConfigDir,
	getProjectGlobalConfigDir,
	getProjectStorageKey,
	resolveProjectStorageIdentityRoot,
	resolvePath as resolveStoragePath,
} from "./storage/paths.js";
import {
	type AccountWithMetrics,
	getHealthTracker,
	getTokenTracker,
	selectHybridAccountTraced,
} from "./rotation.js";
import {
	runDoctor as runRepairDoctor,
	type RepairCommandDeps,
	runFix as runRepairFix,
	runVerifyFlagged as runRepairVerifyFlagged,
} from "./codex-manager/repair-commands.js";
import { runUninstallCommand } from "./codex-manager/commands/uninstall.js";
import { runForecastCommand } from "./codex-manager/commands/forecast.js";
import { runInitConfigCommand } from "./codex-manager/commands/init-config.js";
import { runReportCommand } from "./codex-manager/commands/report.js";
import { runRotationCommand } from "./codex-manager/commands/rotation.js";
import {
	runFeaturesCommand,
	runStatusCommand,
} from "./codex-manager/commands/status.js";
import { loadPersistedRuntimeObservabilitySnapshot } from "./runtime/runtime-observability.js";
import { runSwitchCommand } from "./codex-manager/commands/switch.js";
import { runUnpinCommand } from "./codex-manager/commands/unpin.js";
import { runWorkspaceCommand } from "./codex-manager/commands/workspace.js";
import { runUsageCommand } from "./codex-manager/commands/usage.js";
import { printUsage } from "./codex-manager/help.js";
import {
	availabilityTone,
	formatBackupSavedAt,
	formatCompactQuotaSnapshot,
	formatRateLimitEntry,
	formatResultSummary,
	normalizeFailureDetail,
	riskTone,
	styleAccountDetailText,
	stylePromptText,
	styleQuotaSummary,
} from "./codex-manager/formatters/index.js";
import { applyUiThemeFromDashboardSettings } from "./codex-manager/settings-hub.js";
import {
	getCodexRuntimeRotationProxy,
	getPluginConfigExplainReport,
	loadPluginConfig,
	savePluginConfig,
} from "./config.js";
import {
	bindCodexAppRuntimeRotation,
	getAppBindStatus,
	unbindCodexAppRuntimeRotation,
} from "./runtime/app-bind.js";
import {
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	loadDashboardDisplaySettings,
} from "./dashboard-settings.js";
import {
	evaluateForecastAccounts,
	recommendForecastAccount,
	summarizeForecast,
} from "./forecast.js";
import { resolveActiveIndex } from "./runtime/account-status.js";
import { buildQuotaEmailFallbackState } from "./quota-readiness.js";
import { loadQuotaCache, saveQuotaCache } from "./quota-cache.js";
import { readAppRuntimeHelperAccountSignal } from "./runtime/runtime-current-account.js";
import {
	fetchCodexQuotaSnapshot,
	formatQuotaSnapshotLine,
} from "./quota-probe.js";
import { queuedRefresh } from "./refresh-queue.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	clearAccounts,
	findMatchingAccountIndex,
	inspectStorageHealth,
	getLastAccountsSaveTimestamp,
	getStoragePath,
	loadAccounts,
	loadFlaggedAccounts,
	saveAccounts,
	setStoragePath,
	withAccountStorageTransaction,
} from "./storage.js";

// Formatter implementations moved to lib/codex-manager/formatters/ (audit
// roadmap §4.1.1 phase 1). Re-exported here so existing consumers importing
// from lib/codex-manager.js keep working unchanged.
export { formatBackupSavedAt, styleAccountDetailText };

function createRepairCommandDeps(): RepairCommandDeps {
	return {
		stylePromptText,
		styleAccountDetailText,
		formatResultSummary,
		resolveActiveIndex,
		hasUsableAccessToken,
		hasLikelyInvalidRefreshToken,
		normalizeFailureDetail,
		buildQuotaEmailFallbackState,
		updateQuotaCacheForAccount,
		cloneQuotaCacheData,
		pruneUnsafeQuotaEmailCacheEntry,
		formatCompactQuotaSnapshot,
		resolveStoredAccountIdentity,
		applyTokenAccountIdentity,
	};
}

interface ImplementedFeature {
	id: number;
	name: string;
}

const IMPLEMENTED_FEATURES: ImplementedFeature[] = [
	{ id: 1, name: "Multi-account OAuth login dashboard" },
	{ id: 2, name: "Account add/update dedupe by token/id/email" },
	{ id: 3, name: "Set current account command" },
	{ id: 4, name: "Per-family active index handling" },
	{ id: 5, name: "Quick health check command" },
	{ id: 6, name: "Full refresh check command" },
	{ id: 7, name: "Flagged account verification command" },
	{ id: 8, name: "Flagged account restore flow" },
	{ id: 9, name: "Best account forecast engine" },
	{ id: 10, name: "Forecast live quota probing" },
	{ id: 11, name: "Auto-fix command (safe mode)" },
	{ id: 12, name: "Doctor diagnostics command" },
	{ id: 13, name: "JSON outputs for machine automation" },
	{ id: 14, name: "Report generation command" },
	{ id: 15, name: "Storage v3 normalization and migration" },
	{ id: 16, name: "Storage backup and recovery journal" },
	{ id: 17, name: "Project-scoped and global storage paths" },
	{ id: 18, name: "Quota cache storage" },
	{ id: 19, name: "Live account sync watcher" },
	{ id: 20, name: "Session affinity store" },
	{ id: 21, name: "Refresh queue dedupe (in-process)" },
	{ id: 22, name: "Refresh lease dedupe (cross-process)" },
	{ id: 23, name: "Token rotation mapping in refresh queue" },
	{ id: 24, name: "Refresh guardian (proactive refresh)" },
	{ id: 25, name: "Preemptive quota scheduler" },
	{ id: 26, name: "Entitlement cache for unsupported models" },
	{ id: 27, name: "Capability policy scoring store" },
	{ id: 28, name: "Failure policy evaluation module" },
	{ id: 29, name: "Streaming failover pipeline" },
	{ id: 30, name: "Rate-limit backoff and cooldown handling" },
	{ id: 31, name: "Host request transformer bridge" },
	{ id: 32, name: "Prompt template sync with cache" },
	{ id: 33, name: "Codex CLI active-account state sync" },
	{ id: 34, name: "TUI quick-switch hotkeys (1-9)" },
	{ id: 35, name: "TUI search and help toggles" },
	{ id: 36, name: "TUI account detail hotkeys (S/R/E/D)" },
	{ id: 37, name: "TUI settings hub (list/summary/behavior/theme)" },
	{ id: 38, name: "Dashboard display customization" },
	{ id: 39, name: "Unified color/theme runtime (v2 UI)" },
	{ id: 40, name: "OAuth browser-first flow with manual callback fallback" },
	{ id: 41, name: "Auto-switch to best account command" },
];

async function runForecast(args: string[]): Promise<number> {
	return runForecastCommand(args, {
		setStoragePath,
		loadAccounts,
		saveAccounts,
		loadDashboardDisplaySettings,
		resolveActiveIndex,
		loadQuotaCache,
		saveQuotaCache,
		cloneQuotaCacheData,
		buildQuotaEmailFallbackState,
		updateQuotaCacheForAccount,
		hasUsableAccessToken,
		queuedRefresh,
		fetchCodexQuotaSnapshot,
		normalizeFailureDetail,
		formatAccountLabel,
		extractAccountId,
		evaluateForecastAccounts,
		summarizeForecast,
		recommendForecastAccount,
		stylePromptText,
		formatResultSummary,
		styleQuotaSummary,
		formatCompactQuotaSnapshot,
		availabilityTone,
		riskTone,
		formatWaitTime,
		defaultDisplay: DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
		formatQuotaSnapshotLine,
		loadRuntimeObservabilitySnapshot: loadPersistedRuntimeObservabilitySnapshot,
	});
}

async function runBest(args: string[]): Promise<number> {
	return runBestCommand(args, {
		setStoragePath,
		loadAccounts,
		saveAccounts,
		parseBestArgs,
		printBestUsage,
		resolveActiveIndex,
		hasUsableAccessToken,
		queuedRefresh,
		normalizeFailureDetail,
		extractAccountId,
		extractAccountEmail,
		sanitizeEmail,
		formatAccountLabel,
		fetchCodexQuotaSnapshot,
		evaluateForecastAccounts,
		recommendForecastAccount,
		persistAndSyncSelectedAccount,
		setCodexCliActiveSelection,
	});
}

export async function autoSyncActiveAccountToCodex(): Promise<boolean> {
	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		return false;
	}

	const activeIndex = resolveActiveIndex(storage, "codex");
	if (activeIndex < 0 || activeIndex >= storage.accounts.length) {
		return false;
	}

	const account = storage.accounts[activeIndex];
	if (!account) {
		return false;
	}
	const accountMatch = {
		accountId: account.accountId,
		email: account.email,
		refreshToken: account.refreshToken,
	};

	const now = Date.now();
	let syncAccessToken = account.accessToken;
	let syncRefreshToken = account.refreshToken;
	let syncExpiresAt = account.expiresAt;
	let syncIdToken: string | undefined;
	let syncAccountId = account.accountId;
	let syncEmail = account.email;
	let changed = false;
	let nextStoredAccount: AccountMetadataV3 | null = null;

	if (!hasUsableAccessToken(account, now)) {
		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type !== "success") {
			return false;
		}
		nextStoredAccount = structuredClone(account);
		const tokenAccountId = extractAccountId(refreshResult.access);
		const nextEmail = sanitizeEmail(
			extractAccountEmail(refreshResult.access, refreshResult.idToken),
		);
		if (nextStoredAccount.refreshToken !== refreshResult.refresh) {
			nextStoredAccount.refreshToken = refreshResult.refresh;
			changed = true;
		}
		if (nextStoredAccount.accessToken !== refreshResult.access) {
			nextStoredAccount.accessToken = refreshResult.access;
			changed = true;
		}
		if (nextStoredAccount.expiresAt !== refreshResult.expires) {
			nextStoredAccount.expiresAt = refreshResult.expires;
			changed = true;
		}
		if (nextEmail && nextEmail !== nextStoredAccount.email) {
			nextStoredAccount.email = nextEmail;
			changed = true;
		}
		if (applyTokenAccountIdentity(nextStoredAccount, tokenAccountId)) {
			changed = true;
		}
		syncAccessToken = refreshResult.access;
		syncRefreshToken = refreshResult.refresh;
		syncExpiresAt = refreshResult.expires;
		syncIdToken = refreshResult.idToken;
		syncAccountId = nextStoredAccount.accountId;
		syncEmail = nextStoredAccount.email;
	}

	if (changed && nextStoredAccount) {
		let persisted = false;
		await withAccountStorageTransaction(async (loadedStorage, persist) => {
			if (!loadedStorage) {
				return;
			}
			const nextStorage = structuredClone(loadedStorage);
			const targetIndex =
				findMatchingAccountIndex(nextStorage.accounts, accountMatch, {
					allowUniqueAccountIdFallbackWithoutEmail: true,
				}) ??
				findMatchingAccountIndex(nextStorage.accounts, nextStoredAccount, {
					allowUniqueAccountIdFallbackWithoutEmail: true,
				});
			if (targetIndex === undefined) {
				return;
			}
			nextStorage.accounts[targetIndex] = structuredClone(nextStoredAccount);
			await persist(nextStorage);
			persisted = true;
		});
		if (!persisted) {
			return false;
		}
	}

	return setCodexCliActiveSelection({
		accountId: syncAccountId,
		email: syncEmail,
		accessToken: syncAccessToken,
		refreshToken: syncRefreshToken,
		expiresAt: syncExpiresAt,
		...(syncIdToken ? { idToken: syncIdToken } : {}),
	});
}
function buildSelectAccountTraced(): (
	storage: AccountStorageV3,
) => ReturnType<typeof selectHybridAccountTraced> {
	return (storage: AccountStorageV3) => {
		const now = Date.now();
		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();
		const accountsWithMetrics: AccountWithMetrics[] = storage.accounts.map(
			(account, index) => {
				const enabled = account?.enabled !== false;
				const rateLimits = account?.rateLimitResetTimes ?? {};
				let rateLimited = false;
				for (const value of Object.values(rateLimits)) {
					if (typeof value === "number" && value > now) {
						rateLimited = true;
						break;
					}
				}
				const coolingDown =
					typeof account?.coolingDownUntil === "number" &&
					account.coolingDownUntil > now;
				const isAvailable = enabled && !rateLimited && !coolingDown;
				return {
					index,
					trackerKey: account?.accountId ?? index,
					isAvailable,
					lastUsed: account?.lastUsed ?? 0,
				};
			},
		);
		return selectHybridAccountTraced({
			accounts: accountsWithMetrics,
			healthTracker,
			tokenTracker,
		});
	};
}

/**
 * Uniform handler signature for the `auth` subcommand registry: every entry
 * receives the already-parsed argument tail (everything after the subcommand)
 * and resolves to the process exit code. Dependencies are closure-captured
 * from this module exactly as the previous if/else dispatch chain did.
 */
type CliCommandHandler = (rest: string[]) => number | Promise<number>;

/**
 * Shared handler for `list` and `status` (aliases of the same view).
 */
const runListOrStatusCommand: CliCommandHandler = (rest) =>
	runStatusCommand({
		setStoragePath,
		getStoragePath,
		loadAccounts,
		inspectStorageHealth,
		resolveActiveIndex,
		formatRateLimitEntry,
		loadRuntimeObservabilitySnapshot: loadPersistedRuntimeObservabilitySnapshot,
		loadAppBindStatus: async () =>
			getAppBindStatus()
				.then((status) => (status.running ? status.router : null))
				.catch(() => null),
		loadAppHelperStatus: readAppRuntimeHelperAccountSignal,
		loadQuotaCache,
		json: rest.includes("--json") || rest.includes("-j"),
	});

/**
 * Command registry for the `auth` dispatcher (audit roadmap §4.1.1 phase 2).
 *
 * Replaces the former `if (command === …)` chain in runCodexMultiAuthCli with
 * a lookup map. Aliases (`status` → `list` view) point at the same handler.
 * Per-invocation dependency factories (createRepairCommandDeps,
 * buildSelectAccountTraced) are still invoked inside each handler so they are
 * constructed at dispatch time, not at module load — identical to the old
 * chain. Keys are exact-match and unique, so lookup order cannot change
 * semantics relative to the sequential chain it replaces.
 */
const CLI_COMMAND_HANDLERS: ReadonlyMap<string, CliCommandHandler> = new Map<
	string,
	CliCommandHandler
>([
	["login", (rest) => runAuthLogin(rest, { runForecast, createRepairCommandDeps })],
	["list", runListOrStatusCommand],
	["status", runListOrStatusCommand],
	[
		"switch",
		(rest) =>
			runSwitchCommand(rest, {
				setStoragePath,
				loadAccounts,
				persistAndSyncSelectedAccount,
			}),
	],
	[
		"unpin",
		() =>
			runUnpinCommand({
				setStoragePath,
				loadAccounts,
				saveAccounts,
				getStoragePath,
			}),
	],
	[
		"workspace",
		(rest) =>
			runWorkspaceCommand(rest, {
				setStoragePath,
				loadAccounts,
				saveAccounts,
			}),
	],
	["check", () => runCheckCommand({ runHealthCheck })],
	[
		"features",
		() => runFeaturesCommand({ implementedFeatures: IMPLEMENTED_FEATURES }),
	],
	[
		"verify-flagged",
		(rest) => runRepairVerifyFlagged(rest, createRepairCommandDeps()),
	],
	["forecast", (rest) => runForecast(rest)],
	["best", (rest) => runBest(rest)],
	[
		"account",
		(rest) =>
			runAccountCommand(rest, {
				setStoragePath,
				loadAccounts,
			}),
	],
	["budget", (rest) => runBudgetCommand(rest)],
	["bridge", (rest) => runBridgeCommand(rest)],
	["integrations", (rest) => runIntegrationsCommand(rest)],
	[
		"models",
		(rest) =>
			runModelsCommand(rest, {
				setStoragePath,
				loadAccounts,
				loadQuotaCache,
			}),
	],
	[
		"monitor",
		(rest) =>
			runMonitorCommand(rest, {
				setStoragePath,
				loadAccounts,
			}),
	],
	[
		"report",
		(rest) =>
			runReportCommand(rest, {
				setStoragePath,
				getStoragePath,
				loadAccounts,
				inspectStorageHealth,
				saveAccounts,
				resolveActiveIndex,
				hasUsableAccessToken,
				queuedRefresh,
				fetchCodexQuotaSnapshot,
				formatRateLimitEntry,
				normalizeFailureDetail,
				loadRuntimeObservabilitySnapshot:
					loadPersistedRuntimeObservabilitySnapshot,
				loadQuotaCache,
			}),
	],
	["usage", (rest) => runUsageCommand(rest)],
	[
		"rotation",
		(rest) =>
			runRotationCommand(rest, {
				loadPluginConfig,
				savePluginConfig,
				getCodexRuntimeRotationProxy,
				setStoragePath,
				getStoragePath,
				loadAccounts,
				saveAccounts,
				resolveActiveIndex,
				bindCodexApp: bindCodexAppRuntimeRotation,
				unbindCodexApp: unbindCodexAppRuntimeRotation,
				getCodexAppBindStatus: getAppBindStatus,
				loadRuntimeObservabilitySnapshot:
					loadPersistedRuntimeObservabilitySnapshot,
				loadQuotaCache,
			}),
	],
	[
		"why-selected",
		(rest) =>
			runWhySelectedCommand(rest, {
				parseWhySelectedArgs,
				printWhySelectedUsage,
				setStoragePath,
				loadAccounts,
				resolveActiveIndex,
				selectAccountTraced: buildSelectAccountTraced(),
				loadRuntimeObservabilitySnapshot: async () => {
					const snapshot = await loadPersistedRuntimeObservabilitySnapshot();
					if (!snapshot) return null;
					const generatedAt =
						typeof (snapshot as { generatedAt?: unknown }).generatedAt ===
							"number" ||
						typeof (snapshot as { generatedAt?: unknown }).generatedAt ===
							"string"
							? (snapshot as { generatedAt?: number | string }).generatedAt
							: undefined;
					return { generatedAt };
				},
				sanitizeEmail,
			}),
	],
	[
		"verify",
		(rest) =>
			runVerifyCommand(rest, {
				parseVerifyArgs,
				printVerifyUsage,
				runVerifyFlagged: async (flaggedArgs: string[]) =>
					runRepairVerifyFlagged(flaggedArgs, createRepairCommandDeps()),
				setStoragePath,
				verifyPathsDeps: {
					getCwd: () => process.cwd(),
					findProjectRoot,
					resolveProjectStorageIdentityRoot,
					getProjectStorageKey,
					getProjectConfigDir,
					getProjectGlobalConfigDir,
					resolvePath: resolveStoragePath,
				},
			}),
	],
	["fix", (rest) => runRepairFix(rest, createRepairCommandDeps())],
	["doctor", (rest) => runRepairDoctor(rest, createRepairCommandDeps())],
	["uninstall", (rest) => runUninstallCommand(rest, { clearAccounts })],
	[
		"config",
		(rest) => {
			const [subcommand, ...configArgs] = rest;
			if (subcommand === "explain") {
				return runConfigExplainCommand(configArgs, {
					getReport: getPluginConfigExplainReport,
				});
			}
			if (subcommand === "template") {
				return runInitConfigCommand(configArgs);
			}
			console.error(`Unknown config command: ${subcommand ?? "(missing)"}`);
			return 1;
		},
	],
	["init-config", (rest) => runInitConfigCommand(rest)],
	[
		"debug",
		(rest) => {
			const [subcommand, ...debugArgs] = rest;
			if (subcommand === "bundle") {
				return runDebugBundleCommand(debugArgs, {
					getConfigReport: getPluginConfigExplainReport,
					getStoragePath,
					loadAccounts,
					loadFlaggedAccounts,
					loadCodexCliState,
					getLastAccountsSaveTimestamp,
				});
			}
			console.error(`Unknown debug command: ${subcommand ?? "(missing)"}`);
			return 1;
		},
	],
]);

export async function runCodexMultiAuthCli(rawArgs: string[]): Promise<number> {
	// Lazy install setup (audit roadmap §4.5.4): app detection, Codex app bind,
	// and launcher routing moved out of npm postinstall to the first CLI run.
	// ensureFirstRunSetup never throws; the catch is belt-and-braces so no
	// command can ever fail because of first-run housekeeping.
	await ensureFirstRunSetup({
		notify: (message) => console.error(`codex-multi-auth: ${message}`),
	}).catch(() => undefined);
	const startupDisplaySettings = await loadDashboardDisplaySettings();
	applyUiThemeFromDashboardSettings(startupDisplaySettings);

	const args =
		rawArgs[0] && rawArgs[0] !== "auth" && ACCOUNT_MANAGER_COMMANDS.has(rawArgs[0])
			? ["auth", ...rawArgs]
			: [...rawArgs];
	if (args.length === 0) {
		printUsage();
		return 0;
	}
	if (args[0] === "--help" || args[0] === "-h") {
		printUsage();
		return 0;
	}

	const [root, sub, ...rest] = args;
	if (root !== "auth") {
		printUsage();
		return 1;
	}

	const command = sub ?? "login";
	if (command === "--help" || command === "-h") {
		printUsage();
		return 0;
	}

	const handler = CLI_COMMAND_HANDLERS.get(command);
	if (handler) {
		return handler(rest);
	}

	console.error(`Unknown command: ${command}`);
	printUsage();
	return 1;
}
