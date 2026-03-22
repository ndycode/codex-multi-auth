/**
 * OpenAI ChatGPT (Codex) OAuth Authentication Plugin for Codex CLI host runtime
 *
 * COMPLIANCE NOTICE:
 * This plugin uses OpenAI's official OAuth authentication flow (the same method
 * used by OpenAI's official Codex CLI at https://github.com/openai/codex).
 *
 * INTENDED USE: Personal development and coding assistance with your own
 * ChatGPT Plus/Pro subscription.
 *
 * NOT INTENDED FOR: Commercial resale, multi-user services, high-volume
 * automated extraction, or any use that violates OpenAI's Terms of Service.
 *
 * Users are responsible for ensuring their usage complies with:
 * - OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
 * - OpenAI Usage Policies: https://openai.com/policies/usage-policies/
 *
 * For production applications, use the OpenAI Platform API: https://platform.openai.com/
 *
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @author ndycode
 * @repository https://github.com/ndycode/codex-multi-auth

 */

import type { Plugin, PluginInput } from "@codex-ai/plugin";
import { tool } from "@codex-ai/plugin/tool";
import type { Auth } from "@codex-ai/sdk";
import {
	AccountManager,
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	formatCooldown,
	formatWaitTime,
	getAccountIdCandidates,
	isCodexCliSyncEnabled,
	lookupCodexCliTokensByEmail,
	parseRateLimitReason,
	resolveRequestAccountId,
	resolveRuntimeRequestIdentity,
	sanitizeEmail,
	selectBestAccountCandidate,
	shouldUpdateAccountIdFromToken,
} from "./lib/accounts.js";
import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	redactOAuthUrlForLog,
	REDIRECT_URI,
} from "./lib/auth/auth.js";
import { isBrowserLaunchSuppressed, openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import { checkAndNotify } from "./lib/auto-update-checker.js";
import { CapabilityPolicyStore } from "./lib/capability-policy.js";
import { promptAddAnotherAccount, promptLoginMode } from "./lib/cli.js";
import {
	getAutoResume,
	getCodexMode,
	getEmptyResponseMaxRetries,
	getEmptyResponseRetryDelayMs,
	getFallbackToGpt52OnUnsupportedGpt53,
	getFastSession,
	getFastSessionMaxInputItems,
	getFastSessionStrategy,
	getFetchTimeoutMs,
	getLiveAccountSync,
	getLiveAccountSyncDebounceMs,
	getLiveAccountSyncPollMs,
	getNetworkErrorCooldownMs,
	getPerProjectAccounts,
	getPidOffsetEnabled,
	getPreemptiveQuotaEnabled,
	getPreemptiveQuotaMaxDeferralMs,
	getPreemptiveQuotaRemainingPercent5h,
	getPreemptiveQuotaRemainingPercent7d,
	getProactiveRefreshBufferMs,
	getProactiveRefreshGuardian,
	getProactiveRefreshIntervalMs,
	getRateLimitToastDebounceMs,
	getRetryAllAccountsMaxRetries,
	getRetryAllAccountsMaxWaitMs,
	getRetryAllAccountsRateLimited,
	getBackgroundResponses,
	getResponseContinuation,
	getServerErrorCooldownMs,
	getSessionAffinity,
	getSessionAffinityMaxEntries,
	getSessionAffinityTtlMs,
	getSessionRecovery,
	getStorageBackupEnabled,
	getStreamStallTimeoutMs,
	getToastDurationMs,
	getTokenRefreshSkewMs,
	getUnsupportedCodexFallbackChain,
	getUnsupportedCodexPolicy,
	loadPluginConfig,
} from "./lib/config.js";
import {
	ACCOUNT_LIMITS,
	AUTH_LABELS,
	CODEX_BASE_URL,
	DUMMY_API_KEY,
	LOG_STAGES,
	PLUGIN_NAME,
	PROVIDER_ID,
} from "./lib/constants.js";
import { handleContextOverflow } from "./lib/context-overflow.js";
import {
	EntitlementCache,
	resolveEntitlementAccountKey,
} from "./lib/entitlement-cache.js";
import { LiveAccountSync } from "./lib/live-account-sync.js";
import {
	clearCorrelationId,
	initLogger,
	logDebug,
	logError,
	logInfo,
	logRequest,
	logWarn,
	setCorrelationId,
} from "./lib/logger.js";
import {
	PreemptiveQuotaScheduler,
	readQuotaSchedulerSnapshot,
} from "./lib/preemptive-quota-scheduler.js";
import {
	getModelFamily,
	MODEL_FAMILIES,
	prewarmCodexInstructions,
} from "./lib/prompts/codex.js";
import { prewarmHostCodexPrompt } from "./lib/prompts/host-codex-prompt.js";
import {
	fetchCodexQuotaSnapshot,
	formatQuotaSnapshotLine,
} from "./lib/quota-probe.js";
import {
	detectErrorType,
	getRecoveryToastContent,
	isRecoverableError,
} from "./lib/recovery.js";
import { RefreshGuardian } from "./lib/refresh-guardian.js";
import { queuedRefresh } from "./lib/refresh-queue.js";
import {
	parseEnvInt,
	parseFailoverMode,
} from "./lib/request/failover-config.js";
import {
	evaluateFailurePolicy,
	type FailoverMode,
} from "./lib/request/failure-policy.js";
import {
	applyProxyCompatibleInit,
	createCodexHeaders,
	extractRequestUrl,
	getUnsupportedCodexModelInfo,
	handleErrorResponse,
	handleSuccessResponse,
	isWorkspaceDisabledError,
	refreshAndUpdateToken,
	resolveUnsupportedCodexFallbackModel,
	rewriteUrlForCodex,
	shouldRefreshToken,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import {
	getRateLimitBackoff,
	RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS,
	resetRateLimitBackoff,
} from "./lib/request/rate-limit-backoff.js";
import {
	normalizeRequestInit,
	parseRequestBodyFromInit,
} from "./lib/request/request-init.js";
import { applyFastSessionDefaults } from "./lib/request/request-transformer.js";
import { applyResponseCompaction } from "./lib/request/response-compaction.js";
import { isEmptyResponse } from "./lib/request/response-handler.js";
import {
	parseRetryAfterHintMs,
	sanitizeResponseHeadersForLog,
} from "./lib/request/response-metadata.js";
import { withStreamingFailover } from "./lib/request/stream-failover.js";
import {
	createAbortableSleep,
	sleepWithCountdown,
} from "./lib/request/wait-utils.js";
import { addJitter } from "./lib/rotation.js";
import {
	clampActiveIndices,
	isFlaggableFailure,
} from "./lib/runtime/account-check-helpers.js";
import { runRuntimeAccountCheck } from "./lib/runtime/account-check.js";
import { createAccountCheckWorkingState } from "./lib/runtime/account-check-types.js";
import {
	type TokenSuccessWithAccount as AccountPoolTokenSuccessWithAccount,
	persistAccountPoolResults,
} from "./lib/runtime/account-pool.js";
import { handleAccountSelectEvent } from "./lib/runtime/account-select-event.js";
import { resolveAccountSelection } from "./lib/runtime/account-selection.js";
import {
	formatRateLimitEntry,
	getRateLimitResetTimeForFamily,
	resolveActiveIndex,
} from "./lib/runtime/account-status.js";
import { reloadRuntimeAccountManager } from "./lib/runtime/account-manager-cache.js";
import {
	createAccountManagerReloader,
	createPersistAccounts,
	runRuntimeOAuthFlow,
} from "./lib/runtime/auth-facade.js";
import { runBrowserOAuthFlow } from "./lib/runtime/browser-oauth-flow.js";
import { buildLoginMenuAccounts } from "./lib/runtime/login-menu-accounts.js";
import { buildManualOAuthFlow } from "./lib/runtime/manual-oauth-flow.js";
import {
	ensureLiveAccountSyncState,
	ensureRefreshGuardianState,
	ensureSessionAffinityState,
} from "./lib/runtime/runtime-services.js";
import { applyAccountStorageScopeFromConfig } from "./lib/runtime/storage-scope.js";
import { createRuntimeSessionRecoveryHook } from "./lib/runtime/session-recovery.js";
import {
	applyUiRuntimeFromConfig,
	getStatusMarker,
} from "./lib/runtime/ui-runtime.js";
import { verifyRuntimeFlaggedAccounts } from "./lib/runtime/verify-flagged.js";
import { SessionAffinityStore } from "./lib/session-affinity.js";
import { registerCleanup } from "./lib/shutdown.js";
import {
	type AccountStorageV3,
	clearAccounts,
	clearFlaggedAccounts,
	exportAccounts,
	findMatchingAccountIndex,
	formatStorageErrorHint,
	getStoragePath,
	importAccounts,
	loadAccounts,
	loadFlaggedAccounts,
	StorageError,
	saveAccounts,
	saveFlaggedAccounts,
	setStorageBackupEnabled,
	setStoragePath,
	withAccountStorageTransaction,
} from "./lib/storage.js";
import {
	buildTableHeader,
	buildTableRow,
	type TableOptions,
} from "./lib/table-formatter.js";
import {
	createHashlineEditTool,
	createHashlineReadTool,
} from "./lib/tools/hashline-tools.js";
import type {
	OAuthAuthDetails,
	RequestBody,
	TokenResult,
	UserConfig,
} from "./lib/types.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
	formatUiSection,
	paintUiText,
} from "./lib/ui/format.js";
import {
	setUiRuntimeOptions,
	type UiRuntimeOptions,
} from "./lib/ui/runtime.js";

/**
 * OpenAI Codex OAuth authentication plugin for Codex CLI host runtime
 *
 * This plugin enables the host runtime to use OpenAI's Codex backend via ChatGPT Plus/Pro
 * OAuth authentication, allowing users to leverage their ChatGPT subscription
 * instead of OpenAI Platform API credits.
 *
 * @example
 * ```json
 * {
 *   "plugin": ["codex-multi-auth"],

 *   "model": "openai/gpt-5-codex"
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/require-await
export const OpenAIOAuthPlugin: Plugin = async ({ client }: PluginInput) => {
	initLogger(client);
	let cachedAccountManager: AccountManager | null = null;
	let accountManagerPromise: Promise<AccountManager> | null = null;
	let loaderMutex: Promise<void> | null = null;
	let startupPrewarmTriggered = false;
	let lastCodexCliActiveSyncIndex: number | null = null;
	let perProjectStorageWarningShown = false;
	let liveAccountSync: LiveAccountSync | null = null;
	let liveAccountSyncPath: string | null = null;
	let refreshGuardian: RefreshGuardian | null = null;
	let refreshGuardianConfigKey: string | null = null;
	let refreshGuardianCleanupRegistered = false;
	let sessionAffinityStore: SessionAffinityStore | null =
		new SessionAffinityStore();
	let sessionAffinityConfigKey: string | null = null;
	const entitlementCache = new EntitlementCache();
	const preemptiveQuotaScheduler = new PreemptiveQuotaScheduler();
	const capabilityPolicyStore = new CapabilityPolicyStore();
	let accountReloadInFlight: Promise<AccountManager> | null = null;
	const exposeAdvancedCodexTools =
		(process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS ?? "").trim() === "1";
	const MIN_BACKOFF_MS = 100;
	const STREAM_FAILOVER_MAX_BY_MODE: Record<FailoverMode, number> = {
		aggressive: 1,
		balanced: 2,
		conservative: 2,
	};
	const STREAM_FAILOVER_SOFT_TIMEOUT_BY_MODE: Record<FailoverMode, number> = {
		aggressive: 10_000,
		balanced: 15_000,
		conservative: 20_000,
	};

	type RuntimeMetrics = {
		startedAt: number;
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		rateLimitedResponses: number;
		serverErrors: number;
		networkErrors: number;
		userAborts: number;
		authRefreshFailures: number;
		emptyResponseRetries: number;
		accountRotations: number;
		sameAccountRetries: number;
		streamFailoverAttempts: number;
		streamFailoverRecoveries: number;
		streamFailoverCrossAccountRecoveries: number;
		cumulativeLatencyMs: number;
		lastRequestAt: number | null;
		lastError: string | null;
	};

	const runtimeMetrics: RuntimeMetrics = {
		startedAt: Date.now(),
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		rateLimitedResponses: 0,
		serverErrors: 0,
		networkErrors: 0,
		userAborts: 0,
		authRefreshFailures: 0,
		emptyResponseRetries: 0,
		accountRotations: 0,
		sameAccountRetries: 0,
		streamFailoverAttempts: 0,
		streamFailoverRecoveries: 0,
		streamFailoverCrossAccountRecoveries: 0,
		cumulativeLatencyMs: 0,
		lastRequestAt: null,
		lastError: null,
	};

	type TokenSuccess = Extract<TokenResult, { type: "success" }>;
	type TokenSuccessWithAccount = AccountPoolTokenSuccessWithAccount;

	const resolveTokenSuccessAccount = (
		tokens: TokenSuccess,
	): TokenSuccessWithAccount =>
		resolveAccountSelection(tokens, {
			envAccountId: process.env.CODEX_AUTH_ACCOUNT_ID,
			logInfo,
			getAccountIdCandidates,
			selectBestAccountCandidate,
		});

	const runOAuthFlow = async (
		forceNewLogin: boolean = false,
	): Promise<TokenResult> =>
		runRuntimeOAuthFlow(forceNewLogin, {
			runBrowserOAuthFlow: (input) =>
				runBrowserOAuthFlow({
					...input,
					createAuthorizationFlow,
					redactOAuthUrlForLog,
					startLocalOAuthServer,
					openBrowserUrl,
					pluginName: PLUGIN_NAME,
					authManualLabel: AUTH_LABELS.OAUTH_MANUAL,
					exchangeAuthorizationCode,
					redirectUri: REDIRECT_URI,
				}),
			manualModeLabel: AUTH_LABELS.OAUTH_MANUAL,
			logInfo,
			logDebug,
			logWarn,
			pluginName: PLUGIN_NAME,
		});

	const persistAccountPool = createPersistAccounts({
		persistAccountPoolResults,
		withAccountStorageTransaction,
		extractAccountId,
		extractAccountEmail,
		sanitizeEmail,
		findMatchingAccountIndex,
		modelFamilies: MODEL_FAMILIES,
	});

	const showToast = async (
		message: string,
		variant: "info" | "success" | "warning" | "error" = "success",
		options?: { title?: string; duration?: number },
	): Promise<void> => {
		try {
			await client.tui.showToast({
				body: {
					message,
					variant,
					...(options?.title && { title: options.title }),
					...(options?.duration && { duration: options.duration }),
				},
			});
		} catch {
			// Ignore when TUI is not available.
		}
	};

	const hydrateEmails = async (
		storage: AccountStorageV3 | null,
	): Promise<AccountStorageV3 | null> => {
		if (!storage) return storage;
		const skipHydrate =
			process.env.VITEST_WORKER_ID !== undefined ||
			process.env.NODE_ENV === "test" ||
			process.env.CODEX_SKIP_EMAIL_HYDRATE === "1";
		if (skipHydrate) return storage;

		const accountsCopy = storage.accounts.map((account) =>
			account ? { ...account } : account,
		);
		const accountsToHydrate = accountsCopy.filter(
			(account) => account && !account.email,
		);
		if (accountsToHydrate.length === 0) return storage;

		let changed = false;
		await Promise.all(
			accountsToHydrate.map(async (account) => {
				try {
					const refreshed = await queuedRefresh(account.refreshToken);
					if (refreshed.type !== "success") return;
					const id = extractAccountId(refreshed.access);
					const email = sanitizeEmail(
						extractAccountEmail(refreshed.access, refreshed.idToken),
					);
					if (
						id &&
						id !== account.accountId &&
						shouldUpdateAccountIdFromToken(
							account.accountIdSource,
							account.accountId,
						)
					) {
						account.accountId = id;
						account.accountIdSource = "token";
						changed = true;
					}
					if (email && email !== account.email) {
						account.email = email;
						changed = true;
					}
					if (refreshed.access && refreshed.access !== account.accessToken) {
						account.accessToken = refreshed.access;
						changed = true;
					}
					if (
						typeof refreshed.expires === "number" &&
						refreshed.expires !== account.expiresAt
					) {
						account.expiresAt = refreshed.expires;
						changed = true;
					}
					if (refreshed.refresh && refreshed.refresh !== account.refreshToken) {
						account.refreshToken = refreshed.refresh;
						changed = true;
					}
				} catch {
					logWarn(`[${PLUGIN_NAME}] Failed to hydrate email for account`);
				}
			}),
		);

		if (changed) {
			storage.accounts = accountsCopy;
			await saveAccounts(storage);
		}
		return storage;
	};

	const resolveUiRuntime = (): UiRuntimeOptions => {
		return applyUiRuntimeFromConfig(loadPluginConfig(), setUiRuntimeOptions);
	};

	const invalidateAccountManagerCache = (): void => {
		cachedAccountManager = null;
		accountManagerPromise = null;
	};

	const reloadAccountManagerFromDisk =
		createAccountManagerReloader<AccountManager>({
			reloadRuntimeAccountManager,
			getReloadInFlight: () => accountReloadInFlight,
			loadFromDisk: (fallback) => AccountManager.loadFromDisk(fallback),
			setCachedAccountManager: (value) => {
				cachedAccountManager = value;
			},
			setAccountManagerPromise: (value) => {
				accountManagerPromise = value;
			},
			setReloadInFlight: (value) => {
				accountReloadInFlight = value;
			},
		});

	const applyAccountStorageScope = (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
	): void =>
		applyAccountStorageScopeFromConfig(pluginConfig, {
			getPerProjectAccounts,
			getStorageBackupEnabled,
			setStorageBackupEnabled,
			isCodexCliSyncEnabled,
			getWarningShown: () => perProjectStorageWarningShown,
			setWarningShown: (shown) => {
				perProjectStorageWarningShown = shown;
			},
			logWarn,
			pluginName: PLUGIN_NAME,
			setStoragePath,
			cwd: () => process.cwd(),
		});

	const ensureLiveAccountSync = async (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
		authFallback?: OAuthAuthDetails,
	): Promise<void> => {
		const next = await ensureLiveAccountSyncState({
			enabled: getLiveAccountSync(pluginConfig),
			targetPath: getStoragePath(),
			currentSync: liveAccountSync,
			currentPath: liveAccountSyncPath,
			authFallback,
			createSync: (oauthFallback) =>
				new LiveAccountSync(
					async () => {
						await reloadAccountManagerFromDisk(oauthFallback);
					},
					{
						debounceMs: getLiveAccountSyncDebounceMs(pluginConfig),
						pollIntervalMs: getLiveAccountSyncPollMs(pluginConfig),
					},
				),
			registerCleanup,
			logWarn,
			pluginName: PLUGIN_NAME,
		});
		liveAccountSync = next.liveAccountSync;
		liveAccountSyncPath = next.liveAccountSyncPath;
	};

	const ensureRefreshGuardian = (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
	): void => {
		const next = ensureRefreshGuardianState({
			enabled: getProactiveRefreshGuardian(pluginConfig),
			intervalMs: getProactiveRefreshIntervalMs(pluginConfig),
			bufferMs: getProactiveRefreshBufferMs(pluginConfig),
			currentGuardian: refreshGuardian,
			currentConfigKey: refreshGuardianConfigKey,
			currentCleanupRegistered: refreshGuardianCleanupRegistered,
			getCurrentGuardian: () => refreshGuardian,
			createGuardian: ({ intervalMs, bufferMs }) =>
				new RefreshGuardian(() => cachedAccountManager, {
					intervalMs,
					bufferMs,
				}),
			registerCleanup,
		});
		refreshGuardian = next.refreshGuardian;
		refreshGuardianConfigKey = next.refreshGuardianConfigKey;
		refreshGuardianCleanupRegistered =
			next.refreshGuardianCleanupRegistered;
	};

	const ensureSessionAffinity = (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
	): void => {
		const next = ensureSessionAffinityState({
			enabled:
				getSessionAffinity(pluginConfig) ||
				getResponseContinuation(pluginConfig),
			ttlMs: getSessionAffinityTtlMs(pluginConfig),
			maxEntries: getSessionAffinityMaxEntries(pluginConfig),
			currentStore: sessionAffinityStore,
			currentConfigKey: sessionAffinityConfigKey,
			createStore: ({ ttlMs, maxEntries }) =>
				new SessionAffinityStore({ ttlMs, maxEntries }),
		});
		sessionAffinityStore = next.sessionAffinityStore;
		sessionAffinityConfigKey = next.sessionAffinityConfigKey;
	};

	const applyPreemptiveQuotaSettings = (
		pluginConfig: ReturnType<typeof loadPluginConfig>,
	): void => {
		preemptiveQuotaScheduler.configure({
			enabled: getPreemptiveQuotaEnabled(pluginConfig),
			remainingPercentThresholdPrimary:
				getPreemptiveQuotaRemainingPercent5h(pluginConfig),
			remainingPercentThresholdSecondary:
				getPreemptiveQuotaRemainingPercent7d(pluginConfig),
			maxDeferralMs: getPreemptiveQuotaMaxDeferralMs(pluginConfig),
		});
	};

	// Event handler for session recovery and account selection
	const eventHandler = async (input: {
		event: { type: string; properties?: unknown };
	}) => {
		try {
			const handled = await handleAccountSelectEvent({
				event: input.event,
				providerId: PROVIDER_ID,
				loadAccounts,
				saveAccounts,
				modelFamilies: MODEL_FAMILIES,
				getCachedAccountManager: () => cachedAccountManager,
				reloadAccountManagerFromDisk: async () => {
					await reloadAccountManagerFromDisk();
				},
				setLastCodexCliActiveSyncIndex: (index) => {
					lastCodexCliActiveSyncIndex = index;
				},
				showToast,
			});
			if (handled) {
				return;
			}
		} catch (error) {
			logDebug(
				`[${PLUGIN_NAME}] Event handler error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	// Initialize runtime UI settings once on plugin load; auth/tools refresh this dynamically.
	resolveUiRuntime();

	return {
		event: eventHandler,
		auth: {
			provider: PROVIDER_ID,
			/**
			 * Loader function that configures OAuth authentication and request handling
			 *
			 * This function:
			 * 1. Validates OAuth authentication
			 * 2. Loads multi-account pool from disk (fallback to current auth)
			 * 3. Loads user configuration from runtime model config
			 * 4. Fetches Codex system instructions from GitHub (cached)
			 * 5. Returns SDK configuration with custom fetch implementation
			 *
			 * @param getAuth - Function to retrieve current auth state
			 * @param provider - Provider configuration from runtime model config
			 * @returns SDK configuration object or empty object for non-OAuth auth
			 */
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				const auth = await getAuth();
				const pluginConfig = loadPluginConfig();
				applyUiRuntimeFromConfig(pluginConfig, setUiRuntimeOptions);
				applyAccountStorageScope(pluginConfig);
				ensureSessionAffinity(pluginConfig);
				ensureRefreshGuardian(pluginConfig);
				applyPreemptiveQuotaSettings(pluginConfig);

				// Only handle OAuth auth type, skip API key auth
				if (auth.type !== "oauth") {
					return {};
				}

				// Prefer multi-account auth metadata when available, but still handle
				// plain OAuth credentials (for legacy runtime versions that inject internal
				// Codex auth first and omit the multiAccount marker).
				const authWithMulti = auth as typeof auth & { multiAccount?: boolean };
				if (!authWithMulti.multiAccount) {
					logDebug(
						`[${PLUGIN_NAME}] Auth is missing multiAccount marker; continuing with single-account compatibility mode`,
					);
				}
				// Acquire mutex for thread-safe initialization
				// Use while loop to handle multiple concurrent waiters correctly
				while (loaderMutex) {
					await loaderMutex;
				}

				let resolveMutex: (() => void) | undefined;
				loaderMutex = new Promise<void>((resolve) => {
					resolveMutex = resolve;
				});
				try {
					await ensureLiveAccountSync(pluginConfig, auth);
					if (!accountManagerPromise) {
						await reloadAccountManagerFromDisk(auth as OAuthAuthDetails);
					}
					const managerPromise =
						accountManagerPromise ??
						reloadAccountManagerFromDisk(auth as OAuthAuthDetails);
					let accountManager = await managerPromise;
					cachedAccountManager = accountManager;
					const refreshToken = auth.type === "oauth" ? auth.refresh : "";
					const needsPersist =
						refreshToken && !accountManager.hasRefreshToken(refreshToken);
					if (needsPersist) {
						await accountManager.saveToDisk();
					}

					if (accountManager.getAccountCount() === 0) {
						logDebug(
							`[${PLUGIN_NAME}] No OAuth accounts available (run codex login)`,
						);
						return {};
					}
					// Extract user configuration (global + per-model options)
					const providerConfig = provider as
						| {
								options?: Record<string, unknown>;
								models?: UserConfig["models"];
						  }
						| undefined;
					const userConfig: UserConfig = {
						global: providerConfig?.options || {},
						models: providerConfig?.models || {},
					};

					// Load plugin configuration and determine CODEX_MODE
					// Priority: CODEX_MODE env var > config file > default (true)
					const codexMode = getCodexMode(pluginConfig);
					const fastSessionEnabled = getFastSession(pluginConfig);
					const fastSessionStrategy = getFastSessionStrategy(pluginConfig);
					const fastSessionMaxInputItems =
						getFastSessionMaxInputItems(pluginConfig);
					const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
					const rateLimitToastDebounceMs =
						getRateLimitToastDebounceMs(pluginConfig);
					const retryAllAccountsRateLimited =
						getRetryAllAccountsRateLimited(pluginConfig);
					const retryAllAccountsMaxWaitMs =
						getRetryAllAccountsMaxWaitMs(pluginConfig);
					const retryAllAccountsMaxRetries =
						getRetryAllAccountsMaxRetries(pluginConfig);
					const unsupportedCodexPolicy =
						getUnsupportedCodexPolicy(pluginConfig);
					const fallbackOnUnsupportedCodexModel =
						unsupportedCodexPolicy === "fallback";
					const fallbackToGpt52OnUnsupportedGpt53 =
						getFallbackToGpt52OnUnsupportedGpt53(pluginConfig);
					const unsupportedCodexFallbackChain =
						getUnsupportedCodexFallbackChain(pluginConfig);
					const toastDurationMs = getToastDurationMs(pluginConfig);
					const fetchTimeoutMs = getFetchTimeoutMs(pluginConfig);
					const streamStallTimeoutMs = getStreamStallTimeoutMs(pluginConfig);
					const networkErrorCooldownMs =
						getNetworkErrorCooldownMs(pluginConfig);
					const serverErrorCooldownMs = getServerErrorCooldownMs(pluginConfig);
					const failoverMode = parseFailoverMode(
						process.env.CODEX_AUTH_FAILOVER_MODE,
					);
					const streamFailoverMax = Math.max(
						0,
						parseEnvInt(process.env.CODEX_AUTH_STREAM_FAILOVER_MAX) ??
							STREAM_FAILOVER_MAX_BY_MODE[failoverMode],
					);
					const streamFailoverSoftTimeoutMs = Math.max(
						1_000,
						parseEnvInt(process.env.CODEX_AUTH_STREAM_STALL_SOFT_TIMEOUT_MS) ??
							STREAM_FAILOVER_SOFT_TIMEOUT_BY_MODE[failoverMode],
					);
					const streamFailoverHardTimeoutMs = Math.max(
						streamFailoverSoftTimeoutMs,
						parseEnvInt(process.env.CODEX_AUTH_STREAM_STALL_HARD_TIMEOUT_MS) ??
							streamStallTimeoutMs,
					);
					const maxSameAccountRetries =
						failoverMode === "conservative"
							? 2
							: failoverMode === "balanced"
								? 1
								: 0;

					const sessionRecoveryEnabled = getSessionRecovery(pluginConfig);
					const autoResumeEnabled = getAutoResume(pluginConfig);
					const emptyResponseMaxRetries =
						getEmptyResponseMaxRetries(pluginConfig);
					const emptyResponseRetryDelayMs =
						getEmptyResponseRetryDelayMs(pluginConfig);
					const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
					const effectiveUserConfig = fastSessionEnabled
						? applyFastSessionDefaults(userConfig)
						: userConfig;
					if (fastSessionEnabled) {
						logDebug("Fast session mode enabled", {
							reasoningEffort: "none/low",
							reasoningSummary: "auto",
							textVerbosity: "low",
							fastSessionStrategy,
							fastSessionMaxInputItems,
						});
					}

					const prewarmEnabled =
						process.env.CODEX_AUTH_PREWARM !== "0" &&
						process.env.VITEST !== "true" &&
						process.env.NODE_ENV !== "test";

					if (!startupPrewarmTriggered && prewarmEnabled) {
						startupPrewarmTriggered = true;
						const configuredModels = Object.keys(userConfig.models ?? {});
						prewarmCodexInstructions(configuredModels);
						if (codexMode) {
							prewarmHostCodexPrompt();
						}
					}

					const recoveryHook = createRuntimeSessionRecoveryHook({
						enabled: sessionRecoveryEnabled,
						client,
						directory: process.cwd(),
						autoResume: autoResumeEnabled,
					});

					checkAndNotify(async (message, variant) => {
						await showToast(message, variant);
					}).catch((err) => {
						logDebug(
							`Update check failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});

					// Return SDK configuration
					return {
						apiKey: DUMMY_API_KEY,
						baseURL: CODEX_BASE_URL,
						/**
						 * Custom fetch implementation for Codex API
						 *
						 * Handles:
						 * - Token refresh when expired
						 * - URL rewriting for Codex backend
						 * - Request body transformation
						 * - OAuth header injection
						 * - SSE to JSON conversion for non-tool requests
						 * - Error handling and logging
						 *
						 * @param input - Request URL or Request object
						 * @param init - Request options
						 * @returns Response from Codex API
						 */
						async fetch(
							input: Request | string | URL,
							init?: RequestInit,
						): Promise<Response> {
							try {
								if (
									cachedAccountManager &&
									cachedAccountManager !== accountManager
								) {
									accountManager = cachedAccountManager;
								}

								// Step 1: Extract and rewrite URL for Codex backend
								const originalUrl = extractRequestUrl(input);
								const url = rewriteUrlForCodex(originalUrl);

								// Step 3: Transform request body with model-specific Codex instructions
								// Instructions are fetched per model family (codex-max, codex, gpt-5.1)
								// Capture original stream value before transformation
								// generateText() sends no stream field, streamText() sends stream=true
								const baseInit = await normalizeRequestInit(input, init);
								const originalBody = await parseRequestBodyFromInit(
									baseInit?.body,
									logWarn,
								);
								const isStreaming = originalBody.stream === true;
								const parsedBody =
									Object.keys(originalBody).length > 0
										? { ...originalBody }
										: undefined;
								const transformation = await transformRequestForCodex(
									baseInit,
									url,
									effectiveUserConfig,
									codexMode,
									parsedBody,
									{
										fastSession: fastSessionEnabled,
										fastSessionStrategy,
										fastSessionMaxInputItems,
										deferFastSessionInputTrimming: fastSessionEnabled,
										allowBackgroundResponses: getBackgroundResponses(pluginConfig),
									},
								);
								let requestInit = transformation?.updatedInit ?? baseInit;
								let transformedBody: RequestBody | undefined =
									transformation?.body;
								let pendingFastSessionInputTrim =
									transformation?.deferredFastSessionInputTrim;
								const promptCacheKey = transformedBody?.prompt_cache_key;
								let model = transformedBody?.model;
								let modelFamily = model ? getModelFamily(model) : "gpt-5.1";
								let quotaKey = model ? `${modelFamily}:${model}` : modelFamily;
								const responseContinuationEnabled =
									getResponseContinuation(pluginConfig);
								const threadIdCandidate =
									(process.env.CODEX_THREAD_ID ?? promptCacheKey ?? "")
										.toString()
										.trim() || undefined;
								const sessionAffinityKey =
									threadIdCandidate ?? promptCacheKey ?? null;
								const effectivePromptCacheKey =
									(sessionAffinityKey ?? promptCacheKey ?? "")
										.toString()
										.trim() || undefined;
								const shouldUseResponseContinuation =
									Boolean(transformedBody) &&
									responseContinuationEnabled &&
									!transformedBody?.previous_response_id;
								if (shouldUseResponseContinuation && transformedBody) {
									const lastResponseId =
										sessionAffinityStore?.getLastResponseId(
											sessionAffinityKey,
										);
									if (lastResponseId) {
										transformedBody = {
											...transformedBody,
											previous_response_id: lastResponseId,
										};
										requestInit = {
											...requestInit,
											body: JSON.stringify(transformedBody),
										};
									}
								}
								const preferredSessionAccountIndex =
									sessionAffinityStore?.getPreferredAccountIndex(
										sessionAffinityKey,
									);
								sessionAffinityStore?.prune();
								const requestCorrelationId = setCorrelationId(
									threadIdCandidate
										? `${threadIdCandidate}:${Date.now()}`
										: undefined,
								);
								runtimeMetrics.lastRequestAt = Date.now();

								const abortSignal = requestInit?.signal ?? init?.signal ?? null;
								const sleep = createAbortableSleep(abortSignal);

								let allRateLimitedRetries = 0;
								let emptyResponseRetries = 0;
								const attemptedUnsupportedFallbackModels = new Set<string>();
								if (model) {
									attemptedUnsupportedFallbackModels.add(model);
								}

								while (true) {
									const accountCount = accountManager.getAccountCount();
									const attempted = new Set<number>();
									let restartAccountTraversalWithFallback = false;
									let retryNextAccountBeforeFallback = false;
									let usedPreferredSessionAccount = false;
									const capabilityBoostByAccount: Record<number, number> = {};
									type AccountSnapshotCandidate = {
										index: number;
										accountId?: string;
										email?: string;
									};
									const accountSnapshotSource = accountManager as {
										getAccountsSnapshot?: () => AccountSnapshotCandidate[];
										getAccountByIndex?: (
											index: number,
										) => AccountSnapshotCandidate | null;
									};
									const accountSnapshotList =
										typeof accountSnapshotSource.getAccountsSnapshot ===
										"function"
											? (accountSnapshotSource.getAccountsSnapshot() ?? [])
											: [];
									if (
										accountSnapshotList.length === 0 &&
										typeof accountSnapshotSource.getAccountByIndex ===
											"function"
									) {
										for (
											let accountSnapshotIndex = 0;
											accountSnapshotIndex < accountCount;
											accountSnapshotIndex += 1
										) {
											const candidate =
												accountSnapshotSource.getAccountByIndex(
													accountSnapshotIndex,
												);
											if (candidate) {
												accountSnapshotList.push(candidate);
											}
										}
									}
									for (const candidate of accountSnapshotList) {
										const accountKey = resolveEntitlementAccountKey(candidate);
										capabilityBoostByAccount[candidate.index] =
											capabilityPolicyStore.getBoost(
												accountKey,
												model ?? modelFamily,
											);
									}

									accountAttemptLoop: while (
										attempted.size < Math.max(1, accountCount)
									) {
										let account = null;
										if (
											!usedPreferredSessionAccount &&
											typeof preferredSessionAccountIndex === "number"
										) {
											usedPreferredSessionAccount = true;
											if (
												accountManager.isAccountAvailableForFamily(
													preferredSessionAccountIndex,
													modelFamily,
													model,
												)
											) {
												account = accountManager.getAccountByIndex(
													preferredSessionAccountIndex,
												);
												if (account) {
													account.lastUsed = Date.now();
													accountManager.markSwitched(
														account,
														"rotation",
														modelFamily,
													);
												}
											} else {
												sessionAffinityStore?.forgetSession(sessionAffinityKey);
											}
										}

										if (!account) {
											account = accountManager.getCurrentOrNextForFamilyHybrid(
												modelFamily,
												model,
												{
													pidOffsetEnabled,
													scoreBoostByAccount: capabilityBoostByAccount,
												},
											);
										}
										if (!account || attempted.has(account.index)) {
											break;
										}
										attempted.add(account.index);
										// Log account selection for debugging rotation
										logDebug(
											`Using account ${account.index + 1}/${accountCount}: ${account.email ?? "unknown"} for ${modelFamily}`,
										);

										let accountAuth = accountManager.toAuthDetails(
											account,
										) as OAuthAuthDetails;
										try {
											if (shouldRefreshToken(accountAuth, tokenRefreshSkewMs)) {
												accountAuth = (await refreshAndUpdateToken(
													accountAuth,
													client,
												)) as OAuthAuthDetails;
												accountManager.updateFromAuth(account, accountAuth);
												accountManager.clearAuthFailures(account);
												accountManager.saveToDiskDebounced();
											}
										} catch (err) {
											logDebug(
												`[${PLUGIN_NAME}] Auth refresh failed for account: ${(err as Error)?.message ?? String(err)}`,
											);
											runtimeMetrics.authRefreshFailures++;
											runtimeMetrics.failedRequests++;
											runtimeMetrics.accountRotations++;
											runtimeMetrics.lastError =
												(err as Error)?.message ?? String(err);
											const failures =
												accountManager.incrementAuthFailures(account);
											const accountLabel = formatAccountLabel(
												account,
												account.index,
											);

											const authFailurePolicy = evaluateFailurePolicy({
												kind: "auth-refresh",
												consecutiveAuthFailures: failures,
											});
											sessionAffinityStore?.forgetSession(sessionAffinityKey);

											if (authFailurePolicy.removeAccount) {
												const removedIndex = account.index;
												sessionAffinityStore?.forgetAccount(removedIndex);
												accountManager.removeAccount(account);
												sessionAffinityStore?.reindexAfterRemoval(removedIndex);
												accountManager.saveToDiskDebounced();
												await showToast(
													`Removed ${accountLabel} after ${failures} consecutive auth failures. Run 'codex login' to re-add.`,
													"error",
													{ duration: toastDurationMs * 2 },
												);
												continue;
											}

											if (
												typeof authFailurePolicy.cooldownMs === "number" &&
												authFailurePolicy.cooldownReason
											) {
												accountManager.markAccountCoolingDown(
													account,
													authFailurePolicy.cooldownMs,
													authFailurePolicy.cooldownReason,
												);
											}
											accountManager.saveToDiskDebounced();
											continue;
										}

										const currentWorkspace =
											accountManager.getCurrentWorkspace(account);
										const storedAccountId =
											currentWorkspace?.id ?? account.accountId;
										const storedAccountIdSource = currentWorkspace
											? "manual"
											: account.accountIdSource;
										const storedEmail = account.email;
										const hadAccountId = !!storedAccountId;
										const runtimeIdentity = resolveRuntimeRequestIdentity({
											storedAccountId,
											source: storedAccountIdSource,
											storedEmail,
											accessToken: accountAuth.access,
											idToken: accountAuth.idToken,
										});
										const tokenAccountId = runtimeIdentity.tokenAccountId;
										const accountId = runtimeIdentity.accountId;
										if (!accountId) {
											accountManager.markAccountCoolingDown(
												account,
												ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
												"auth-failure",
											);
											accountManager.saveToDiskDebounced();
											continue;
										}
										const resolvedEmail = runtimeIdentity.email;
										const entitlementAccountKey = resolveEntitlementAccountKey({
											accountId: storedAccountId ?? accountId,
											email: resolvedEmail,
											refreshToken: account.refreshToken,
											index: account.index,
										});
										const entitlementBlock = entitlementCache.isBlocked(
											entitlementAccountKey,
											model ?? modelFamily,
										);
										if (entitlementBlock.blocked) {
											runtimeMetrics.accountRotations++;
											runtimeMetrics.lastError = `Entitlement cached block for account ${account.index + 1}`;
											logWarn(
												`Skipping account ${account.index + 1} due to cached entitlement block (${formatWaitTime(entitlementBlock.waitMs)} remaining).`,
											);
											continue;
										}
										account.accountId = accountId;
										if (
											!hadAccountId &&
											tokenAccountId &&
											accountId === tokenAccountId
										) {
											account.accountIdSource =
												storedAccountIdSource ?? "token";
										}
										if (resolvedEmail) {
											account.email = resolvedEmail;
										}

										if (
											accountCount > 1 &&
											accountManager.shouldShowAccountToast(
												account.index,
												rateLimitToastDebounceMs,
											)
										) {
											const accountLabel = formatAccountLabel(
												account,
												account.index,
											);
											await showToast(
												`Using ${accountLabel} (${account.index + 1}/${accountCount})`,
												"info",
											);
											accountManager.markToastShown(account.index);
										}

										const headers = createCodexHeaders(
											requestInit,
											accountId,
											accountAuth.access,
											{
												model,
												promptCacheKey: effectivePromptCacheKey,
											},
										);
										if (transformedBody && pendingFastSessionInputTrim) {
											const activeFastSessionInputTrim =
												pendingFastSessionInputTrim;
											pendingFastSessionInputTrim = undefined;
											const compactionResult =
												await applyResponseCompaction({
													body: transformedBody,
													requestUrl: url,
													headers,
													trim: activeFastSessionInputTrim,
													fetchImpl: async (requestUrl, requestInit) => {
														const normalizedCompactionUrl =
															typeof requestUrl === "string"
																? requestUrl
																: String(requestUrl);
														return fetch(
															normalizedCompactionUrl,
															applyProxyCompatibleInit(
																normalizedCompactionUrl,
																requestInit,
															),
														);
													},
													signal: abortSignal,
													timeoutMs: Math.min(fetchTimeoutMs, 4_000),
												});
											if (compactionResult.mode !== "unchanged") {
												transformedBody = compactionResult.body;
												requestInit = {
													...(requestInit ?? {}),
													body: JSON.stringify(transformedBody),
												};
											}
										}
										const quotaScheduleKey = `${entitlementAccountKey}:${model ?? modelFamily}`;
										const capabilityModelKey = model ?? modelFamily;
										const quotaDeferral =
											preemptiveQuotaScheduler.getDeferral(quotaScheduleKey);
										if (quotaDeferral.defer && quotaDeferral.waitMs > 0) {
											accountManager.markRateLimitedWithReason(
												account,
												quotaDeferral.waitMs,
												modelFamily,
												"quota",
												model,
											);
											accountManager.recordRateLimit(
												account,
												modelFamily,
												model,
											);
											runtimeMetrics.accountRotations++;
											runtimeMetrics.lastError = `Preemptive quota deferral for account ${account.index + 1}`;
											accountManager.saveToDiskDebounced();
											continue;
										}

										// Consume a token before making the request for proactive rate limiting
										const tokenConsumed = accountManager.consumeToken(
											account,
											modelFamily,
											model,
										);
										if (!tokenConsumed) {
											accountManager.recordRateLimit(
												account,
												modelFamily,
												model,
											);
											runtimeMetrics.accountRotations++;
											runtimeMetrics.lastError = `Local token bucket depleted for account ${account.index + 1} (${modelFamily}${model ? `:${model}` : ""})`;
											logWarn(
												`Skipping account ${account.index + 1}: local token bucket depleted for ${modelFamily}${model ? `:${model}` : ""}`,
											);
											continue;
										}

										let sameAccountRetryCount = 0;
										let successAccountForResponse = account;
										let successEntitlementAccountKey = entitlementAccountKey;
										while (true) {
											let response: Response;
											const fetchStart = performance.now();

											// Merge user AbortSignal with timeout (Node 18 compatible - no AbortSignal.any)
											const fetchController = new AbortController();
											const requestTimeoutMs = fetchTimeoutMs;
											let requestTimedOut = false;
											const timeoutReason = new Error("Request timeout");
											const fetchTimeoutId = setTimeout(() => {
												requestTimedOut = true;
												fetchController.abort(timeoutReason);
											}, requestTimeoutMs);

											const onUserAbort = abortSignal
												? () =>
														fetchController.abort(
															abortSignal.reason ??
																new Error("Aborted by user"),
														)
												: null;

											if (abortSignal?.aborted) {
												clearTimeout(fetchTimeoutId);
												fetchController.abort(
													abortSignal.reason ?? new Error("Aborted by user"),
												);
											} else if (abortSignal && onUserAbort) {
												abortSignal.addEventListener("abort", onUserAbort, {
													once: true,
												});
											}

											try {
												runtimeMetrics.totalRequests++;
												response = await fetch(
													url,
													applyProxyCompatibleInit(url, {
														...requestInit,
														headers,
														signal: fetchController.signal,
													}),
												);
											} catch (networkError) {
												const fetchAbortReason = fetchController.signal.reason;
												const isTimeoutAbort =
													requestTimedOut ||
													(fetchAbortReason instanceof Error &&
														fetchAbortReason.message === timeoutReason.message);
												const isUserAbort =
													Boolean(abortSignal?.aborted) && !isTimeoutAbort;
												if (isUserAbort) {
													accountManager.refundToken(
														account,
														modelFamily,
														model,
													);
													runtimeMetrics.userAborts++;
													runtimeMetrics.lastError = "request aborted by user";
													sessionAffinityStore?.forgetSession(
														sessionAffinityKey,
													);
													throw fetchAbortReason instanceof Error
														? fetchAbortReason
														: new Error("Aborted by user");
												}
												const errorMsg =
													networkError instanceof Error
														? networkError.message
														: String(networkError);
												logWarn(
													`Network error for account ${account.index + 1}: ${errorMsg}`,
												);
												runtimeMetrics.failedRequests++;
												runtimeMetrics.networkErrors++;
												runtimeMetrics.accountRotations++;
												runtimeMetrics.lastError = errorMsg;
												const policy = evaluateFailurePolicy(
													{ kind: "network", failoverMode },
													{ networkCooldownMs: networkErrorCooldownMs },
												);
												if (policy.refundToken) {
													accountManager.refundToken(
														account,
														modelFamily,
														model,
													);
												}
												if (policy.recordFailure) {
													accountManager.recordFailure(
														account,
														modelFamily,
														model,
													);
													capabilityPolicyStore.recordFailure(
														entitlementAccountKey,
														capabilityModelKey,
													);
												}
												if (
													policy.retrySameAccount &&
													sameAccountRetryCount < maxSameAccountRetries
												) {
													sameAccountRetryCount += 1;
													runtimeMetrics.sameAccountRetries += 1;
													const retryDelayMs = Math.max(
														MIN_BACKOFF_MS,
														Math.floor(policy.retryDelayMs ?? 250),
													);
													await sleep(addJitter(retryDelayMs, 0.2));
													continue;
												}
												if (
													typeof policy.cooldownMs === "number" &&
													policy.cooldownReason
												) {
													accountManager.markAccountCoolingDown(
														account,
														policy.cooldownMs,
														policy.cooldownReason,
													);
													accountManager.saveToDiskDebounced();
												}
												sessionAffinityStore?.forgetSession(sessionAffinityKey);
												break;
											} finally {
												clearTimeout(fetchTimeoutId);
												if (abortSignal && onUserAbort) {
													abortSignal.removeEventListener("abort", onUserAbort);
												}
											}
											const fetchLatencyMs = Math.round(
												performance.now() - fetchStart,
											);

											logRequest(LOG_STAGES.RESPONSE, {
												status: response.status,
												ok: response.ok,
												statusText: response.statusText,
												latencyMs: fetchLatencyMs,
												headers: sanitizeResponseHeadersForLog(
													response.headers,
												),
											});
											const quotaSnapshot = readQuotaSchedulerSnapshot(
												response.headers,
												response.status,
											);
											if (quotaSnapshot) {
												preemptiveQuotaScheduler.update(
													quotaScheduleKey,
													quotaSnapshot,
												);
											}

											if (!response.ok) {
												const contextOverflowResult =
													await handleContextOverflow(response, model);
												if (contextOverflowResult.handled) {
													return contextOverflowResult.response;
												}

												const {
													response: errorResponse,
													rateLimit,
													errorBody,
												} = await handleErrorResponse(response, {
													requestCorrelationId,
													threadId: threadIdCandidate,
												});

												const unsupportedModelInfo =
													getUnsupportedCodexModelInfo(errorBody);
												const hasRemainingAccounts =
													attempted.size < Math.max(1, accountCount);
												const blockedModel =
													unsupportedModelInfo.unsupportedModel ??
													model ??
													"requested model";
												const blockedModelNormalized =
													blockedModel.toLowerCase();
												const shouldForceSparkFallback =
													unsupportedModelInfo.isUnsupported &&
													(blockedModelNormalized === "gpt-5.3-codex-spark" ||
														blockedModelNormalized.includes(
															"gpt-5.3-codex-spark",
														));
												const allowUnsupportedFallback =
													fallbackOnUnsupportedCodexModel ||
													shouldForceSparkFallback;

												// Entitlements can differ by account/workspace, so try remaining
												// accounts before degrading the model via fallback.
												// Spark entitlement is commonly unavailable on non-Pro/Business workspaces;
												// force direct fallback instead of traversing every account/workspace first.
												if (
													unsupportedModelInfo.isUnsupported &&
													hasRemainingAccounts &&
													!shouldForceSparkFallback
												) {
													entitlementCache.markBlocked(
														entitlementAccountKey,
														blockedModel,
														"unsupported-model",
													);
													capabilityPolicyStore.recordUnsupported(
														entitlementAccountKey,
														blockedModel,
													);
													accountManager.refundToken(
														account,
														modelFamily,
														model,
													);
													accountManager.recordFailure(
														account,
														modelFamily,
														model,
													);
													capabilityPolicyStore.recordFailure(
														entitlementAccountKey,
														capabilityModelKey,
													);
													sessionAffinityStore?.forgetSession(
														sessionAffinityKey,
													);
													account.lastSwitchReason = "rotation";
													runtimeMetrics.lastError = `Unsupported model on account ${account.index + 1}: ${blockedModel}`;
													logWarn(
														`Model ${blockedModel} is unsupported for account ${account.index + 1}. Trying next account/workspace before fallback.`,
														{
															unsupportedCodexPolicy,
															requestedModel: blockedModel,
															effectiveModel: blockedModel,
															fallbackApplied: false,
															fallbackReason: "unsupported-model-entitlement",
														},
													);
													retryNextAccountBeforeFallback = true;
													break;
												}

												const fallbackModel =
													resolveUnsupportedCodexFallbackModel({
														requestedModel: model,
														errorBody,
														attemptedModels: attemptedUnsupportedFallbackModels,
														fallbackOnUnsupportedCodexModel:
															allowUnsupportedFallback,
														fallbackToGpt52OnUnsupportedGpt53,
														customChain: unsupportedCodexFallbackChain,
													});

												if (fallbackModel) {
													const previousModel = model ?? "gpt-5-codex";
													const previousModelFamily = modelFamily;
													attemptedUnsupportedFallbackModels.add(previousModel);
													attemptedUnsupportedFallbackModels.add(fallbackModel);
													entitlementCache.markBlocked(
														entitlementAccountKey,
														previousModel,
														"unsupported-model",
													);
													capabilityPolicyStore.recordUnsupported(
														entitlementAccountKey,
														previousModel,
													);
													accountManager.refundToken(
														account,
														previousModelFamily,
														previousModel,
													);

													model = fallbackModel;
													modelFamily = getModelFamily(model);
													quotaKey = `${modelFamily}:${model}`;

													if (
														transformedBody &&
														typeof transformedBody === "object"
													) {
														transformedBody = { ...transformedBody, model };
													} else {
														let fallbackBody: Record<string, unknown> = {
															model,
														};
														if (
															requestInit?.body &&
															typeof requestInit.body === "string"
														) {
															try {
																const parsed = JSON.parse(
																	requestInit.body,
																) as Record<string, unknown>;
																fallbackBody = { ...parsed, model };
															} catch {
																// Keep minimal fallback body if parsing fails.
															}
														}
														transformedBody = fallbackBody as RequestBody;
													}

													requestInit = {
														...(requestInit ?? {}),
														body: JSON.stringify(transformedBody),
													};
													runtimeMetrics.lastError = `Model fallback: ${previousModel} -> ${model}`;
													logWarn(
														`Model ${previousModel} is unsupported for this ChatGPT account. Falling back to ${model}.`,
														{
															unsupportedCodexPolicy,
															requestedModel: previousModel,
															effectiveModel: model,
															fallbackApplied: true,
															fallbackReason: "unsupported-model-entitlement",
														},
													);
													await showToast(
														`Model ${previousModel} is not available for this account. Retrying with ${model}.`,
														"warning",
														{ duration: toastDurationMs },
													);
													restartAccountTraversalWithFallback = true;
													break;
												}

												if (
													unsupportedModelInfo.isUnsupported &&
													!allowUnsupportedFallback
												) {
													entitlementCache.markBlocked(
														entitlementAccountKey,
														blockedModel,
														"unsupported-model",
													);
													capabilityPolicyStore.recordUnsupported(
														entitlementAccountKey,
														blockedModel,
													);
													runtimeMetrics.lastError = `Unsupported model (strict): ${blockedModel}`;
													logWarn(
														`Model ${blockedModel} is unsupported for this ChatGPT account. Strict policy blocks automatic fallback.`,
														{
															unsupportedCodexPolicy,
															requestedModel: blockedModel,
															effectiveModel: blockedModel,
															fallbackApplied: false,
															fallbackReason: "unsupported-model-entitlement",
														},
													);
													await showToast(
														`Model ${blockedModel} is not available for this account. Strict policy blocked automatic fallback.`,
														"warning",
														{ duration: toastDurationMs },
													);
												}
												if (
													unsupportedModelInfo.isUnsupported &&
													allowUnsupportedFallback &&
													!hasRemainingAccounts &&
													!fallbackModel
												) {
													entitlementCache.markBlocked(
														entitlementAccountKey,
														blockedModel,
														"unsupported-model",
													);
													capabilityPolicyStore.recordUnsupported(
														entitlementAccountKey,
														blockedModel,
													);
												}
												const workspaceErrorCode =
													(
														errorBody as
															| { error?: { code?: string } }
															| undefined
													)?.error?.code ?? "";
												const workspaceErrorMessage =
													(
														errorBody as
															| { error?: { message?: string } }
															| undefined
													)?.error?.message ?? "";
												const isDisabledWorkspaceError =
													isWorkspaceDisabledError(
														errorResponse.status,
														workspaceErrorCode,
														workspaceErrorMessage,
													);

												// Handle workspace disabled/expired errors by rotating to the next workspace
												// within the same account before falling back to another account.
												if (isDisabledWorkspaceError) {
													runtimeMetrics.failedRequests++;
													runtimeMetrics.lastError = `Workspace disabled for account ${account.index + 1}`;

													if (
														!account.workspaces ||
														account.workspaces.length === 0
													) {
														logWarn(
															`Workspace disabled/expired for account ${account.index + 1} without tracked workspaces. Leaving account enabled.`,
															{ errorCode: workspaceErrorCode },
														);
														if (hasRemainingAccounts) {
															continue accountAttemptLoop;
														}
														return errorResponse;
													} else {
														const currentWorkspace =
															accountManager.getCurrentWorkspace(account);
														const workspaceName =
															currentWorkspace?.name ??
															currentWorkspace?.id ??
															"unknown";

														logWarn(
															`Workspace disabled/expired for account ${account.index + 1} - workspace: ${workspaceName}. Rotating to next workspace.`,
															{ errorCode: workspaceErrorCode },
														);

														const disabledWorkspace = currentWorkspace
															? accountManager.disableCurrentWorkspace(
																	account,
																	currentWorkspace.id,
																)
															: false;
														let nextWorkspace = disabledWorkspace
															? accountManager.rotateToNextWorkspace(account)
															: accountManager.getCurrentWorkspace(account);
														if (
															!disabledWorkspace &&
															(!nextWorkspace ||
																nextWorkspace.enabled === false)
														) {
															nextWorkspace =
																accountManager.rotateToNextWorkspace(account);
														}

														if (nextWorkspace) {
															accountManager.saveToDiskDebounced();

															const newWorkspaceName =
																nextWorkspace.name ?? nextWorkspace.id;
															await showToast(
																`Workspace ${workspaceName} disabled. Switched to ${newWorkspaceName}.`,
																"warning",
																{ duration: toastDurationMs },
															);

															logInfo(
																`Rotated to workspace ${newWorkspaceName} for account ${account.index + 1}`,
															);

															// Allow the same account to be selected again with fresh request state.
															attempted.delete(account.index);
															continue accountAttemptLoop;
														}

														logWarn(
															`All workspaces disabled for account ${account.index + 1}. Disabling account.`,
														);

														accountManager.setAccountEnabled(
															account.index,
															false,
														);
														accountManager.saveToDiskDebounced();

														await showToast(
															`All workspaces disabled for account ${account.index + 1}. Switching to another account.`,
															"warning",
															{ duration: toastDurationMs },
														);

														// Forget session affinity and continue the outer loop so another
														// enabled account can service the request.
														sessionAffinityStore?.forgetSession(
															sessionAffinityKey,
														);
														continue accountAttemptLoop;
													}
												}

												if (
													errorResponse.status === 403 &&
													!unsupportedModelInfo.isUnsupported &&
													!isDisabledWorkspaceError
												) {
													entitlementCache.markBlocked(
														entitlementAccountKey,
														model ?? modelFamily,
														"plan-entitlement",
													);
													capabilityPolicyStore.recordFailure(
														entitlementAccountKey,
														capabilityModelKey,
													);
												}

												if (
													recoveryHook &&
													errorBody &&
													isRecoverableError(errorBody)
												) {
													const errorType = detectErrorType(errorBody);
													const toastContent =
														getRecoveryToastContent(errorType);
													await showToast(
														`${toastContent.title}: ${toastContent.message}`,
														"warning",
														{ duration: toastDurationMs },
													);
													logDebug(
														`[${PLUGIN_NAME}] Recoverable error detected: ${errorType}`,
													);
												}

												// Handle 5xx server errors by rotating to another account
												if (response.status >= 500 && response.status < 600) {
													logWarn(
														`Server error ${response.status} for account ${account.index + 1}. Rotating to next account.`,
													);
													runtimeMetrics.failedRequests++;
													runtimeMetrics.serverErrors++;
													runtimeMetrics.accountRotations++;
													runtimeMetrics.lastError = `HTTP ${response.status}`;
													const serverRetryAfterMs = parseRetryAfterHintMs(
														response.headers,
													);
													const policy = evaluateFailurePolicy(
														{
															kind: "server",
															failoverMode,
															serverRetryAfterMs:
																serverRetryAfterMs ?? undefined,
														},
														{ serverCooldownMs: serverErrorCooldownMs },
													);
													if (policy.refundToken) {
														accountManager.refundToken(
															account,
															modelFamily,
															model,
														);
													}
													if (policy.recordFailure) {
														accountManager.recordFailure(
															account,
															modelFamily,
															model,
														);
														capabilityPolicyStore.recordFailure(
															entitlementAccountKey,
															capabilityModelKey,
														);
													}
													if (
														policy.retrySameAccount &&
														sameAccountRetryCount < maxSameAccountRetries
													) {
														sameAccountRetryCount += 1;
														runtimeMetrics.sameAccountRetries += 1;
														const retryDelayMs = Math.max(
															MIN_BACKOFF_MS,
															Math.floor(policy.retryDelayMs ?? 500),
														);
														await sleep(addJitter(retryDelayMs, 0.2));
														continue;
													}
													if (
														typeof policy.cooldownMs === "number" &&
														policy.cooldownReason
													) {
														accountManager.markAccountCoolingDown(
															account,
															policy.cooldownMs,
															policy.cooldownReason,
														);
														accountManager.saveToDiskDebounced();
													}
													sessionAffinityStore?.forgetSession(
														sessionAffinityKey,
													);
													break;
												}

												if (rateLimit) {
													runtimeMetrics.rateLimitedResponses++;
													const { attempt, delayMs } = getRateLimitBackoff(
														account.index,
														quotaKey,
														rateLimit.retryAfterMs,
													);
													preemptiveQuotaScheduler.markRateLimited(
														quotaScheduleKey,
														delayMs,
													);
													const waitLabel = formatWaitTime(delayMs);

													if (delayMs <= RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS) {
														if (
															accountManager.shouldShowAccountToast(
																account.index,
																rateLimitToastDebounceMs,
															)
														) {
															await showToast(
																`Rate limited. Retrying in ${waitLabel} (attempt ${attempt})...`,
																"warning",
																{ duration: toastDurationMs },
															);
															accountManager.markToastShown(account.index);
														}

														await sleep(
															addJitter(Math.max(MIN_BACKOFF_MS, delayMs), 0.2),
														);
														continue;
													}

													accountManager.markRateLimitedWithReason(
														account,
														delayMs,
														modelFamily,
														parseRateLimitReason(rateLimit.code),
														model,
													);
													accountManager.recordRateLimit(
														account,
														modelFamily,
														model,
													);
													account.lastSwitchReason = "rate-limit";
													sessionAffinityStore?.forgetSession(
														sessionAffinityKey,
													);
													runtimeMetrics.accountRotations++;
													accountManager.saveToDiskDebounced();
													logWarn(
														`Rate limited. Rotating account ${account.index + 1} (${account.email ?? "unknown"}).`,
													);

													if (
														accountManager.getAccountCount() > 1 &&
														accountManager.shouldShowAccountToast(
															account.index,
															rateLimitToastDebounceMs,
														)
													) {
														await showToast(
															`Rate limited. Switching accounts (retry in ${waitLabel}).`,
															"warning",
															{ duration: toastDurationMs },
														);
														accountManager.markToastShown(account.index);
													}
													break;
												}
												if (
													!rateLimit &&
													!unsupportedModelInfo.isUnsupported &&
													errorResponse.status !== 403
												) {
													capabilityPolicyStore.recordFailure(
														entitlementAccountKey,
														capabilityModelKey,
													);
												}
												runtimeMetrics.failedRequests++;
												runtimeMetrics.lastError = `HTTP ${response.status}`;
												return errorResponse;
											}

											resetRateLimitBackoff(account.index, quotaKey);
											runtimeMetrics.cumulativeLatencyMs += fetchLatencyMs;
											let responseForSuccess = response;
											if (isStreaming) {
												const streamFallbackCandidateOrder = [
													account.index,
													...accountManager
														.getAccountsSnapshot()
														.map((candidate) => candidate.index)
														.filter((index) => index !== account.index),
												];
												responseForSuccess = withStreamingFailover(
													response,
													async (failoverAttempt, emittedBytes) => {
														if (abortSignal?.aborted) {
															return null;
														}
														runtimeMetrics.streamFailoverAttempts += 1;

														for (const candidateIndex of streamFallbackCandidateOrder) {
															if (abortSignal?.aborted) {
																return null;
															}
															if (
																!accountManager.isAccountAvailableForFamily(
																	candidateIndex,
																	modelFamily,
																	model,
																)
															) {
																continue;
															}

															const fallbackAccount =
																accountManager.getAccountByIndex(
																	candidateIndex,
																);
															if (!fallbackAccount) continue;

															let fallbackAuth = accountManager.toAuthDetails(
																fallbackAccount,
															) as OAuthAuthDetails;
															try {
																if (
																	shouldRefreshToken(
																		fallbackAuth,
																		tokenRefreshSkewMs,
																	)
																) {
																	fallbackAuth = (await refreshAndUpdateToken(
																		fallbackAuth,
																		client,
																	)) as OAuthAuthDetails;
																	accountManager.updateFromAuth(
																		fallbackAccount,
																		fallbackAuth,
																	);
																	accountManager.clearAuthFailures(
																		fallbackAccount,
																	);
																	accountManager.saveToDiskDebounced();
																}
															} catch (refreshError) {
																logWarn(
																	`Stream failover refresh failed for account ${fallbackAccount.index + 1}.`,
																	{
																		error:
																			refreshError instanceof Error
																				? refreshError.message
																				: String(refreshError),
																	},
																);
																continue;
															}

															const fallbackStoredAccountId =
																fallbackAccount.accountId;
															const fallbackStoredAccountIdSource =
																fallbackAccount.accountIdSource;
															const fallbackStoredEmail = fallbackAccount.email;
															const hadFallbackAccountId =
																!!fallbackStoredAccountId;
															const fallbackRuntimeIdentity =
																resolveRuntimeRequestIdentity({
																	storedAccountId: fallbackStoredAccountId,
																	source: fallbackStoredAccountIdSource,
																	storedEmail: fallbackStoredEmail,
																	accessToken: fallbackAuth.access,
																	idToken: fallbackAuth.idToken,
																});
															const fallbackTokenAccountId =
																fallbackRuntimeIdentity.tokenAccountId;
															const fallbackAccountId =
																fallbackRuntimeIdentity.accountId;
															if (!fallbackAccountId) {
																continue;
															}
															const fallbackResolvedEmail =
																fallbackRuntimeIdentity.email;
															const fallbackEntitlementAccountKey =
																resolveEntitlementAccountKey({
																	accountId:
																		fallbackStoredAccountId ??
																		fallbackAccountId,
																	email: fallbackResolvedEmail,
																	refreshToken: fallbackAccount.refreshToken,
																	index: fallbackAccount.index,
																});
															const fallbackEntitlementBlock =
																entitlementCache.isBlocked(
																	fallbackEntitlementAccountKey,
																	model ?? modelFamily,
																);
															if (fallbackEntitlementBlock.blocked) {
																runtimeMetrics.accountRotations++;
																runtimeMetrics.lastError = `Entitlement cached block for account ${fallbackAccount.index + 1}`;
																logWarn(
																	`Skipping account ${fallbackAccount.index + 1} due to cached entitlement block (${formatWaitTime(fallbackEntitlementBlock.waitMs)} remaining).`,
																);
																continue;
															}

															if (
																!accountManager.consumeToken(
																	fallbackAccount,
																	modelFamily,
																	model,
																)
															) {
																continue;
															}
															fallbackAccount.accountId = fallbackAccountId;
															if (
																!hadFallbackAccountId &&
																fallbackTokenAccountId &&
																fallbackAccountId === fallbackTokenAccountId
															) {
																fallbackAccount.accountIdSource =
																	fallbackStoredAccountIdSource ?? "token";
															}
															if (fallbackResolvedEmail) {
																fallbackAccount.email = fallbackResolvedEmail;
															}

															const fallbackHeaders = createCodexHeaders(
																requestInit,
																fallbackAccountId,
																fallbackAuth.access,
																{
																	model,
																	promptCacheKey: effectivePromptCacheKey,
																},
															);

															const fallbackController = new AbortController();
															const fallbackTimeoutId = setTimeout(
																() =>
																	fallbackController.abort(
																		new Error("Request timeout"),
																	),
																fetchTimeoutMs,
															);
															const onFallbackAbort = abortSignal
																? () =>
																		fallbackController.abort(
																			abortSignal.reason ??
																				new Error("Aborted by user"),
																		)
																: null;
															if (abortSignal && onFallbackAbort) {
																abortSignal.addEventListener(
																	"abort",
																	onFallbackAbort,
																	{
																		once: true,
																	},
																);
															}

															try {
																runtimeMetrics.totalRequests++;
																const fallbackResponse = await fetch(
																	url,
																	applyProxyCompatibleInit(url, {
																		...requestInit,
																		headers: fallbackHeaders,
																		signal: fallbackController.signal,
																	}),
																);
																const fallbackSnapshot =
																	readQuotaSchedulerSnapshot(
																		fallbackResponse.headers,
																		fallbackResponse.status,
																	);
																if (fallbackSnapshot) {
																	preemptiveQuotaScheduler.update(
																		`${fallbackEntitlementAccountKey}:${model ?? modelFamily}`,
																		fallbackSnapshot,
																	);
																}
																if (!fallbackResponse.ok) {
																	try {
																		await fallbackResponse.body?.cancel();
																	} catch {
																		// Best effort cleanup before trying next fallback account.
																	}
																	if (fallbackResponse.status === 429) {
																		const retryAfterMs =
																			parseRetryAfterHintMs(
																				fallbackResponse.headers,
																			) ?? 60_000;
																		accountManager.markRateLimitedWithReason(
																			fallbackAccount,
																			retryAfterMs,
																			modelFamily,
																			"quota",
																			model,
																		);
																		accountManager.recordRateLimit(
																			fallbackAccount,
																			modelFamily,
																			model,
																		);
																	} else {
																		accountManager.recordFailure(
																			fallbackAccount,
																			modelFamily,
																			model,
																		);
																	}
																	capabilityPolicyStore.recordFailure(
																		fallbackEntitlementAccountKey,
																		capabilityModelKey,
																	);
																	continue;
																}

																successAccountForResponse = fallbackAccount;
																successEntitlementAccountKey =
																	fallbackEntitlementAccountKey;
																runtimeMetrics.streamFailoverRecoveries += 1;
																if (fallbackAccount.index !== account.index) {
																	runtimeMetrics.streamFailoverCrossAccountRecoveries += 1;
																	runtimeMetrics.accountRotations += 1;
																	if (!responseContinuationEnabled) {
																		sessionAffinityStore?.remember(
																			sessionAffinityKey,
																			fallbackAccount.index,
																		);
																	}
																}

																logInfo(
																	`Recovered stream via failover attempt ${failoverAttempt} using account ${fallbackAccount.index + 1}.`,
																	{ emittedBytes },
																);
																return fallbackResponse;
															} catch (streamFailoverError) {
																accountManager.refundToken(
																	fallbackAccount,
																	modelFamily,
																	model,
																);
																accountManager.recordFailure(
																	fallbackAccount,
																	modelFamily,
																	model,
																);
																capabilityPolicyStore.recordFailure(
																	fallbackEntitlementAccountKey,
																	capabilityModelKey,
																);
																logWarn(
																	`Stream failover attempt ${failoverAttempt} failed for account ${fallbackAccount.index + 1}.`,
																	{
																		emittedBytes,
																		error:
																			streamFailoverError instanceof Error
																				? streamFailoverError.message
																				: String(streamFailoverError),
																	},
																);
															} finally {
																clearTimeout(fallbackTimeoutId);
																if (abortSignal && onFallbackAbort) {
																	abortSignal.removeEventListener(
																		"abort",
																		onFallbackAbort,
																	);
																}
															}
														}

														return null;
													},
													{
														maxFailovers: streamFailoverMax,
														softTimeoutMs: streamFailoverSoftTimeoutMs,
														hardTimeoutMs: streamFailoverHardTimeoutMs,
														requestInstanceId:
															requestCorrelationId ?? undefined,
													},
												);
											}
											let storedResponseIdForSuccess = false;
											const successResponse = await handleSuccessResponse(
												responseForSuccess,
												isStreaming,
												{
													onResponseId: (responseId) => {
														if (!responseContinuationEnabled) return;
														sessionAffinityStore?.remember(
															sessionAffinityKey,
															successAccountForResponse.index,
														);
														sessionAffinityStore?.updateLastResponseId(
															sessionAffinityKey,
															responseId,
														);
														storedResponseIdForSuccess = true;
													},
													streamStallTimeoutMs,
												},
											);

											if (!isStreaming && emptyResponseMaxRetries > 0) {
												const clonedResponse = successResponse.clone();
												try {
													const bodyText = await clonedResponse.text();
													const parsedBody = bodyText
														? (JSON.parse(bodyText) as unknown)
														: null;
													if (isEmptyResponse(parsedBody)) {
														if (
															emptyResponseRetries < emptyResponseMaxRetries
														) {
															emptyResponseRetries++;
															runtimeMetrics.emptyResponseRetries++;
															logWarn(
																`Empty response received (attempt ${emptyResponseRetries}/${emptyResponseMaxRetries}). Retrying...`,
															);
															await showToast(
																`Empty response. Retrying (${emptyResponseRetries}/${emptyResponseMaxRetries})...`,
																"warning",
																{ duration: toastDurationMs },
															);
															accountManager.refundToken(
																account,
																modelFamily,
																model,
															);
															accountManager.recordFailure(
																account,
																modelFamily,
																model,
															);
															capabilityPolicyStore.recordFailure(
																entitlementAccountKey,
																capabilityModelKey,
															);
															const emptyPolicy = evaluateFailurePolicy({
																kind: "empty-response",
																failoverMode,
															});
															if (
																emptyPolicy.retrySameAccount &&
																sameAccountRetryCount < maxSameAccountRetries
															) {
																sameAccountRetryCount += 1;
																runtimeMetrics.sameAccountRetries += 1;
																const retryDelayMs = Math.max(
																	0,
																	Math.floor(
																		emptyPolicy.retryDelayMs ??
																			emptyResponseRetryDelayMs,
																	),
																);
																if (retryDelayMs > 0) {
																	await sleep(addJitter(retryDelayMs, 0.2));
																}
																continue;
															}
															sessionAffinityStore?.forgetSession(
																sessionAffinityKey,
															);
															await sleep(
																addJitter(emptyResponseRetryDelayMs, 0.2),
															);
															break;
														}
														logWarn(
															`Empty response after ${emptyResponseMaxRetries} retries. Returning as-is.`,
														);
													}
												} catch {
													// Intentionally empty: non-JSON response bodies should be returned as-is
												}
											}

											if (successAccountForResponse.index !== account.index) {
												accountManager.markSwitched(
													successAccountForResponse,
													"rotation",
													modelFamily,
												);
											}
											const successAccountKey = successEntitlementAccountKey;
											accountManager.recordSuccess(
												successAccountForResponse,
												modelFamily,
												model,
											);
											capabilityPolicyStore.recordSuccess(
												successAccountKey,
												capabilityModelKey,
											);
											entitlementCache.clear(
												successAccountKey,
												capabilityModelKey,
											);
											if (
												!responseContinuationEnabled ||
												(!isStreaming && !storedResponseIdForSuccess)
											) {
												sessionAffinityStore?.remember(
													sessionAffinityKey,
													successAccountForResponse.index,
												);
											}
											runtimeMetrics.successfulRequests++;
											runtimeMetrics.lastError = null;
											if (
												lastCodexCliActiveSyncIndex !==
												successAccountForResponse.index
											) {
												void accountManager.syncCodexCliActiveSelectionForIndex(
													successAccountForResponse.index,
												);
												lastCodexCliActiveSyncIndex =
													successAccountForResponse.index;
											}
											return successResponse;
										}
										if (retryNextAccountBeforeFallback) {
											retryNextAccountBeforeFallback = false;
											continue;
										}

										if (restartAccountTraversalWithFallback) {
											break;
										}
									}

									if (restartAccountTraversalWithFallback) {
										continue;
									}

									const waitMs = accountManager.getMinWaitTimeForFamily(
										modelFamily,
										model,
									);
									const count = accountManager.getAccountCount();

									if (
										retryAllAccountsRateLimited &&
										count > 0 &&
										waitMs > 0 &&
										(retryAllAccountsMaxWaitMs === 0 ||
											waitMs <= retryAllAccountsMaxWaitMs) &&
										allRateLimitedRetries < retryAllAccountsMaxRetries
									) {
										const countdownMessage = `All ${count} account(s) rate-limited. Waiting`;
										await sleepWithCountdown({
											totalMs: addJitter(waitMs, 0.2),
											message: countdownMessage,
											sleep,
											showToast,
											formatWaitTime,
											toastDurationMs,
											abortSignal,
										});
										allRateLimitedRetries++;
										continue;
									}

									const waitLabel =
										waitMs > 0 ? formatWaitTime(waitMs) : "a bit";
									const message =
										count === 0
											? "No Codex accounts configured. Run `codex login`."
											: waitMs > 0
												? `All ${count} account(s) are rate-limited. Try again in ${waitLabel} or add another account with \`codex login\`.`
												: `All ${count} account(s) failed (server errors or auth issues). Check account health with \`codex-health\`.`;
									runtimeMetrics.failedRequests++;
									runtimeMetrics.lastError = message;
									return new Response(JSON.stringify({ error: { message } }), {
										status: waitMs > 0 ? 429 : 503,
										headers: {
											"content-type": "application/json; charset=utf-8",
										},
									});
								}
							} finally {
								clearCorrelationId();
							}
						},
					};
				} finally {
					resolveMutex?.();
					loaderMutex = null;
				}
			},
			methods: [
				{
					label: AUTH_LABELS.OAUTH,
					type: "oauth" as const,
					authorize: async (inputs?: Record<string, string>) => {
						const authPluginConfig = loadPluginConfig();
						applyUiRuntimeFromConfig(authPluginConfig, setUiRuntimeOptions);
						applyAccountStorageScope(authPluginConfig);

						const accounts: TokenSuccessWithAccount[] = [];
						const noBrowser =
							inputs?.manual === "true" ||
							inputs?.noBrowser === "true" ||
							inputs?.["no-browser"] === "true";
						const useManualMode = noBrowser || isBrowserLaunchSuppressed();
						const explicitLoginMode =
							inputs?.loginMode === "fresh" || inputs?.loginMode === "add"
								? inputs.loginMode
								: null;

						let startFresh = explicitLoginMode === "fresh";
						let refreshAccountIndex: number | undefined;

						const runAccountCheck = async (deepProbe: boolean): Promise<void> =>
							runRuntimeAccountCheck(deepProbe, {
								hydrateEmails,
								loadAccounts,
								createEmptyStorage: () => ({
									version: 3 as const,
									accounts: [],
									activeIndex: 0,
									activeIndexByFamily: {},
								}),
								loadFlaggedAccounts,
								createAccountCheckWorkingState,
								lookupCodexCliTokensByEmail,
								extractAccountId,
								shouldUpdateAccountIdFromToken,
								sanitizeEmail,
								extractAccountEmail,
								queuedRefresh,
								isRuntimeFlaggableFailure: isFlaggableFailure,
								fetchCodexQuotaSnapshot,
								resolveRequestAccountId,
								formatCodexQuotaLine: formatQuotaSnapshotLine,
								clampRuntimeActiveIndices: clampActiveIndices,
								MODEL_FAMILIES,
								saveAccounts,
								invalidateAccountManagerCache,
								saveFlaggedAccounts,
								showLine: (message) => console.log(message),
							});

						if (!explicitLoginMode) {
							while (true) {
								const loadedStorage = await hydrateEmails(await loadAccounts());
								const workingStorage = loadedStorage
									? {
											...loadedStorage,
											accounts: loadedStorage.accounts.map((account) => ({
												...account,
											})),
											activeIndexByFamily: loadedStorage.activeIndexByFamily
												? { ...loadedStorage.activeIndexByFamily }
												: {},
										}
									: {
											version: 3 as const,
											accounts: [],
											activeIndex: 0,
											activeIndexByFamily: {},
										};
								const flaggedStorage = await loadFlaggedAccounts();

								if (
									workingStorage.accounts.length === 0 &&
									flaggedStorage.accounts.length === 0
								) {
									break;
								}

								const now = Date.now();
								const activeIndex = resolveActiveIndex(workingStorage, "codex");
								const existingAccounts = buildLoginMenuAccounts(
									workingStorage.accounts,
									{
										now,
										activeIndex,
										formatRateLimitEntry: (account, currentNow) =>
											formatRateLimitEntry(
												account,
												currentNow,
												formatWaitTime,
											),
									},
								);

								const menuResult = await promptLoginMode(existingAccounts, {
									flaggedCount: flaggedStorage.accounts.length,
								});

								if (menuResult.mode === "cancel") {
									return {
										url: "",
										instructions: "Authentication cancelled",
										method: "auto",
										callback: () =>
											Promise.resolve({
												type: "failed" as const,
											}),
									};
								}

								if (menuResult.mode === "check") {
									await runAccountCheck(false);
									continue;
								}
								if (menuResult.mode === "deep-check") {
									await runAccountCheck(true);
									continue;
								}
								if (menuResult.mode === "verify-flagged") {
									await verifyRuntimeFlaggedAccounts({
										loadFlaggedAccounts,
										lookupCodexCliTokensByEmail,
										queuedRefresh,
										resolveTokenSuccessAccount,
										persistAccounts: persistAccountPool,
										invalidateAccountManagerCache,
										saveFlaggedAccounts,
										showLine: (message) => console.log(message),
									});
									continue;
								}

								if (menuResult.mode === "manage") {
									if (typeof menuResult.deleteAccountIndex === "number") {
										const target =
											workingStorage.accounts[menuResult.deleteAccountIndex];
										if (target) {
											workingStorage.accounts.splice(
												menuResult.deleteAccountIndex,
												1,
											);
											clampActiveIndices(workingStorage, MODEL_FAMILIES);
											await saveAccounts(workingStorage);
											await saveFlaggedAccounts({
												version: 1,
												accounts: flaggedStorage.accounts.filter(
													(flagged) =>
														flagged.refreshToken !== target.refreshToken,
												),
											});
											invalidateAccountManagerCache();
											console.log(
												`\nDeleted ${target.email ?? `Account ${menuResult.deleteAccountIndex + 1}`}.\n`,
											);
										}
										continue;
									}

									if (typeof menuResult.toggleAccountIndex === "number") {
										const target =
											workingStorage.accounts[menuResult.toggleAccountIndex];
										if (target) {
											target.enabled = target.enabled === false ? true : false;
											await saveAccounts(workingStorage);
											invalidateAccountManagerCache();
											console.log(
												`\n${target.email ?? `Account ${menuResult.toggleAccountIndex + 1}`} ${target.enabled === false ? "disabled" : "enabled"}.\n`,
											);
										}
										continue;
									}

									if (typeof menuResult.refreshAccountIndex === "number") {
										refreshAccountIndex = menuResult.refreshAccountIndex;
										startFresh = false;
										break;
									}

									continue;
								}

								if (menuResult.mode === "fresh") {
									startFresh = true;
									if (menuResult.deleteAll) {
										await clearAccounts();
										await clearFlaggedAccounts();
										invalidateAccountManagerCache();
										console.log(
											"\nCleared saved accounts from active storage. Recovery snapshots remain available. Starting fresh.\n",
										);
									}
									break;
								}

								startFresh = false;
								break;
							}
						}

						const latestStorage = await loadAccounts();
						const existingCount = latestStorage?.accounts.length ?? 0;
						const requestedCount = Number.parseInt(
							inputs?.accountCount ?? "1",
							10,
						);
						const normalizedRequested = Number.isFinite(requestedCount)
							? requestedCount
							: 1;
						const availableSlots =
							refreshAccountIndex !== undefined
								? 1
								: startFresh
									? ACCOUNT_LIMITS.MAX_ACCOUNTS
									: ACCOUNT_LIMITS.MAX_ACCOUNTS - existingCount;

						if (availableSlots <= 0) {
							return {
								url: "",
								instructions:
									"Account limit reached. Remove an account or start fresh.",
								method: "auto",
								callback: () =>
									Promise.resolve({
										type: "failed" as const,
									}),
							};
						}

						let targetCount = Math.max(
							1,
							Math.min(normalizedRequested, availableSlots),
						);
						if (refreshAccountIndex !== undefined) {
							targetCount = 1;
						}
						if (useManualMode) {
							targetCount = 1;
						}

						if (useManualMode) {
							const { pkce, state, url } = await createAuthorizationFlow();
							return buildManualOAuthFlow({
								pkce,
								url,
								expectedState: state,
								redirectUri: REDIRECT_URI,
								parseAuthorizationInput,
								exchangeAuthorizationCode,
								resolveTokenSuccess: resolveTokenSuccessAccount,
								instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
								onSuccess: async (tokens) => {
									try {
										await persistAccountPool([tokens], startFresh);
										invalidateAccountManagerCache();
									} catch (err) {
										const storagePath = getStoragePath();
										const errorCode =
											(err as NodeJS.ErrnoException)?.code || "UNKNOWN";
										const hint =
											err instanceof StorageError
												? err.hint
												: formatStorageErrorHint(err, storagePath);
										logError(
											`[${PLUGIN_NAME}] Failed to persist account: [${errorCode}] ${(err as Error)?.message ?? String(err)}`,
										);
										await showToast(hint, "error", {
											title: "Account Persistence Failed",
											duration: 10000,
										});
									}
								},
							});
						}

						const explicitCountProvided =
							typeof inputs?.accountCount === "string" &&
							inputs.accountCount.trim().length > 0;

						while (accounts.length < targetCount) {
							logInfo(`=== OpenAI OAuth (Account ${accounts.length + 1}) ===`);
							const forceNewLogin =
								accounts.length > 0 || refreshAccountIndex !== undefined;
							const result = await runOAuthFlow(forceNewLogin);

							let resolved: TokenSuccessWithAccount | null = null;
							if (result.type === "success") {
								resolved = resolveTokenSuccessAccount(result);
								const email = extractAccountEmail(
									resolved.access,
									resolved.idToken,
								);
								const accountId =
									resolved.accountIdOverride ??
									extractAccountId(resolved.access);
								const label =
									resolved.accountLabel ??
									email ??
									accountId ??
									"Unknown account";
								logInfo(`Authenticated as: ${label}`);

								const isDuplicate =
									findMatchingAccountIndex(
										accounts.map((account) => ({
											accountId:
												account.accountIdOverride ??
												extractAccountId(account.access),
											email: sanitizeEmail(
												extractAccountEmail(account.access, account.idToken),
											),
											refreshToken: account.refresh,
										})),
										{
											accountId,
											email: sanitizeEmail(email),
											refreshToken: resolved.refresh,
										},
										{
											allowUniqueAccountIdFallbackWithoutEmail: true,
										},
									) !== undefined;

								if (isDuplicate) {
									logWarn(
										`WARNING: duplicate account login detected (${label}). Existing entry will be updated.`,
									);
								}
							}

							if (result.type === "failed") {
								if (accounts.length === 0) {
									return {
										url: "",
										instructions: "Authentication failed.",
										method: "auto",
										callback: () => Promise.resolve(result),
									};
								}
								logWarn(
									`[${PLUGIN_NAME}] Skipping failed account ${accounts.length + 1}`,
								);
								break;
							}

							if (!resolved) {
								continue;
							}

							accounts.push(resolved);
							await showToast(
								`Account ${accounts.length} authenticated`,
								"success",
							);

							try {
								const isFirstAccount = accounts.length === 1;
								await persistAccountPool(
									[resolved],
									isFirstAccount && startFresh,
								);
								invalidateAccountManagerCache();
							} catch (err) {
								const storagePath = getStoragePath();
								const errorCode =
									(err as NodeJS.ErrnoException)?.code || "UNKNOWN";
								const hint =
									err instanceof StorageError
										? err.hint
										: formatStorageErrorHint(err, storagePath);
								logError(
									`[${PLUGIN_NAME}] Failed to persist account: [${errorCode}] ${(err as Error)?.message ?? String(err)}`,
								);
								await showToast(hint, "error", {
									title: "Account Persistence Failed",
									duration: 10000,
								});
							}

							if (accounts.length >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
								break;
							}

							if (
								!explicitCountProvided &&
								refreshAccountIndex === undefined &&
								accounts.length < availableSlots &&
								accounts.length >= targetCount
							) {
								const addMore = await promptAddAnotherAccount(accounts.length);
								if (addMore) {
									targetCount = Math.min(targetCount + 1, availableSlots);
									continue;
								}
								break;
							}
						}

						const primary = accounts[0];
						if (!primary) {
							return {
								url: "",
								instructions: "Authentication cancelled",
								method: "auto",
								callback: () =>
									Promise.resolve({
										type: "failed" as const,
									}),
							};
						}

						let actualAccountCount = accounts.length;
						try {
							const finalStorage = await loadAccounts();
							if (finalStorage) {
								actualAccountCount = finalStorage.accounts.length;
							}
						} catch (err) {
							logWarn(
								`[${PLUGIN_NAME}] Failed to load final account count: ${(err as Error)?.message ?? String(err)}`,
							);
						}

						return {
							url: "",
							instructions: `Multi-account setup complete (${actualAccountCount} account(s)).`,
							method: "auto",
							callback: () => Promise.resolve(primary),
						};
					},
				},

				{
					label: AUTH_LABELS.OAUTH_MANUAL,
					type: "oauth" as const,
					authorize: async () => {
						// Initialize storage path for manual OAuth flow
						// Must happen BEFORE persistAccountPool to ensure correct storage location
						const manualPluginConfig = loadPluginConfig();
						applyUiRuntimeFromConfig(manualPluginConfig, setUiRuntimeOptions);
						applyAccountStorageScope(manualPluginConfig);

						const { pkce, state, url } = await createAuthorizationFlow();
						return buildManualOAuthFlow({
							pkce,
							url,
							expectedState: state,
							redirectUri: REDIRECT_URI,
							parseAuthorizationInput,
							exchangeAuthorizationCode,
							resolveTokenSuccess: resolveTokenSuccessAccount,
							instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
							onSuccess: async (tokens) => {
								try {
									await persistAccountPool([tokens], false);
								} catch (err) {
									const storagePath = getStoragePath();
									const errorCode =
										(err as NodeJS.ErrnoException)?.code || "UNKNOWN";
									const hint =
										err instanceof StorageError
											? err.hint
											: formatStorageErrorHint(err, storagePath);
									logError(
										`[${PLUGIN_NAME}] Failed to persist account: [${errorCode}] ${(err as Error)?.message ?? String(err)}`,
									);
									await showToast(hint, "error", {
										title: "Account Persistence Failed",
										duration: 10000,
									});
								}
							},
						});
					},
				},
			],
		},
		tool: {
			edit: createHashlineEditTool(),
			// Legacy runtime v1.2.x exposes apply_patch (not edit) to the model.
			// Register the same hashline-capable implementation under both names.
			apply_patch: createHashlineEditTool(),
			hashline_read: createHashlineReadTool(),
			"codex-list": tool({
				description:
					"List all Codex OAuth accounts and the current active index.",
				args: {},
				async execute() {
					const ui = resolveUiRuntime();
					const storage = await loadAccounts();
					const storePath = getStoragePath();

					if (!storage || storage.accounts.length === 0) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Codex accounts"),
								"",
								formatUiItem(ui, "No accounts configured.", "warning"),
								formatUiItem(ui, "Run: codex login", "accent"),
								formatUiKeyValue(ui, "Storage", storePath, "muted"),
							].join("\n");
						}
						return [
							"No Codex accounts configured.",
							"",
							"Add accounts:",
							"  codex login",
							"",
							`Storage: ${storePath}`,
						].join("\n");
					}

					const now = Date.now();
					const activeIndex = resolveActiveIndex(storage, "codex");
					if (ui.v2Enabled) {
						const lines: string[] = [
							...formatUiHeader(ui, "Codex accounts"),
							formatUiKeyValue(ui, "Total", String(storage.accounts.length)),
							formatUiKeyValue(ui, "Storage", storePath, "muted"),
							"",
							...formatUiSection(ui, "Accounts"),
						];

						storage.accounts.forEach((account, index) => {
							const label = formatAccountLabel(account, index);
							const badges: string[] = [];
							if (index === activeIndex)
								badges.push(formatUiBadge(ui, "current", "accent"));
							if (account.enabled === false)
								badges.push(formatUiBadge(ui, "disabled", "danger"));
							const rateLimit = formatRateLimitEntry(
								account,
								now,
								formatWaitTime,
							);
							if (rateLimit)
								badges.push(formatUiBadge(ui, "rate-limited", "warning"));
							if (
								typeof account.coolingDownUntil === "number" &&
								account.coolingDownUntil > now
							) {
								badges.push(formatUiBadge(ui, "cooldown", "warning"));
							}
							if (badges.length === 0) {
								badges.push(formatUiBadge(ui, "ok", "success"));
							}

							lines.push(
								formatUiItem(
									ui,
									`${index + 1}. ${label} ${badges.join(" ")}`.trim(),
								),
							);
							if (rateLimit) {
								lines.push(
									`  ${paintUiText(ui, `rate limit: ${rateLimit}`, "muted")}`,
								);
							}
						});

						lines.push("");
						lines.push(...formatUiSection(ui, "Commands"));
						lines.push(formatUiItem(ui, "Add account: codex login", "accent"));
						lines.push(
							formatUiItem(ui, "Switch account: codex-switch <index>"),
						);
						lines.push(formatUiItem(ui, "Detailed status: codex-status"));
						lines.push(formatUiItem(ui, "Health check: codex-health"));
						return lines.join("\n");
					}

					const listTableOptions: TableOptions = {
						columns: [
							{ header: "#", width: 3 },
							{ header: "Label", width: 42 },
							{ header: "Status", width: 20 },
						],
					};

					const lines: string[] = [
						`Codex Accounts (${storage.accounts.length}):`,
						"",
						...buildTableHeader(listTableOptions),
					];

					storage.accounts.forEach((account, index) => {
						const label = formatAccountLabel(account, index);
						const statuses: string[] = [];
						const rateLimit = formatRateLimitEntry(
							account,
							now,
							formatWaitTime,
						);
						if (index === activeIndex) statuses.push("active");
						if (rateLimit) statuses.push("rate-limited");
						if (
							typeof account.coolingDownUntil === "number" &&
							account.coolingDownUntil > now
						) {
							statuses.push("cooldown");
						}
						const statusText = statuses.length > 0 ? statuses.join(", ") : "ok";
						lines.push(
							buildTableRow(
								[String(index + 1), label, statusText],
								listTableOptions,
							),
						);
					});

					lines.push("");
					lines.push(`Storage: ${storePath}`);
					lines.push("");
					lines.push("Commands:");
					lines.push("  - Add account: codex login");
					lines.push("  - Switch account: codex-switch");
					lines.push("  - Status details: codex-status");
					lines.push("  - Health check: codex-health");

					return lines.join("\n");
				},
			}),
			"codex-switch": tool({
				description: "Switch active Codex account by index (1-based).",
				args: {
					index: tool.schema
						.number()
						.describe(
							"Account number to switch to (1-based, e.g., 1 for first account)",
						),
				},
				async execute({ index }) {
					const ui = resolveUiRuntime();
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Switch account"),
								"",
								formatUiItem(ui, "No accounts configured.", "warning"),
								formatUiItem(ui, "Run: codex login", "accent"),
							].join("\n");
						}
						return "No Codex accounts configured. Run: codex login";
					}

					const targetIndex = Math.floor((index ?? 0) - 1);
					if (
						!Number.isFinite(targetIndex) ||
						targetIndex < 0 ||
						targetIndex >= storage.accounts.length
					) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Switch account"),
								"",
								formatUiItem(ui, `Invalid account number: ${index}`, "danger"),
								formatUiKeyValue(
									ui,
									"Valid range",
									`1-${storage.accounts.length}`,
									"muted",
								),
							].join("\n");
						}
						return `Invalid account number: ${index}\n\nValid range: 1-${storage.accounts.length}`;
					}

					const now = Date.now();
					const account = storage.accounts[targetIndex];
					if (account) {
						account.lastUsed = now;
						account.lastSwitchReason = "rotation";
					}

					storage.activeIndex = targetIndex;
					storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
					for (const family of MODEL_FAMILIES) {
						storage.activeIndexByFamily[family] = targetIndex;
					}
					try {
						await saveAccounts(storage);
					} catch (saveError) {
						logWarn("Failed to save account switch", {
							error: String(saveError),
						});
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Switch account"),
								"",
								formatUiItem(
									ui,
									`Switched to ${formatAccountLabel(account, targetIndex)}`,
									"warning",
								),
								formatUiItem(
									ui,
									"Failed to persist change. It may be lost on restart.",
									"danger",
								),
							].join("\n");
						}
						return `Switched to ${formatAccountLabel(account, targetIndex)} but failed to persist. Changes may be lost on restart.`;
					}

					if (cachedAccountManager) {
						await reloadAccountManagerFromDisk();
					}

					const label = formatAccountLabel(account, targetIndex);
					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Switch account"),
							"",
							formatUiItem(
								ui,
								`${getStatusMarker(ui, "ok")} Switched to ${label}`,
								"success",
							),
						].join("\n");
					}
					return `Switched to account: ${label}`;
				},
			}),
			"codex-status": tool({
				description: "Show detailed status of Codex accounts and rate limits.",
				args: {},
				async execute() {
					const ui = resolveUiRuntime();
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Account status"),
								"",
								formatUiItem(ui, "No accounts configured.", "warning"),
								formatUiItem(ui, "Run: codex login", "accent"),
							].join("\n");
						}
						return "No Codex accounts configured. Run: codex login";
					}

					const now = Date.now();
					const activeIndex = resolveActiveIndex(storage, "codex");
					if (ui.v2Enabled) {
						const lines: string[] = [
							...formatUiHeader(ui, "Account status"),
							formatUiKeyValue(ui, "Total", String(storage.accounts.length)),
							"",
							...formatUiSection(ui, "Accounts"),
						];

						storage.accounts.forEach((account, index) => {
							const label = formatAccountLabel(account, index);
							const badges: string[] = [];
							if (index === activeIndex)
								badges.push(formatUiBadge(ui, "active", "accent"));
							if (account.enabled === false)
								badges.push(formatUiBadge(ui, "disabled", "danger"));
							const rateLimit =
								formatRateLimitEntry(account, now, formatWaitTime) ?? "none";
							const cooldown = formatCooldown(account, now) ?? "none";
							if (rateLimit !== "none")
								badges.push(formatUiBadge(ui, "rate-limited", "warning"));
							if (cooldown !== "none")
								badges.push(formatUiBadge(ui, "cooldown", "warning"));
							if (badges.length === 0)
								badges.push(formatUiBadge(ui, "ok", "success"));

							lines.push(
								formatUiItem(
									ui,
									`${index + 1}. ${label} ${badges.join(" ")}`.trim(),
								),
							);
							lines.push(
								`  ${formatUiKeyValue(ui, "rate limit", rateLimit, rateLimit === "none" ? "muted" : "warning")}`,
							);
							lines.push(
								`  ${formatUiKeyValue(ui, "cooldown", cooldown, cooldown === "none" ? "muted" : "warning")}`,
							);
						});

						lines.push("");
						lines.push(...formatUiSection(ui, "Active index by model family"));
						for (const family of MODEL_FAMILIES) {
							const idx = storage.activeIndexByFamily?.[family];
							const familyIndexLabel =
								typeof idx === "number" && Number.isFinite(idx)
									? String(idx + 1)
									: "-";
							lines.push(formatUiItem(ui, `${family}: ${familyIndexLabel}`));
						}

						lines.push("");
						lines.push(
							...formatUiSection(
								ui,
								"Rate limits by model family (per account)",
							),
						);
						storage.accounts.forEach((account, index) => {
							const statuses = MODEL_FAMILIES.map((family) => {
								const resetAt = getRateLimitResetTimeForFamily(
									account,
									now,
									family,
								);
								if (typeof resetAt !== "number") return `${family}=ok`;
								return `${family}=${formatWaitTime(resetAt - now)}`;
							});
							lines.push(
								formatUiItem(
									ui,
									`Account ${index + 1}: ${statuses.join(" | ")}`,
								),
							);
						});

						return lines.join("\n");
					}

					const statusTableOptions: TableOptions = {
						columns: [
							{ header: "#", width: 3 },
							{ header: "Label", width: 42 },
							{ header: "Active", width: 6 },
							{ header: "Rate Limit", width: 16 },
							{ header: "Cooldown", width: 16 },
							{ header: "Last Used", width: 16 },
						],
					};

					const lines: string[] = [
						`Account Status (${storage.accounts.length} total):`,
						"",
						...buildTableHeader(statusTableOptions),
					];

					storage.accounts.forEach((account, index) => {
						const label = formatAccountLabel(account, index);
						const active = index === activeIndex ? "Yes" : "No";
						const rateLimit =
							formatRateLimitEntry(account, now, formatWaitTime) ?? "None";
						const cooldown = formatCooldown(account, now) ?? "No";
						const lastUsed =
							typeof account.lastUsed === "number" && account.lastUsed > 0
								? `${formatWaitTime(now - account.lastUsed)} ago`
								: "-";

						lines.push(
							buildTableRow(
								[
									String(index + 1),
									label,
									active,
									rateLimit,
									cooldown,
									lastUsed,
								],
								statusTableOptions,
							),
						);
					});

					lines.push("");
					lines.push("Active index by model family:");
					for (const family of MODEL_FAMILIES) {
						const idx = storage.activeIndexByFamily?.[family];
						const familyIndexLabel =
							typeof idx === "number" && Number.isFinite(idx)
								? String(idx + 1)
								: "-";
						lines.push(`  ${family}: ${familyIndexLabel}`);
					}

					lines.push("");
					lines.push("Rate limits by model family (per account):");
					storage.accounts.forEach((account, index) => {
						const statuses = MODEL_FAMILIES.map((family) => {
							const resetAt = getRateLimitResetTimeForFamily(
								account,
								now,
								family,
							);
							if (typeof resetAt !== "number") return `${family}=ok`;
							return `${family}=${formatWaitTime(resetAt - now)}`;
						});
						lines.push(`  Account ${index + 1}: ${statuses.join(" | ")}`);
					});

					return lines.join("\n");
				},
			}),
			...(exposeAdvancedCodexTools
				? {
						"codex-metrics": tool({
							description:
								"Show runtime request metrics for this plugin process.",
							args: {},
							execute() {
								const ui = resolveUiRuntime();
								const now = Date.now();
								const uptimeMs = Math.max(0, now - runtimeMetrics.startedAt);
								const total = runtimeMetrics.totalRequests;
								const successful = runtimeMetrics.successfulRequests;
								const successRate =
									total > 0 ? ((successful / total) * 100).toFixed(1) : "0.0";
								const avgLatencyMs =
									successful > 0
										? Math.round(
												runtimeMetrics.cumulativeLatencyMs / successful,
											)
										: 0;
								const liveSyncSnapshot = liveAccountSync?.getSnapshot();
								const guardianStats = refreshGuardian?.getStats();
								const sessionAffinityEntries =
									sessionAffinityStore?.size() ?? 0;
								const lastRequest =
									runtimeMetrics.lastRequestAt !== null
										? `${formatWaitTime(now - runtimeMetrics.lastRequestAt)} ago`
										: "never";

								const lines = [
									"Codex Plugin Metrics:",
									"",
									`Uptime: ${formatWaitTime(uptimeMs)}`,
									`Total upstream requests: ${total}`,
									`Successful responses: ${successful}`,
									`Failed responses: ${runtimeMetrics.failedRequests}`,
									`Success rate: ${successRate}%`,
									`Average successful latency: ${avgLatencyMs}ms`,
									`Rate-limited responses: ${runtimeMetrics.rateLimitedResponses}`,
									`Server errors (5xx): ${runtimeMetrics.serverErrors}`,
									`Network errors: ${runtimeMetrics.networkErrors}`,
									`User aborts: ${runtimeMetrics.userAborts}`,
									`Auth refresh failures: ${runtimeMetrics.authRefreshFailures}`,
									`Account rotations: ${runtimeMetrics.accountRotations}`,
									`Same-account retries: ${runtimeMetrics.sameAccountRetries}`,
									`Stream failover attempts: ${runtimeMetrics.streamFailoverAttempts}`,
									`Stream failover recoveries: ${runtimeMetrics.streamFailoverRecoveries}`,
									`Stream failover cross-account recoveries: ${runtimeMetrics.streamFailoverCrossAccountRecoveries}`,
									`Empty-response retries: ${runtimeMetrics.emptyResponseRetries}`,
									`Session affinity entries: ${sessionAffinityEntries}`,
									`Live sync: ${liveSyncSnapshot?.running ? "on" : "off"} (${liveSyncSnapshot?.reloadCount ?? 0} reloads)`,
									`Refresh guardian: ${guardianStats ? "on" : "off"} (${guardianStats?.refreshed ?? 0} refreshed, ${guardianStats?.failed ?? 0} failed)`,
									`Last upstream request: ${lastRequest}`,
								];

								if (runtimeMetrics.lastError) {
									lines.push(`Last error: ${runtimeMetrics.lastError}`);
								}

								if (ui.v2Enabled) {
									const styled: string[] = [
										...formatUiHeader(ui, "Codex plugin metrics"),
										formatUiKeyValue(ui, "Uptime", formatWaitTime(uptimeMs)),
										formatUiKeyValue(
											ui,
											"Total upstream requests",
											String(total),
										),
										formatUiKeyValue(
											ui,
											"Successful responses",
											String(successful),
											"success",
										),
										formatUiKeyValue(
											ui,
											"Failed responses",
											String(runtimeMetrics.failedRequests),
											"danger",
										),
										formatUiKeyValue(
											ui,
											"Success rate",
											`${successRate}%`,
											"accent",
										),
										formatUiKeyValue(
											ui,
											"Average successful latency",
											`${avgLatencyMs}ms`,
										),
										formatUiKeyValue(
											ui,
											"Rate-limited responses",
											String(runtimeMetrics.rateLimitedResponses),
											"warning",
										),
										formatUiKeyValue(
											ui,
											"Server errors (5xx)",
											String(runtimeMetrics.serverErrors),
											"danger",
										),
										formatUiKeyValue(
											ui,
											"Network errors",
											String(runtimeMetrics.networkErrors),
											"danger",
										),
										formatUiKeyValue(
											ui,
											"User aborts",
											String(runtimeMetrics.userAborts),
											"muted",
										),
										formatUiKeyValue(
											ui,
											"Auth refresh failures",
											String(runtimeMetrics.authRefreshFailures),
											"warning",
										),
										formatUiKeyValue(
											ui,
											"Account rotations",
											String(runtimeMetrics.accountRotations),
											"accent",
										),
										formatUiKeyValue(
											ui,
											"Same-account retries",
											String(runtimeMetrics.sameAccountRetries),
											"warning",
										),
										formatUiKeyValue(
											ui,
											"Stream failover attempts",
											String(runtimeMetrics.streamFailoverAttempts),
											"muted",
										),
										formatUiKeyValue(
											ui,
											"Stream failover recoveries",
											String(runtimeMetrics.streamFailoverRecoveries),
											"success",
										),
										formatUiKeyValue(
											ui,
											"Stream failover cross-account recoveries",
											String(
												runtimeMetrics.streamFailoverCrossAccountRecoveries,
											),
											"accent",
										),
										formatUiKeyValue(
											ui,
											"Empty-response retries",
											String(runtimeMetrics.emptyResponseRetries),
											"warning",
										),
										formatUiKeyValue(
											ui,
											"Session affinity entries",
											String(sessionAffinityEntries),
											"muted",
										),
										formatUiKeyValue(
											ui,
											"Live sync",
											`${liveSyncSnapshot?.running ? "on" : "off"} (${liveSyncSnapshot?.reloadCount ?? 0} reloads)`,
											liveSyncSnapshot?.running ? "success" : "muted",
										),
										formatUiKeyValue(
											ui,
											"Refresh guardian",
											guardianStats
												? `on (${guardianStats.refreshed} refreshed, ${guardianStats.failed} failed)`
												: "off",
											guardianStats ? "success" : "muted",
										),
										formatUiKeyValue(
											ui,
											"Last upstream request",
											lastRequest,
											"muted",
										),
									];
									if (runtimeMetrics.lastError) {
										styled.push(
											formatUiKeyValue(
												ui,
												"Last error",
												runtimeMetrics.lastError,
												"danger",
											),
										);
									}
									return Promise.resolve(styled.join("\n"));
								}

								return Promise.resolve(lines.join("\n"));
							},
						}),
					}
				: {}),
			"codex-health": tool({
				description:
					"Check health of all Codex accounts by validating refresh tokens.",
				args: {},
				async execute() {
					const ui = resolveUiRuntime();
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Health check"),
								"",
								formatUiItem(ui, "No accounts configured.", "warning"),
								formatUiItem(ui, "Run: codex login", "accent"),
							].join("\n");
						}
						return "No Codex accounts configured. Run: codex login";
					}

					const results: string[] = ui.v2Enabled
						? []
						: [`Health Check (${storage.accounts.length} accounts):`, ""];

					let healthyCount = 0;
					let unhealthyCount = 0;

					for (let i = 0; i < storage.accounts.length; i++) {
						const account = storage.accounts[i];
						if (!account) continue;

						const label = formatAccountLabel(account, i);
						try {
							const refreshResult = await queuedRefresh(account.refreshToken);
							if (refreshResult.type === "success") {
								results.push(
									`  ${getStatusMarker(ui, "ok")} ${label}: Healthy`,
								);
								healthyCount++;
							} else {
								results.push(
									`  ${getStatusMarker(ui, "error")} ${label}: Token refresh failed`,
								);
								unhealthyCount++;
							}
						} catch (error) {
							const errorMsg =
								error instanceof Error ? error.message : String(error);
							results.push(
								`  ${getStatusMarker(ui, "error")} ${label}: Error - ${errorMsg.slice(0, 120)}`,
							);
							unhealthyCount++;
						}
					}

					results.push("");
					results.push(
						`Summary: ${healthyCount} healthy, ${unhealthyCount} unhealthy`,
					);

					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Health check"),
							"",
							...results.map((line) => paintUiText(ui, line, "normal")),
						].join("\n");
					}

					return results.join("\n");
				},
			}),
			...(exposeAdvancedCodexTools
				? {
						"codex-remove": tool({
							description:
								"Remove a Codex account by index (1-based). Use codex-list to list accounts first.",
							args: {
								index: tool.schema
									.number()
									.describe(
										"Account number to remove (1-based, e.g., 1 for first account)",
									),
							},
							async execute({ index }) {
								const ui = resolveUiRuntime();
								const storage = await loadAccounts();
								if (!storage || storage.accounts.length === 0) {
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Remove account"),
											"",
											formatUiItem(ui, "No accounts configured.", "warning"),
										].join("\n");
									}
									return "No Codex accounts configured. Nothing to remove.";
								}

								const targetIndex = Math.floor((index ?? 0) - 1);
								if (
									!Number.isFinite(targetIndex) ||
									targetIndex < 0 ||
									targetIndex >= storage.accounts.length
								) {
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Remove account"),
											"",
											formatUiItem(
												ui,
												`Invalid account number: ${index}`,
												"danger",
											),
											formatUiKeyValue(
												ui,
												"Valid range",
												`1-${storage.accounts.length}`,
												"muted",
											),
											formatUiItem(
												ui,
												"Use codex-list to list all accounts.",
												"accent",
											),
										].join("\n");
									}
									return `Invalid account number: ${index}\n\nValid range: 1-${storage.accounts.length}\n\nUse codex-list to list all accounts.`;
								}

								const account = storage.accounts[targetIndex];
								if (!account) {
									return `Account ${index} not found.`;
								}

								const label = formatAccountLabel(account, targetIndex);

								storage.accounts.splice(targetIndex, 1);

								if (storage.accounts.length === 0) {
									storage.activeIndex = 0;
									storage.activeIndexByFamily = {};
								} else {
									if (storage.activeIndex >= storage.accounts.length) {
										storage.activeIndex = 0;
									} else if (storage.activeIndex > targetIndex) {
										storage.activeIndex -= 1;
									}

									if (storage.activeIndexByFamily) {
										for (const family of MODEL_FAMILIES) {
											const idx = storage.activeIndexByFamily[family];
											if (typeof idx === "number") {
												if (idx >= storage.accounts.length) {
													storage.activeIndexByFamily[family] = 0;
												} else if (idx > targetIndex) {
													storage.activeIndexByFamily[family] = idx - 1;
												}
											}
										}
									}
								}

								try {
									await saveAccounts(storage);
								} catch (saveError) {
									logWarn("Failed to save account removal", {
										error: String(saveError),
									});
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Remove account"),
											"",
											formatUiItem(
												ui,
												`Removed ${formatAccountLabel(account, targetIndex)} from memory`,
												"warning",
											),
											formatUiItem(
												ui,
												"Failed to persist. Change may be lost on restart.",
												"danger",
											),
										].join("\n");
									}
									return `Removed ${formatAccountLabel(account, targetIndex)} from memory but failed to persist. Changes may be lost on restart.`;
								}

								if (cachedAccountManager) {
									await reloadAccountManagerFromDisk();
								}

								const remaining = storage.accounts.length;
								if (ui.v2Enabled) {
									return [
										...formatUiHeader(ui, "Remove account"),
										"",
										formatUiItem(
											ui,
											`${getStatusMarker(ui, "ok")} Removed: ${label}`,
											"success",
										),
										remaining > 0
											? formatUiKeyValue(
													ui,
													"Remaining accounts",
													String(remaining),
												)
											: formatUiItem(
													ui,
													"No accounts remaining. Run: codex login",
													"warning",
												),
									].join("\n");
								}
								return [
									`Removed: ${label}`,
									"",
									remaining > 0
										? `Remaining accounts: ${remaining}`
										: "No accounts remaining. Run: codex login",
								].join("\n");
							},
						}),

						"codex-refresh": tool({
							description:
								"Manually refresh OAuth tokens for all accounts to verify they're still valid.",
							args: {},
							async execute() {
								const ui = resolveUiRuntime();
								const storage = await loadAccounts();
								if (!storage || storage.accounts.length === 0) {
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Refresh accounts"),
											"",
											formatUiItem(ui, "No accounts configured.", "warning"),
											formatUiItem(ui, "Run: codex login", "accent"),
										].join("\n");
									}
									return "No Codex accounts configured. Run: codex login";
								}

								const results: string[] = ui.v2Enabled
									? []
									: [`Refreshing ${storage.accounts.length} account(s):`, ""];

								let refreshedCount = 0;
								let failedCount = 0;

								for (let i = 0; i < storage.accounts.length; i++) {
									const account = storage.accounts[i];
									if (!account) continue;
									const label = formatAccountLabel(account, i);

									try {
										const refreshResult = await queuedRefresh(
											account.refreshToken,
										);
										if (refreshResult.type === "success") {
											account.refreshToken = refreshResult.refresh;
											account.accessToken = refreshResult.access;
											account.expiresAt = refreshResult.expires;
											results.push(
												`  ${getStatusMarker(ui, "ok")} ${label}: Refreshed`,
											);
											refreshedCount++;
										} else {
											results.push(
												`  ${getStatusMarker(ui, "error")} ${label}: Failed - ${refreshResult.message ?? refreshResult.reason}`,
											);
											failedCount++;
										}
									} catch (error) {
										const errorMsg =
											error instanceof Error ? error.message : String(error);
										results.push(
											`  ${getStatusMarker(ui, "error")} ${label}: Error - ${errorMsg.slice(0, 120)}`,
										);
										failedCount++;
									}
								}

								await saveAccounts(storage);
								if (cachedAccountManager) {
									await reloadAccountManagerFromDisk();
								}
								results.push("");
								results.push(
									`Summary: ${refreshedCount} refreshed, ${failedCount} failed`,
								);
								if (ui.v2Enabled) {
									return [
										...formatUiHeader(ui, "Refresh accounts"),
										"",
										...results.map((line) => paintUiText(ui, line, "normal")),
									].join("\n");
								}
								return results.join("\n");
							},
						}),

						"codex-export": tool({
							description:
								"Export accounts to a JSON file for backup or migration to another machine.",
							args: {
								path: tool.schema
									.string()
									.describe(
										"File path to export to (e.g., ~/codex-backup.json)",
									),
								force: tool.schema
									.boolean()
									.optional()
									.describe("Overwrite existing file (default: true)"),
							},
							async execute({ path: filePath, force }) {
								const ui = resolveUiRuntime();
								try {
									await exportAccounts(filePath, force ?? true);
									const storage = await loadAccounts();
									const count = storage?.accounts.length ?? 0;
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Export accounts"),
											"",
											formatUiItem(
												ui,
												`${getStatusMarker(ui, "ok")} Exported ${count} account(s)`,
												"success",
											),
											formatUiKeyValue(ui, "Path", filePath, "muted"),
										].join("\n");
									}
									return `Exported ${count} account(s) to: ${filePath}`;
								} catch (error) {
									const msg =
										error instanceof Error ? error.message : String(error);
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Export accounts"),
											"",
											formatUiItem(
												ui,
												`${getStatusMarker(ui, "error")} Export failed`,
												"danger",
											),
											formatUiKeyValue(ui, "Error", msg, "danger"),
										].join("\n");
									}
									return `Export failed: ${msg}`;
								}
							},
						}),

						"codex-import": tool({
							description:
								"Import accounts from a JSON file, merging with existing accounts.",
							args: {
								path: tool.schema
									.string()
									.describe(
										"File path to import from (e.g., ~/codex-backup.json)",
									),
							},
							async execute({ path: filePath }) {
								const ui = resolveUiRuntime();
								try {
									const result = await importAccounts(filePath);
									invalidateAccountManagerCache();
									const lines = [`Import complete.`, ``];
									if (result.imported > 0) {
										lines.push(`New accounts: ${result.imported}`);
									}
									if (result.skipped > 0) {
										lines.push(`Duplicates skipped: ${result.skipped}`);
									}
									lines.push(`Total accounts: ${result.total}`);
									if (ui.v2Enabled) {
										const styled = [
											...formatUiHeader(ui, "Import accounts"),
											"",
											formatUiItem(
												ui,
												`${getStatusMarker(ui, "ok")} Import complete`,
												"success",
											),
											formatUiKeyValue(ui, "Path", filePath, "muted"),
											formatUiKeyValue(
												ui,
												"New accounts",
												String(result.imported),
												result.imported > 0 ? "success" : "muted",
											),
											formatUiKeyValue(
												ui,
												"Duplicates skipped",
												String(result.skipped),
												result.skipped > 0 ? "warning" : "muted",
											),
											formatUiKeyValue(
												ui,
												"Total accounts",
												String(result.total),
												"accent",
											),
										];
										return styled.join("\n");
									}
									return lines.join("\n");
								} catch (error) {
									const msg =
										error instanceof Error ? error.message : String(error);
									if (ui.v2Enabled) {
										return [
											...formatUiHeader(ui, "Import accounts"),
											"",
											formatUiItem(
												ui,
												`${getStatusMarker(ui, "error")} Import failed`,
												"danger",
											),
											formatUiKeyValue(ui, "Error", msg, "danger"),
										].join("\n");
									}
									return `Import failed: ${msg}`;
								}
							},
						}),
					}
				: {}),
		},
	};
};

export const OpenAIAuthPlugin = OpenAIOAuthPlugin;

export default OpenAIOAuthPlugin;
