import { EventEmitter } from "node:events";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testOnly as supervisorTestApi } from "../scripts/codex-supervisor.js";

const createdDirs: string[] = [];
const envKeys = [
	"CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS",
	"CODEX_AUTH_CLI_SESSION_BINDING_POLL_MS",
] as const;
const originalEnv = Object.fromEntries(
	envKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>;

async function removeDirectoryWithRetry(dir: string): Promise<void> {
	const retryableCodes = new Set(["ENOTEMPTY", "EPERM", "EBUSY"]);
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? `${error.code ?? ""}`
					: "";
			if (!retryableCodes.has(code) || attempt === 6) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, attempt * 50));
		}
	}
}

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-supervisor-test-"));
	createdDirs.push(dir);
	return dir;
}

class FakeManager {
	private accounts: Array<{
		index: number;
		accountId: string;
		access: string;
		email: string;
		refreshToken: string;
		enabled: boolean;
		cooldownUntil: number;
	}>;

	activeIndex = 0;

	constructor() {
		this.accounts = [
			{
				index: 0,
				accountId: "near-limit",
				access: "token-1",
				email: "near-limit@example.com",
				refreshToken: "rt-near-limit",
				enabled: true,
				cooldownUntil: 0,
			},
			{
				index: 1,
				accountId: "healthy",
				access: "token-2",
				email: "healthy@example.com",
				refreshToken: "rt-healthy",
				enabled: true,
				cooldownUntil: 0,
			},
		];
	}

	getAccountsSnapshot() {
		return this.accounts.map((account) => ({ ...account }));
	}

	getAccountByIndex(index: number) {
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
				(account) => account.enabled !== false && account.cooldownUntil <= now,
			) ?? null
		);
	}

	getMinWaitTimeForFamily() {
		const now = Date.now();
		const waits = this.accounts
			.map((account) => Math.max(0, account.cooldownUntil - now))
			.filter((waitMs) => waitMs > 0);
		return waits.length > 0 ? Math.min(...waits) : 0;
	}

	markRateLimitedWithReason(
		account: { index: number },
		waitMs: number,
	) {
		const target = this.getAccountByIndex(account.index);
		if (!target) return;
		target.cooldownUntil = Date.now() + Math.max(waitMs, 1);
	}

	markAccountCoolingDown(
		account: { index: number },
		waitMs: number,
	) {
		this.markRateLimitedWithReason(account, waitMs);
	}

	setActiveIndex(index: number) {
		this.activeIndex = index;
	}

	async syncCodexCliActiveSelectionForIndex() {}

	async saveToDisk() {}
}

function createFakeRuntime(
	manager: FakeManager,
	quotaProbeDelayMs = 0,
) {
	const storageDir = createTempDir();
	const snapshots = new Map([
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

	return {
		AccountManager: {
			async loadFromDisk() {
				return manager;
			},
		},
		getStoragePath() {
			return join(storageDir, "accounts.json");
		},
		getPreemptiveQuotaEnabled() {
			return true;
		},
		getPreemptiveQuotaRemainingPercent5h() {
			return 10;
		},
		getPreemptiveQuotaRemainingPercent7d() {
			return 5;
		},
		getRetryAllAccountsRateLimited() {
			return true;
		},
		async fetchCodexQuotaSnapshot({
			accountId,
			signal,
		}: {
			accountId: string;
			signal?: AbortSignal;
		}) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, quotaProbeDelayMs);
				const onAbort = () => {
					clearTimeout(timer);
					const error = new Error("Quota probe aborted");
					error.name = "AbortError";
					reject(error);
				};
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			return snapshots.get(accountId) ?? null;
		},
	};
}

afterEach(async () => {
	vi.useRealTimers();
	for (const key of envKeys) {
		const value = originalEnv[key];
		if (value === undefined) {
			delete process.env[key];
			continue;
		}
		process.env[key] = value;
	}
	for (const dir of createdDirs.splice(0, createdDirs.length).reverse()) {
		await removeDirectoryWithRetry(dir);
	}
});

