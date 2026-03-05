#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_CHECK_SCRIPT = "scripts/enterprise-health-check.js";
const HEALTH_CHECK_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

function parseArgValue(name) {
	const prefix = `${name}=`;
	const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
	return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name) {
	return process.argv.slice(2).includes(name);
}

function resolveRoot() {
	const override = (process.env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (override.length > 0) return override;
	return join(homedir(), ".codex", "multi-auth");
}

async function loadAuditEntries(logDir, cutoffMs) {
	if (!existsSync(logDir)) return [];
	const entries = await readdir(logDir, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.startsWith("audit") && entry.name.endsWith(".log"))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

	const output = [];
	for (const file of files) {
		const fullPath = join(logDir, file);
		const raw = await readFile(fullPath, "utf8");
		for (const line of raw.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line);
				if (!parsed || typeof parsed !== "object") continue;
				const timestamp = Date.parse(parsed.timestamp);
				if (Number.isFinite(timestamp) && timestamp >= cutoffMs) {
					output.push(parsed);
				}
			} catch {
				// Ignore malformed audit lines.
			}
		}
	}
	return output;
}

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function resolveHealthCheckScriptPath() {
	const override = parseArgValue("--health-script") ?? process.env.CODEX_SLO_HEALTH_CHECK_SCRIPT;
	return override && override.trim().length > 0 ? override.trim() : DEFAULT_HEALTH_CHECK_SCRIPT;
}

export function runHealthCheck() {
	const timeoutMs = parsePositiveInt(process.env.CODEX_HEALTH_CHECK_TIMEOUT_MS, DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
	const healthCheckScript = resolveHealthCheckScriptPath();
	try {
		const nodeCmd = process.execPath;
		const raw = execFileSync(nodeCmd, [healthCheckScript], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			cwd: process.cwd(),
			timeout: timeoutMs,
			killSignal: "SIGTERM",
			maxBuffer: HEALTH_CHECK_MAX_BUFFER_BYTES,
		});
		return JSON.parse(raw);
	} catch (error) {
		const out = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
		const fallbackMessage = error instanceof Error ? error.message : String(error);
		return {
			status: "fail",
			checks: [],
			findings: [
				{
					code: "health-check-exec-failed",
					message: (out.length > 0 ? out : fallbackMessage).slice(0, 500),
				},
			],
		};
	}
}

function pct(value) {
	if (!Number.isFinite(value)) return null;
	return Number(value.toFixed(3));
}

async function main() {
	const policyPath = resolve(parseArgValue("--policy") ?? "config/slo-policy.json");
	const outputPath = parseArgValue("--output");
	const enforce = hasFlag("--enforce");
	const root = resolveRoot();
	const logDir = resolve(parseArgValue("--log-dir") ?? join(root, "logs"));
	const policy = JSON.parse(await readFile(policyPath, "utf8"));
	const windowDays = typeof policy.windowDays === "number" ? policy.windowDays : 30;
	const objectives = policy.objectives ?? {};
	const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
	const entries = await loadAuditEntries(logDir, cutoffMs);
	const health = runHealthCheck();

	let requestSuccess = 0;
	let requestFailure = 0;
	for (const entry of entries) {
		if (entry.action === "request.success") requestSuccess += 1;
		if (entry.action === "request.failure") requestFailure += 1;
	}
	const requestTotal = requestSuccess + requestFailure;
	const requestSuccessRate = requestTotal > 0 ? (requestSuccess * 100) / requestTotal : null;

	const staleWalFindings = Array.isArray(health.findings)
		? health.findings.filter(
				(finding) =>
					finding &&
					(finding.code === "stale-wal" || finding.code === "stale-audit-log"),
			).length
		: 0;
	const healthCheckPass = health.status === "pass";

	const evaluations = [
		{
			id: "request-success-rate",
			target: objectives.requestSuccessRatePercent ?? null,
			actual: requestSuccessRate,
			status:
				requestSuccessRate === null || typeof objectives.requestSuccessRatePercent !== "number"
					? "insufficient_data"
					: requestSuccessRate >= objectives.requestSuccessRatePercent
						? "pass"
						: "fail",
		},
		{
			id: "health-check-pass",
			target: objectives.healthCheckPassRequired === true ? true : null,
			actual: healthCheckPass,
			status:
				objectives.healthCheckPassRequired === true
					? healthCheckPass
						? "pass"
						: "fail"
					: "insufficient_data",
		},
		{
			id: "stale-wal-findings",
			target: typeof objectives.staleWalFindingsMax === "number" ? objectives.staleWalFindingsMax : null,
			actual: staleWalFindings,
			status:
				typeof objectives.staleWalFindingsMax !== "number"
					? "insufficient_data"
					: staleWalFindings <= objectives.staleWalFindingsMax
						? "pass"
						: "fail",
		},
	];

	const hardFailures = evaluations.filter((item) => item.status === "fail");
	const payload = {
		command: "slo-budget-report",
		generatedAt: new Date().toISOString(),
		windowDays,
		root,
		logDir,
		entriesConsidered: entries.length,
		requests: {
			success: requestSuccess,
			failure: requestFailure,
			total: requestTotal,
			successRatePercent: pct(requestSuccessRate),
			errorBudgetConsumedPercent:
				typeof objectives.requestSuccessRatePercent === "number" && requestSuccessRate !== null
					? pct(100 - requestSuccessRate)
					: null,
			errorBudgetAllowedPercent:
				typeof objectives.requestSuccessRatePercent === "number"
					? pct(100 - objectives.requestSuccessRatePercent)
					: null,
		},
		health: {
			status: health.status,
			staleWalFindings,
		},
		evaluations,
		status: hardFailures.length === 0 ? "pass" : "fail",
	};

	if (outputPath) {
		await writeFile(resolve(outputPath), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	}
	console.log(JSON.stringify(payload, null, 2));
	if (enforce && payload.status === "fail") {
		process.exit(1);
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
	main().catch((error) => {
		console.error(`slo-budget-report failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
