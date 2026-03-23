import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { extractAccountId, formatAccountLabel } from "../../accounts.js";
import {
	evaluateForecastAccounts,
	type ForecastAccountResult,
	recommendForecastAccount,
	summarizeForecast,
} from "../../forecast.js";
import {
	type CodexQuotaSnapshot,
	formatQuotaSnapshotLine,
} from "../../quota-probe.js";
import { type ModelFamily } from "../../prompts/codex.js";
import {
	getModelCapabilities,
	getModelProfile,
	resolveNormalizedModel,
} from "../../request/helpers/model-map.js";
import type { AccountStorageV3 } from "../../storage.js";
import type { TokenFailure, TokenResult } from "../../types.js";
import { sleep } from "../../utils.js";

interface ReportCliOptions {
	live: boolean;
	json: boolean;
	explain: boolean;
	model: string;
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

const RETRYABLE_WRITE_CODES = new Set(["EBUSY", "EPERM"]);

export interface ReportCommandDeps {
	setStoragePath: (path: string | null) => void;
	getStoragePath: () => string;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	resolveActiveIndex: (storage: AccountStorageV3, family?: "codex") => number;
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
	normalizeFailureDetail: (
		message: string | undefined,
		reason: string | undefined,
	) => string;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
	getCwd?: () => string;
	writeFile?: (path: string, contents: string) => Promise<void>;
}

function isRetryableWriteError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_WRITE_CODES.has(code);
}

function printReportUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage: codex auth report [--live] [--json] [--explain] [--model MODEL] [--out PATH]",
			"",
			"Options:",
			"  --live, -l         Probe live quota headers via Codex backend",
			"  --json, -j         Print machine-readable JSON output",
			"  --explain          Print per-account reasoning in text mode",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
			"  --out              Write JSON report to a file path",
		].join("\n"),
	);
}

function parseReportArgs(args: string[]): ParsedArgsResult<ReportCliOptions> {
	const options: ReportCliOptions = {
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

function serializeForecastResults(
	results: ForecastAccountResult[],
	liveQuotaByIndex: Map<number, CodexQuotaSnapshot>,
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
	const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
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
	const requestedModel = options.model?.trim() || "gpt-5-codex";
	const modelInspection = inspectRequestedModel(requestedModel);

	deps.setStoragePath(null);
	const storagePath = deps.getStoragePath();
	const storage = await deps.loadAccounts();
	const now = deps.getNow?.() ?? Date.now();
	const accountCount = storage?.accounts.length ?? 0;
	const activeIndex = storage ? deps.resolveActiveIndex(storage, "codex") : 0;
	const refreshFailures = new Map<number, TokenFailure>();
	const liveQuotaByIndex = new Map<number, CodexQuotaSnapshot>();
	const probeErrors: string[] = [];

	if (storage && options.live) {
		for (let i = 0; i < storage.accounts.length; i += 1) {
			const account = storage.accounts[i];
			if (!account || account.enabled === false) continue;

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

			const accountId =
				account.accountId ?? extractAccountId(refreshResult.access);
			if (!accountId) {
				probeErrors.push(
					`${formatAccountLabel(account, i)}: missing accountId for live probe`,
				);
				continue;
			}

			try {
				const liveQuota = await deps.fetchCodexQuotaSnapshot({
					accountId,
					accessToken: refreshResult.access,
					model: modelInspection.normalized,
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
		model: requestedModel,
		modelSelection: {
			requested: modelInspection.requested,
			normalized: modelInspection.normalized,
			remapped: modelInspection.remapped,
			promptFamily: modelInspection.promptFamily,
			capabilities: modelInspection.capabilities,
		},
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
			accounts: serializeForecastResults(
				forecastResults,
				liveQuotaByIndex,
				refreshFailures,
			),
		},
	};

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
	logInfo(`Model: ${formatModelInspection(modelInspection)}`);
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
