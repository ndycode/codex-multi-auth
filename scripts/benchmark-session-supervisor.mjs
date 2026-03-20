#!/usr/bin/env node

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

function argValue(args, name) {
	const prefix = `${name}=`;
	const match = args.find((arg) => arg.startsWith(prefix));
	return match ? match.slice(prefix.length) : undefined;
}

function parsePositiveInt(value, fallback) {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function average(values) {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
	return Number(value.toFixed(3));
}

class FakeChild extends EventEmitter {
	constructor() {
		super();
		this.exitCode = null;
		this.killCalls = [];
	}

	kill(signal) {
		this.killCalls.push(signal);
		return true;
	}
}

class FakeManager {
	constructor(accounts) {
		this.accounts = accounts.map((account, index) => ({
			index,
			refreshToken: `rt_${account.accountId}`,
			email: `${account.accountId}@example.com`,
			enabled: true,
			cooldownUntil: 0,
			...account,
		}));
		this.activeIndex = 0;
	}

	getAccountsSnapshot() {
		return this.accounts.map((account) => ({ ...account }));
	}

	getAccountByIndex(index) {
		return this.accounts.find((account) => account.index === index) ?? null;
	}

	getCurrentAccountForFamily() {
		return this.getAccountByIndex(this.activeIndex);
	}

	getCurrentOrNextForFamilyHybrid() {
		const now = Date.now();
		const ordered = [
			this.getCurrentAccountForFamily(),
			...this.accounts.filter((account) => account.index !== this.activeIndex),
		].filter(Boolean);
		return (
			ordered.find(
				(account) => account.enabled !== false && (account.cooldownUntil ?? 0) <= now,
			) ?? null
		);
	}

	getMinWaitTimeForFamily() {
		const now = Date.now();
		const waits = this.accounts
			.map((account) => Math.max(0, (account.cooldownUntil ?? 0) - now))
			.filter((waitMs) => waitMs > 0);
		return waits.length > 0 ? Math.min(...waits) : 0;
	}

	markRateLimitedWithReason(account, waitMs) {
		const target = this.getAccountByIndex(account.index);
		if (!target) return;
		target.cooldownUntil = Date.now() + Math.max(waitMs, 1);
	}

	markAccountCoolingDown(account, waitMs) {
		this.markRateLimitedWithReason(account, waitMs);
	}

	setActiveIndex(index) {
		this.activeIndex = index;
	}

	async syncCodexCliActiveSelectionForIndex() {}

	async saveToDisk() {}
}

async function buildRuntime(probeLatencyMs, tempRoot) {
	const pluginConfig = {
		preemptiveQuotaEnabled: true,
		preemptiveQuotaRemainingPercent5h: 10,
		preemptiveQuotaRemainingPercent7d: 5,
		retryAllAccountsRateLimited: true,
	};
	const manager = new FakeManager([
		{ accountId: "near-limit", access: "token-1" },
		{ accountId: "healthy", access: "token-2" },
	]);
	const quotaByAccountId = new Map([
		[
			"near-limit",
			{
				status: 200,
				primary: { usedPercent: 91 },
				secondary: { usedPercent: 12 },
			},
		],
		[
			"healthy",
			{
				status: 200,
				primary: { usedPercent: 25 },
				secondary: { usedPercent: 8 },
			},
		],
	]);

	const runtime = {
		AccountManager: {
			async loadFromDisk() {
				return manager;
			},
		},
		getStoragePath() {
			return join(tempRoot, "accounts.json");
		},
		getPreemptiveQuotaEnabled(config) {
			return config.preemptiveQuotaEnabled !== false;
		},
		getPreemptiveQuotaRemainingPercent5h(config) {
			return config.preemptiveQuotaRemainingPercent5h ?? 10;
		},
		getPreemptiveQuotaRemainingPercent7d(config) {
			return config.preemptiveQuotaRemainingPercent7d ?? 5;
		},
		getRetryAllAccountsRateLimited(config) {
			return config.retryAllAccountsRateLimited !== false;
		},
		async fetchCodexQuotaSnapshot({ accountId, signal }) {
			await new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, probeLatencyMs);
				if (!signal) return;
				const onAbort = () => {
					clearTimeout(timer);
					const error = new Error("Quota probe aborted");
					error.name = "AbortError";
					reject(error);
				};
				signal.addEventListener("abort", onAbort, { once: true });
			});
			return quotaByAccountId.get(accountId) ?? null;
		},
	};

	return { runtime, pluginConfig, manager };
}

