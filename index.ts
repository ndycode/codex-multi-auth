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
 * @author numman-ali
 * @repository https://github.com/ndycode/codex-multi-auth

 */

import { tool } from "@codex-ai/plugin/tool";
import type { Plugin, PluginInput } from "@codex-ai/plugin";
import type { Auth } from "@codex-ai/sdk";
import {
        createAuthorizationFlow,
        exchangeAuthorizationCode,
        parseAuthorizationInput,
        redactOAuthUrlForLog,
        REDIRECT_URI,
} from "./lib/auth/auth.js";
import { queuedRefresh } from "./lib/refresh-queue.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import { promptAddAnotherAccount, promptLoginMode } from "./lib/cli.js";
import {
	getCodexMode,
	getFastSession,
	getFastSessionStrategy,
	getFastSessionMaxInputItems,
	getRateLimitToastDebounceMs,
	getRetryAllAccountsMaxRetries,
	getRetryAllAccountsMaxWaitMs,
	getRetryAllAccountsRateLimited,
	getFallbackToGpt52OnUnsupportedGpt53,
	getUnsupportedCodexPolicy,
	getUnsupportedCodexFallbackChain,
	getTokenRefreshSkewMs,
	getSessionRecovery,
	getAutoResume,
	getToastDurationMs,
	getPerProjectAccounts,
	getEmptyResponseMaxRetries,
	getEmptyResponseRetryDelayMs,
	getPidOffsetEnabled,
	getFetchTimeoutMs,
	getStreamStallTimeoutMs,
	getCodexTuiV2,
	getCodexTuiColorProfile,
	getCodexTuiGlyphMode,
	getLiveAccountSync,
	getLiveAccountSyncDebounceMs,
	getLiveAccountSyncPollMs,
	getSessionAffinity,
	getSessionAffinityTtlMs,
	getSessionAffinityMaxEntries,
	getProactiveRefreshGuardian,
	getProactiveRefreshIntervalMs,
	getProactiveRefreshBufferMs,
	getNetworkErrorCooldownMs,
	getServerErrorCooldownMs,
	getStorageBackupEnabled,
	getPreemptiveQuotaEnabled,
	getPreemptiveQuotaRemainingPercent5h,
	getPreemptiveQuotaRemainingPercent7d,
	getPreemptiveQuotaMaxDeferralMs,
	loadPluginConfig,
} from "./lib/config.js";
import {
        AUTH_LABELS,
        CODEX_BASE_URL,
        DUMMY_API_KEY,
        LOG_STAGES,
        PLUGIN_NAME,
        PROVIDER_ID,
        ACCOUNT_LIMITS,
} from "./lib/constants.js";
import {
	initLogger,
	logRequest,
	logDebug,
	logInfo,
	logWarn,
	logError,
	setCorrelationId,
	clearCorrelationId,
} from "./lib/logger.js";
import { checkAndNotify } from "./lib/auto-update-checker.js";
import { handleContextOverflow } from "./lib/context-overflow.js";
import {
	AccountManager,
        getAccountIdCandidates,
        extractAccountEmail,
        extractAccountId,
        formatAccountLabel,
        formatCooldown,
        formatWaitTime,
        sanitizeEmail,
        selectBestAccountCandidate,
        shouldUpdateAccountIdFromToken,
        resolveRequestAccountId,
        parseRateLimitReason,
	lookupCodexCliTokensByEmail,
	isCodexCliSyncEnabled,
} from "./lib/accounts.js";
import {
	resolveActiveIndex,
	getRateLimitResetTimeForFamily,
	formatRateLimitEntry,
} from "./lib/accounts/account-view.js";
import { setActiveIndexForAllFamilies } from "./lib/accounts/active-index.js";
import {
	getStoragePath,
	loadAccounts,
	saveAccounts,
	withAccountStorageTransaction,
	clearAccounts,
	setStoragePath,
	exportAccounts,
	importAccounts,
	loadFlaggedAccounts,
	saveFlaggedAccounts,
	clearFlaggedAccounts,
	normalizeEmailKey,
	StorageError,
	formatStorageErrorHint,
	setStorageBackupEnabled,
	type AccountStorageV3,
	type FlaggedAccountMetadataV1,
} from "./lib/storage.js";
import {
	createCodexHeaders,
	extractRequestUrl,
        handleErrorResponse,
        handleSuccessResponse,
	getUnsupportedCodexModelInfo,
	resolveUnsupportedCodexFallbackModel,
        refreshAndUpdateToken,
        rewriteUrlForCodex,
	shouldRefreshToken,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import { applyFastSessionDefaults } from "./lib/request/request-transformer.js";
import {
	getRateLimitBackoff,
	RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS,
	resetRateLimitBackoff,
} from "./lib/request/rate-limit-backoff.js";
import { isEmptyResponse } from "./lib/request/response-handler.js";
import { addJitter } from "./lib/rotation.js";
import { SessionAffinityStore } from "./lib/session-affinity.js";
import { LiveAccountSync } from "./lib/live-account-sync.js";
import { RefreshGuardian } from "./lib/refresh-guardian.js";
import {
	evaluateFailurePolicy,
	type FailoverMode,
} from "./lib/request/failure-policy.js";
import {
	EntitlementCache,
	resolveEntitlementAccountKey,
} from "./lib/entitlement-cache.js";
import {
	PreemptiveQuotaScheduler,
	readQuotaSchedulerSnapshot,
} from "./lib/preemptive-quota-scheduler.js";
import { CapabilityPolicyStore } from "./lib/capability-policy.js";
import { withStreamingFailover } from "./lib/request/stream-failover.js";
import { buildTableHeader, buildTableRow, type TableOptions } from "./lib/table-formatter.js";
import { setUiRuntimeOptions, type UiRuntimeOptions } from "./lib/ui/runtime.js";
import { paintUiText, formatUiBadge, formatUiHeader, formatUiItem, formatUiKeyValue, formatUiSection } from "./lib/ui/format.js";
import {
	getModelFamily,
	getCodexInstructions,
	MODEL_FAMILIES,
	prewarmCodexInstructions,
	type ModelFamily,
} from "./lib/prompts/codex.js";
import { prewarmHostCodexPrompt } from "./lib/prompts/host-codex-prompt.js";
import type {
	AccountIdSource,
	OAuthAuthDetails,
	RequestBody,
	TokenResult,
	UserConfig,
} from "./lib/types.js";
import {
	createSessionRecoveryHook,
	isRecoverableError,
	detectErrorType,
	getRecoveryToastContent,
} from "./lib/recovery.js";
import {
	createHashlineEditTool,
	createHashlineReadTool,
} from "./lib/tools/hashline-tools.js";
import { registerCleanup } from "./lib/shutdown.js";

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
	let sessionAffinityStore: SessionAffinityStore | null = new SessionAffinityStore();
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

	const parseFailoverMode = (value: string | undefined): FailoverMode => {
		const normalized = (value ?? "").trim().toLowerCase();
		if (normalized === "aggressive") return "aggressive";
		if (normalized === "conservative") return "conservative";
		return "balanced";
	};

		const parseEnvInt = (value: string | undefined): number | undefined => {
			if (value === undefined) return undefined;
			const parsed = Number.parseInt(value, 10);
			return Number.isFinite(parsed) ? parsed : undefined;
		};

		const MAX_RETRY_HINT_MS = 5 * 60 * 1000;
		const clampRetryHintMs = (value: number): number | null => {
			if (!Number.isFinite(value)) return null;
			const normalized = Math.floor(value);
			if (normalized <= 0) return null;
			return Math.min(normalized, MAX_RETRY_HINT_MS);
		};

		const parseRetryAfterHintMs = (headers: Headers): number | null => {
			const retryAfterMsHeader = headers.get("retry-after-ms")?.trim();
			if (retryAfterMsHeader && /^\d+$/.test(retryAfterMsHeader)) {
				return clampRetryHintMs(Number.parseInt(retryAfterMsHeader, 10));
			}

			const retryAfterHeader = headers.get("retry-after")?.trim();
			if (retryAfterHeader && /^\d+$/.test(retryAfterHeader)) {
				return clampRetryHintMs(Number.parseInt(retryAfterHeader, 10) * 1000);
			}
			if (retryAfterHeader) {
				const retryAtMs = Date.parse(retryAfterHeader);
				if (Number.isFinite(retryAtMs)) {
					return clampRetryHintMs(retryAtMs - Date.now());
				}
			}

			const resetAtHeader = headers.get("x-ratelimit-reset")?.trim();
			if (resetAtHeader && /^\d+$/.test(resetAtHeader)) {
				const resetRaw = Number.parseInt(resetAtHeader, 10);
				const resetAtMs = resetRaw < 10_000_000_000 ? resetRaw * 1000 : resetRaw;
				return clampRetryHintMs(resetAtMs - Date.now());
			}

			return null;
		};

	const sanitizeResponseHeadersForLog = (headers: Headers): Record<string, string> => {
		const allowed = new Set([
			"content-type",
			"x-request-id",
			"x-openai-request-id",
			"x-codex-plan-type",
			"x-codex-active-limit",
			"x-codex-primary-used-percent",
			"x-codex-primary-window-minutes",
			"x-codex-primary-reset-at",
			"x-codex-primary-reset-after-seconds",
			"x-codex-secondary-used-percent",
			"x-codex-secondary-window-minutes",
			"x-codex-secondary-reset-at",
			"x-codex-secondary-reset-after-seconds",
			"retry-after",
			"x-ratelimit-reset",
			"x-ratelimit-reset-requests",
		]);
		const sanitized: Record<string, string> = {};
		for (const [rawName, rawValue] of headers.entries()) {
			const name = rawName.toLowerCase();
			if (!allowed.has(name)) continue;
			sanitized[name] = rawValue;
		}
		return sanitized;
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
        type TokenSuccessWithAccount = TokenSuccess & {
                accountIdOverride?: string;
                accountIdSource?: AccountIdSource;
                accountLabel?: string;
        };

        const resolveAccountSelection = (
                tokens: TokenSuccess,
        ): TokenSuccessWithAccount => {
                const override = (process.env.CODEX_AUTH_ACCOUNT_ID ?? "").trim();
                if (override) {
                        const suffix = override.length > 6 ? override.slice(-6) : override;
                        logInfo(`Using account override from CODEX_AUTH_ACCOUNT_ID (id:${suffix}).`);
                        return {
                                ...tokens,
                                accountIdOverride: override,
                                accountIdSource: "manual",
                                accountLabel: `Override [id:${suffix}]`,
                        };
                }

                const candidates = getAccountIdCandidates(tokens.access, tokens.idToken);
                if (candidates.length === 0) {
                        return tokens;
                }

                if (candidates.length === 1) {
				const [candidate] = candidates;
				if (candidate) {
					return {
						...tokens,
						accountIdOverride: candidate.accountId,
						accountIdSource: candidate.source,
						accountLabel: candidate.label,
					};
				}
			}

                // Auto-select the best workspace candidate without prompting.
                // This honors org/default/id-token signals and avoids forcing personal token IDs.
                const choice = selectBestAccountCandidate(candidates);
                if (!choice) return tokens;

                return {
                        ...tokens,
                        accountIdOverride: choice.accountId,
                        accountIdSource: choice.source ?? "token",
                        accountLabel: choice.label,
                };
        };

        const buildManualOAuthFlow = (
                pkce: { verifier: string },
                url: string,
                expectedState: string,
                onSuccess?: (tokens: TokenSuccessWithAccount) => Promise<void>,
        ) => ({
                url,
                method: "code" as const,
                instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
                validate: (input: string): string | undefined => {
                        const parsed = parseAuthorizationInput(input);
                        if (!parsed.code) {
                                return `No authorization code found. Paste the full callback URL (e.g., ${REDIRECT_URI}?code=...)`;
                        }
                        if (!parsed.state) {
                                return "Missing OAuth state. Paste the full callback URL including both code and state parameters.";
                        }
                        if (parsed.state !== expectedState) {
                                return "OAuth state mismatch. Restart login and paste the callback URL generated for this login attempt.";
                        }
                        return undefined;
                },
                callback: async (input: string) => {
                        const parsed = parseAuthorizationInput(input);
                        if (!parsed.code || !parsed.state) {
                                return {
                                        type: "failed" as const,
                                        reason: "invalid_response" as const,
                                        message: "Missing authorization code or OAuth state",
                                };
                        }
                        if (parsed.state !== expectedState) {
                                return {
                                        type: "failed" as const,
                                        reason: "invalid_response" as const,
                                        message: "OAuth state mismatch. Restart login and try again.",
                                };
                        }
                        const tokens = await exchangeAuthorizationCode(
                                parsed.code,
                                pkce.verifier,
                                REDIRECT_URI,
                        );
                        if (tokens?.type === "success") {
                                const resolved = resolveAccountSelection(tokens);
                                if (onSuccess) {
                                        await onSuccess(resolved);
                                }
                                return resolved;
                        }
                        return tokens?.type === "failed"
                                ? tokens
                                : { type: "failed" as const };
                },
        });

	const runOAuthFlow = async (
		forceNewLogin: boolean = false,
	): Promise<TokenResult> => {
		const { pkce, state, url } = await createAuthorizationFlow({ forceNewLogin });
		logInfo(`OAuth URL: ${redactOAuthUrlForLog(url)}`);

                let serverInfo: Awaited<ReturnType<typeof startLocalOAuthServer>> | null = null;
                try {
                        serverInfo = await startLocalOAuthServer({ state });
                } catch (err) {
                        logDebug(`[${PLUGIN_NAME}] Failed to start OAuth server: ${(err as Error)?.message ?? String(err)}`);
                        serverInfo = null;
                }
                openBrowserUrl(url);

                if (!serverInfo || !serverInfo.ready) {
                        serverInfo?.close();
                        const message =
                                `\n[${PLUGIN_NAME}] OAuth callback server failed to start. ` +
                                `Please retry with "${AUTH_LABELS.OAUTH_MANUAL}".\n`;
				logWarn(message);
                        return { type: "failed" as const };
                }

                const result = await serverInfo.waitForCode(state);
                serverInfo.close();

		if (!result) {
			return { type: "failed" as const, reason: "unknown" as const, message: "OAuth callback timeout or cancelled" };
		}

                return await exchangeAuthorizationCode(
                        result.code,
                        pkce.verifier,
                        REDIRECT_URI,
                );
        };

	        const persistAccountPool = async (
	                results: TokenSuccessWithAccount[],
	                replaceAll: boolean = false,
	        ): Promise<void> => {
	                if (results.length === 0) return;
				await withAccountStorageTransaction(async (loadedStorage, persist) => {
					const now = Date.now();
					const stored = replaceAll ? null : loadedStorage;
					const accounts = stored?.accounts ? [...stored.accounts] : [];

					const indexByRefreshToken = new Map<string, number>();
					const indexByAccountId = new Map<string, number>();
					const indexByEmail = new Map<string, number>();
					for (let i = 0; i < accounts.length; i += 1) {
						const account = accounts[i];
						if (!account) continue;
						if (account.refreshToken) {
							indexByRefreshToken.set(account.refreshToken, i);
						}
						if (account.accountId) {
							indexByAccountId.set(account.accountId, i);
						}
						const emailKey = normalizeEmailKey(account.email);
						if (emailKey) {
							indexByEmail.set(emailKey, i);
						}
					}

					for (const result of results) {
						const accountId = result.accountIdOverride ?? extractAccountId(result.access);
						const accountIdSource =
							accountId
								? result.accountIdSource ??
								  (result.accountIdOverride ? "manual" : "token")
								: undefined;
						const accountLabel = result.accountLabel;
						const accountEmail = sanitizeEmail(extractAccountEmail(result.access, result.idToken));
						const existingByEmail =
							accountEmail && indexByEmail.has(accountEmail)
								? indexByEmail.get(accountEmail)
								: undefined;
						const existingById =
							accountId && indexByAccountId.has(accountId)
								? indexByAccountId.get(accountId)
								: undefined;
						const existingByToken = indexByRefreshToken.get(result.refresh);
						const existingIndex = existingById ?? existingByEmail ?? existingByToken;

						if (existingIndex === undefined) {
							const newIndex = accounts.length;
							accounts.push({
								accountId,
								accountIdSource,
								accountLabel,
								email: accountEmail,
								refreshToken: result.refresh,
								accessToken: result.access,
								expiresAt: result.expires,
								addedAt: now,
								lastUsed: now,
							});
							indexByRefreshToken.set(result.refresh, newIndex);
							if (accountId) {
								indexByAccountId.set(accountId, newIndex);
							}
							if (accountEmail) {
								indexByEmail.set(accountEmail, newIndex);
							}
							continue;
						}

						const existing = accounts[existingIndex];
						if (!existing) continue;

						const oldToken = existing.refreshToken;
						const oldEmail = existing.email;
						const nextEmail = accountEmail ?? sanitizeEmail(existing.email);
						const nextAccountId = accountId ?? existing.accountId;
						const nextAccountIdSource =
							accountId ? accountIdSource ?? existing.accountIdSource : existing.accountIdSource;
						const nextAccountLabel = accountLabel ?? existing.accountLabel;
						accounts[existingIndex] = {
							...existing,
							accountId: nextAccountId,
							accountIdSource: nextAccountIdSource,
							accountLabel: nextAccountLabel,
							email: nextEmail,
							refreshToken: result.refresh,
							accessToken: result.access,
							expiresAt: result.expires,
							lastUsed: now,
						};
						if (oldToken !== result.refresh) {
							indexByRefreshToken.delete(oldToken);
							indexByRefreshToken.set(result.refresh, existingIndex);
						}
						if (accountId) {
							indexByAccountId.set(accountId, existingIndex);
						}
						const oldEmailKey = normalizeEmailKey(oldEmail);
						const nextEmailKey = normalizeEmailKey(nextEmail);
						if (oldEmailKey && oldEmailKey !== nextEmailKey) {
							indexByEmail.delete(oldEmailKey);
						}
						if (nextEmailKey) {
							indexByEmail.set(nextEmailKey, existingIndex);
						}
					}

					if (accounts.length === 0) return;

					const activeIndex = replaceAll
						? 0
						: typeof stored?.activeIndex === "number" && Number.isFinite(stored.activeIndex)
							? stored.activeIndex
							: 0;

					const clampedActiveIndex = Math.max(0, Math.min(activeIndex, accounts.length - 1));
					const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
					for (const family of MODEL_FAMILIES) {
						const storedFamilyIndex = stored?.activeIndexByFamily?.[family];
						const rawFamilyIndex = replaceAll
							? 0
							: typeof storedFamilyIndex === "number" && Number.isFinite(storedFamilyIndex)
								? storedFamilyIndex
								: clampedActiveIndex;
						activeIndexByFamily[family] = Math.max(
							0,
							Math.min(Math.floor(rawFamilyIndex), accounts.length - 1),
						);
					}

					await persist({
						version: 3,
						accounts,
						activeIndex: clampedActiveIndex,
						activeIndexByFamily,
					});
				});
	        };

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
                                        const email = sanitizeEmail(extractAccountEmail(refreshed.access, refreshed.idToken));
                                        if (
                                                id &&
                                                id !== account.accountId &&
                                                shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId)
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
					if (typeof refreshed.expires === "number" && refreshed.expires !== account.expiresAt) {
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

		const applyUiRuntimeFromConfig = (
			pluginConfig: ReturnType<typeof loadPluginConfig>,
		): UiRuntimeOptions => {
			return setUiRuntimeOptions({
				v2Enabled: getCodexTuiV2(pluginConfig),
				colorProfile: getCodexTuiColorProfile(pluginConfig),
				glyphMode: getCodexTuiGlyphMode(pluginConfig),
			});
		};

		const resolveUiRuntime = (): UiRuntimeOptions => {
			return applyUiRuntimeFromConfig(loadPluginConfig());
		};

		const getStatusMarker = (
			ui: UiRuntimeOptions,
			status: "ok" | "warning" | "error",
		): string => {
			if (!ui.v2Enabled) {
				if (status === "ok") return "✓";
				if (status === "warning") return "!";
				return "✗";
			}
			if (status === "ok") return ui.theme.glyphs.check;
			if (status === "warning") return "!";
			return ui.theme.glyphs.cross;
		};

		const invalidateAccountManagerCache = (): void => {
			cachedAccountManager = null;
			accountManagerPromise = null;
		};

		const reloadAccountManagerFromDisk = async (
			authFallback?: OAuthAuthDetails,
		): Promise<AccountManager> => {
			if (accountReloadInFlight) {
				return accountReloadInFlight;
			}
			accountReloadInFlight = (async () => {
				const reloaded = await AccountManager.loadFromDisk(authFallback);
				cachedAccountManager = reloaded;
				accountManagerPromise = Promise.resolve(reloaded);
				return reloaded;
			})();
			try {
				return await accountReloadInFlight;
			} finally {
				accountReloadInFlight = null;
			}
		};

		const applyAccountStorageScope = (pluginConfig: ReturnType<typeof loadPluginConfig>): void => {
			const perProjectAccounts = getPerProjectAccounts(pluginConfig);
			setStorageBackupEnabled(getStorageBackupEnabled(pluginConfig));
			if (isCodexCliSyncEnabled()) {
				if (perProjectAccounts && !perProjectStorageWarningShown) {
					perProjectStorageWarningShown = true;
					logWarn(
						`[${PLUGIN_NAME}] CODEX_AUTH_PER_PROJECT_ACCOUNTS is ignored while Codex CLI sync is enabled. Using global account storage.`,
					);
				}
				setStoragePath(null);
				return;
			}

			setStoragePath(perProjectAccounts ? process.cwd() : null);
		};

		const ensureLiveAccountSync = async (
			pluginConfig: ReturnType<typeof loadPluginConfig>,
			authFallback?: OAuthAuthDetails,
		): Promise<void> => {
			if (!getLiveAccountSync(pluginConfig)) {
				if (liveAccountSync) {
					liveAccountSync.stop();
					liveAccountSync = null;
					liveAccountSyncPath = null;
				}
				return;
			}

			const targetPath = getStoragePath();
			if (!liveAccountSync) {
				liveAccountSync = new LiveAccountSync(
					async () => {
						await reloadAccountManagerFromDisk(authFallback);
					},
					{
						debounceMs: getLiveAccountSyncDebounceMs(pluginConfig),
						pollIntervalMs: getLiveAccountSyncPollMs(pluginConfig),
					},
				);
				registerCleanup(() => {
					liveAccountSync?.stop();
				});
			}

		if (liveAccountSyncPath !== targetPath) {
			let switched = false;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					await liveAccountSync.syncToPath(targetPath);
					liveAccountSyncPath = targetPath;
					switched = true;
					break;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException | undefined)?.code;
					if (code !== "EBUSY" && code !== "EPERM") {
						throw error;
					}
					await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
				}
			}
			if (!switched) {
				logWarn(
					`[${PLUGIN_NAME}] Live account sync path switch failed due to transient filesystem locks; keeping previous watcher.`,
				);
			}
		}
	};

		const ensureRefreshGuardian = (
			pluginConfig: ReturnType<typeof loadPluginConfig>,
		): void => {
			if (!getProactiveRefreshGuardian(pluginConfig)) {
				if (refreshGuardian) {
					refreshGuardian.stop();
					refreshGuardian = null;
					refreshGuardianConfigKey = null;
				}
				return;
			}

			const intervalMs = getProactiveRefreshIntervalMs(pluginConfig);
			const bufferMs = getProactiveRefreshBufferMs(pluginConfig);
			const configKey = `${intervalMs}:${bufferMs}`;
			if (refreshGuardian && refreshGuardianConfigKey === configKey) return;

			if (refreshGuardian) {
				refreshGuardian.stop();
			}
			refreshGuardian = new RefreshGuardian(
				() => cachedAccountManager,
				{ intervalMs, bufferMs },
			);
			refreshGuardianConfigKey = configKey;
			refreshGuardian.start();
			registerCleanup(() => {
				refreshGuardian?.stop();
			});
		};

		const ensureSessionAffinity = (
			pluginConfig: ReturnType<typeof loadPluginConfig>,
		): void => {
			if (!getSessionAffinity(pluginConfig)) {
				sessionAffinityStore = null;
				sessionAffinityConfigKey = null;
				return;
			}

			const ttlMs = getSessionAffinityTtlMs(pluginConfig);
			const maxEntries = getSessionAffinityMaxEntries(pluginConfig);
			const configKey = `${ttlMs}:${maxEntries}`;
			if (sessionAffinityStore && sessionAffinityConfigKey === configKey) return;
			sessionAffinityStore = new SessionAffinityStore({ ttlMs, maxEntries });
			sessionAffinityConfigKey = configKey;
		};

		const applyPreemptiveQuotaSettings = (
			pluginConfig: ReturnType<typeof loadPluginConfig>,
		): void => {
			preemptiveQuotaScheduler.configure({
				enabled: getPreemptiveQuotaEnabled(pluginConfig),
				remainingPercentThresholdPrimary: getPreemptiveQuotaRemainingPercent5h(pluginConfig),
				remainingPercentThresholdSecondary: getPreemptiveQuotaRemainingPercent7d(pluginConfig),
				maxDeferralMs: getPreemptiveQuotaMaxDeferralMs(pluginConfig),
			});
		};

        // Event handler for session recovery and account selection
        const eventHandler = async (input: { event: { type: string; properties?: unknown } }) => {
          try {
                const { event } = input;
                // Handle TUI account selection events
                // Accepts generic selection events with an index property
                if (
                        event.type === "account.select" ||
                        event.type === "openai.account.select"
                ) {
                        const props = event.properties as { index?: number; accountIndex?: number; provider?: string };
                        // Filter by provider if specified
                        if (props.provider && props.provider !== "openai" && props.provider !== PROVIDER_ID) {
                                return;
                        }

                        const index = props.index ?? props.accountIndex;
                        if (typeof index === "number") {
                                const storage = await loadAccounts();
                                if (!storage || index < 0 || index >= storage.accounts.length) {
                                        return;
                                }

                                const now = Date.now();
                                const account = storage.accounts[index];
                                if (account) {
                                        account.lastUsed = now;
                                        account.lastSwitchReason = "rotation";
                                }
                                setActiveIndexForAllFamilies(storage, index);

                                await saveAccounts(storage);
				if (cachedAccountManager) {
					await cachedAccountManager.syncCodexCliActiveSelectionForIndex(index);
				}
				lastCodexCliActiveSyncIndex = index;

				// Reload manager from disk so we don't overwrite newer rotated
				// refresh tokens with stale in-memory state.
				if (cachedAccountManager) {
					await reloadAccountManagerFromDisk();
				}

                                await showToast(`Switched to account ${index + 1}`, "info");
                        }
                }
          } catch (error) {
                logDebug(`[${PLUGIN_NAME}] Event handler error: ${error instanceof Error ? error.message : String(error)}`);
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
			applyUiRuntimeFromConfig(pluginConfig);
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
					const refreshToken =
						auth.type === "oauth" ? auth.refresh : "";
					const needsPersist =
						refreshToken &&
						!accountManager.hasRefreshToken(refreshToken);
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
					| { options?: Record<string, unknown>; models?: UserConfig["models"] }
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
				const fastSessionMaxInputItems = getFastSessionMaxInputItems(pluginConfig);
				const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
				const rateLimitToastDebounceMs = getRateLimitToastDebounceMs(pluginConfig);
				const retryAllAccountsRateLimited = getRetryAllAccountsRateLimited(pluginConfig);
				const retryAllAccountsMaxWaitMs = getRetryAllAccountsMaxWaitMs(pluginConfig);
				const retryAllAccountsMaxRetries = getRetryAllAccountsMaxRetries(pluginConfig);
				const unsupportedCodexPolicy = getUnsupportedCodexPolicy(pluginConfig);
				const fallbackOnUnsupportedCodexModel = unsupportedCodexPolicy === "fallback";
				const fallbackToGpt52OnUnsupportedGpt53 =
					getFallbackToGpt52OnUnsupportedGpt53(pluginConfig);
				const unsupportedCodexFallbackChain =
					getUnsupportedCodexFallbackChain(pluginConfig);
				const toastDurationMs = getToastDurationMs(pluginConfig);
				const fetchTimeoutMs = getFetchTimeoutMs(pluginConfig);
				const streamStallTimeoutMs = getStreamStallTimeoutMs(pluginConfig);
				const networkErrorCooldownMs = getNetworkErrorCooldownMs(pluginConfig);
				const serverErrorCooldownMs = getServerErrorCooldownMs(pluginConfig);
				const failoverMode = parseFailoverMode(process.env.CODEX_AUTH_FAILOVER_MODE);
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
					failoverMode === "conservative" ? 2 : failoverMode === "balanced" ? 1 : 0;

				const sessionRecoveryEnabled = getSessionRecovery(pluginConfig);
				const autoResumeEnabled = getAutoResume(pluginConfig);
				const emptyResponseMaxRetries = getEmptyResponseMaxRetries(pluginConfig);
				const emptyResponseRetryDelayMs = getEmptyResponseRetryDelayMs(pluginConfig);
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

				const recoveryHook = sessionRecoveryEnabled
					? createSessionRecoveryHook(
							{ client, directory: process.cwd() },
							{ sessionRecovery: true, autoResume: autoResumeEnabled }
						)
					: null;

			checkAndNotify(async (message, variant) => {
				await showToast(message, variant);
			}).catch((err) => {
				logDebug(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
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
							if (cachedAccountManager && cachedAccountManager !== accountManager) {
								accountManager = cachedAccountManager;
							}

                                                // Step 1: Extract and rewrite URL for Codex backend
                                                const originalUrl = extractRequestUrl(input);
                                                const url = rewriteUrlForCodex(originalUrl);

							// Step 3: Transform request body with model-specific Codex instructions
							// Instructions are fetched per model family (codex-max, codex, gpt-5.1)
							// Capture original stream value before transformation
							// generateText() sends no stream field, streamText() sends stream=true
								const normalizeRequestInit = async (
									requestInput: Request | string | URL,
									requestInit: RequestInit | undefined,
								): Promise<RequestInit | undefined> => {
									if (requestInit) return requestInit;
									if (!(requestInput instanceof Request)) return requestInit;

									const method = requestInput.method || "GET";
									const normalized: RequestInit = {
										method,
										headers: new Headers(requestInput.headers),
									};

									if (method !== "GET" && method !== "HEAD") {
										try {
											const bodyText = await requestInput.clone().text();
											if (bodyText) {
												normalized.body = bodyText;
											}
										} catch {
											// Body may be unreadable; proceed without it.
										}
									}

									return normalized;
								};

								const parseRequestBodyFromInit = async (
									body: unknown,
								): Promise<Record<string, unknown>> => {
									if (!body) return {};

									try {
										if (typeof body === "string") {
											return JSON.parse(body) as Record<string, unknown>;
										}

										if (body instanceof Uint8Array) {
											return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
										}

										if (body instanceof ArrayBuffer) {
											return JSON.parse(new TextDecoder().decode(new Uint8Array(body))) as Record<string, unknown>;
										}

										if (ArrayBuffer.isView(body)) {
											const view = new Uint8Array(
												body.buffer,
												body.byteOffset,
												body.byteLength,
											);
											return JSON.parse(new TextDecoder().decode(view)) as Record<string, unknown>;
										}

										if (typeof Blob !== "undefined" && body instanceof Blob) {
											return JSON.parse(await body.text()) as Record<string, unknown>;
										}
									} catch {
										logWarn("Failed to parse request body, using empty object");
									}

									return {};
								};

								const baseInit = await normalizeRequestInit(input, init);
								const originalBody = await parseRequestBodyFromInit(baseInit?.body);
								const isStreaming = originalBody.stream === true;
								const parsedBody =
									Object.keys(originalBody).length > 0 ? originalBody : undefined;

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
									},
								);
										let requestInit = transformation?.updatedInit ?? baseInit;
										let transformedBody: RequestBody | undefined = transformation?.body;
										const promptCacheKey = transformedBody?.prompt_cache_key;
										let model = transformedBody?.model;
										let modelFamily = model ? getModelFamily(model) : "gpt-5.1";
										let quotaKey = model ? `${modelFamily}:${model}` : modelFamily;
						const threadIdCandidate =
							(process.env.CODEX_THREAD_ID ?? promptCacheKey ?? "")
								.toString()
								.trim() || undefined;
						const sessionAffinityKey = threadIdCandidate ?? promptCacheKey ?? null;
						const effectivePromptCacheKey =
							(sessionAffinityKey ?? promptCacheKey ?? "").toString().trim() || undefined;
						const preferredSessionAccountIndex = sessionAffinityStore?.getPreferredAccountIndex(
							sessionAffinityKey,
						);
						sessionAffinityStore?.prune();
							const requestCorrelationId = setCorrelationId(
								threadIdCandidate ? `${threadIdCandidate}:${Date.now()}` : undefined,
							);
							runtimeMetrics.lastRequestAt = Date.now();

					const abortSignal = requestInit?.signal ?? init?.signal ?? null;
					const sleep = (ms: number): Promise<void> =>
						new Promise((resolve, reject) => {
							if (abortSignal?.aborted) {
								reject(new Error("Aborted"));
								return;
							}

							const timeout = setTimeout(() => {
								cleanup();
								resolve();
							}, ms);

							const onAbort = () => {
								cleanup();
								reject(new Error("Aborted"));
							};

							const cleanup = () => {
								clearTimeout(timeout);
								abortSignal?.removeEventListener("abort", onAbort);
							};

							abortSignal?.addEventListener("abort", onAbort, { once: true });
						});

					const sleepWithCountdown = async (
						totalMs: number,
						message: string,
						intervalMs: number = 5000,
					): Promise<void> => {
						const startTime = Date.now();
						const endTime = startTime + totalMs;
						
						while (Date.now() < endTime) {
							if (abortSignal?.aborted) {
								throw new Error("Aborted");
							}
							
							const remaining = Math.max(0, endTime - Date.now());
							const waitLabel = formatWaitTime(remaining);
							await showToast(
								`${message} (${waitLabel} remaining)`,
								"warning",
								{ duration: Math.min(intervalMs + 1000, toastDurationMs) },
							);
							
							const sleepTime = Math.min(intervalMs, remaining);
							if (sleepTime > 0) {
								await sleep(sleepTime);
							} else {
								break;
							}
						}
					};

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
										let usedPreferredSessionAccount = false;
										const capabilityBoostByAccount: Record<number, number> = {};
										type AccountSnapshotCandidate = {
											index: number;
											accountId?: string;
											email?: string;
										};
										const accountSnapshotSource = accountManager as {
											getAccountsSnapshot?: () => AccountSnapshotCandidate[];
											getAccountByIndex?: (index: number) => AccountSnapshotCandidate | null;
										};
										const accountSnapshotList =
											typeof accountSnapshotSource.getAccountsSnapshot === "function"
												? accountSnapshotSource.getAccountsSnapshot() ?? []
												: [];
										if (
											accountSnapshotList.length === 0 &&
											typeof accountSnapshotSource.getAccountByIndex === "function"
										) {
											for (
												let accountSnapshotIndex = 0;
												accountSnapshotIndex < accountCount;
												accountSnapshotIndex += 1
											) {
												const candidate = accountSnapshotSource.getAccountByIndex(
													accountSnapshotIndex,
												);
												if (candidate) {
													accountSnapshotList.push(candidate);
												}
											}
										}
										for (const candidate of accountSnapshotList) {
											const accountKey = resolveEntitlementAccountKey(candidate);
											capabilityBoostByAccount[candidate.index] = capabilityPolicyStore.getBoost(
												accountKey,
												model ?? modelFamily,
											);
										}

while (attempted.size < Math.max(1, accountCount)) {
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
						account = accountManager.getAccountByIndex(preferredSessionAccountIndex);
						if (account) {
							account.lastUsed = Date.now();
							accountManager.markSwitched(account, "rotation", modelFamily);
						}
					} else {
						sessionAffinityStore?.forgetSession(sessionAffinityKey);
					}
				}

				if (!account) {
					account = accountManager.getCurrentOrNextForFamilyHybrid(modelFamily, model, {
						pidOffsetEnabled,
						scoreBoostByAccount: capabilityBoostByAccount,
					});
				}
				if (!account || attempted.has(account.index)) {
					break;
				}
							attempted.add(account.index);
							// Log account selection for debugging rotation
							logDebug(
								`Using account ${account.index + 1}/${accountCount}: ${account.email ?? "unknown"} for ${modelFamily}`,
							);

											let accountAuth = accountManager.toAuthDetails(account) as OAuthAuthDetails;
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
				logDebug(`[${PLUGIN_NAME}] Auth refresh failed for account: ${(err as Error)?.message ?? String(err)}`);
				runtimeMetrics.authRefreshFailures++;
				runtimeMetrics.failedRequests++;
				runtimeMetrics.accountRotations++;
				runtimeMetrics.lastError = (err as Error)?.message ?? String(err);
				const failures = accountManager.incrementAuthFailures(account);
				const accountLabel = formatAccountLabel(account, account.index);

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

				const hadAccountId = !!account.accountId;
					const tokenAccountId = extractAccountId(accountAuth.access);
					const accountId = resolveRequestAccountId(
						account.accountId,
						account.accountIdSource,
						tokenAccountId,
					);
					const entitlementAccountKey = resolveEntitlementAccountKey({
						accountId: hadAccountId ? account.accountId : undefined,
						email: account.email,
						index: account.index,
					});
						if (!accountId) {
							accountManager.markAccountCoolingDown(
								account,
								ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
								"auth-failure",
							);
							accountManager.saveToDiskDebounced();
							continue;
						}
											account.accountId = accountId;
											if (!hadAccountId && tokenAccountId && accountId === tokenAccountId) {
												account.accountIdSource = account.accountIdSource ?? "token";
											}
											account.email =
												extractAccountEmail(accountAuth.access) ?? account.email;
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

											if (
												accountCount > 1 &&
												accountManager.shouldShowAccountToast(
													account.index,
													rateLimitToastDebounceMs,
												)
											) {
												const accountLabel = formatAccountLabel(account, account.index);
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
								const quotaScheduleKey = `${entitlementAccountKey}:${model ?? modelFamily}`;
								const capabilityModelKey = model ?? modelFamily;
								const quotaDeferral = preemptiveQuotaScheduler.getDeferral(quotaScheduleKey);
								if (quotaDeferral.defer && quotaDeferral.waitMs > 0) {
									accountManager.markRateLimitedWithReason(
										account,
										quotaDeferral.waitMs,
										modelFamily,
										"quota",
										model,
									);
									accountManager.recordRateLimit(account, modelFamily, model);
									runtimeMetrics.accountRotations++;
									runtimeMetrics.lastError = `Preemptive quota deferral for account ${account.index + 1}`;
									accountManager.saveToDiskDebounced();
									continue;
								}

								// Consume a token before making the request for proactive rate limiting
								const tokenConsumed = accountManager.consumeToken(account, modelFamily, model);
									if (!tokenConsumed) {
										accountManager.recordRateLimit(account, modelFamily, model);
										runtimeMetrics.accountRotations++;
									runtimeMetrics.lastError =
										`Local token bucket depleted for account ${account.index + 1} (${modelFamily}${model ? `:${model}` : ""})`;
										logWarn(
											`Skipping account ${account.index + 1}: local token bucket depleted for ${modelFamily}${model ? `:${model}` : ""}`,
										);
										continue;
									}

							let sameAccountRetryCount = 0;
							let successAccountForResponse = account;
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
									? () => fetchController.abort(abortSignal.reason ?? new Error("Aborted by user"))
									: null;

								if (abortSignal?.aborted) {
									clearTimeout(fetchTimeoutId);
									fetchController.abort(abortSignal.reason ?? new Error("Aborted by user"));
								} else if (abortSignal && onUserAbort) {
									abortSignal.addEventListener("abort", onUserAbort, { once: true });
								}

							try {
								runtimeMetrics.totalRequests++;
								response = await fetch(url, {
									...requestInit,
									headers,
									signal: fetchController.signal,
								});
					} catch (networkError) {
									const fetchAbortReason = fetchController.signal.reason;
									const isTimeoutAbort =
										requestTimedOut ||
										(fetchAbortReason instanceof Error &&
											fetchAbortReason.message === timeoutReason.message);
									const isUserAbort = Boolean(abortSignal?.aborted) && !isTimeoutAbort;
									if (isUserAbort) {
										accountManager.refundToken(account, modelFamily, model);
										runtimeMetrics.userAborts++;
										runtimeMetrics.lastError = "request aborted by user";
										sessionAffinityStore?.forgetSession(sessionAffinityKey);
										throw (
											fetchAbortReason instanceof Error
												? fetchAbortReason
												: new Error("Aborted by user")
										);
									}
								const errorMsg = networkError instanceof Error ? networkError.message : String(networkError);
								logWarn(`Network error for account ${account.index + 1}: ${errorMsg}`);
								runtimeMetrics.failedRequests++;
								runtimeMetrics.networkErrors++;
								runtimeMetrics.accountRotations++;
								runtimeMetrics.lastError = errorMsg;
								const policy = evaluateFailurePolicy(
									{ kind: "network", failoverMode },
									{ networkCooldownMs: networkErrorCooldownMs },
								);
								if (policy.refundToken) {
									accountManager.refundToken(account, modelFamily, model);
								}
								if (policy.recordFailure) {
									accountManager.recordFailure(account, modelFamily, model);
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
											const fetchLatencyMs = Math.round(performance.now() - fetchStart);

												logRequest(LOG_STAGES.RESPONSE, {
													status: response.status,
													ok: response.ok,
													statusText: response.statusText,
													latencyMs: fetchLatencyMs,
													headers: sanitizeResponseHeadersForLog(response.headers),
												});
												const quotaSnapshot = readQuotaSchedulerSnapshot(
													response.headers,
													response.status,
												);
												if (quotaSnapshot) {
													preemptiveQuotaScheduler.update(quotaScheduleKey, quotaSnapshot);
												}

									if (!response.ok) {
									const contextOverflowResult = await handleContextOverflow(response, model);
									if (contextOverflowResult.handled) {
										return contextOverflowResult.response;
									}

									const { response: errorResponse, rateLimit, errorBody } =
										await handleErrorResponse(response, {
											requestCorrelationId,
											threadId: threadIdCandidate,
										});

			const unsupportedModelInfo = getUnsupportedCodexModelInfo(errorBody);
			const hasRemainingAccounts = attempted.size < Math.max(1, accountCount);
			const blockedModel =
				unsupportedModelInfo.unsupportedModel ?? model ?? "requested model";
			const blockedModelNormalized = blockedModel.toLowerCase();
			const shouldForceSparkFallback =
				unsupportedModelInfo.isUnsupported &&
				(blockedModelNormalized === "gpt-5.3-codex-spark" ||
					blockedModelNormalized.includes("gpt-5.3-codex-spark"));
			const allowUnsupportedFallback =
				fallbackOnUnsupportedCodexModel || shouldForceSparkFallback;

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
										accountManager.refundToken(account, modelFamily, model);
										accountManager.recordFailure(account, modelFamily, model);
										capabilityPolicyStore.recordFailure(
											entitlementAccountKey,
											capabilityModelKey,
										);
										sessionAffinityStore?.forgetSession(sessionAffinityKey);
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
				break;
			}

			const fallbackModel = resolveUnsupportedCodexFallbackModel({
				requestedModel: model,
				errorBody,
				attemptedModels: attemptedUnsupportedFallbackModels,
				fallbackOnUnsupportedCodexModel: allowUnsupportedFallback,
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
					accountManager.refundToken(account, previousModelFamily, previousModel);

				model = fallbackModel;
				modelFamily = getModelFamily(model);
				quotaKey = `${modelFamily}:${model}`;

				if (transformedBody && typeof transformedBody === "object") {
					transformedBody = { ...transformedBody, model };
				} else {
					let fallbackBody: Record<string, unknown> = { model };
					if (requestInit?.body && typeof requestInit.body === "string") {
						try {
							const parsed = JSON.parse(requestInit.body) as Record<string, unknown>;
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

			if (unsupportedModelInfo.isUnsupported && !allowUnsupportedFallback) {
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
			if (errorResponse.status === 403 && !unsupportedModelInfo.isUnsupported) {
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

			if (recoveryHook && errorBody && isRecoverableError(errorBody)) {
					const errorType = detectErrorType(errorBody);
					const toastContent = getRecoveryToastContent(errorType);
					await showToast(
						`${toastContent.title}: ${toastContent.message}`,
						"warning",
						{ duration: toastDurationMs },
					);
						logDebug(`[${PLUGIN_NAME}] Recoverable error detected: ${errorType}`);
					}

						// Handle 5xx server errors by rotating to another account
						if (response.status >= 500 && response.status < 600) {
							logWarn(`Server error ${response.status} for account ${account.index + 1}. Rotating to next account.`);
							runtimeMetrics.failedRequests++;
							runtimeMetrics.serverErrors++;
							runtimeMetrics.accountRotations++;
							runtimeMetrics.lastError = `HTTP ${response.status}`;
							const serverRetryAfterMs = parseRetryAfterHintMs(response.headers);
							const policy = evaluateFailurePolicy(
								{ kind: "server", failoverMode, serverRetryAfterMs: serverRetryAfterMs ?? undefined },
								{ serverCooldownMs: serverErrorCooldownMs },
							);
						if (policy.refundToken) {
							accountManager.refundToken(account, modelFamily, model);
						}
							if (policy.recordFailure) {
								accountManager.recordFailure(account, modelFamily, model);
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
						sessionAffinityStore?.forgetSession(sessionAffinityKey);
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

															await sleep(addJitter(Math.max(MIN_BACKOFF_MS, delayMs), 0.2));
															continue;
																																}

				accountManager.markRateLimitedWithReason(
					account,
					delayMs,
					modelFamily,
					parseRateLimitReason(rateLimit.code),
					model,
				);
				accountManager.recordRateLimit(account, modelFamily, model);
				account.lastSwitchReason = "rate-limit";
				sessionAffinityStore?.forgetSession(sessionAffinityKey);
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

										const fallbackAccount = accountManager.getAccountByIndex(candidateIndex);
										if (!fallbackAccount) continue;

										let fallbackAuth = accountManager.toAuthDetails(fallbackAccount) as OAuthAuthDetails;
										try {
											if (shouldRefreshToken(fallbackAuth, tokenRefreshSkewMs)) {
												fallbackAuth = (await refreshAndUpdateToken(
													fallbackAuth,
													client,
												)) as OAuthAuthDetails;
												accountManager.updateFromAuth(fallbackAccount, fallbackAuth);
												accountManager.clearAuthFailures(fallbackAccount);
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

										const fallbackTokenAccountId = extractAccountId(fallbackAuth.access);
										const fallbackAccountId = resolveRequestAccountId(
											fallbackAccount.accountId,
											fallbackAccount.accountIdSource,
											fallbackTokenAccountId,
										);
										if (!fallbackAccountId) {
											continue;
										}

										if (!accountManager.consumeToken(fallbackAccount, modelFamily, model)) {
											continue;
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
											() => fallbackController.abort(new Error("Request timeout")),
											fetchTimeoutMs,
										);
										const onFallbackAbort = abortSignal
											? () =>
													fallbackController.abort(
														abortSignal.reason ?? new Error("Aborted by user"),
													)
											: null;
										if (abortSignal && onFallbackAbort) {
											abortSignal.addEventListener("abort", onFallbackAbort, {
												once: true,
											});
										}

										try {
											runtimeMetrics.totalRequests++;
											const fallbackResponse = await fetch(url, {
												...requestInit,
												headers: fallbackHeaders,
												signal: fallbackController.signal,
											});
											const fallbackSnapshot = readQuotaSchedulerSnapshot(
												fallbackResponse.headers,
												fallbackResponse.status,
											);
											if (fallbackSnapshot) {
												preemptiveQuotaScheduler.update(
													`${resolveEntitlementAccountKey(fallbackAccount)}:${model ?? modelFamily}`,
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
															parseRetryAfterHintMs(fallbackResponse.headers) ?? 60_000;
														accountManager.markRateLimitedWithReason(
															fallbackAccount,
															retryAfterMs,
														modelFamily,
														"quota",
														model,
													);
													accountManager.recordRateLimit(fallbackAccount, modelFamily, model);
												} else {
													accountManager.recordFailure(fallbackAccount, modelFamily, model);
												}
												capabilityPolicyStore.recordFailure(
													resolveEntitlementAccountKey(fallbackAccount),
													capabilityModelKey,
												);
												continue;
											}

											successAccountForResponse = fallbackAccount;
											runtimeMetrics.streamFailoverRecoveries += 1;
											if (fallbackAccount.index !== account.index) {
												runtimeMetrics.streamFailoverCrossAccountRecoveries += 1;
												runtimeMetrics.accountRotations += 1;
												sessionAffinityStore?.remember(
													sessionAffinityKey,
													fallbackAccount.index,
												);
											}

											logInfo(
												`Recovered stream via failover attempt ${failoverAttempt} using account ${fallbackAccount.index + 1}.`,
												{ emittedBytes },
											);
											return fallbackResponse;
										} catch (streamFailoverError) {
											accountManager.refundToken(fallbackAccount, modelFamily, model);
											accountManager.recordFailure(fallbackAccount, modelFamily, model);
											capabilityPolicyStore.recordFailure(
												resolveEntitlementAccountKey(fallbackAccount),
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
											continue;
										} finally {
											clearTimeout(fallbackTimeoutId);
											if (abortSignal && onFallbackAbort) {
												abortSignal.removeEventListener("abort", onFallbackAbort);
											}
										}
									}

									return null;
								},
								{
									maxFailovers: streamFailoverMax,
									softTimeoutMs: streamFailoverSoftTimeoutMs,
									hardTimeoutMs: streamFailoverHardTimeoutMs,
									requestInstanceId: requestCorrelationId ?? undefined,
								},
							);
						}
						const successResponse = await handleSuccessResponse(responseForSuccess, isStreaming, {
							streamStallTimeoutMs,
						});

					if (!isStreaming && emptyResponseMaxRetries > 0) {
						const clonedResponse = successResponse.clone();
						try {
							const bodyText = await clonedResponse.text();
							const parsedBody = bodyText ? JSON.parse(bodyText) as unknown : null;
							if (isEmptyResponse(parsedBody)) {
								if (emptyResponseRetries < emptyResponseMaxRetries) {
									emptyResponseRetries++;
									runtimeMetrics.emptyResponseRetries++;
									logWarn(`Empty response received (attempt ${emptyResponseRetries}/${emptyResponseMaxRetries}). Retrying...`);
									await showToast(
										`Empty response. Retrying (${emptyResponseRetries}/${emptyResponseMaxRetries})...`,
										"warning",
										{ duration: toastDurationMs },
									);
									accountManager.refundToken(account, modelFamily, model);
									accountManager.recordFailure(account, modelFamily, model);
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
											Math.floor(emptyPolicy.retryDelayMs ?? emptyResponseRetryDelayMs),
										);
										if (retryDelayMs > 0) {
											await sleep(addJitter(retryDelayMs, 0.2));
										}
										continue;
									}
									sessionAffinityStore?.forgetSession(sessionAffinityKey);
									await sleep(addJitter(emptyResponseRetryDelayMs, 0.2));
									break;
								}
								logWarn(`Empty response after ${emptyResponseMaxRetries} retries. Returning as-is.`);
							}
						} catch {
							// Intentionally empty: non-JSON response bodies should be returned as-is
						}
					}

						if (successAccountForResponse.index !== account.index) {
							accountManager.markSwitched(successAccountForResponse, "rotation", modelFamily);
						}
						const successAccountKey = resolveEntitlementAccountKey(successAccountForResponse);
						accountManager.recordSuccess(successAccountForResponse, modelFamily, model);
						capabilityPolicyStore.recordSuccess(
							successAccountKey,
							capabilityModelKey,
						);
						entitlementCache.clear(successAccountKey, capabilityModelKey);
						sessionAffinityStore?.remember(
							sessionAffinityKey,
							successAccountForResponse.index,
						);
					runtimeMetrics.successfulRequests++;
					runtimeMetrics.lastError = null;
					if (lastCodexCliActiveSyncIndex !== successAccountForResponse.index) {
						void accountManager.syncCodexCliActiveSelectionForIndex(successAccountForResponse.index);
						lastCodexCliActiveSyncIndex = successAccountForResponse.index;
					}
						return successResponse;
																								}
										if (restartAccountTraversalWithFallback) {
											break;
										}
										}

										if (restartAccountTraversalWithFallback) {
											continue;
										}

										const waitMs = accountManager.getMinWaitTimeForFamily(modelFamily, model);
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
									await sleepWithCountdown(addJitter(waitMs, 0.2), countdownMessage);
									allRateLimitedRetries++;
									continue;
								}

								const waitLabel = waitMs > 0 ? formatWaitTime(waitMs) : "a bit";
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
							applyUiRuntimeFromConfig(authPluginConfig);
							applyAccountStorageScope(authPluginConfig);

							const accounts: TokenSuccessWithAccount[] = [];
							const noBrowser =
								inputs?.noBrowser === "true" ||
								inputs?.["no-browser"] === "true";
							const useManualMode = noBrowser;
							const explicitLoginMode =
								inputs?.loginMode === "fresh" || inputs?.loginMode === "add"
									? inputs.loginMode
									: null;

							let startFresh = explicitLoginMode === "fresh";
							let refreshAccountIndex: number | undefined;

							const clampActiveIndices = (storage: AccountStorageV3): void => {
								const count = storage.accounts.length;
								if (count === 0) {
									storage.activeIndex = 0;
									storage.activeIndexByFamily = {};
									return;
								}
								storage.activeIndex = Math.max(0, Math.min(storage.activeIndex, count - 1));
								storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
								for (const family of MODEL_FAMILIES) {
									const raw = storage.activeIndexByFamily[family];
									const candidate =
										typeof raw === "number" && Number.isFinite(raw) ? raw : storage.activeIndex;
									storage.activeIndexByFamily[family] = Math.max(0, Math.min(candidate, count - 1));
								}
							};

							const isFlaggableFailure = (failure: Extract<TokenResult, { type: "failed" }>): boolean => {
								if (failure.reason === "missing_refresh") return true;
								if (failure.statusCode === 401) return true;
								if (failure.statusCode !== 400) return false;
								const message = (failure.message ?? "").toLowerCase();
								return (
									message.includes("invalid_grant") ||
									message.includes("invalid refresh") ||
									message.includes("token has been revoked")
								);
							};

							type CodexQuotaWindow = {
								usedPercent?: number;
								windowMinutes?: number;
								resetAtMs?: number;
							};

							type CodexQuotaSnapshot = {
								status: number;
								planType?: string;
								activeLimit?: number;
								primary: CodexQuotaWindow;
								secondary: CodexQuotaWindow;
							};

							const parseFiniteNumberHeader = (headers: Headers, name: string): number | undefined => {
								const raw = headers.get(name);
								if (!raw) return undefined;
								const parsed = Number(raw);
								return Number.isFinite(parsed) ? parsed : undefined;
							};

							const parseFiniteIntHeader = (headers: Headers, name: string): number | undefined => {
								const raw = headers.get(name);
								if (!raw) return undefined;
								const parsed = Number.parseInt(raw, 10);
								return Number.isFinite(parsed) ? parsed : undefined;
							};

							const parseResetAtMs = (headers: Headers, prefix: string): number | undefined => {
								const resetAfterSeconds = parseFiniteIntHeader(
									headers,
									`${prefix}-reset-after-seconds`,
								);
								if (
									typeof resetAfterSeconds === "number" &&
									Number.isFinite(resetAfterSeconds) &&
									resetAfterSeconds > 0
								) {
									return Date.now() + resetAfterSeconds * 1000;
								}

								const resetAtRaw = headers.get(`${prefix}-reset-at`);
								if (!resetAtRaw) return undefined;

								const trimmed = resetAtRaw.trim();
								if (/^\d+$/.test(trimmed)) {
									const parsedNumber = Number.parseInt(trimmed, 10);
									if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
										// Upstream sometimes returns seconds since epoch.
										return parsedNumber < 10_000_000_000 ? parsedNumber * 1000 : parsedNumber;
									}
								}

								const parsedDate = Date.parse(trimmed);
								return Number.isFinite(parsedDate) ? parsedDate : undefined;
							};

							const hasCodexQuotaHeaders = (headers: Headers): boolean => {
								const keys = [
									"x-codex-primary-used-percent",
									"x-codex-primary-window-minutes",
									"x-codex-primary-reset-at",
									"x-codex-primary-reset-after-seconds",
									"x-codex-secondary-used-percent",
									"x-codex-secondary-window-minutes",
									"x-codex-secondary-reset-at",
									"x-codex-secondary-reset-after-seconds",
								];
								return keys.some((key) => headers.get(key) !== null);
							};

							const parseCodexQuotaSnapshot = (headers: Headers, status: number): CodexQuotaSnapshot | null => {
								if (!hasCodexQuotaHeaders(headers)) return null;

								const primaryPrefix = "x-codex-primary";
								const secondaryPrefix = "x-codex-secondary";
								const primary: CodexQuotaWindow = {
									usedPercent: parseFiniteNumberHeader(headers, `${primaryPrefix}-used-percent`),
									windowMinutes: parseFiniteIntHeader(headers, `${primaryPrefix}-window-minutes`),
									resetAtMs: parseResetAtMs(headers, primaryPrefix),
								};
								const secondary: CodexQuotaWindow = {
									usedPercent: parseFiniteNumberHeader(headers, `${secondaryPrefix}-used-percent`),
									windowMinutes: parseFiniteIntHeader(headers, `${secondaryPrefix}-window-minutes`),
									resetAtMs: parseResetAtMs(headers, secondaryPrefix),
								};

								const planTypeRaw = headers.get("x-codex-plan-type");
								const planType = planTypeRaw && planTypeRaw.trim() ? planTypeRaw.trim() : undefined;
								const activeLimit = parseFiniteIntHeader(headers, "x-codex-active-limit");

								return { status, planType, activeLimit, primary, secondary };
							};

							const formatQuotaWindowLabel = (windowMinutes: number | undefined): string => {
								if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
									return "quota";
								}
								if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
								if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
								return `${windowMinutes}m`;
							};

							const formatResetAt = (resetAtMs: number | undefined): string | undefined => {
								if (!resetAtMs || !Number.isFinite(resetAtMs) || resetAtMs <= 0) return undefined;
								const date = new Date(resetAtMs);
								if (!Number.isFinite(date.getTime())) return undefined;

								const now = new Date();
								const sameDay =
									now.getFullYear() === date.getFullYear() &&
									now.getMonth() === date.getMonth() &&
									now.getDate() === date.getDate();

								const time = date.toLocaleTimeString(undefined, {
									hour: "2-digit",
									minute: "2-digit",
									hour12: false,
								});

								if (sameDay) return time;
								const day = date.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
								return `${time} on ${day}`;
							};

							const formatCodexQuotaLine = (snapshot: CodexQuotaSnapshot): string => {
								const summarizeWindow = (label: string, window: CodexQuotaWindow): string => {
									const used = window.usedPercent;
									const left =
										typeof used === "number" && Number.isFinite(used)
											? Math.max(0, Math.min(100, Math.round(100 - used)))
											: undefined;
									const reset = formatResetAt(window.resetAtMs);
									let summary = label;
									if (left !== undefined) summary = `${summary} ${left}% left`;
									if (reset) summary = `${summary} (resets ${reset})`;
									return summary;
								};

								const primaryLabel = formatQuotaWindowLabel(snapshot.primary.windowMinutes);
								const secondaryLabel = formatQuotaWindowLabel(snapshot.secondary.windowMinutes);
								const parts = [
									summarizeWindow(primaryLabel, snapshot.primary),
									summarizeWindow(secondaryLabel, snapshot.secondary),
								];
								if (snapshot.planType) parts.push(`plan:${snapshot.planType}`);
								if (typeof snapshot.activeLimit === "number" && Number.isFinite(snapshot.activeLimit)) {
									parts.push(`active:${snapshot.activeLimit}`);
								}
								if (snapshot.status === 429) parts.push("rate-limited");
								return parts.join(", ");
							};

							const fetchCodexQuotaSnapshot = async (params: {
								accountId: string;
								accessToken: string;
							}): Promise<CodexQuotaSnapshot> => {
								const QUOTA_PROBE_MODELS = ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"];
								let lastError: Error | null = null;

								for (const model of QUOTA_PROBE_MODELS) {
									try {
										const instructions = await getCodexInstructions(model);
										const probeBody: RequestBody = {
											model,
											stream: true,
											store: false,
											include: ["reasoning.encrypted_content"],
											instructions,
											input: [
												{
													type: "message",
													role: "user",
													content: [{ type: "input_text", text: "quota ping" }],
												},
											],
											reasoning: { effort: "none", summary: "auto" },
											text: { verbosity: "low" },
										};

										const headers = createCodexHeaders(undefined, params.accountId, params.accessToken, {
											model,
										});
										headers.set("content-type", "application/json; charset=utf-8");

										const controller = new AbortController();
										const timeout = setTimeout(() => controller.abort(), 15_000);
										let response: Response;
										try {
											response = await fetch(`${CODEX_BASE_URL}/codex/responses`, {
												method: "POST",
												headers,
												body: JSON.stringify(probeBody),
												signal: controller.signal,
											});
										} finally {
											clearTimeout(timeout);
										}

										const snapshot = parseCodexQuotaSnapshot(response.headers, response.status);
										if (snapshot) {
											// We only need headers; cancel the SSE stream immediately.
											try {
												await response.body?.cancel();
											} catch {
												// Ignore cancellation failures.
											}
											return snapshot;
										}

										if (!response.ok) {
											const bodyText = await response.text().catch(() => "");
											let errorBody: unknown = undefined;
											try {
												errorBody = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
											} catch {
												errorBody = { error: { message: bodyText } };
											}

											const unsupportedInfo = getUnsupportedCodexModelInfo(errorBody);
											if (unsupportedInfo.isUnsupported) {
												lastError = new Error(
													unsupportedInfo.message ?? `Model '${model}' unsupported for this account`,
												);
												continue;
											}

											const message =
												(typeof (errorBody as { error?: { message?: unknown } })?.error?.message === "string"
													? (errorBody as { error?: { message?: string } }).error?.message
													: bodyText) || `HTTP ${response.status}`;
											throw new Error(message);
										}

										lastError = new Error("Codex response did not include quota headers");
									} catch (error) {
										lastError = error instanceof Error ? error : new Error(String(error));
									}
								}

								throw lastError ?? new Error("Failed to fetch quotas");
							};

							const runAccountCheck = async (deepProbe: boolean): Promise<void> => {
								const loadedStorage = await hydrateEmails(await loadAccounts());
								const workingStorage = loadedStorage
									? {
										...loadedStorage,
										accounts: loadedStorage.accounts.map((account) => ({ ...account })),
										activeIndexByFamily: loadedStorage.activeIndexByFamily
											? { ...loadedStorage.activeIndexByFamily }
											: {},
									}
									: { version: 3 as const, accounts: [], activeIndex: 0, activeIndexByFamily: {} };

								if (workingStorage.accounts.length === 0) {
									console.log("\nNo accounts to check.\n");
									return;
								}

								const flaggedStorage = await loadFlaggedAccounts();
								let storageChanged = false;
								let flaggedChanged = false;
								const removeFromActive = new Set<string>();
								const total = workingStorage.accounts.length;
								let ok = 0;
								let disabled = 0;
								let errors = 0;

								console.log(
									`\nChecking ${deepProbe ? "full account health" : "quotas"} for all accounts...\n`,
								);

								for (let i = 0; i < total; i += 1) {
									const account = workingStorage.accounts[i];
									if (!account) continue;
									const label = account.email ?? account.accountLabel ?? `Account ${i + 1}`;
									if (account.enabled === false) {
										disabled += 1;
										console.log(`[${i + 1}/${total}] ${label}: DISABLED`);
										continue;
									}

									try {
										// If we already have a valid cached access token, don't force-refresh.
										// This avoids flagging accounts where the refresh token has been burned
										// but the access token is still valid (same behavior as Codex CLI).
										const nowMs = Date.now();
										let accessToken: string | null = null;
										let tokenAccountId: string | undefined = undefined;
										let authDetail = "OK";
										if (
											account.accessToken &&
											(typeof account.expiresAt !== "number" ||
												!Number.isFinite(account.expiresAt) ||
												account.expiresAt > nowMs)
										) {
											accessToken = account.accessToken;
											authDetail = "OK (cached access)";

											tokenAccountId = extractAccountId(account.accessToken);
											if (
												tokenAccountId &&
												shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId) &&
												tokenAccountId !== account.accountId
											) {
												account.accountId = tokenAccountId;
												account.accountIdSource = "token";
												storageChanged = true;
											}

										}

										// If Codex CLI has a valid cached access token for this email, use it
										// instead of forcing a refresh.
										if (!accessToken) {
											const cached = await lookupCodexCliTokensByEmail(account.email);
											if (
												cached &&
												(typeof cached.expiresAt !== "number" ||
													!Number.isFinite(cached.expiresAt) ||
													cached.expiresAt > nowMs)
											) {
												accessToken = cached.accessToken;
												authDetail = "OK (Codex CLI cache)";

												if (cached.refreshToken && cached.refreshToken !== account.refreshToken) {
													account.refreshToken = cached.refreshToken;
													storageChanged = true;
												}
												if (cached.accessToken && cached.accessToken !== account.accessToken) {
													account.accessToken = cached.accessToken;
													storageChanged = true;
												}
												if (cached.expiresAt !== account.expiresAt) {
													account.expiresAt = cached.expiresAt;
													storageChanged = true;
												}

												const hydratedEmail = sanitizeEmail(
													extractAccountEmail(cached.accessToken),
												);
												if (hydratedEmail && hydratedEmail !== account.email) {
													account.email = hydratedEmail;
													storageChanged = true;
												}

												tokenAccountId = extractAccountId(cached.accessToken);
												if (
													tokenAccountId &&
													shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId) &&
													tokenAccountId !== account.accountId
												) {
													account.accountId = tokenAccountId;
													account.accountIdSource = "token";
													storageChanged = true;
												}
											}
										}

										if (!accessToken) {
											const refreshResult = await queuedRefresh(account.refreshToken);
											if (refreshResult.type !== "success") {
												errors += 1;
												const message =
													refreshResult.message ?? refreshResult.reason ?? "refresh failed";
												console.log(`[${i + 1}/${total}] ${label}: ERROR (${message})`);
												if (deepProbe && isFlaggableFailure(refreshResult)) {
													const existingIndex = flaggedStorage.accounts.findIndex(
														(flagged) => flagged.refreshToken === account.refreshToken,
													);
													const flaggedRecord: FlaggedAccountMetadataV1 = {
														...account,
														flaggedAt: Date.now(),
														flaggedReason: "token-invalid",
														lastError: message,
													};
													if (existingIndex >= 0) {
														flaggedStorage.accounts[existingIndex] = flaggedRecord;
													} else {
														flaggedStorage.accounts.push(flaggedRecord);
													}
													removeFromActive.add(account.refreshToken);
													flaggedChanged = true;
												}
												continue;
											}

											accessToken = refreshResult.access;
											authDetail = "OK";
											if (refreshResult.refresh !== account.refreshToken) {
												account.refreshToken = refreshResult.refresh;
												storageChanged = true;
											}
											if (refreshResult.access && refreshResult.access !== account.accessToken) {
												account.accessToken = refreshResult.access;
												storageChanged = true;
											}
											if (
												typeof refreshResult.expires === "number" &&
												refreshResult.expires !== account.expiresAt
											) {
												account.expiresAt = refreshResult.expires;
												storageChanged = true;
											}
											const hydratedEmail = sanitizeEmail(
												extractAccountEmail(refreshResult.access, refreshResult.idToken),
											);
											if (hydratedEmail && hydratedEmail !== account.email) {
												account.email = hydratedEmail;
												storageChanged = true;
											}
											tokenAccountId = extractAccountId(refreshResult.access);
											if (
												tokenAccountId &&
												shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId) &&
												tokenAccountId !== account.accountId
											) {
												account.accountId = tokenAccountId;
												account.accountIdSource = "token";
												storageChanged = true;
											}
										}

										if (!accessToken) {
											throw new Error("Missing access token after refresh");
										}

										if (deepProbe) {
											ok += 1;
											const detail =
												tokenAccountId
													? `${authDetail} (id:${tokenAccountId.slice(-6)})`
													: authDetail;
											console.log(`[${i + 1}/${total}] ${label}: ${detail}`);
											continue;
										}

										try {
											const requestAccountId =
												resolveRequestAccountId(
													account.accountId,
													account.accountIdSource,
													tokenAccountId,
												) ??
												tokenAccountId ??
												account.accountId;

											if (!requestAccountId) {
												throw new Error("Missing accountId for quota probe");
											}

											const snapshot = await fetchCodexQuotaSnapshot({
												accountId: requestAccountId,
												accessToken,
											});
											ok += 1;
											console.log(
												`[${i + 1}/${total}] ${label}: ${formatCodexQuotaLine(snapshot)}`,
											);
										} catch (error) {
											errors += 1;
											const message = error instanceof Error ? error.message : String(error);
											console.log(
												`[${i + 1}/${total}] ${label}: ERROR (${message.slice(0, 160)})`,
											);
										}
									} catch (error) {
										errors += 1;
										const message = error instanceof Error ? error.message : String(error);
										console.log(`[${i + 1}/${total}] ${label}: ERROR (${message.slice(0, 120)})`);
									}
								}

								if (removeFromActive.size > 0) {
									workingStorage.accounts = workingStorage.accounts.filter(
										(account) => !removeFromActive.has(account.refreshToken),
									);
									clampActiveIndices(workingStorage);
									storageChanged = true;
								}

								if (storageChanged) {
									await saveAccounts(workingStorage);
									invalidateAccountManagerCache();
								}
								if (flaggedChanged) {
									await saveFlaggedAccounts(flaggedStorage);
								}

								console.log("");
								console.log(`Results: ${ok} ok, ${errors} error, ${disabled} disabled`);
								if (removeFromActive.size > 0) {
									console.log(
										`Moved ${removeFromActive.size} account(s) to flagged pool (invalid refresh token).`,
									);
								}
								console.log("");
							};

							const verifyFlaggedAccounts = async (): Promise<void> => {
								const flaggedStorage = await loadFlaggedAccounts();
								if (flaggedStorage.accounts.length === 0) {
									console.log("\nNo flagged accounts to verify.\n");
									return;
								}

								console.log("\nVerifying flagged accounts...\n");
								const remaining: FlaggedAccountMetadataV1[] = [];
								const restored: TokenSuccessWithAccount[] = [];

								for (let i = 0; i < flaggedStorage.accounts.length; i += 1) {
									const flagged = flaggedStorage.accounts[i];
									if (!flagged) continue;
									const label = flagged.email ?? flagged.accountLabel ?? `Flagged ${i + 1}`;
									try {
										const cached = await lookupCodexCliTokensByEmail(flagged.email);
										const now = Date.now();
										if (
											cached &&
											typeof cached.expiresAt === "number" &&
											Number.isFinite(cached.expiresAt) &&
											cached.expiresAt > now
										) {
											const refreshToken =
												typeof cached.refreshToken === "string" && cached.refreshToken.trim()
													? cached.refreshToken.trim()
													: flagged.refreshToken;
											const resolved = resolveAccountSelection({
												type: "success",
												access: cached.accessToken,
												refresh: refreshToken,
												expires: cached.expiresAt,
												multiAccount: true,
											});
											if (!resolved.accountIdOverride && flagged.accountId) {
												resolved.accountIdOverride = flagged.accountId;
												resolved.accountIdSource = flagged.accountIdSource ?? "manual";
											}
											if (!resolved.accountLabel && flagged.accountLabel) {
												resolved.accountLabel = flagged.accountLabel;
											}
											restored.push(resolved);
											console.log(
												`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: RESTORED (Codex CLI cache)`,
											);
											continue;
										}

										const refreshResult = await queuedRefresh(flagged.refreshToken);
										if (refreshResult.type !== "success") {
											console.log(
												`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: STILL FLAGGED (${refreshResult.message ?? refreshResult.reason ?? "refresh failed"})`,
											);
											remaining.push(flagged);
											continue;
										}

										const resolved = resolveAccountSelection(refreshResult);
										if (!resolved.accountIdOverride && flagged.accountId) {
											resolved.accountIdOverride = flagged.accountId;
											resolved.accountIdSource = flagged.accountIdSource ?? "manual";
										}
										if (!resolved.accountLabel && flagged.accountLabel) {
											resolved.accountLabel = flagged.accountLabel;
										}
										restored.push(resolved);
										console.log(`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: RESTORED`);
									} catch (error) {
										const message = error instanceof Error ? error.message : String(error);
										console.log(
											`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: ERROR (${message.slice(0, 120)})`,
										);
										remaining.push({
											...flagged,
											lastError: message,
										});
									}
								}

								if (restored.length > 0) {
									await persistAccountPool(restored, false);
									invalidateAccountManagerCache();
								}

								await saveFlaggedAccounts({
									version: 1,
									accounts: remaining,
								});

								console.log("");
								console.log(`Results: ${restored.length} restored, ${remaining.length} still flagged`);
								console.log("");
							};

							if (!explicitLoginMode) {
								while (true) {
									const loadedStorage = await hydrateEmails(await loadAccounts());
									const workingStorage = loadedStorage
										? {
											...loadedStorage,
											accounts: loadedStorage.accounts.map((account) => ({ ...account })),
											activeIndexByFamily: loadedStorage.activeIndexByFamily
												? { ...loadedStorage.activeIndexByFamily }
												: {},
										}
										: { version: 3 as const, accounts: [], activeIndex: 0, activeIndexByFamily: {} };
									const flaggedStorage = await loadFlaggedAccounts();

									if (workingStorage.accounts.length === 0 && flaggedStorage.accounts.length === 0) {
										break;
									}

									const now = Date.now();
									const activeIndex = resolveActiveIndex(workingStorage, "codex");
									const existingAccounts = workingStorage.accounts.map((account, index) => {
										let status: "active" | "ok" | "rate-limited" | "cooldown" | "disabled";
										if (account.enabled === false) {
											status = "disabled";
										} else if (
											typeof account.coolingDownUntil === "number" &&
											account.coolingDownUntil > now
										) {
											status = "cooldown";
										} else if (formatRateLimitEntry(account, now)) {
											status = "rate-limited";
										} else if (index === activeIndex) {
											status = "active";
										} else {
											status = "ok";
										}
										return {
											accountId: account.accountId,
											accountLabel: account.accountLabel,
											email: account.email,
											index,
											addedAt: account.addedAt,
											lastUsed: account.lastUsed,
											status,
											isCurrentAccount: index === activeIndex,
											enabled: account.enabled !== false,
										};
									});

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
										await verifyFlaggedAccounts();
										continue;
									}

									if (menuResult.mode === "manage") {
										if (typeof menuResult.deleteAccountIndex === "number") {
											const target = workingStorage.accounts[menuResult.deleteAccountIndex];
											if (target) {
												workingStorage.accounts.splice(menuResult.deleteAccountIndex, 1);
												clampActiveIndices(workingStorage);
												await saveAccounts(workingStorage);
												await saveFlaggedAccounts({
													version: 1,
													accounts: flaggedStorage.accounts.filter(
														(flagged) => flagged.refreshToken !== target.refreshToken,
													),
												});
												invalidateAccountManagerCache();
												console.log(`\nDeleted ${target.email ?? `Account ${menuResult.deleteAccountIndex + 1}`}.\n`);
											}
											continue;
										}

										if (typeof menuResult.toggleAccountIndex === "number") {
											const target = workingStorage.accounts[menuResult.toggleAccountIndex];
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
											console.log("\nDeleted all accounts. Starting fresh.\n");
										}
										break;
									}

									startFresh = false;
									break;
								}
							}

							const latestStorage = await loadAccounts();
							const existingCount = latestStorage?.accounts.length ?? 0;
							const requestedCount = Number.parseInt(inputs?.accountCount ?? "1", 10);
							const normalizedRequested = Number.isFinite(requestedCount) ? requestedCount : 1;
							const availableSlots =
								refreshAccountIndex !== undefined
									? 1
									: startFresh
										? ACCOUNT_LIMITS.MAX_ACCOUNTS
										: ACCOUNT_LIMITS.MAX_ACCOUNTS - existingCount;

							if (availableSlots <= 0) {
								return {
									url: "",
									instructions: "Account limit reached. Remove an account or start fresh.",
									method: "auto",
									callback: () =>
										Promise.resolve({
											type: "failed" as const,
										}),
								};
							}

							let targetCount = Math.max(1, Math.min(normalizedRequested, availableSlots));
							if (refreshAccountIndex !== undefined) {
								targetCount = 1;
							}
							if (useManualMode) {
								targetCount = 1;
							}

							if (useManualMode) {
								const { pkce, state, url } = await createAuthorizationFlow();
								return buildManualOAuthFlow(pkce, url, state, async (tokens) => {
									try {
										await persistAccountPool([tokens], startFresh);
										invalidateAccountManagerCache();
									} catch (err) {
										const storagePath = getStoragePath();
										const errorCode = (err as NodeJS.ErrnoException)?.code || "UNKNOWN";
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
								});
							}

							const explicitCountProvided =
								typeof inputs?.accountCount === "string" && inputs.accountCount.trim().length > 0;

							while (accounts.length < targetCount) {
								logInfo(`=== OpenAI OAuth (Account ${accounts.length + 1}) ===`);
								const forceNewLogin = accounts.length > 0 || refreshAccountIndex !== undefined;
								const result = await runOAuthFlow(forceNewLogin);

								let resolved: TokenSuccessWithAccount | null = null;
								if (result.type === "success") {
									resolved = resolveAccountSelection(result);
									const email = extractAccountEmail(resolved.access, resolved.idToken);
									const accountId = resolved.accountIdOverride ?? extractAccountId(resolved.access);
									const label = resolved.accountLabel ?? email ?? accountId ?? "Unknown account";
									logInfo(`Authenticated as: ${label}`);

									const isDuplicate = accounts.some(
										(account) =>
											(accountId &&
												(account.accountIdOverride ?? extractAccountId(account.access)) === accountId) ||
											(email && extractAccountEmail(account.access, account.idToken) === email),
									);

									if (isDuplicate) {
										logWarn(`WARNING: duplicate account login detected (${label}). Existing entry will be updated.`);
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
									logWarn(`[${PLUGIN_NAME}] Skipping failed account ${accounts.length + 1}`);
									break;
								}

								if (!resolved) {
									continue;
								}

								accounts.push(resolved);
								await showToast(`Account ${accounts.length} authenticated`, "success");

								try {
									const isFirstAccount = accounts.length === 1;
									await persistAccountPool([resolved], isFirstAccount && startFresh);
									invalidateAccountManagerCache();
								} catch (err) {
									const storagePath = getStoragePath();
									const errorCode = (err as NodeJS.ErrnoException)?.code || "UNKNOWN";
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
							applyUiRuntimeFromConfig(manualPluginConfig);
							applyAccountStorageScope(manualPluginConfig);

                                                        const { pkce, state, url } = await createAuthorizationFlow();
                                                        return buildManualOAuthFlow(pkce, url, state, async (tokens) => {
                                                                try {
                                                                        await persistAccountPool([tokens], false);
                                                                } catch (err) {
                                                                        const storagePath = getStoragePath();
                                                                        const errorCode = (err as NodeJS.ErrnoException)?.code || "UNKNOWN";
                                                                        const hint = err instanceof StorageError ? err.hint : formatStorageErrorHint(err, storagePath);
                                                                        logError(`[${PLUGIN_NAME}] Failed to persist account: [${errorCode}] ${(err as Error)?.message ?? String(err)}`);
                                                                        await showToast(
                                                                                hint,
                                                                                "error",
                                                                                { title: "Account Persistence Failed", duration: 10000 },
                                                                        );
                                                                }
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
							if (index === activeIndex) badges.push(formatUiBadge(ui, "current", "accent"));
							if (account.enabled === false) badges.push(formatUiBadge(ui, "disabled", "danger"));
							const rateLimit = formatRateLimitEntry(account, now);
							if (rateLimit) badges.push(formatUiBadge(ui, "rate-limited", "warning"));
							if (
								typeof account.coolingDownUntil === "number" &&
								account.coolingDownUntil > now
							) {
								badges.push(formatUiBadge(ui, "cooldown", "warning"));
							}
							if (badges.length === 0) {
								badges.push(formatUiBadge(ui, "ok", "success"));
							}

							lines.push(formatUiItem(ui, `${index + 1}. ${label} ${badges.join(" ")}`.trim()));
							if (rateLimit) {
								lines.push(`  ${paintUiText(ui, `rate limit: ${rateLimit}`, "muted")}`);
							}
						});

						lines.push("");
						lines.push(...formatUiSection(ui, "Commands"));
						lines.push(formatUiItem(ui, "Add account: codex login", "accent"));
						lines.push(formatUiItem(ui, "Switch account: codex-switch <index>"));
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
                                                );
                                                if (index === activeIndex) statuses.push("active");
                                                if (rateLimit) statuses.push("rate-limited");
                                                if (
                                                        typeof account.coolingDownUntil ===
                                                                "number" &&
                                                        account.coolingDownUntil > now
                                                ) {
                                                        statuses.push("cooldown");
                                                }
                                                const statusText = statuses.length > 0 ? statuses.join(", ") : "ok";
                                                lines.push(buildTableRow([String(index + 1), label, statusText], listTableOptions));
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
                                        index: tool.schema.number().describe(
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
								formatUiKeyValue(ui, "Valid range", `1-${storage.accounts.length}`, "muted"),
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

					setActiveIndexForAllFamilies(storage, targetIndex);
					try {
						await saveAccounts(storage);
					} catch (saveError) {
						logWarn("Failed to save account switch", { error: String(saveError) });
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Switch account"),
								"",
								formatUiItem(ui, `Switched to ${formatAccountLabel(account, targetIndex)}`, "warning"),
								formatUiItem(ui, "Failed to persist change. It may be lost on restart.", "danger"),
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
							formatUiItem(ui, `${getStatusMarker(ui, "ok")} Switched to ${label}`, "success"),
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
						if (index === activeIndex) badges.push(formatUiBadge(ui, "active", "accent"));
						if (account.enabled === false) badges.push(formatUiBadge(ui, "disabled", "danger"));
						const rateLimit = formatRateLimitEntry(account, now) ?? "none";
						const cooldown = formatCooldown(account, now) ?? "none";
						if (rateLimit !== "none") badges.push(formatUiBadge(ui, "rate-limited", "warning"));
						if (cooldown !== "none") badges.push(formatUiBadge(ui, "cooldown", "warning"));
						if (badges.length === 0) badges.push(formatUiBadge(ui, "ok", "success"));

						lines.push(formatUiItem(ui, `${index + 1}. ${label} ${badges.join(" ")}`.trim()));
						lines.push(`  ${formatUiKeyValue(ui, "rate limit", rateLimit, rateLimit === "none" ? "muted" : "warning")}`);
						lines.push(`  ${formatUiKeyValue(ui, "cooldown", cooldown, cooldown === "none" ? "muted" : "warning")}`);
					});

					lines.push("");
					lines.push(...formatUiSection(ui, "Active index by model family"));
					for (const family of MODEL_FAMILIES) {
						const idx = storage.activeIndexByFamily?.[family];
						const familyIndexLabel =
							typeof idx === "number" && Number.isFinite(idx) ? String(idx + 1) : "-";
						lines.push(formatUiItem(ui, `${family}: ${familyIndexLabel}`));
					}

					lines.push("");
					lines.push(...formatUiSection(ui, "Rate limits by model family (per account)"));
					storage.accounts.forEach((account, index) => {
						const statuses = MODEL_FAMILIES.map((family) => {
							const resetAt = getRateLimitResetTimeForFamily(account, now, family);
							if (typeof resetAt !== "number") return `${family}=ok`;
							return `${family}=${formatWaitTime(resetAt - now)}`;
						});
						lines.push(formatUiItem(ui, `Account ${index + 1}: ${statuses.join(" | ")}`));
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
										const rateLimit = formatRateLimitEntry(account, now) ?? "None";
										const cooldown = formatCooldown(account, now) ?? "No";
										const lastUsed =
												typeof account.lastUsed === "number" && account.lastUsed > 0
														? `${formatWaitTime(now - account.lastUsed)} ago`
														: "-";

										lines.push(buildTableRow([String(index + 1), label, active, rateLimit, cooldown, lastUsed], statusTableOptions));
								});

										lines.push("");
										lines.push("Active index by model family:");
										for (const family of MODEL_FAMILIES) {
												const idx = storage.activeIndexByFamily?.[family];
												const familyIndexLabel =
													typeof idx === "number" && Number.isFinite(idx) ? String(idx + 1) : "-";
												lines.push(`  ${family}: ${familyIndexLabel}`);
										}

										lines.push("");
										lines.push("Rate limits by model family (per account):");
										storage.accounts.forEach((account, index) => {
												const statuses = MODEL_FAMILIES.map((family) => {
														const resetAt = getRateLimitResetTimeForFamily(account, now, family);
														if (typeof resetAt !== "number") return `${family}=ok`;
														return `${family}=${formatWaitTime(resetAt - now)}`;
												});
												lines.push(`  Account ${index + 1}: ${statuses.join(" | ")}`);
										});

										return lines.join("\n");
                                },
                        }),
			...(exposeAdvancedCodexTools ? {
			"codex-metrics": tool({
				description: "Show runtime request metrics for this plugin process.",
				args: {},
				execute() {
					const ui = resolveUiRuntime();
					const now = Date.now();
					const uptimeMs = Math.max(0, now - runtimeMetrics.startedAt);
					const total = runtimeMetrics.totalRequests;
					const successful = runtimeMetrics.successfulRequests;
					const successRate = total > 0 ? ((successful / total) * 100).toFixed(1) : "0.0";
					const avgLatencyMs =
						successful > 0
							? Math.round(runtimeMetrics.cumulativeLatencyMs / successful)
							: 0;
					const liveSyncSnapshot = liveAccountSync?.getSnapshot();
					const guardianStats = refreshGuardian?.getStats();
					const sessionAffinityEntries = sessionAffinityStore?.size() ?? 0;
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
							formatUiKeyValue(ui, "Total upstream requests", String(total)),
							formatUiKeyValue(ui, "Successful responses", String(successful), "success"),
							formatUiKeyValue(ui, "Failed responses", String(runtimeMetrics.failedRequests), "danger"),
							formatUiKeyValue(ui, "Success rate", `${successRate}%`, "accent"),
							formatUiKeyValue(ui, "Average successful latency", `${avgLatencyMs}ms`),
							formatUiKeyValue(ui, "Rate-limited responses", String(runtimeMetrics.rateLimitedResponses), "warning"),
							formatUiKeyValue(ui, "Server errors (5xx)", String(runtimeMetrics.serverErrors), "danger"),
							formatUiKeyValue(ui, "Network errors", String(runtimeMetrics.networkErrors), "danger"),
							formatUiKeyValue(ui, "User aborts", String(runtimeMetrics.userAborts), "muted"),
							formatUiKeyValue(ui, "Auth refresh failures", String(runtimeMetrics.authRefreshFailures), "warning"),
							formatUiKeyValue(ui, "Account rotations", String(runtimeMetrics.accountRotations), "accent"),
							formatUiKeyValue(ui, "Same-account retries", String(runtimeMetrics.sameAccountRetries), "warning"),
							formatUiKeyValue(ui, "Stream failover attempts", String(runtimeMetrics.streamFailoverAttempts), "muted"),
							formatUiKeyValue(ui, "Stream failover recoveries", String(runtimeMetrics.streamFailoverRecoveries), "success"),
							formatUiKeyValue(
								ui,
								"Stream failover cross-account recoveries",
								String(runtimeMetrics.streamFailoverCrossAccountRecoveries),
								"accent",
							),
							formatUiKeyValue(ui, "Empty-response retries", String(runtimeMetrics.emptyResponseRetries), "warning"),
							formatUiKeyValue(ui, "Session affinity entries", String(sessionAffinityEntries), "muted"),
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
							formatUiKeyValue(ui, "Last upstream request", lastRequest, "muted"),
						];
						if (runtimeMetrics.lastError) {
							styled.push(formatUiKeyValue(ui, "Last error", runtimeMetrics.lastError, "danger"));
						}
						return Promise.resolve(styled.join("\n"));
					}

					return Promise.resolve(lines.join("\n"));
				},
			}),
			} : {}),
				"codex-health": tool({
				description: "Check health of all Codex accounts by validating refresh tokens.",
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
								results.push(`  ${getStatusMarker(ui, "ok")} ${label}: Healthy`);
								healthyCount++;
							} else {
								results.push(`  ${getStatusMarker(ui, "error")} ${label}: Token refresh failed`);
								unhealthyCount++;
							}
						} catch (error) {
							const errorMsg = error instanceof Error ? error.message : String(error);
							results.push(`  ${getStatusMarker(ui, "error")} ${label}: Error - ${errorMsg.slice(0, 120)}`);
							unhealthyCount++;
						}
					}

					results.push("");
					results.push(`Summary: ${healthyCount} healthy, ${unhealthyCount} unhealthy`);

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
			...(exposeAdvancedCodexTools ? {
			"codex-remove": tool({
				description: "Remove a Codex account by index (1-based). Use codex-list to list accounts first.",
				args: {
					index: tool.schema.number().describe(
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
								formatUiItem(ui, `Invalid account number: ${index}`, "danger"),
								formatUiKeyValue(ui, "Valid range", `1-${storage.accounts.length}`, "muted"),
								formatUiItem(ui, "Use codex-list to list all accounts.", "accent"),
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
					logWarn("Failed to save account removal", { error: String(saveError) });
					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Remove account"),
							"",
							formatUiItem(ui, `Removed ${formatAccountLabel(account, targetIndex)} from memory`, "warning"),
							formatUiItem(ui, "Failed to persist. Change may be lost on restart.", "danger"),
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
							formatUiItem(ui, `${getStatusMarker(ui, "ok")} Removed: ${label}`, "success"),
							remaining > 0
								? formatUiKeyValue(ui, "Remaining accounts", String(remaining))
								: formatUiItem(ui, "No accounts remaining. Run: codex login", "warning"),
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
				description: "Manually refresh OAuth tokens for all accounts to verify they're still valid.",
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
							const refreshResult = await queuedRefresh(account.refreshToken);
							if (refreshResult.type === "success") {
								account.refreshToken = refreshResult.refresh;
								account.accessToken = refreshResult.access;
								account.expiresAt = refreshResult.expires;
								results.push(`  ${getStatusMarker(ui, "ok")} ${label}: Refreshed`);
								refreshedCount++;
							} else {
								results.push(`  ${getStatusMarker(ui, "error")} ${label}: Failed - ${refreshResult.message ?? refreshResult.reason}`);
								failedCount++;
							}
						} catch (error) {
							const errorMsg = error instanceof Error ? error.message : String(error);
							results.push(`  ${getStatusMarker(ui, "error")} ${label}: Error - ${errorMsg.slice(0, 120)}`);
							failedCount++;
						}
					}

				await saveAccounts(storage);
				if (cachedAccountManager) {
					await reloadAccountManagerFromDisk();
				}
				results.push("");
				results.push(`Summary: ${refreshedCount} refreshed, ${failedCount} failed`);
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
			description: "Export accounts to a JSON file for backup or migration to another machine.",
			args: {
				path: tool.schema.string().describe(
					"File path to export to (e.g., ~/codex-backup.json)"
				),
				force: tool.schema.boolean().optional().describe(
					"Overwrite existing file (default: true)"
				),
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
							formatUiItem(ui, `${getStatusMarker(ui, "ok")} Exported ${count} account(s)`, "success"),
							formatUiKeyValue(ui, "Path", filePath, "muted"),
						].join("\n");
					}
					return `Exported ${count} account(s) to: ${filePath}`;
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Export accounts"),
							"",
							formatUiItem(ui, `${getStatusMarker(ui, "error")} Export failed`, "danger"),
							formatUiKeyValue(ui, "Error", msg, "danger"),
						].join("\n");
					}
					return `Export failed: ${msg}`;
				}
			},
		}),

		"codex-import": tool({
			description: "Import accounts from a JSON file, merging with existing accounts.",
			args: {
				path: tool.schema.string().describe(
					"File path to import from (e.g., ~/codex-backup.json)"
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
							formatUiItem(ui, `${getStatusMarker(ui, "ok")} Import complete`, "success"),
							formatUiKeyValue(ui, "Path", filePath, "muted"),
							formatUiKeyValue(ui, "New accounts", String(result.imported), result.imported > 0 ? "success" : "muted"),
							formatUiKeyValue(ui, "Duplicates skipped", String(result.skipped), result.skipped > 0 ? "warning" : "muted"),
							formatUiKeyValue(ui, "Total accounts", String(result.total), "accent"),
						];
						return styled.join("\n");
					}
					return lines.join("\n");
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Import accounts"),
							"",
							formatUiItem(ui, `${getStatusMarker(ui, "error")} Import failed`, "danger"),
							formatUiKeyValue(ui, "Error", msg, "danger"),
						].join("\n");
					}
					return `Import failed: ${msg}`;
				}
			},
		}),
		} : {}),

	},
	};
};

export const OpenAIAuthPlugin = OpenAIOAuthPlugin;

export default OpenAIOAuthPlugin;


