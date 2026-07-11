import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	sanitizeEmail,
} from "../../accounts.js";
import {
	evaluateForecastAccounts,
	recommendForecastAccount,
	summarizeForecast,
} from "../../forecast.js";
import {
	type AccountIdentityMatch,
	applyRefreshedAccountPatch,
	persistRefreshedAccountPatch,
	type RefreshedAccountPatch,
	serializeForecastResults,
} from "../forecast-report-shared.js";
import {
	type CodexQuotaSnapshot,
	formatQuotaSnapshotLine,
	describeCodexProbeFailure,
} from "../../quota-probe.js";
import { type ModelFamily } from "../../prompts/codex.js";
import {
	DEFAULT_PROBE_MODEL,
	getModelCapabilities,
	getModelProfile,
	resolveNormalizedModel,
} from "../../request/helpers/model-map.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	type StorageHealthSummary,
} from "../../storage.js";
import type { RuntimeObservabilitySnapshot } from "../../runtime/runtime-observability.js";
import type { QuotaCacheData } from "../../quota-cache.js";
import type { TokenFailure, TokenResult } from "../../types.js";
import { sleep } from "../../utils.js";
import { tempPathFor } from "../../temp-path.js";

interface ReportCliOptions {
	live: boolean;
	json: boolean;
	explain: boolean;
	model: string;
	maxAccounts?: number;
	maxProbes?: number;
	cachedOnly: boolean;
	outPath?: string;
}

type ParsedArgsResult<T> =
	| { ok: true; options: T }
	| { ok: false; message: string };

interface ModelInspection {
	requested: string;
	normalized: string;
	remapped: boolean;
	promptFamily: ModelFamily;
	capabilities: ReturnType<typeof getModelCapabilities>;
}

function parsePositiveIntegerOption(
	rawValue: string,
): number | null {
	const normalized = rawValue.trim();
	if (!/^\d+$/.test(normalized)) {
		return null;
	}
	const parsed = Number.parseInt(normalized, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		return null;
	}
	return parsed;
}

const RETRYABLE_WRITE_CODES = new Set(["EBUSY", "EPERM"]);

export interface ReportCommandDeps {
	setStoragePath: (path: string | null) => void;
	getStoragePath: () => string;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	saveAccounts: (storage: AccountStorageV3) => Promise<void>;
	resolveActiveIndex: (storage: AccountStorageV3, family?: "codex") => number;
	hasUsableAccessToken: (
		account: Pick<AccountMetadataV3, "accessToken" | "expiresAt">,
		now: number,
	) => boolean;
	queuedRefresh: (refreshToken: string) => Promise<TokenResult>;
	fetchCodexQuotaSnapshot: (input: {
		accountId: string;
		accessToken: string;
		model: string;
	}) => Promise<CodexQuotaSnapshot>;
	formatRateLimitEntry: (
		account: AccountStorageV3["accounts"][number],
		now: number,
		family: "codex",
	) => string | null;
	inspectStorageHealth?: () => Promise<StorageHealthSummary>;
	normalizeFailureDetail: (
		message: string | undefined,
		reason: string | undefined,
	) => string;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
	getCwd?: () => string;
	writeFile?: (path: string, contents: string) => Promise<void>;
	loadRuntimeObservabilitySnapshot?: () => Promise<RuntimeObservabilitySnapshot | null>;
	loadQuotaCache?: () => Promise<QuotaCacheData | null>;
}

function isRetryableWriteError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_WRITE_CODES.has(code);
}

function printReportUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage: codex-multi-auth report [--live] [--json] [--explain] [--model MODEL] [--out PATH]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend",
			"  --json, -j         Print machine-readable JSON output",
			"  --explain          Print per-account reasoning in text mode",
			`  --model, -m        Probe model for live mode (default: ${DEFAULT_PROBE_MODEL})`,
			"  --max-accounts N   Limit how many enabled accounts live mode can consider",
			"  --max-probes N     Limit how many live quota probes can run",
			"  --cached-only      Skip refreshes and only use already-usable access tokens",
			"  --out              Write JSON report to a file path",
		].join("\n"),
	);
}

