#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertSyncBenchmarkMergeResult } from "./benchmark-runtime-path-helpers.mjs";
import { filterInput } from "../dist/lib/request/request-transformer.js";
import { cleanupToolDefinitions } from "../dist/lib/request/helpers/tool-utils.js";
import { AccountManager } from "../dist/lib/accounts.js";
import { syncAccountStorageFromCodexCli } from "../dist/lib/codex-cli/sync.js";
import { clearCodexCliStateCache } from "../dist/lib/codex-cli/state.js";
import {
	handleErrorResponse,
	handleSuccessResponseDetailed,
} from "../dist/lib/request/fetch-helpers.js";
import { normalizeAccountStorage } from "../dist/lib/storage.js";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
let processStateMutationQueue = Promise.resolve();

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

async function removeWithRetry(path, options) {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await rm(path, options);
			return;
		} catch (error) {
			const code = error?.code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await sleep(25 * 2 ** attempt);
		}
	}
}

async function withProcessStateMutationLock(fn) {
	const previous = processStateMutationQueue;
	let release;
	processStateMutationQueue = new Promise((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await fn();
	} finally {
		release?.();
	}
}

function benchmarkCase(name, iterations, fn) {
	for (let i = 0; i < 5; i += 1) {
		fn();
	}
	const start = performance.now();
	for (let i = 0; i < iterations; i += 1) {
		fn();
	}
	const end = performance.now();
	return {
		name,
		iterations,
		avgMs: Number(((end - start) / iterations).toFixed(6)),
	};
}

async function benchmarkCaseAsync(name, iterations, fn) {
	for (let i = 0; i < 3; i += 1) {
		await fn();
	}
	const start = performance.now();
	for (let i = 0; i < iterations; i += 1) {
		await fn();
	}
	const end = performance.now();
	return {
		name,
		iterations,
		avgMs: Number(((end - start) / iterations).toFixed(6)),
	};
}

function buildInputItems(size) {
	const items = [];
	for (let i = 0; i < size; i += 1) {
		items.push({
			type: "message",
			role: i % 2 === 0 ? "user" : "assistant",
			id: `msg_${i}`,
			content: [{ type: "input_text", text: `payload-${i}` }],
		});
		if (i % 40 === 0) {
			items.push({ type: "item_reference", id: `ref_${i}` });
		}
	}
	return items;
}

function buildTools(toolCount, propertyCount) {
	const tools = [];
	for (let i = 0; i < toolCount; i += 1) {
		const properties = {};
		const required = [];
		for (let j = 0; j < propertyCount; j += 1) {
			const key = `field_${j}`;
			properties[key] = { type: ["string", "null"], description: `property-${j}` };
			required.push(key);
		}
		required.push("ghost_field");
		tools.push({
			type: "function",
			function: {
				name: `tool_${i}`,
				parameters: {
					type: "object",
					properties,
					required,
					additionalProperties: false,
				},
			},
		});
	}
	return tools;
}

function buildManager(accountCount) {
	const now = Date.now();
	const accounts = [];
	for (let i = 0; i < accountCount; i += 1) {
		accounts.push({
			refreshToken: `rt_${i}`,
			accessToken: `at_${i}`,
			expiresAt: now + 3_600_000,
			accountId: `acct_${i}`,
			email: `user${i}@example.com`,
			enabled: true,
			addedAt: now,
			lastUsed: 0,
			rateLimitResetTimes: {},
		});
	}
	return new AccountManager(undefined, {
		version: 3,
		accounts,
		activeIndex: 0,
		activeIndexByFamily: {},
	});
}

function buildSyncSnapshots(accountCount) {
	const accounts = [];
	for (let i = 0; i < accountCount; i += 1) {
		accounts.push({
			accountId: `acc_${i}`,
			email: `sync${i}@example.com`,
			auth: {
				tokens: {
					access_token: `sync.access.${i}`,
					refresh_token: `sync.refresh.${i}`,
				},
			},
		});
	}
	return accounts;
}

function buildSyncStorage(accountCount) {
	const accounts = [];
	for (let i = 0; i < accountCount; i += 1) {
		accounts.push({
			accountId: `acc_${i}`,
			email: `sync${i}@example.com`,
			refreshToken: `sync.refresh.${i}`,
			accessToken: `sync.access.${i}`,
			addedAt: 1,
			lastUsed: 0,
			enabled: true,
		});
	}
	return {
		version: 3,
		accounts,
		activeIndex: 0,
		activeIndexByFamily: {},
	};
}

function buildNormalizationStorage(accountCount) {
	const accounts = [];
	for (let i = 0; i < accountCount; i += 1) {
		const emailSuffix = Math.floor(i / 3);
		accounts.push({
			accountId: `norm_${i}`,
			refreshToken: `norm.refresh.${i}`,
			accessToken: `norm.access.${i}`,
			email: `norm${emailSuffix}@example.com`,
			addedAt: 1,
			lastUsed: 0,
			enabled: true,
		});
		if (i % 25 === 0) {
			accounts.push({
				accountId: `norm_${i}`,
				refreshToken: `norm.refresh.dup.${i}`,
				accessToken: `norm.access.dup.${i}`,
				email: `norm${emailSuffix}@example.com`,
				addedAt: 1,
				lastUsed: 0,
				enabled: true,
			});
		}
	}

	return {
		version: 3,
		accounts,
		activeIndex: Math.max(0, accountCount - 1),
		activeIndexByFamily: {
			codex: Math.floor(accountCount / 2),
			gpt5: Math.floor(accountCount / 3),
		},
	};
}

async function withCodexCliState(accountCount, fn) {
	return withProcessStateMutationLock(async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-perf-"));
		const accountsPath = join(tempDir, "accounts.json");
		const authPath = join(tempDir, "auth.json");
		const configPath = join(tempDir, "config.toml");
		const snapshots = buildSyncSnapshots(accountCount);
		await writeFile(
			accountsPath,
			`${JSON.stringify({ activeAccountId: "acc_0", accounts: snapshots }, null, 2)}\n`,
			"utf8",
		);

		const previousEnv = {
			CODEX_CLI_ACCOUNTS_PATH: process.env.CODEX_CLI_ACCOUNTS_PATH,
			CODEX_CLI_AUTH_PATH: process.env.CODEX_CLI_AUTH_PATH,
			CODEX_CLI_CONFIG_PATH: process.env.CODEX_CLI_CONFIG_PATH,
			CODEX_MULTI_AUTH_SYNC_CODEX_CLI: process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI,
			CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE:
				process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE,
		};

		process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
		process.env.CODEX_CLI_AUTH_PATH = authPath;
		process.env.CODEX_CLI_CONFIG_PATH = configPath;
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "1";
		clearCodexCliStateCache();

		try {
			return await fn();
		} finally {
			clearCodexCliStateCache();
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await removeWithRetry(tempDir, { recursive: true, force: true });
		}
	});
}

