import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	extractAccountId,
	formatAccountLabel,
	formatWaitTime,
} from "../accounts.js";
import { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } from "../dashboard-settings.js";
import {
	evaluateForecastAccounts,
	recommendForecastAccount,
	summarizeForecast,
	type ForecastAccountResult,
} from "../forecast.js";
import { loadQuotaCache, saveQuotaCache, type QuotaCacheData } from "../quota-cache.js";
import { fetchCodexQuotaSnapshot, formatQuotaSnapshotLine } from "../quota-probe.js";
import { queuedRefresh } from "../refresh-queue.js";
import {
	getStoragePath,
	loadAccounts,
	setStoragePath,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../storage.js";
import type { TokenFailure } from "../types.js";
import type { ModelFamily } from "../prompts/codex.js";

type PromptTone = "accent" | "success" | "warning" | "danger" | "muted";

type QuotaEmailFallbackState = {
	matchingCount: number;
	distinctAccountIds: Set<string>;
};

type QuotaCacheAccountRef = Pick<AccountMetadataV3, "accountId"> & {
	email?: string;
};

export interface ForecastCliOptions {
	live: boolean;
	json: boolean;
	model: string;
}

export interface ReportCliOptions {
	live: boolean;
	json: boolean;
	model: string;
	outPath?: string;
}

type ParsedArgsResult<T> = { ok: true; options: T } | { ok: false; message: string };

export interface ForecastReportCommandDeps {
	stylePromptText: (text: string, tone: PromptTone) => string;
	styleQuotaSummary: (summary: string) => string;
	formatResultSummary: (
		segments: ReadonlyArray<{ text: string; tone: PromptTone }>,
	) => string;
	resolveActiveIndex: (
		storage: AccountStorageV3,
		family?: ModelFamily,
	) => number;
	hasUsableAccessToken: (
		account: AccountMetadataV3,
		now: number,
	) => boolean;
	normalizeFailureDetail: (
		message: string | undefined,
		reason: string | undefined,
	) => string;
	buildQuotaEmailFallbackState: (
		accounts: readonly QuotaCacheAccountRef[],
	) => ReadonlyMap<string, QuotaEmailFallbackState>;
	updateQuotaCacheForAccount: (
		cache: QuotaCacheData,
		account: QuotaCacheAccountRef,
		snapshot: Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>,
		accounts: readonly QuotaCacheAccountRef[],
		emailFallbackState?: ReadonlyMap<string, QuotaEmailFallbackState>,
	) => boolean;
	cloneQuotaCacheData: (cache: QuotaCacheData) => QuotaCacheData;
	formatCompactQuotaSnapshot: (
		snapshot: Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>,
	) => string;
	formatRateLimitEntry: (
		account: AccountMetadataV3,
		now: number,
		family: ModelFamily,
	) => string | null;
}

export function printForecastUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth forecast [--live] [--json] [--model <model>]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend",
			"  --json, -j         Print machine-readable JSON output",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
		].join("\n"),
	);
}

export function printReportUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth report [--live] [--json] [--model <model>] [--out <path>]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend",
			"  --json, -j         Print machine-readable JSON output",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
			"  --out              Write JSON report to a file path",
		].join("\n"),
	);
}