function parseReportArgs(args: string[]): ParsedArgsResult<ReportCliOptions> {
	const options: ReportCliOptions = {
		live: false,
		json: false,
		explain: false,
		model: DEFAULT_PROBE_MODEL,
		cachedOnly: false,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--live" || arg === "-l") {
			options.live = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--explain") {
			options.explain = true;
			continue;
		}
		if (arg === "--cached-only") {
			options.cachedOnly = true;
			continue;
		}
		if (arg === "--model" || arg === "-m") {
			const value = args[i + 1]?.trim();
			if (!value || value.startsWith("-")) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (!value || value.startsWith("-")) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			continue;
		}
		if (arg === "--max-accounts") {
			const value = args[i + 1];
			if (!value) return { ok: false, message: "Missing value for --max-accounts" };
			const parsed = parsePositiveIntegerOption(value);
			if (parsed === null) {
				return { ok: false, message: "--max-accounts must be a positive integer" };
			}
			options.maxAccounts = parsed;
			i += 1;
			continue;
		}
		if (arg.startsWith("--max-accounts=")) {
			const parsed = parsePositiveIntegerOption(arg.slice("--max-accounts=".length));
			if (parsed === null) {
				return { ok: false, message: "--max-accounts must be a positive integer" };
			}
			options.maxAccounts = parsed;
			continue;
		}
		if (arg === "--max-probes") {
			const value = args[i + 1];
			if (!value) return { ok: false, message: "Missing value for --max-probes" };
			const parsed = parsePositiveIntegerOption(value);
			if (parsed === null) {
				return { ok: false, message: "--max-probes must be a positive integer" };
			}
			options.maxProbes = parsed;
			i += 1;
			continue;
		}
		if (arg.startsWith("--max-probes=")) {
			const parsed = parsePositiveIntegerOption(arg.slice("--max-probes=".length));
			if (parsed === null) {
				return { ok: false, message: "--max-probes must be a positive integer" };
			}
			options.maxProbes = parsed;
			continue;
		}
		if (arg === "--out") {
			const value = args[i + 1];
			if (!value) return { ok: false, message: "Missing value for --out" };
			options.outPath = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--out=")) {
			const value = arg.slice("--out=".length).trim();
			if (!value) return { ok: false, message: "Missing value for --out" };
			options.outPath = value;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}

	return { ok: true, options };
}

function inspectRequestedModel(requestedModel: string): ModelInspection {
	const normalized = resolveNormalizedModel(requestedModel);
	const profile = getModelProfile(normalized);
	return {
		requested: requestedModel,
		normalized,
		remapped: requestedModel !== normalized,
		promptFamily: profile.promptFamily,
		capabilities: getModelCapabilities(normalized),
	};
}

function formatModelInspection(model: ModelInspection): string {
	const route = model.remapped
		? `${model.requested} -> ${model.normalized}`
		: model.normalized;
	return [
		route,
		`prompt family ${model.promptFamily}`,
		`tool search ${model.capabilities.toolSearch ? "yes" : "no"}`,
		`computer use ${model.capabilities.computerUse ? "yes" : "no"}`,
	].join(" | ");
}

async function defaultWriteFile(path: string, contents: string): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true });
	const tempPath = tempPathFor(path);
	let moved = false;
	try {
		await fs.writeFile(tempPath, contents, "utf-8");
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				await fs.rename(tempPath, path);
				moved = true;
				return;
			} catch (error) {
				if (!isRetryableWriteError(error) || attempt >= 4) {
					throw error;
				}
				await sleep(10 * 2 ** attempt);
			}
		}
	} finally {
		if (!moved) {
			try {
				await fs.unlink(tempPath);
			} catch {
				// Best-effort temp cleanup.
			}
		}
	}
}