describe("codex supervisor", () => {
	it("finds session metadata when it lands on the 200th non-empty line", async () => {
		expect(supervisorTestApi).toBeDefined();
		const dir = createTempDir();
		const filePath = join(dir, "boundary.jsonl");
		const preamble = Array.from({ length: 199 }, (_unused, index) =>
			JSON.stringify({ type: "event", seq: index + 1 }),
		);
		await fs.writeFile(
			filePath,
			[
				...preamble,
				JSON.stringify({
					session_meta: {
						payload: { id: "boundary-session", cwd: dir },
					},
				}),
			].join("\n"),
			"utf8",
		);

		await expect(supervisorTestApi?.extractSessionMeta(filePath)).resolves.toEqual({
			sessionId: "boundary-session",
			cwd: dir,
		});
	});

	it("misses session metadata beyond the 200-line scan limit", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "over-limit.jsonl");
		const preamble = Array.from({ length: 200 }, (_unused, index) =>
			JSON.stringify({ type: "event", seq: index + 1 }),
		);
		await fs.writeFile(
			filePath,
			[
				...preamble,
				JSON.stringify({
					session_meta: {
						payload: { id: "missed-session", cwd: dir },
					},
				}),
			].join("\n"),
			"utf8",
		);

		await expect(supervisorTestApi?.extractSessionMeta(filePath)).resolves.toBeNull();
	});

	it("interrupts child restart waits when the abort signal fires", async () => {
		vi.useFakeTimers();
		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			kill = vi.fn((_signal: string) => true);
		}

		const child = new FakeChild();
		const controller = new AbortController();
		const pending = supervisorTestApi?.requestChildRestart(
			child,
			"win32",
			controller.signal,
		);

		controller.abort();
		await vi.runAllTimersAsync();
		await expect(pending).resolves.toBeUndefined();
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("skips a near-limit current account and selects the next healthy account", async () => {
		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager);

		const result = await supervisorTestApi?.ensureLaunchableAccount(
			runtime,
			{},
			undefined,
			{ probeTimeoutMs: 250 },
		);

		expect(result?.ok).toBe(true);
		expect(result?.account?.accountId).toBe("healthy");
		expect(manager.activeIndex).toBe(1);
		expect(manager.getCurrentAccountForFamily()?.accountId).toBe("healthy");
		expect(manager.getAccountByIndex(0)?.cooldownUntil ?? 0).toBeGreaterThan(
			Date.now() - 1,
		);
	});

	it("overlaps selection with restart so handoff finishes sooner than the serial path", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS = "40";

		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			kill = vi.fn((_signal: string) => true);
		}

		const serialManager = new FakeManager();
		const serialRuntime = createFakeRuntime(serialManager, 60);
		const serialChild = new FakeChild();
		const serialStart = performance.now();
		const serialResult = await (async () => {
			await supervisorTestApi?.requestChildRestart(serialChild, "win32");
			return supervisorTestApi?.ensureLaunchableAccount(
				serialRuntime,
				{},
				undefined,
				{ probeTimeoutMs: 250 },
			);
		})();
		const serialElapsedMs = performance.now() - serialStart;
		expect(serialResult).toMatchObject({
			ok: true,
			account: { accountId: "healthy" },
		});

		const overlapManager = new FakeManager();
		const overlapRuntime = createFakeRuntime(overlapManager, 60);
		const overlapChild = new FakeChild();
		const overlapStart = performance.now();
		const overlapResult = await Promise.all([
			supervisorTestApi?.requestChildRestart(overlapChild, "win32"),
			supervisorTestApi?.ensureLaunchableAccount(
				overlapRuntime,
				{},
				undefined,
				{ probeTimeoutMs: 250 },
			),
		]);
		const overlapElapsedMs = performance.now() - overlapStart;
		expect(overlapResult).toEqual([
			undefined,
			expect.objectContaining({
				ok: true,
				account: expect.objectContaining({ accountId: "healthy" }),
			}),
		]);
		expect(overlapElapsedMs).toBeLessThan(serialElapsedMs - 40);
	});

	it("reduces restart pause further when selection is prepared before the idle gate", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS = "40";

		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			kill = vi.fn((_signal: string) => true);
		}

		const overlapManager = new FakeManager();
		const overlapRuntime = createFakeRuntime(overlapManager, 80);
		const overlapStart = performance.now();
		await Promise.all([
			supervisorTestApi?.requestChildRestart(new FakeChild(), "win32"),
			supervisorTestApi?.ensureLaunchableAccount(
				overlapRuntime,
				{},
				undefined,
				{ probeTimeoutMs: 250 },
			),
		]);
		const overlapElapsedMs = performance.now() - overlapStart;

		const prewarmedManager = new FakeManager();
		const prewarmedRuntime = createFakeRuntime(prewarmedManager, 80);
		await supervisorTestApi?.prepareResumeSelection({
			runtime: prewarmedRuntime,
			pluginConfig: {},
			currentAccount: prewarmedManager.getCurrentAccountForFamily(),
			restartDecision: {
				reason: "quota-near-exhaustion",
				waitMs: 0,
				sessionId: "prepared-session",
			},
			signal: undefined,
		});
		const prewarmedStart = performance.now();
		await supervisorTestApi?.requestChildRestart(new FakeChild(), "win32");
		const prewarmedElapsedMs = performance.now() - prewarmedStart;

		expect(prewarmedElapsedMs).toBeLessThan(overlapElapsedMs - 20);
	});
});
