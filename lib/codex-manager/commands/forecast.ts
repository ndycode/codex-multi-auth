import type { DashboardDisplaySettings } from "../../dashboard-settings.js";
import {
	buildForecastExplanation,
	type ForecastAccountResult,
} from "../../forecast.js";
import type { QuotaCacheData } from "../../quota-cache.js";
import type { CodexQuotaSnapshot } from "../../quota-probe.js";
import { resolveNormalizedModel } from "../../request/helpers/model-map.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../../storage.js";
import type { TokenFailure, TokenResult } from "../../types.js";

interface ForecastCliOptions {
	live: boolean;
	json: boolean;
	explain: boolean;
	model: string;
}

type ParsedArgsResult<T> =
	| { ok: true; options: T }
	| { ok: false; message: string };

type PromptTone = "accent" | "success" | "warning" | "danger" | "muted";
type QuotaEmailFallbackState = ReadonlyMap<
	string,
	{ matchingCount: number; distinctAccountIds: Set<string> }
>;

export interface ForecastCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	loadDashboardDisplaySettings?: () => Promise<DashboardDisplaySettings>;
	resolveActiveIndex: (storage: AccountStorageV3, family?: "codex") => number;
	loadQuotaCache: () => Promise<QuotaCacheData | null>;
	saveQuotaCache: (cache: QuotaCacheData) => Promise<void>;
	cloneQuotaCacheData: (cache: QuotaCacheData) => QuotaCacheData;
	buildQuotaEmailFallbackState: (
		accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	) => QuotaEmailFallbackState;
	updateQuotaCacheForAccount: (
		cache: QuotaCacheData,
		account: Pick<AccountMetadataV3, "accountId" | "email">,
		snapshot: CodexQuotaSnapshot,
		accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
		emailFallbackState?: QuotaEmailFallbackState,
	) => boolean;
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
	normalizeFailureDetail: (
		message: string | undefined,
		reason: string | undefined,
	) => string;
	formatAccountLabel: (
		account: Pick<AccountMetadataV3, "email" | "accountLabel" | "accountId">,
		index: number,
	) => string;
	extractAccountId: (accessToken: string | undefined) => string | undefined;
	evaluateForecastAccounts: (
		inputs: Array<{
			index: number;
			account: AccountMetadataV3;
			isCurrent: boolean;
			now: number;
			refreshFailure?: TokenFailure;
			liveQuota?: CodexQuotaSnapshot;
		}>,
	) => ForecastAccountResult[];
	summarizeForecast: (results: ForecastAccountResult[]) => {
		total: number;
		ready: number;
		delayed: number;
		unavailable: number;
		highRisk: number;
	};
	recommendForecastAccount: (results: ForecastAccountResult[]) => {
		recommendedIndex: number | null;
		reason: string;
	};
	stylePromptText: (text: string, tone: PromptTone) => string;
	formatResultSummary: (
		segments: ReadonlyArray<{ text: string; tone: PromptTone }>,
	) => string;
	styleQuotaSummary: (summary: string) => string;
	formatCompactQuotaSnapshot: (snapshot: CodexQuotaSnapshot) => string;
	availabilityTone: (
		availability: ForecastAccountResult["availability"],
	) => "success" | "warning" | "danger";
	riskTone: (
		level: ForecastAccountResult["riskLevel"],
	) => "success" | "warning" | "danger";
	formatWaitTime: (ms: number) => string;
	defaultDisplay: DashboardDisplaySettings;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

function printForecastUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex auth forecast [--live] [--json] [--explain] [--model <model>]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend",
			"  --json, -j         Print machine-readable JSON output",
			"  --explain          Include structured recommendation reasoning",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
		].join("\n"),
	);
}