async function run() {
	const args = process.argv.slice(2);
	const iterations = parsePositiveInt(argValue(args, "--iterations"), 30);
	const outputPath = argValue(args, "--output");

	const inputSmall = buildInputItems(400);
	const inputLarge = buildInputItems(2000);
	const toolsMedium = buildTools(40, 12);
	const toolsLarge = buildTools(140, 25);
	const normalizationStorage = buildNormalizationStorage(2000);

	const results = [
		benchmarkCase("filterInput_small", iterations, () => {
			const out = filterInput(inputSmall);
			if (!Array.isArray(out)) throw new Error("filterInput_small failed");
		}),
		benchmarkCase("filterInput_large", iterations, () => {
			const out = filterInput(inputLarge);
			if (!Array.isArray(out)) throw new Error("filterInput_large failed");
		}),
		benchmarkCase("cleanupToolDefinitions_medium", iterations, () => {
			const out = cleanupToolDefinitions(toolsMedium);
			if (!Array.isArray(out)) throw new Error("cleanupToolDefinitions_medium failed");
		}),
		benchmarkCase("cleanupToolDefinitions_large", iterations, () => {
			const out = cleanupToolDefinitions(toolsLarge);
			if (!Array.isArray(out)) throw new Error("cleanupToolDefinitions_large failed");
		}),
		benchmarkCase("accountHybridSelection_200", iterations, () => {
			const manager = buildManager(200);
			for (let i = 0; i < 200; i += 1) {
				manager.getCurrentOrNextForFamilyHybrid("codex", "gpt-5-codex", { pidOffsetEnabled: false });
			}
		}),
		benchmarkCase("normalizeAccountStorage_large", iterations, () => {
			const out = normalizeAccountStorage(normalizationStorage);
			if (!out || out.version !== 3) {
				throw new Error("normalizeAccountStorage_large failed");
			}
		}),
	];

	const asyncResults = await withCodexCliState(1000, async () => {
		const current = buildSyncStorage(1000);
		current.accounts[0].refreshToken = "stale.refresh.token";
		const syncResult = await benchmarkCaseAsync(
			"codexCliSync_merge_1000",
			iterations,
			async () => {
				const reconciled = await syncAccountStorageFromCodexCli(current);
				assertSyncBenchmarkMergeResult(reconciled, {
					caseName: "codexCliSync_merge_1000",
					minimumAccounts: 1000,
					expectedRefreshToken: "sync.refresh.0",
				});
			},
		);

		const errorBodyText = JSON.stringify({
			error: {
				code: "usage_limit_reached",
				message: "usage limit reached",
				retry_after_ms: 1200,
			},
		});
		const errorResult = await benchmarkCaseAsync(
			"handleErrorResponse_usageLimit",
			iterations,
			async () => {
				const result = await handleErrorResponse(
					new Response(errorBodyText, { status: 404 }),
				);
				if (result.response.status !== 429) {
					throw new Error("handleErrorResponse_usageLimit failed");
				}
			},
		);

		const sseSuccess =
			'data: {"type":"response.done","response":{"id":"resp_perf","output":"ok"}}\n';
		const successResult = await benchmarkCaseAsync(
			"handleSuccessResponseDetailed_nonstream",
			iterations,
			async () => {
				const result = await handleSuccessResponseDetailed(
					new Response(sseSuccess, { status: 200 }),
					false,
				);
				if (!result.parsedBody) {
					throw new Error("handleSuccessResponseDetailed_nonstream failed");
				}
			},
		);

		return [syncResult, errorResult, successResult];
	});

	const payload = {
		generatedAt: new Date().toISOString(),
		node: process.version,
		iterations,
		results: [...results, ...asyncResults],
	};

	if (outputPath) {
		const resolved = resolve(outputPath);
		return mkdir(dirname(resolved), { recursive: true }).then(() =>
			writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8"),
		).then(() => {
			console.log(`Runtime benchmark written: ${resolved}`);
			console.log(JSON.stringify(payload, null, 2));
		});
	}

	console.log(JSON.stringify(payload, null, 2));
	return Promise.resolve();
}

run().catch((error) => {
	console.error(`Runtime benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
