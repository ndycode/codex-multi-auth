import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { sleep } from "../../utils.js";
import {
	readUsageLedgerRows,
	rotateUsageLedger,
	summarizeUsageLedger,
	type UsageLedgerRow,
	type UsageSummary,
	type UsageSummaryBucket,
	type UsageSummaryGroupBy,
} from "../../usage/index.js";

interface UsageCliOptions {
	since?: number | Date | string;
	by: UsageSummaryGroupBy;
	json: boolean;
	csv: boolean;
	outPath?: string;
}

interface UsageRotateOptions {
	json: boolean;
	ifLargerThanBytes?: number;
}

type ParsedArgsResult<T> =
	| { ok: true; options: T }
	| { ok: false; message: string };

export interface UsageCommandDeps {
	summarizeUsage?: typeof summarizeUsageLedger;
	readRows?: typeof readUsageLedgerRows;
	rotateLedger?: typeof rotateUsageLedger;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getCwd?: () => string;
	writeFile?: (path: string, contents: string) => Promise<void>;
}

const VALID_GROUPS = new Set<UsageSummaryGroupBy>([
	"model",
	"account",
	"project",
	"outcome",
	"day",
]);
const RETRYABLE_WRITE_CODES = new Set(["EBUSY", "EPERM"]);

function parsePositiveInteger(rawValue: string): number | null {
	if (!/^\d+$/.test(rawValue.trim())) return null;
	const parsed = Number.parseInt(rawValue, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseSinceValue(value: string): number | string {
	const trimmed = value.trim();
	const relative = /^(\d+)(m|h|d|w)$/i.exec(trimmed);
	if (relative?.[1] && relative[2]) {
		const amount = Number.parseInt(relative[1], 10);
		const unit = relative[2].toLowerCase();
		const multiplier =
			unit === "m"
				? 60_000
				: unit === "h"
					? 3_600_000
					: unit === "d"
						? 86_400_000
						: 604_800_000;
		return Date.now() - amount * multiplier;
	}
	if (/^\d+$/.test(trimmed)) {
		return Number.parseInt(trimmed, 10);
	}
	return trimmed;
}

function printUsageCommandHelp(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex auth usage [--since <time|duration>] [--by <model|account|project|outcome|day>] [--json|--csv] [--out <path>]",
			"  codex auth usage rotate [--if-larger-than-bytes <bytes>] [--json]",
			"",
			"Options:",
			"  --since            Filter rows by timestamp, ISO date, or relative duration like 24h, 7d, 2w",
			"  --by               Group summary output (default: model)",
			"  --json, -j         Print machine-readable JSON output",
			"  --csv              Print or write CSV bucket output",
			"  --out              Write output to a file path",
			"",
			"Notes:",
			"  - Usage rows contain local metadata only, not prompts, tokens, auth headers, raw emails, or raw account ids.",
		].join("\n"),
	);
}

function parseUsageArgs(args: string[]): ParsedArgsResult<UsageCliOptions> {
	const options: UsageCliOptions = {
		by: "model",
		json: false,
		csv: false,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--csv") {
			options.csv = true;
			continue;
		}
		if (arg === "--since") {
			const value = args[i + 1];
			if (!value) return { ok: false, message: "Missing value for --since" };
			options.since = parseSinceValue(value);
			i += 1;
			continue;
		}
		if (arg.startsWith("--since=")) {
			const value = arg.slice("--since=".length).trim();
			if (!value) return { ok: false, message: "Missing value for --since" };
			options.since = parseSinceValue(value);
			continue;
		}
		if (arg === "--by") {
			const value = args[i + 1];
			if (!value) return { ok: false, message: "Missing value for --by" };
			if (!VALID_GROUPS.has(value as UsageSummaryGroupBy)) {
				return { ok: false, message: `Unknown --by value: ${value}` };
			}
			options.by = value as UsageSummaryGroupBy;
			i += 1;
			continue;
		}
		if (arg.startsWith("--by=")) {
			const value = arg.slice("--by=".length).trim();
			if (!VALID_GROUPS.has(value as UsageSummaryGroupBy)) {
				return { ok: false, message: `Unknown --by value: ${value}` };
			}
			options.by = value as UsageSummaryGroupBy;
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
		return { ok: false, message: `Unknown usage option: ${arg}` };
	}

	if (options.json && options.csv) {
		return { ok: false, message: "Cannot combine --json and --csv" };
	}
	return { ok: true, options };
}