function parseForecastArgs(
	args: string[],
): ParsedArgsResult<ForecastCliOptions> {
	const options: ForecastCliOptions = {
		live: false,
		json: false,
		explain: false,
		model: "gpt-5-codex",
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
		if (arg === "--model" || arg === "-m") {
			const value = args[i + 1];
			if (!value) return { ok: false, message: "Missing value for --model" };
			options.model = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (!value) return { ok: false, message: "Missing value for --model" };
			options.model = value;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}

	return { ok: true, options };
}

function serializeForecastResults(
	results: ForecastAccountResult[],
	liveQuotaByIndex: Map<number, CodexQuotaSnapshot>,
	refreshFailures: Map<number, TokenFailure>,
	formatQuotaSnapshotLine: (snapshot: CodexQuotaSnapshot) => string,
): Array<{
	index: number;
	label: string;
	isCurrent: boolean;
	availability: ForecastAccountResult["availability"];
	riskScore: number;
	riskLevel: ForecastAccountResult["riskLevel"];
	waitMs: number;
	reasons: string[];
	liveQuota?: {
		status: number;
		planType?: string;
		activeLimit?: number;
		model: string;
		summary: string;
	};
	refreshFailure?: TokenFailure;
}> {
	return results.map((result) => {
		const liveQuota = liveQuotaByIndex.get(result.index);
		return {
			index: result.index,
			label: result.label,
			isCurrent: result.isCurrent,
			availability: result.availability,
			riskScore: result.riskScore,
			riskLevel: result.riskLevel,
			waitMs: result.waitMs,
			reasons: result.reasons,
			liveQuota: liveQuota
				? {
						status: liveQuota.status,
						planType: liveQuota.planType,
						activeLimit: liveQuota.activeLimit,
						model: liveQuota.model,
						summary: formatQuotaSnapshotLine(liveQuota),
					}
				: undefined,
			refreshFailure: refreshFailures.get(result.index),
		};
	});
}

export async function runForecastCommand(
	args: string[],
	deps: ForecastCommandDeps & {
		formatQuotaSnapshotLine: (snapshot: CodexQuotaSnapshot) => string;
	},
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		printForecastUsage(logInfo);
		return 0;
	}

	const parsedArgs = parseForecastArgs(args);
	if (!parsedArgs.ok) {
		logError(parsedArgs.message);
		printForecastUsage(logInfo);
		return 1;
	}
	const options = parsedArgs.options;
	const requestedModel = options.model?.trim() || "gpt-5-codex";
	const probeModel = resolveNormalizedModel(requestedModel);
	const display = deps.loadDashboardDisplaySettings
		? (await deps.loadDashboardDisplaySettings().catch(() => null)) ??
			deps.defaultDisplay
		: deps.defaultDisplay;
	const quotaCache = options.live ? await deps.loadQuotaCache() : null;
	const workingQuotaCache = quotaCache
		? deps.cloneQuotaCacheData(quotaCache)
		: null;
	let quotaCacheChanged = false;

	deps.setStoragePath(null);
	const storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		logInfo("No accounts configured.");
		return 0;
	}
	const quotaEmailFallbackState =
		options.live && quotaCache
			? deps.buildQuotaEmailFallbackState(storage.accounts)
			: null;

	const now = deps.getNow?.() ?? Date.now();
	const activeIndex = deps.resolveActiveIndex(storage, "codex");
	const refreshFailures = new Map<number, TokenFailure>();
	const liveQuotaByIndex = new Map<number, CodexQuotaSnapshot>();
	const probeErrors: string[] = [];

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account || !options.live) continue;
		if (account.enabled === false) continue;

		let probeAccessToken = account.accessToken;
		let probeAccountId =
			account.accountId ?? deps.extractAccountId(account.accessToken);
		if (!deps.hasUsableAccessToken(account, now)) {
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
			probeAccessToken = refreshResult.access;
			probeAccountId =
				account.accountId ?? deps.extractAccountId(refreshResult.access);
		}

		if (!probeAccessToken || !probeAccountId) {
			probeErrors.push(
				`${deps.formatAccountLabel(account, i)}: missing accountId for live probe`,
			);
			continue;
		}

		try {
			const liveQuota = await deps.fetchCodexQuotaSnapshot({
				accountId: probeAccountId,
				accessToken: probeAccessToken,
				model: probeModel,
			});
			liveQuotaByIndex.set(i, liveQuota);
			if (workingQuotaCache) {
				const nextAccount = storage.accounts[i];
				if (nextAccount) {
					quotaCacheChanged =
						deps.updateQuotaCacheForAccount(
							workingQuotaCache,
							nextAccount,
							liveQuota,
							storage.accounts,
							quotaEmailFallbackState ?? undefined,
						) || quotaCacheChanged;
				}
			}
		} catch (error) {
			const message = deps.normalizeFailureDetail(
				error instanceof Error ? error.message : String(error),
				undefined,
			);
			probeErrors.push(`${deps.formatAccountLabel(account, i)}: ${message}`);
		}
	}

	const forecastInputs = storage.accounts.map((account, index) => ({
		index,
		account,
		isCurrent: index === activeIndex,
		now,
		refreshFailure: refreshFailures.get(index),
		liveQuota: liveQuotaByIndex.get(index),
	}));
	const forecastResults = deps.evaluateForecastAccounts(forecastInputs);
	const summary = deps.summarizeForecast(forecastResults);
	const recommendation = deps.recommendForecastAccount(forecastResults);
	const explanation = buildForecastExplanation(
		forecastResults,
		recommendation,
	);

	if (options.json) {
		if (workingQuotaCache && quotaCacheChanged) {
			await deps.saveQuotaCache(workingQuotaCache);
		}
		logInfo(
			JSON.stringify(
				{
					command: "forecast",
					model: requestedModel,
					liveProbe: options.live,
					summary,
					recommendation,
					explanation: options.explain ? explanation : undefined,
					probeErrors,
					accounts: serializeForecastResults(
						forecastResults,
						liveQuotaByIndex,
						refreshFailures,
						deps.formatQuotaSnapshotLine,
					),
				},
				null,
				2,
			),
		);
		return 0;
	}

	logInfo(
		deps.stylePromptText(
			`Best-account preview (${storage.accounts.length} account(s), model ${requestedModel}, live check ${options.live ? "on" : "off"})`,
			"accent",
		),
	);
	logInfo(
		deps.formatResultSummary([
			{ text: `${summary.ready} ready now`, tone: "success" },
			{ text: `${summary.delayed} waiting`, tone: "warning" },
			{
				text: `${summary.unavailable} unavailable`,
				tone: summary.unavailable > 0 ? "danger" : "muted",
			},
			{
				text: `${summary.highRisk} high risk`,
				tone: summary.highRisk > 0 ? "danger" : "muted",
			},
		]),
	);
	logInfo("");

	for (const result of forecastResults) {
		if (!display.showPerAccountRows) continue;
		const currentTag = result.isCurrent ? " [current]" : "";
		const waitLabel =
			result.waitMs > 0
				? deps.stylePromptText(
						`wait ${deps.formatWaitTime(result.waitMs)}`,
						"muted",
					)
				: "";
		const indexLabel = deps.stylePromptText(`${result.index + 1}.`, "accent");
		const accountLabel = deps.stylePromptText(
			`${result.label}${currentTag}`,
			"accent",
		);
		const riskLabel = deps.stylePromptText(
			`${result.riskLevel} risk (${result.riskScore})`,
			deps.riskTone(result.riskLevel),
		);
		const availabilityLabel = deps.stylePromptText(
			result.availability,
			deps.availabilityTone(result.availability),
		);
		const rowParts = [availabilityLabel, riskLabel];
		if (waitLabel) rowParts.push(waitLabel);
		logInfo(
			`${indexLabel} ${accountLabel} ${deps.stylePromptText("|", "muted")} ${rowParts.join(deps.stylePromptText(" | ", "muted"))}`,
		);
		if (display.showForecastReasons && result.reasons.length > 0) {
			logInfo(
				`   ${deps.stylePromptText(result.reasons.slice(0, 3).join("; "), "muted")}`,
			);
		}
		const liveQuota = liveQuotaByIndex.get(result.index);
		if (display.showQuotaDetails && liveQuota) {
			logInfo(
				`   ${deps.stylePromptText("quota:", "accent")} ${deps.styleQuotaSummary(deps.formatCompactQuotaSnapshot(liveQuota))}`,
			);
		}
	}

	if (!display.showPerAccountRows) {
		logInfo(
			deps.stylePromptText(
				"Per-account lines are hidden in dashboard settings.",
				"muted",
			),
		);
	}

	if (display.showRecommendations || options.explain) {
		logInfo("");
	}

	if (display.showRecommendations) {
		if (recommendation.recommendedIndex !== null) {
			const index = recommendation.recommendedIndex;
			const account = forecastResults.find((result) => result.index === index);
			if (account) {
				logInfo(
					`${deps.stylePromptText("Best next account:", "accent")} ${deps.stylePromptText(`${index + 1} (${account.label})`, "success")}`,
				);
				logInfo(
					`${deps.stylePromptText("Why:", "accent")} ${deps.stylePromptText(recommendation.reason, "muted")}`,
				);
				if (index !== activeIndex) {
					logInfo(
						`${deps.stylePromptText("Switch now with:", "accent")} codex auth switch ${index + 1}`,
					);
				}
			}
		} else {
			logInfo(
				`${deps.stylePromptText("Note:", "accent")} ${deps.stylePromptText(recommendation.reason, "muted")}`,
			);
		}
	}

	if (options.explain) {
		logInfo(
			`${deps.stylePromptText("Explain:", "accent")} ${deps.stylePromptText(explanation.recommendationReason, "muted")}`,
		);
		for (const item of explanation.considered) {
			const selectedLabel = item.selected ? " selected" : "";
			const waitLabel =
				item.waitMs > 0 ? `, wait ${deps.formatWaitTime(item.waitMs)}` : "";
			logInfo(
				`  ${deps.stylePromptText(item.selected ? "*" : "-", item.selected ? "success" : "muted")} ${deps.stylePromptText(
					`${item.index + 1}. ${item.label}${item.isCurrent ? " [current]" : ""}: ${item.availability}, ${item.riskLevel} risk (${item.riskScore})${waitLabel}${selectedLabel}`,
					item.selected ? "success" : "muted",
				)}`,
			);
			if (item.reasons.length > 0) {
				logInfo(
					`    ${deps.stylePromptText(item.reasons.slice(0, 3).join("; "), "muted")}`,
				);
			}
		}
	}

	if (display.showLiveProbeNotes && probeErrors.length > 0) {
		logInfo("");
		logInfo(
			deps.stylePromptText(
				`Live check notes (${probeErrors.length}):`,
				"warning",
			),
		);
		for (const error of probeErrors) {
			logInfo(
				`  ${deps.stylePromptText("-", "warning")} ${deps.stylePromptText(error, "muted")}`,
			);
		}
	}
	if (workingQuotaCache && quotaCacheChanged) {
		await deps.saveQuotaCache(workingQuotaCache);
	}

	return 0;
}
