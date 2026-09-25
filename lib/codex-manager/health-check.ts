import { refreshAndPrintResetCredits } from "../runtime/account-reset-credits.js";
import { mapWithConcurrency } from "../concurrency.js";
import { withCheckProgress } from "../ui/check-progress.js";
import { refreshAndPrintModelInventory } from "../runtime/model-discovery-status.js";
import {
	AUTH_INVALIDATION_MARKER,
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	sanitizeEmail,
} from "../accounts.js";
import { codexCliAccountIdFor } from "../auth/token-utils.js";
import { setCodexCliActiveSelection } from "../codex-cli/writer.js";
import {
	type DashboardDisplaySettings,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
} from "../dashboard-settings.js";
import { isCodexUnavailableError } from "../errors.js";
import { loadQuotaCache, saveQuotaCache } from "../quota-cache.js";
import {
	CODEX_UNAVAILABLE_PROBE_NOTE,
	fetchCodexQuotaSnapshot,
} from "../quota-probe.js";
import { buildQuotaEmailFallbackState } from "../quota-readiness.js";
import { queuedRefresh } from "../refresh-queue.js";
import { resolveActiveIndex } from "../runtime/account-status.js";
import { loadAccounts, saveAccounts, setStoragePath } from "../storage.js";
import {
	applyTokenAccountIdentity,
	hasLikelyInvalidRefreshToken,
	hasUsableAccessToken,
} from "./account-credentials.js";
import { saveAccountsWithRetry } from "./forecast-report-shared.js";
import {
	formatModelInspection,
	formatQuotaSnapshotForDashboard,
	formatResultSummary,
	inspectRequestedModel,
	normalizeFailureDetail,
	styleAccountDetailText,
	stylePromptText,
} from "./formatters/index.js";
import {
	cloneQuotaCacheData,
	DEFAULT_LIVE_PROBE_MODEL,
	pruneUnsafeQuotaEmailCacheEntry,
	updateQuotaCacheForAccount,
} from "./quota-cache-helpers.js";

function appendAuthInvalidationMarker(
	account: { authInvalidatedAt?: number },
	detail: string,
): string {
	return typeof account.authInvalidatedAt === "number" &&
		Number.isFinite(account.authInvalidatedAt)
		? `${detail} [${AUTH_INVALIDATION_MARKER}]`
		: detail;
}

/**
 * Body of the `check` command, also reused by the login dashboard's quick
 * check / deep check actions. Moved verbatim out of lib/codex-manager.ts
 * (audit roadmap §4.1.1 phase 3).
 */
export interface HealthCheckOptions {
	forceRefresh?: boolean;
	discoverModels?: boolean;
	liveProbe?: boolean;
	/** Explicit `check --prime` only: may start an unused subscription's quota windows. */
	primeUnusedSubscription?: boolean;
	model?: string;
	display?: DashboardDisplaySettings;
}