function parseRotateArgs(args: string[]): ParsedArgsResult<UsageRotateOptions> {
	const options: UsageRotateOptions = { json: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--if-larger-than-bytes") {
			const value = args[i + 1];
			if (!value) {
				return {
					ok: false,
					message: "Missing value for --if-larger-than-bytes",
				};
			}
			const parsed = parsePositiveInteger(value);
			if (parsed === null) {
				return {
					ok: false,
					message: "--if-larger-than-bytes must be a positive integer",
				};
			}
			options.ifLargerThanBytes = parsed;
			i += 1;
			continue;
		}
		if (arg.startsWith("--if-larger-than-bytes=")) {
			const parsed = parsePositiveInteger(
				arg.slice("--if-larger-than-bytes=".length),
			);
			if (parsed === null) {
				return {
					ok: false,
					message: "--if-larger-than-bytes must be a positive integer",
				};
			}
			options.ifLargerThanBytes = parsed;
			continue;
		}
		return { ok: false, message: `Unknown usage rotate option: ${arg}` };
	}
	return { ok: true, options };
}

function formatCurrency(value: number): string {
	return `$${value.toFixed(6)}`;
}

function formatTextSummary(summary: UsageSummary): string {
	const lines = [
		`Usage summary by ${summary.by}`,
		`Requests: ${summary.totals.requests} (${summary.totals.successes} success, ${summary.totals.failures} failed, ${summary.totals.blocked} blocked, ${summary.totals.cancelled} cancelled)`,
		`Tokens: ${summary.totals.totalTokens} total (${summary.totals.inputTokens} input, ${summary.totals.outputTokens} output, ${summary.totals.cachedInputTokens} cached, ${summary.totals.reasoningTokens} reasoning)`,
		`Estimated cost: ${formatCurrency(summary.totals.costUsd)}`,
	];
	if (summary.buckets.length === 0) {
		lines.push("No usage rows found.");
		return lines.join("\n");
	}
	lines.push("");
	for (const bucket of summary.buckets) {
		lines.push(
			`${bucket.key}: ${bucket.requests} request(s), ${bucket.totalTokens} token(s), ${formatCurrency(bucket.costUsd)}`,
		);
	}
	return lines.join("\n");
}

function csvEscape(value: string | number): string {
	const text = String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function bucketToCsvRow(bucket: UsageSummaryBucket): string {
	return [
		bucket.key,
		bucket.requests,
		bucket.successes,
		bucket.failures,
		bucket.blocked,
		bucket.cancelled,
		bucket.inputTokens,
		bucket.outputTokens,
		bucket.cachedInputTokens,
		bucket.reasoningTokens,
		bucket.totalTokens,
		bucket.costUsd.toFixed(8),
	]
		.map(csvEscape)
		.join(",");
}

function formatCsvSummary(summary: UsageSummary): string {
	return [
		"key,requests,successes,failures,blocked,cancelled,inputTokens,outputTokens,cachedInputTokens,reasoningTokens,totalTokens,costUsd",
		...summary.buckets.map(bucketToCsvRow),
		...(summary.buckets.length === 0 ? [bucketToCsvRow(summary.totals)] : []),
	].join("\n");
}

function rowsToJsonPayload(summary: UsageSummary, rows: UsageLedgerRow[]): string {
	return JSON.stringify(
		{
			command: "usage",
			summary,
			rows,
		},
		null,
		2,
	);
}

function isRetryableWriteError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_WRITE_CODES.has(code);
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
				if (!isRetryableWriteError(error) || attempt >= 4) throw error;
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

export async function runUsageCommand(
	args: string[],
	deps: UsageCommandDeps = {},
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		printUsageCommandHelp(logInfo);
		return 0;
	}

	const [subcommand, ...rest] = args;
	if (subcommand === "rotate") {
		const parsed = parseRotateArgs(rest);
		if (!parsed.ok) {
			logError(parsed.message);
			return 1;
		}
		const rotatedPath = await (deps.rotateLedger ?? rotateUsageLedger)({
			ifLargerThanBytes: parsed.options.ifLargerThanBytes,
		});
		if (parsed.options.json) {
			logInfo(
				JSON.stringify({
					command: "usage rotate",
					rotated: rotatedPath !== null,
					path: rotatedPath,
				}),
			);
		} else {
			logInfo(
				rotatedPath
					? `Usage ledger rotated: ${rotatedPath}`
					: "Usage ledger rotation skipped.",
			);
		}
		return 0;
	}

	const parsed = parseUsageArgs(args);
	if (!parsed.ok) {
		logError(parsed.message);
		printUsageCommandHelp(logInfo);
		return 1;
	}
	const options = parsed.options;
	const query = { since: options.since, by: options.by };
	const [summary, rows] = await Promise.all([
		(deps.summarizeUsage ?? summarizeUsageLedger)(query),
		(deps.readRows ?? readUsageLedgerRows)(query),
	]);
	const rendered = options.json
		? rowsToJsonPayload(summary, rows)
		: options.csv
			? formatCsvSummary(summary)
			: formatTextSummary(summary);

	if (options.outPath) {
		const outputPath = resolve(deps.getCwd?.() ?? process.cwd(), options.outPath);
		await (deps.writeFile ?? defaultWriteFile)(outputPath, `${rendered}\n`);
		if (!options.json && !options.csv) {
			logInfo(`Usage report written: ${outputPath}`);
		}
		return 0;
	}

	logInfo(rendered);
	return 0;
}