export async function runReportCommand(
	args: string[],
	deps: ReportCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		printReportUsage(logInfo);
		return 0;
	}

	const parsedArgs = parseReportArgs(args);
	if (!parsedArgs.ok) {
		logError(parsedArgs.message);
		printReportUsage(logInfo);
		return 1;
	}
	const options = parsedArgs.options;
	const requestedModel = options.model?.trim() || DEFAULT_PROBE_MODEL;
	const modelInspection = inspectRequestedModel(requestedModel);

	deps.setStoragePath(null);
	const storagePath = deps.getStoragePath();
	const storage = await deps.loadAccounts();
	const storageHealth = await deps.inspectStorageHealth?.();
	const now = deps.getNow?.() ?? Date.now();
	const accountCount = storage?.accounts.length ?? 0;
	const activeIndex = storage ? deps.resolveActiveIndex(storage, "codex") : 0;
	const refreshFailures = new Map<number, TokenFailure>();
	const liveQuotaByIndex = new Map<number, CodexQuotaSnapshot>();
	const probeErrors: string[] = [];
	const quotaCache = (await deps.loadQuotaCache?.().catch(() => null)) ?? null;
	let runtimeSnapshot: RuntimeObservabilitySnapshot | null | undefined;
	let runtimeSnapshotLoadError: string | null = null;
	try {
		runtimeSnapshot = await deps.loadRuntimeObservabilitySnapshot?.();
	} catch (error) {
		runtimeSnapshot = null;
		runtimeSnapshotLoadError = error instanceof Error ? error.message : String(error);
		deps.logError?.(`Runtime observability snapshot unavailable: ${runtimeSnapshotLoadError}`);
	}
	let consideredLiveAccounts = 0;
	let executedLiveProbes = 0;

	if (storage && options.live) {
		for (let i = 0; i < storage.accounts.length; i += 1) {
			if (
				typeof options.maxAccounts === "number" &&
				consideredLiveAccounts >= options.maxAccounts
			) {
				probeErrors.push(
					`live probe account budget reached (${options.maxAccounts})`,
				);
				break;
			}
			const account = storage.accounts[i];
			if (!account || account.enabled === false) continue;
			consideredLiveAccounts += 1;

			let probeAccessToken = account.accessToken;
			let probeAccountId =
				account.accountId ?? extractAccountId(account.accessToken);
			if (!deps.hasUsableAccessToken(account, now)) {
				if (options.cachedOnly) {
					probeErrors.push(
						`${formatAccountLabel(account, i)}: skipped refresh because --cached-only is enabled`,
					);
					continue;
				}
				const refreshResult = await deps.queuedRefresh(account.refreshToken);
				if (refreshResult.type !== "success") {
					refreshFailures.set(i, {
						...refreshResult,
						message: deps.normalizeFailureDetail(
							refreshResult.message,
							refreshResult.reason,
						),
					});
					continue;
				}

				const refreshedEmail = sanitizeEmail(
					extractAccountEmail(refreshResult.access, refreshResult.idToken),
				);
				const tokenDerivedAccountId = extractAccountId(refreshResult.access);
				const refreshedAccountId = account.accountId ?? tokenDerivedAccountId;
				const previousRefreshToken = account.refreshToken;
				const previousAccessToken = account.accessToken;
				const previousExpiresAt = account.expiresAt;
				const previousEmail = account.email;
				const previousAccountId = account.accountId;
				const refreshPatch: RefreshedAccountPatch = {
					refreshToken: refreshResult.refresh,
					accessToken: refreshResult.access,
					expiresAt: refreshResult.expires,
				};
				if (refreshedEmail) {
					refreshPatch.email = refreshedEmail;
				}
				if (tokenDerivedAccountId) {
					refreshPatch.accountId = tokenDerivedAccountId;
					refreshPatch.accountIdSource = "token";
				}
				const accountMatch: AccountIdentityMatch = {
					refreshToken: previousRefreshToken,
					email: previousEmail,
					accountId: previousAccountId,
				};
				if (
					previousRefreshToken !== refreshPatch.refreshToken ||
					previousAccessToken !== refreshPatch.accessToken ||
					previousExpiresAt !== refreshPatch.expiresAt ||
					previousEmail !== account.email ||
					previousAccountId !== account.accountId
				) {
					try {
						await persistRefreshedAccountPatch(
							storage,
							accountMatch,
							refreshPatch,
							deps.loadAccounts,
							deps.saveAccounts,
						);
					} catch (error) {
						const message = deps.normalizeFailureDetail(
							error instanceof Error ? error.message : String(error),
							undefined,
						);
						probeErrors.push(`${formatAccountLabel(account, i)}: ${message}`);
						continue;
					}
					applyRefreshedAccountPatch(account, refreshPatch);
				}
				probeAccessToken = refreshResult.access;
				probeAccountId =
					refreshPatch.accountId ?? account.accountId ?? refreshedAccountId;
			}

			if (!probeAccessToken || !probeAccountId) {
				probeErrors.push(
					`${formatAccountLabel(account, i)}: missing accountId for live probe`,
				);
				continue;
			}
			if (
				typeof options.maxProbes === "number" &&
				executedLiveProbes >= options.maxProbes
			) {
				probeErrors.push(`live probe request budget reached (${options.maxProbes})`);
				break;
			}

			try {
				executedLiveProbes += 1;
				const liveQuota = await deps.fetchCodexQuotaSnapshot({
					accountId: probeAccountId,
					accessToken: probeAccessToken,
					model: modelInspection.normalized,
				});
				liveQuotaByIndex.set(i, liveQuota);
			} catch (error) {
				const message = describeCodexProbeFailure(error, (raw) =>
					deps.normalizeFailureDetail(raw, undefined),
				);
				probeErrors.push(`${formatAccountLabel(account, i)}: ${message}`);
			}
		}
	}

	const forecastResults = storage
		? evaluateForecastAccounts(
				storage.accounts.map((account, index) => ({
					index,
					account,
					isCurrent: index === activeIndex,
					now,
					refreshFailure: refreshFailures.get(index),
					liveQuota: liveQuotaByIndex.get(index),
					quotaCache,
					allAccounts: storage.accounts,
					runtimeOverlay: runtimeSnapshot,
				})),
			)
		: [];
	const forecastSummary = summarizeForecast(forecastResults);
	const recommendation = recommendForecastAccount(forecastResults);
	const enabledCount = storage
		? storage.accounts.filter((account) => account.enabled !== false).length
		: 0;
	const disabledCount = Math.max(0, accountCount - enabledCount);
	const coolingCount = storage
		? storage.accounts.filter(
				(account) =>
					typeof account.coolingDownUntil === "number" &&
					account.coolingDownUntil > now,
			).length
		: 0;
	const rateLimitedCount = storage
		? storage.accounts.filter(
				(account) => !!deps.formatRateLimitEntry(account, now, "codex"),
			).length
		: 0;

	const report = {
		command: "report",
		generatedAt: new Date(now).toISOString(),
		storagePath,
		storageHealth,
		model: requestedModel,
		modelSelection: {
			requested: modelInspection.requested,
			normalized: modelInspection.normalized,
			remapped: modelInspection.remapped,
			promptFamily: modelInspection.promptFamily,
			capabilities: modelInspection.capabilities,
		},
		liveProbe: options.live,
		liveProbeBudget: {
			cachedOnly: options.cachedOnly,
			maxAccounts: options.maxAccounts ?? null,
			maxProbes: options.maxProbes ?? null,
			consideredAccounts: consideredLiveAccounts,
			executedProbes: executedLiveProbes,
		},
		accounts: {
			total: accountCount,
			enabled: enabledCount,
			disabled: disabledCount,
			coolingDown: coolingCount,
			rateLimited: rateLimitedCount,
		},
		activeIndex: accountCount > 0 ? activeIndex + 1 : null,
		forecast: {
			summary: forecastSummary,
			recommendation: {
				...recommendation,
				selectedReason:
					recommendation.recommendedIndex !== null
						? forecastResults[recommendation.recommendedIndex]?.reasons[0] ?? recommendation.reason
						: recommendation.reason,
			},
			probeErrors,
			accounts: serializeForecastResults(
				forecastResults,
				liveQuotaByIndex,
				refreshFailures,
				formatQuotaSnapshotLine,
			),
		},
		runtimeOverlay: runtimeSnapshot !== null && runtimeSnapshot !== undefined,
		runtime: runtimeSnapshot,
		runtimeSnapshotLoadError,
	};
	if (report.forecast.recommendation.recommendedIndex !== null) {
		const selectedIndex = report.forecast.recommendation.recommendedIndex;
		const selected = report.forecast.accounts[selectedIndex];
		if (selected) {
			selected.selected = true;
		}
	}

	const cwd = deps.getCwd?.() ?? process.cwd();
	if (options.outPath) {
		const outputPath = resolve(cwd, options.outPath);
		await (deps.writeFile ?? defaultWriteFile)(
			outputPath,
			`${JSON.stringify(report, null, 2)}\n`,
		);
	}

	if (options.json) {
		logInfo(JSON.stringify(report, null, 2));
		return 0;
	}

	logInfo(`Report generated at ${report.generatedAt}`);
	logInfo(`Storage: ${report.storagePath}`);
	if (report.storageHealth) {
		logInfo(`Storage health: ${report.storageHealth.state}`);
	}
	logInfo(`Model: ${formatModelInspection(modelInspection)}`);
	if (options.live) {
		const budgetParts = [
			`considered ${consideredLiveAccounts} account(s)`,
			`executed ${executedLiveProbes} probe(s)`,
		];
		if (typeof options.maxAccounts === "number") {
			budgetParts.push(`max-accounts ${options.maxAccounts}`);
		}
		if (typeof options.maxProbes === "number") {
			budgetParts.push(`max-probes ${options.maxProbes}`);
		}
		if (options.cachedOnly) {
			budgetParts.push("cached-only");
		}
		logInfo(`Live probe budget: ${budgetParts.join(", ")}`);
	}
	logInfo(
		`Accounts: ${report.accounts.total} total (${report.accounts.enabled} enabled, ${report.accounts.disabled} disabled, ${report.accounts.coolingDown} cooling, ${report.accounts.rateLimited} rate-limited)`,
	);
	if (report.activeIndex !== null) {
		logInfo(`Active account: ${report.activeIndex}`);
	}
	logInfo(
		`Forecast: ${report.forecast.summary.ready} ready, ${report.forecast.summary.delayed} delayed, ${report.forecast.summary.unavailable} unavailable`,
	);
	if (report.forecast.recommendation.recommendedIndex !== null) {
		logInfo(
			`Recommendation: account ${report.forecast.recommendation.recommendedIndex + 1} (${report.forecast.recommendation.reason})`,
		);
	} else {
		logInfo(`Recommendation: ${report.forecast.recommendation.reason}`);
	}
	if (options.outPath) {
		logInfo(`Report written: ${resolve(cwd, options.outPath)}`);
	}
	if (report.forecast.probeErrors.length > 0) {
		logInfo(`Probe notes: ${report.forecast.probeErrors.length}`);
	}
	if (report.runtime) {
		logInfo(
			`Runtime traffic: responses=${report.runtime.responsesRequests}, refresh=${report.runtime.authRefreshRequests}, probes=${report.runtime.diagnosticProbeRequests}`,
		);
	}
	if (options.explain) {
		logInfo("");
		for (const account of report.forecast.accounts) {
			logInfo(
				`Account ${account.index + 1}: ${account.availability}, ${account.riskLevel} risk (${account.riskScore})`,
			);
			if (account.reasons.length > 0) {
				logInfo(`  Reasons: ${account.reasons.join("; ")}`);
			}
			if (account.refreshFailure?.message) {
				logInfo(`  Refresh failure: ${account.refreshFailure.message}`);
			}
			if (account.liveQuota?.summary) {
				logInfo(`  Live quota: ${account.liveQuota.summary}`);
			}
		}
	}
	return 0;
}