export async function runHealthCheck(
	options: HealthCheckOptions = {},
): Promise<void> {
	const forceRefresh = options.forceRefresh === true;
	const liveProbe = options.liveProbe === true;
	const primeUnusedSubscription = options.primeUnusedSubscription === true;
	const probeModel = options.model?.trim() || DEFAULT_LIVE_PROBE_MODEL;
	const modelInspection = inspectRequestedModel(probeModel);
	const display = options.display ?? DEFAULT_DASHBOARD_DISPLAY_SETTINGS;
	const quotaCache = liveProbe ? await loadQuotaCache() : null;
	const workingQuotaCache = quotaCache ? cloneQuotaCacheData(quotaCache) : null;
	let quotaCacheChanged = false;
	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		console.log("No accounts configured.");
		if (options.discoverModels) await refreshAndPrintModelInventory(console.log);
		return;
	}
	let quotaEmailFallbackState =
		liveProbe && quotaCache
			? buildQuotaEmailFallbackState(storage.accounts)
			: null;

	let changed = false;
	let ok = 0;
	let failed = 0;
	let warnings = 0;
	let codexAvailable = 0;
	let signedInOnly = 0;
	const activeIndex = resolveActiveIndex(storage, "codex");
	let activeAccountRefreshed = false;
	const now = Date.now();
	console.log(
		stylePromptText(
			forceRefresh
				? `Checking ${storage.accounts.length} account(s) with full refresh test...`
				: `Checking ${storage.accounts.length} account(s) with quick check${liveProbe ? " + live check" : ""}...`,
			"accent",
		),
	);
	if (liveProbe) {
		console.log(
			stylePromptText(
				`Model probe: ${formatModelInspection(modelInspection)}`,
				"muted",
			),
		);
	}
 type ProbeOutcome = { ok: true; value: Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>> } | { ok: false; error: unknown };
 const quickProbes = new Map<number, ProbeOutcome>();
 if (liveProbe && !forceRefresh) {
  const candidates = storage.accounts.flatMap((account, index) => {
   const accountId = account.accountId ?? extractAccountId(account.accessToken);
   return hasUsableAccessToken(account, now) && account.accessToken && accountId
    ? [{index,accountId,accessToken:account.accessToken}] : [];
  });
  if(candidates.length){
   let completed = 0;
   await withCheckProgress(() => `Checking account probes: ${completed}/${candidates.length}`, async () => {
    await mapWithConcurrency(candidates, 3, async candidate => {
     try {
      const value = await fetchCodexQuotaSnapshot({primeUnusedSubscription,accountId:candidate.accountId,accessToken:candidate.accessToken,model:modelInspection.normalized});
      quickProbes.set(candidate.index,{ok:true,value});
     } catch(error) { quickProbes.set(candidate.index,{ok:false,error}); }
     finally { completed++; }
    });
   }, console.log);
  }
 }
	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		const label = formatAccountLabel(account, i);
		const labelText = stylePromptText(label, "accent");
		const sessionLikelyValid = hasUsableAccessToken(account, now);
		if (!forceRefresh && sessionLikelyValid) {
			if (account.enabled === false) {
				account.enabled = true;
				changed = true;
			}
			if (i === activeIndex) {
				activeAccountRefreshed = true;
			}
			let healthDetail = "signed in and working";
			let healthTone: "success" | "warning" = "success";
			if (liveProbe) {
				const currentAccessToken = account.accessToken;
				const probeAccountId = currentAccessToken
					? (account.accountId ?? extractAccountId(currentAccessToken))
					: undefined;
				if (!probeAccountId || !currentAccessToken) {
					warnings += 1;
					signedInOnly += 1;
					healthTone = "warning";
					healthDetail =
						"signed in (live check skipped: missing account ID)";
				} else {
					try {
						const priorProbe = quickProbes.get(i);
      if(priorProbe && !priorProbe.ok) throw priorProbe.error;
      const snapshot = priorProbe?.ok ? priorProbe.value : await withCheckProgress(`Account ${i + 1}/${storage.accounts.length}: live probe`, () => fetchCodexQuotaSnapshot({primeUnusedSubscription,
							accountId: probeAccountId,
							accessToken: currentAccessToken,
							model: modelInspection.normalized,
						}), console.log);
						if (workingQuotaCache) {
							quotaCacheChanged =
								updateQuotaCacheForAccount(
									workingQuotaCache,
									account,
									snapshot,
									storage.accounts,
									quotaEmailFallbackState ?? undefined,
								) || quotaCacheChanged;
						}
						healthDetail = formatQuotaSnapshotForDashboard(snapshot, display);
						if (snapshot.primingFailure) { healthTone = "warning"; warnings += 1; }
						codexAvailable += 1;
					} catch (error) {
						warnings += 1;
						signedInOnly += 1;
						healthTone = "warning";
						if (isCodexUnavailableError(error)) {
							healthDetail =
								`signed in; ${CODEX_UNAVAILABLE_PROBE_NOTE}`;
						} else {
							const message = normalizeFailureDetail(
								error instanceof Error ? error.message : String(error),
								undefined,
							);
							healthDetail = `signed in (live check failed: ${message})`;
						}
					}
				}
			}
			if (hasLikelyInvalidRefreshToken(account.refreshToken)) {
				healthDetail += " (re-login suggested soon)";
			}
			healthDetail = appendAuthInvalidationMarker(account, healthDetail);
			ok += 1;
			if (display.showPerAccountRows) {
				const healthMarker = healthTone === "success" ? "✓" : "!";
				console.log(
					`  ${stylePromptText(healthMarker, healthTone)} ${labelText} ${stylePromptText("|", "muted")} ${styleAccountDetailText(healthDetail, healthTone)}`,
				);
			}
			continue;
		}
		const result = await withCheckProgress(`Account ${i + 1}/${storage.accounts.length}: refreshing sign-in`, () => queuedRefresh(account.refreshToken), console.log);
		if (result.type === "success") {
			const tokenAccountId = extractAccountId(result.access);
			const nextEmail = sanitizeEmail(
				extractAccountEmail(result.access, result.idToken),
			);
			const previousEmail = account.email;
			let accountIdentityChanged = false;
			if (account.refreshToken !== result.refresh) {
				account.refreshToken = result.refresh;
				changed = true;
			}
			if (account.accessToken !== result.access) {
				account.accessToken = result.access;
				changed = true;
			}
			if (account.expiresAt !== result.expires) {
				account.expiresAt = result.expires;
				changed = true;
			}
			if (nextEmail && nextEmail !== account.email) {
				account.email = nextEmail;
				changed = true;
				accountIdentityChanged = true;
			}
			if (applyTokenAccountIdentity(account, tokenAccountId)) {
				changed = true;
				accountIdentityChanged = true;
			}
			if (account.enabled === false) {
				account.enabled = true;
				changed = true;
			}
			if (
				typeof account.authInvalidatedAt === "number" ||
				account.authInvalidationErrorCode !== undefined
			) {
				delete account.authInvalidatedAt;
				delete account.authInvalidationErrorCode;
				changed = true;
			}
			if (accountIdentityChanged && liveProbe && workingQuotaCache) {
				quotaEmailFallbackState = buildQuotaEmailFallbackState(
					storage.accounts,
				);
				quotaCacheChanged =
					pruneUnsafeQuotaEmailCacheEntry(
						workingQuotaCache,
						previousEmail,
						storage.accounts,
						quotaEmailFallbackState,
					) || quotaCacheChanged;
			}
			account.lastUsed = Date.now();
			if (i === activeIndex) {
				activeAccountRefreshed = true;
			}
			ok += 1;
			let healthyMessage = "working now";
			let healthyTone: "success" | "warning" = "success";
			if (liveProbe) {
				const probeAccountId = account.accountId ?? tokenAccountId;
				if (!probeAccountId) {
					warnings += 1;
					signedInOnly += 1;
					healthyTone = "warning";
					healthyMessage =
						"signed in (live check skipped: missing account ID)";
				} else {
					try {
						const snapshot = await withCheckProgress(`Account ${i + 1}/${storage.accounts.length}: live probe`, () => fetchCodexQuotaSnapshot({primeUnusedSubscription,
							accountId: probeAccountId,
							accessToken: result.access,
							model: modelInspection.normalized,
						}), console.log);
						if (workingQuotaCache) {
							quotaCacheChanged =
								updateQuotaCacheForAccount(
									workingQuotaCache,
									account,
									snapshot,
									storage.accounts,
									quotaEmailFallbackState ?? undefined,
								) || quotaCacheChanged;
						}
						healthyMessage = formatQuotaSnapshotForDashboard(snapshot, display);
						if (snapshot.primingFailure) { healthyTone = "warning"; warnings += 1; }
						codexAvailable += 1;
					} catch (error) {
						warnings += 1;
						signedInOnly += 1;
						healthyTone = "warning";
						if (isCodexUnavailableError(error)) {
							healthyMessage =
								`signed in; ${CODEX_UNAVAILABLE_PROBE_NOTE}`;
						} else {
							const message = normalizeFailureDetail(
								error instanceof Error ? error.message : String(error),
								undefined,
							);
							healthyMessage = `signed in (live check failed: ${message})`;
						}
					}
				}
			}
			if (display.showPerAccountRows) {
				healthyMessage = appendAuthInvalidationMarker(account, healthyMessage);
				const healthyMarker = healthyTone === "success" ? "✓" : "!";
				console.log(
					`  ${stylePromptText(healthyMarker, healthyTone)} ${labelText} ${stylePromptText("|", "muted")} ${styleAccountDetailText(healthyMessage, healthyTone)}`,
				);
			}
		} else {
			const detail = normalizeFailureDetail(result.message, result.reason);
			if (sessionLikelyValid) {
				warnings += 1;
				if (liveProbe) {
					signedInOnly += 1;
				}
				if (display.showPerAccountRows) {
					const detailWithMarker = appendAuthInvalidationMarker(
						account,
						`refresh failed (${detail}) but this account still works right now`,
					);
					console.log(
						`  ${stylePromptText("!", "warning")} ${labelText} ${stylePromptText("|", "muted")} ${stylePromptText(detailWithMarker, "warning")}`,
					);
				}
			} else {
				failed += 1;
				if (display.showPerAccountRows) {
					const detailWithMarker = appendAuthInvalidationMarker(account, detail);
					console.log(
						`  ${stylePromptText("✗", "danger")} ${labelText} ${stylePromptText("|", "muted")} ${stylePromptText(detailWithMarker, "danger")}`,
					);
				}
			}
		}
	}

	if (!display.showPerAccountRows) {
		console.log(
			stylePromptText(
				"Per-account lines are hidden in dashboard settings.",
				"muted",
			),
		);
	}
	if (workingQuotaCache && quotaCacheChanged) {
		try {
			await saveQuotaCache(workingQuotaCache);
		} catch (error) {
			// Quota cache is a derived artifact; a transient Windows EBUSY/EPERM
			// here must not abort the health check before account fixes commit.
			console.warn(
				`Quota cache save failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	if (changed) {
		await saveAccountsWithRetry(storage, saveAccounts);
	}

	if (
		activeAccountRefreshed &&
		activeIndex >= 0 &&
		activeIndex < storage.accounts.length
	) {
		const activeAccount = storage.accounts[activeIndex];
		if (activeAccount) {
			await setCodexCliActiveSelection({
				accountId: codexCliAccountIdFor(activeAccount, activeAccount.accessToken),
				email: activeAccount.email,
				accessToken: activeAccount.accessToken,
				refreshToken: activeAccount.refreshToken,
				expiresAt: activeAccount.expiresAt,
			});
		}
	}

	console.log("");
	console.log(
		formatResultSummary(
			liveProbe
				? [
						{
							text: `${codexAvailable} Codex available`,
							tone: codexAvailable > 0 ? "success" : "muted",
						},
						{
							text: `${signedInOnly} signed in only`,
							tone: signedInOnly > 0 ? "warning" : "muted",
						},
						{
							text: `${failed} need re-login`,
							tone: failed > 0 ? "danger" : "muted",
						},
					]
				: [
						{ text: `${ok} working`, tone: "success" },
						{
							text: `${failed} need re-login`,
							tone: failed > 0 ? "danger" : "muted",
						},
						{
							text: `${warnings} warning${warnings === 1 ? "" : "s"}`,
							tone: warnings > 0 ? "warning" : "muted",
						},
					],
		),
	);
	if (options.discoverModels) {
  await refreshAndPrintResetCredits(console.log).catch(() => {
   console.log("Reset-credit availability could not be refreshed; cached counts may be stale.");
  });
  await refreshAndPrintModelInventory(console.log);
 }
}