export function parseForecastArgs(args: string[]): ParsedArgsResult<ForecastCliOptions> {
	const options: ForecastCliOptions = {
		live: false,
		json: false,
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
		if (arg === "--model" || arg === "-m") {
			const value = args[i + 1];
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}

	return { ok: true, options };
}

export function parseReportArgs(args: string[]): ParsedArgsResult<ReportCliOptions> {
	const options: ReportCliOptions = {
		live: false,
		json: false,
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
		if (arg === "--model" || arg === "-m") {
			const value = args[i + 1];
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			continue;
		}
		if (arg === "--out") {
			const value = args[i + 1];
			if (!value) {
				return { ok: false, message: "Missing value for --out" };
			}
			options.outPath = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--out=")) {
			const value = arg.slice("--out=".length).trim();
			if (!value) {
				return { ok: false, message: "Missing value for --out" };
			}
			options.outPath = value;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}

	return { ok: true, options };
}

function serializeForecastResults(
	results: ForecastAccountResult[],
	liveQuotaByIndex: Map<number, Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>>,
	refreshFailures: Map<number, TokenFailure>,
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

export async function runForecast(
	args: string[],
	deps: ForecastReportCommandDeps,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printForecastUsage();
		return 0;
	}

	const parsedArgs = parseForecastArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printForecastUsage();
		return 1;
	}
	const options = parsedArgs.options;
	const display = DEFAULT_DASHBOARD_DISPLAY_SETTINGS;
	const quotaCache = options.live ? await loadQuotaCache() : null;
	const workingQuotaCache = quotaCache ? deps.cloneQuotaCacheData(quotaCache) : null;
	let quotaCacheChanged = false;

	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		console.log("No accounts configured.");
		return 0;
	}
	const quotaEmailFallbackState =
		options.live && quotaCache
			? deps.buildQuotaEmailFallbackState(storage.accounts)
			: null;

	const now = Date.now();
	const activeIndex = deps.resolveActiveIndex(storage, "codex");
	const refreshFailures = new Map<number, TokenFailure>();
	const liveQuotaByIndex = new Map<number, Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>>();
	const probeErrors: string[] = [];

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account || !options.live) continue;
		if (account.enabled === false) continue;

		let probeAccessToken = account.accessToken;
		let probeAccountId = account.accountId ?? extractAccountId(account.accessToken);
		if (!deps.hasUsableAccessToken(account, now)) {
			const refreshResult = await queuedRefresh(account.refreshToken);
			if (refreshResult.type !== "success") {
				refreshFailures.set(i, {
					...refreshResult,
					message: deps.normalizeFailureDetail(refreshResult.message, refreshResult.reason),
				});
				continue;
			}
			probeAccessToken = refreshResult.access;
			probeAccountId = account.accountId ?? extractAccountId(refreshResult.access);
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
			if (workingQuotaCache) {
				const currentAccount = storage.accounts[i];
				if (currentAccount) {
					quotaCacheChanged =
						deps.updateQuotaCacheForAccount(
							workingQuotaCache,
							currentAccount,
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
			probeErrors.push(`${formatAccountLabel(account, i)}: ${message}`);
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
	const forecastResults = evaluateForecastAccounts(forecastInputs);
	const summary = summarizeForecast(forecastResults);
	const recommendation = recommendForecastAccount(forecastResults);

	if (options.json) {
		if (workingQuotaCache && quotaCacheChanged) {
			await saveQuotaCache(workingQuotaCache);
		}
		console.log(
			JSON.stringify(
				{
					command: "forecast",
					model: options.model,
					liveProbe: options.live,
					summary,
					recommendation,
					probeErrors,
					accounts: serializeForecastResults(forecastResults, liveQuotaByIndex, refreshFailures),
				},
				null,
				2,
			),
		);
		return 0;
	}

	console.log(
		deps.stylePromptText(
			`Best-account preview (${storage.accounts.length} account(s), model ${options.model}, live check ${options.live ? "on" : "off"})`,
			"accent",
		),
	);
	console.log(
		deps.formatResultSummary([
			{ text: `${summary.ready} ready now`, tone: "success" },
			{ text: `${summary.delayed} waiting`, tone: "warning" },
			{ text: `${summary.unavailable} unavailable`, tone: summary.unavailable > 0 ? "danger" : "muted" },
			{ text: `${summary.highRisk} high risk`, tone: summary.highRisk > 0 ? "danger" : "muted" },
		]),
	);
	console.log("");

	for (const result of forecastResults) {
		if (!display.showPerAccountRows) continue;
		const currentTag = result.isCurrent ? " [current]" : "";
		const waitLabel = result.waitMs > 0 ? deps.stylePromptText(`wait ${formatWaitTime(result.waitMs)}`, "muted") : "";
		const indexLabel = deps.stylePromptText(`${result.index + 1}.`, "accent");
		const accountLabel = deps.stylePromptText(`${result.label}${currentTag}`, "accent");
		const riskTone: PromptTone = result.riskLevel === "low" ? "success" : result.riskLevel === "medium" ? "warning" : "danger";
		const availabilityTone: PromptTone = result.availability === "ready" ? "success" : result.availability === "delayed" ? "warning" : "danger";
		const rowParts = [
			deps.stylePromptText(result.availability, availabilityTone),
			deps.stylePromptText(`${result.riskLevel} risk (${result.riskScore})`, riskTone),
		];
		if (waitLabel) rowParts.push(waitLabel);
		console.log(`${indexLabel} ${accountLabel} ${deps.stylePromptText("|", "muted")} ${rowParts.join(deps.stylePromptText(" | ", "muted"))}`);
		if (display.showForecastReasons && result.reasons.length > 0) {
			console.log(`   ${deps.stylePromptText(result.reasons.slice(0, 3).join("; "), "muted")}`);
		}
		const liveQuota = liveQuotaByIndex.get(result.index);
		if (display.showQuotaDetails && liveQuota) {
			console.log(`   ${deps.stylePromptText("quota:", "accent")} ${deps.styleQuotaSummary(deps.formatCompactQuotaSnapshot(liveQuota))}`);
		}
	}

	if (!display.showPerAccountRows) {
		console.log(deps.stylePromptText("Per-account lines are hidden in dashboard settings.", "muted"));
	}

	if (display.showRecommendations) {
		console.log("");
		if (recommendation.recommendedIndex !== null) {
			const index = recommendation.recommendedIndex;
			const account = forecastResults.find((result) => result.index === index);
			if (account) {
				console.log(
					`${deps.stylePromptText("Best next account:", "accent")} ${deps.stylePromptText(`${index + 1} (${account.label})`, "success")}`,
				);
				console.log(`${deps.stylePromptText("Why:", "accent")} ${deps.stylePromptText(recommendation.reason, "muted")}`);
				if (index !== activeIndex) {
					console.log(`${deps.stylePromptText("Switch now with:", "accent")} codex auth switch ${index + 1}`);
				}
			}
		} else {
			console.log(`${deps.stylePromptText("Note:", "accent")} ${deps.stylePromptText(recommendation.reason, "muted")}`);
		}
	}

	if (display.showLiveProbeNotes && probeErrors.length > 0) {
		console.log("");
		console.log(deps.stylePromptText(`Live check notes (${probeErrors.length}):`, "warning"));
		for (const error of probeErrors) {
			console.log(`  ${deps.stylePromptText("-", "warning")} ${deps.stylePromptText(error, "muted")}`);
		}
	}

	if (workingQuotaCache && quotaCacheChanged) {
		await saveQuotaCache(workingQuotaCache);
	}

	return 0;
}

export async function runReport(
	args: string[],
	deps: ForecastReportCommandDeps,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printReportUsage();
		return 0;
	}

	const parsedArgs = parseReportArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printReportUsage();
		return 1;
	}
	const options = parsedArgs.options;

	setStoragePath(null);
	const storagePath = getStoragePath();
	const storage = await loadAccounts();
	const now = Date.now();
	const accountCount = storage?.accounts.length ?? 0;
	const activeIndex = storage ? deps.resolveActiveIndex(storage, "codex") : 0;
	const refreshFailures = new Map<number, TokenFailure>();
	const liveQuotaByIndex = new Map<number, Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>>();
	const probeErrors: string[] = [];

	if (storage && options.live) {
		for (let i = 0; i < storage.accounts.length; i += 1) {
			const account = storage.accounts[i];
			if (!account || account.enabled === false) continue;

			const refreshResult = await queuedRefresh(account.refreshToken);
			if (refreshResult.type !== "success") {
				refreshFailures.set(i, {
					...refreshResult,
					message: deps.normalizeFailureDetail(refreshResult.message, refreshResult.reason),
				});
				continue;
			}

			const accountId = account.accountId ?? extractAccountId(refreshResult.access);
			if (!accountId) {
				probeErrors.push(`${formatAccountLabel(account, i)}: missing accountId for live probe`);
				continue;
			}

			try {
				const liveQuota = await fetchCodexQuotaSnapshot({
					accountId,
					accessToken: refreshResult.access,
					model: options.model,
				});
				liveQuotaByIndex.set(i, liveQuota);
			} catch (error) {
				const message = deps.normalizeFailureDetail(
					error instanceof Error ? error.message : String(error),
					undefined,
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
					typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now,
			).length
		: 0;
	const rateLimitedCount = storage
		? storage.accounts.filter((account) => !!deps.formatRateLimitEntry(account, now, "codex")).length
		: 0;

	const report = {
		command: "report",
		generatedAt: new Date(now).toISOString(),
		storagePath,
		model: options.model,
		liveProbe: options.live,
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
			recommendation,
			probeErrors,
			accounts: serializeForecastResults(forecastResults, liveQuotaByIndex, refreshFailures),
		},
	};

	if (options.outPath) {
		const outputPath = resolve(process.cwd(), options.outPath);
		await fs.mkdir(dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
	}

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
		return 0;
	}

	console.log(`Report generated at ${report.generatedAt}`);
	console.log(`Storage: ${report.storagePath}`);
	console.log(
		`Accounts: ${report.accounts.total} total (${report.accounts.enabled} enabled, ${report.accounts.disabled} disabled, ${report.accounts.coolingDown} cooling, ${report.accounts.rateLimited} rate-limited)`,
	);
	if (report.activeIndex !== null) {
		console.log(`Active account: ${report.activeIndex}`);
	}
	console.log(
		`Forecast: ${report.forecast.summary.ready} ready, ${report.forecast.summary.delayed} delayed, ${report.forecast.summary.unavailable} unavailable`,
	);
	if (report.forecast.recommendation.recommendedIndex !== null) {
		console.log(
			`Recommendation: account ${report.forecast.recommendation.recommendedIndex + 1} (${report.forecast.recommendation.reason})`,
		);
	} else {
		console.log(`Recommendation: ${report.forecast.recommendation.reason}`);
	}
	if (options.outPath) {
		console.log(`Report written: ${resolve(process.cwd(), options.outPath)}`);
	}
	if (report.forecast.probeErrors.length > 0) {
		console.log(`Probe notes: ${report.forecast.probeErrors.length}`);
	}

	return 0;
}