async function runCase(api, name, iterations, probeLatencyMs) {
	const tempRoot = await mkdtemp(join(tmpdir(), "codex-supervisor-bench-"));
	const serialDurations = [];
	const overlapDurations = [];
	const prewarmedDurations = [];

	try {
		for (let iteration = 0; iteration < iterations; iteration += 1) {
			process.env.CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS = "75";
			const serialEnv = await buildRuntime(probeLatencyMs, tempRoot);
			let start = performance.now();
			await api.requestChildRestart(new FakeChild(), "win32");
			await api.ensureLaunchableAccount(
				serialEnv.runtime,
				serialEnv.pluginConfig,
				new AbortController().signal,
				{ probeTimeoutMs: probeLatencyMs + 250 },
			);
			serialDurations.push(performance.now() - start);

			const overlapEnv = await buildRuntime(probeLatencyMs, tempRoot);
			start = performance.now();
			await Promise.all([
				api.requestChildRestart(new FakeChild(), "win32"),
				api.ensureLaunchableAccount(
					overlapEnv.runtime,
					overlapEnv.pluginConfig,
					new AbortController().signal,
					{ probeTimeoutMs: probeLatencyMs + 250 },
				),
			]);
			overlapDurations.push(performance.now() - start);

			const prewarmedEnv = await buildRuntime(probeLatencyMs, tempRoot);
			const prewarmedPromise = api.prepareResumeSelection({
				runtime: prewarmedEnv.runtime,
				pluginConfig: prewarmedEnv.pluginConfig,
				currentAccount: prewarmedEnv.manager.getCurrentAccountForFamily(),
				restartDecision: {
					reason: "quota-near-exhaustion",
					waitMs: 0,
					sessionId: "bench-session",
				},
				signal: new AbortController().signal,
			});
			await prewarmedPromise;
			start = performance.now();
			await api.requestChildRestart(new FakeChild(), "win32");
			prewarmedDurations.push(performance.now() - start);
		}
	} finally {
		delete process.env.CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS;
		await rm(tempRoot, { recursive: true, force: true });
	}

	const serialAvgMs = average(serialDurations);
	const overlapAvgMs = average(overlapDurations);
	const prewarmedAvgMs = average(prewarmedDurations);
	return {
		name,
		iterations,
		probeLatencyMs,
		serialPauseAvgMs: round(serialAvgMs),
		overlapPauseAvgMs: round(overlapAvgMs),
		prewarmedPauseAvgMs: round(prewarmedAvgMs),
		serialToOverlapImprovementMs: round(serialAvgMs - overlapAvgMs),
		serialToOverlapImprovementPct:
			serialAvgMs <= 0 ? 0 : round(((serialAvgMs - overlapAvgMs) / serialAvgMs) * 100),
		overlapToPrewarmedImprovementMs: round(overlapAvgMs - prewarmedAvgMs),
		overlapToPrewarmedImprovementPct:
			overlapAvgMs <= 0
				? 0
				: round(((overlapAvgMs - prewarmedAvgMs) / overlapAvgMs) * 100),
	};
}

async function main() {
	const args = process.argv.slice(2);
	const smoke = args.includes("--smoke");
	const iterations = parsePositiveInt(argValue(args, "--iterations"), smoke ? 4 : 12);
	const probeLatencyMs = parsePositiveInt(
		argValue(args, "--probe-latency-ms"),
		smoke ? 120 : 180,
	);
	const outputPath = argValue(args, "--output");

	process.env.NODE_ENV = "test";
	const { __testOnly: api } = await import("./codex-supervisor.js");
	if (!api) {
		throw new Error("benchmark requires codex-supervisor test helpers");
	}

	const payload = {
		generatedAt: new Date().toISOString(),
		node: process.version,
		iterations,
		results: [
			await runCase(api, "session_rotation_overlap_windows", iterations, probeLatencyMs),
		],
	};

	if (outputPath) {
		const resolved = resolve(outputPath);
		await import("node:fs/promises").then(({ mkdir, writeFile }) =>
			mkdir(dirname(resolved), { recursive: true }).then(() =>
				writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8"),
			),
		);
		console.log(`Session supervisor benchmark written: ${resolved}`);
	}

	console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
	console.error(
		`Session supervisor benchmark failed: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
	process.exit(1);
});
