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
	"CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS",
	"CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS",
	"CODEX_AUTH_CLI_SESSION_SUPERVISOR_POLL_MS",
	"CODEX_AUTH_CLI_SESSION_SUPERVISOR_IDLE_MS",
	"CODEX_AUTH_CLI_SESSION_SNAPSHOT_CACHE_TTL_MS",
	"CODEX_HOME",
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

function createDeferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

class FakeManager {
	private accounts: Array<{
		index: number;
		accountId: string;
		access: string;
		email: string;
		refreshToken: string;
		enabled: boolean;
		coolingDownUntil: number;
	}>;

	activeIndex = 0;

	constructor(
		accounts: Array<{
			accountId: string;
			access?: string;
			email?: string;
			refreshToken?: string;
			enabled?: boolean;
			coolingDownUntil?: number;
		}> = [
			{ accountId: "near-limit", access: "token-1" },
			{ accountId: "healthy", access: "token-2" },
		],
	) {
		this.accounts = accounts.map((account, index) => ({
			index,
			accountId: account.accountId,
			access: account.access ?? `token-${index + 1}`,
			email: account.email ?? `${account.accountId}@example.com`,
			refreshToken: account.refreshToken ?? `rt-${account.accountId}`,
			enabled: account.enabled ?? true,
			coolingDownUntil: account.coolingDownUntil ?? 0,
		}));
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
				(account) =>
					account.enabled !== false && account.coolingDownUntil <= now,
			) ?? null
		);
	}

	getMinWaitTimeForFamily() {
		const now = Date.now();
		const waits = this.accounts
			.map((account) => Math.max(0, account.coolingDownUntil - now))
			.filter((waitMs) => waitMs > 0);
		return waits.length > 0 ? Math.min(...waits) : 0;
	}

	markRateLimitedWithReason(
		account: { index: number },
		waitMs: number,
	) {
		const target = this.getAccountByIndex(account.index);
		if (!target) return;
		target.coolingDownUntil = Date.now() + Math.max(waitMs, 1);
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
	options: {
		quotaProbeDelayMs?: number;
		snapshots?: Map<
			string,
			{
				status: number;
				primary?: { usedPercent?: number };
				secondary?: { usedPercent?: number };
			}
		>;
		delayByAccountId?: Map<string, number>;
		waitForFetchByAccountId?: Map<string, Promise<void>>;
		onFetch?: (accountId: string) => void;
		onFetchStart?: (accountId: string) => void;
	} = {},
) {
	const storageDir = createTempDir();
	const snapshots =
		options.snapshots ??
		new Map([
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
	const fallbackProbeDelayMs = options.quotaProbeDelayMs ?? 0;
	const delayByAccountId = options.delayByAccountId ?? new Map();
	const waitForFetchByAccountId = options.waitForFetchByAccountId ?? new Map();

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
			options.onFetch?.(accountId);
			options.onFetchStart?.(accountId);
			const gate = waitForFetchByAccountId.get(accountId);
			if (gate) {
				await gate;
			}
			const quotaProbeDelayMs =
				delayByAccountId.get(accountId) ?? fallbackProbeDelayMs;
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
	supervisorTestApi?.clearAllProbeSnapshotCache?.();
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

	it("reuses the known rollout path before scanning the sessions tree again", async () => {
		const codexHome = createTempDir();
		const cwd = createTempDir();
		process.env.CODEX_HOME = codexHome;

		const sessionsDir = join(codexHome, "sessions", "2026", "03", "20");
		await fs.mkdir(sessionsDir, { recursive: true });
		const rolloutPath = join(sessionsDir, "known-session.jsonl");
		await fs.writeFile(
			rolloutPath,
			JSON.stringify({
				session_meta: {
					payload: { id: "known-session", cwd },
				},
			}),
			"utf8",
		);

		const first = await supervisorTestApi?.findSessionBinding({
			cwd,
			sinceMs: 0,
			sessionId: "known-session",
		});
		expect(first).toMatchObject({
			sessionId: "known-session",
			rolloutPath,
		});

		const readdirSpy = vi.spyOn(fs, "readdir");
		readdirSpy.mockRejectedValue(new Error("should not rescan sessions"));

		try {
			const second = await supervisorTestApi?.findSessionBinding({
				cwd,
				sinceMs: 0,
				sessionId: "known-session",
				rolloutPathHint: first?.rolloutPath,
			});
			expect(second).toMatchObject({
				sessionId: "known-session",
				rolloutPath,
			});
			expect(readdirSpy).not.toHaveBeenCalled();
		} finally {
			readdirSpy.mockRestore();
		}
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

	it("sends SIGINT before escalating on non-Windows platforms", async () => {
		vi.useFakeTimers();
		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			kill = vi.fn((_signal: string) => true);
		}

		const child = new FakeChild();
		const pending = supervisorTestApi?.requestChildRestart(child, "linux");

		await vi.runAllTimersAsync();
		await expect(pending).resolves.toBeUndefined();
		expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
			"SIGINT",
			"SIGTERM",
			"SIGKILL",
		]);
	});

	it("cleans up stale supervisor locks even after a transient Windows unlink failure", async () => {
		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager);
		const lockPath = supervisorTestApi?.getSupervisorStorageLockPath(runtime);
		expect(lockPath).toBeTruthy();
		if (!lockPath) {
			throw new Error("expected a supervisor lock path");
		}

		await fs.mkdir(join(lockPath, ".."), { recursive: true }).catch(() => {});
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				pid: 1,
				acquiredAt: Date.now() - 60_000,
				expiresAt: Date.now() - 1_000,
			}),
			"utf8",
		);

		const originalUnlink = fs.unlink.bind(fs);
		const unlinkSpy = vi
			.spyOn(fs, "unlink")
			.mockImplementationOnce(async () => {
				const error = Object.assign(new Error("file busy"), { code: "EPERM" });
				throw error;
			})
			.mockImplementation(originalUnlink);

		try {
			await expect(
				supervisorTestApi?.withLockedManager(runtime, async (loadedManager: FakeManager) => {
					expect(loadedManager).toBe(manager);
					return "locked";
				}),
			).resolves.toBe("locked");
			expect(unlinkSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		} finally {
			unlinkSpy.mockRestore();
		}
	});

	it.each(["EPERM", "EBUSY"] as const)(
		"retries supervisor lock creation after a transient Windows %s",
		async (code) => {
			process.env.CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS = "1000";
			process.env.CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS = "10";

			const manager = new FakeManager();
			const runtime = createFakeRuntime(manager);
			const lockPath = supervisorTestApi?.getSupervisorStorageLockPath(runtime);
			expect(lockPath).toBeTruthy();
			if (!lockPath) {
				throw new Error("expected a supervisor lock path");
			}

			const originalOpen = fs.open.bind(fs);
			let injectedFailure = false;
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (path, flags, ...rest) => {
				if (!injectedFailure && `${path}` === lockPath && flags === "wx") {
					injectedFailure = true;
					const error = Object.assign(new Error("transient lock create failure"), {
						code,
					});
					throw error;
				}
				return originalOpen(
					path as Parameters<typeof fs.open>[0],
					flags as Parameters<typeof fs.open>[1],
					...(rest as Parameters<typeof fs.open> extends [unknown, unknown, ...infer Tail]
						? Tail
						: never),
				);
			});

			try {
				await expect(
					supervisorTestApi?.withLockedManager(runtime, async (loadedManager: FakeManager) => {
						expect(loadedManager).toBe(manager);
						return "locked";
					}),
				).resolves.toBe("locked");
				expect(injectedFailure).toBe(true);
				expect(
					openSpy.mock.calls.filter(
						([path, flags]) => `${path}` === lockPath && flags === "wx",
					).length,
				).toBeGreaterThanOrEqual(2);
			} finally {
				openSpy.mockRestore();
			}
		},
	);

	it("serializes concurrent callers behind the supervisor storage lock", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS = "1000";
		process.env.CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS = "10";

		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager);
		const order: string[] = [];
		let releaseFirst: (() => void) | null = null;
		let resolveFirstEntered: (() => void) | null = null;
		let resolveSecondEntered: (() => void) | null = null;
		const firstEntered = new Promise<void>((resolve) => {
			resolveFirstEntered = resolve;
		});
		const secondEntered = new Promise<void>((resolve) => {
			resolveSecondEntered = resolve;
		});
		let secondHasLock = false;

		const first = supervisorTestApi?.withLockedManager(
			runtime,
			async (loadedManager: FakeManager) => {
				expect(loadedManager).toBe(manager);
				order.push("first-enter");
				resolveFirstEntered?.();
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
				order.push("first-exit");
				return "first";
			},
		);

		await firstEntered;

		const second = supervisorTestApi?.withLockedManager(
			runtime,
			async (loadedManager: FakeManager) => {
				expect(loadedManager).toBe(manager);
				secondHasLock = true;
				order.push("second-enter");
				resolveSecondEntered?.();
				return "second";
			},
		);

		await supervisorTestApi?.sleep(40);
		expect(secondHasLock).toBe(false);
		releaseFirst?.();

		await secondEntered;
		await expect(Promise.all([first, second])).resolves.toEqual([
			"first",
			"second",
		]);
		expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
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
		expect(manager.getAccountByIndex(0)?.coolingDownUntil ?? 0).toBeGreaterThan(
			Date.now() - 1,
		);
	});

	it("starts prewarm before the rotate threshold without forcing a cutover", async () => {
		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager, {
			snapshots: new Map([
				[
					"near-limit",
					{
						status: 200,
						primary: { usedPercent: 86 },
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
			]),
		});

		const snapshot = await supervisorTestApi?.probeAccountSnapshot(
			runtime,
			manager.getCurrentAccountForFamily(),
			undefined,
			250,
			{ useCache: false },
		);
		const pressure = supervisorTestApi?.computeQuotaPressure(snapshot, runtime, {});
		const prepared = await supervisorTestApi?.prepareResumeSelection({
			runtime,
			pluginConfig: {},
			currentAccount: manager.getCurrentAccountForFamily(),
			signal: undefined,
		});

		expect(pressure).toMatchObject({
			prewarm: true,
			rotate: false,
			remaining5h: 14,
		});
		expect(manager.activeIndex).toBe(0);
		expect(prepared?.nextReady).toMatchObject({
			ok: true,
			account: { accountId: "healthy" },
		});
	});

	it("reuses a cached healthy snapshot within the short ttl", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_SNAPSHOT_CACHE_TTL_MS = "5000";
		const manager = new FakeManager();
		const calls: string[] = [];
		const runtime = createFakeRuntime(manager, {
			onFetch(accountId) {
				calls.push(accountId);
			},
		});
		const account = manager.getCurrentAccountForFamily();

		await supervisorTestApi?.clearProbeSnapshotCache(account);
		const first = await supervisorTestApi?.probeAccountSnapshot(
			runtime,
			account,
			undefined,
			250,
		);
		const second = await supervisorTestApi?.probeAccountSnapshot(
			runtime,
			account,
			undefined,
			250,
		);

		expect(first).toEqual(second);
		expect(calls).toEqual(["near-limit"]);
	});

	it("shares the same in-flight probe across concurrent callers", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_SNAPSHOT_CACHE_TTL_MS = "5000";
		const manager = new FakeManager();
		const calls: string[] = [];
		const nearLimitGate = createDeferred<void>();
		const probeStarted = createDeferred<void>();
		const runtime = createFakeRuntime(manager, {
			waitForFetchByAccountId: new Map([["near-limit", nearLimitGate.promise]]),
			onFetch(accountId) {
				calls.push(accountId);
			},
			onFetchStart(accountId) {
				if (accountId === "near-limit") {
					probeStarted.resolve();
				}
			},
		});
		const account = manager.getCurrentAccountForFamily();

		await supervisorTestApi?.clearProbeSnapshotCache(account);
		const first = supervisorTestApi?.probeAccountSnapshot(
			runtime,
			account,
			undefined,
			250,
		);
		await probeStarted.promise;
		const second = supervisorTestApi?.probeAccountSnapshot(
			runtime,
			account,
			undefined,
			250,
		);
		expect(calls).toEqual(["near-limit"]);

		nearLimitGate.resolve();
		const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
		expect(firstSnapshot).toEqual(secondSnapshot);
		expect(calls).toEqual(["near-limit"]);
	});

	it("starts selection probing before restart finishes in overlap mode", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS = "40";

		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			kill = vi.fn((_signal: string) => true);
		}

		const overlapManager = new FakeManager();
		const nearLimitGate = createDeferred<void>();
		const probeStarted = createDeferred<void>();
		const overlapRuntime = createFakeRuntime(overlapManager, {
			waitForFetchByAccountId: new Map([["near-limit", nearLimitGate.promise]]),
			onFetchStart(accountId) {
				if (accountId === "near-limit") {
					probeStarted.resolve();
				}
			},
		});
		const overlapChild = new FakeChild();
		let restartFinished = false;
		const restartPromise = supervisorTestApi?.requestChildRestart(
			overlapChild,
			"win32",
		).then(() => {
			restartFinished = true;
		});
		const selectionPromise = supervisorTestApi?.ensureLaunchableAccount(
			overlapRuntime,
			{},
			undefined,
			{ probeTimeoutMs: 250 },
		);
		await probeStarted.promise;
		expect(restartFinished).toBe(false);
		nearLimitGate.resolve();

		await expect(Promise.all([
			restartPromise,
			selectionPromise,
		])).resolves.toEqual([
			undefined,
			expect.objectContaining({
				ok: true,
				account: expect.objectContaining({ accountId: "healthy" }),
			}),
		]);
	});

	it("uses the prepared account without re-probing at cutover time", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS = "40";

		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			kill = vi.fn((_signal: string) => true);
		}

		const calls: string[] = [];
		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager, {
			quotaProbeDelayMs: 80,
			onFetch(accountId) {
				calls.push(accountId);
			},
		});

		const prepared = await supervisorTestApi?.prepareResumeSelection({
			runtime,
			pluginConfig: {},
			currentAccount: manager.getCurrentAccountForFamily(),
			restartDecision: {
				reason: "quota-near-exhaustion",
				waitMs: 0,
				sessionId: "prepared-session",
			},
			signal: undefined,
		});
		expect(prepared?.nextReady).toMatchObject({
			ok: true,
			account: { accountId: "healthy" },
		});
		expect(calls).toEqual(["healthy"]);

		calls.length = 0;
		await supervisorTestApi?.markCurrentAccountForRestart(
			runtime,
			manager.getCurrentAccountForFamily(),
			{
				reason: "quota-near-exhaustion",
				waitMs: 0,
				sessionId: "prepared-session",
			},
			undefined,
		);
		await supervisorTestApi?.requestChildRestart(new FakeChild(), "win32");
		const committed = await supervisorTestApi?.commitPreparedSelection(
			runtime,
			prepared?.nextReady?.account,
			undefined,
		);
		expect(committed).toMatchObject({
			ok: true,
			account: { accountId: "healthy" },
		});
		expect(calls).toEqual([]);
	});

	it("commits the prepared account only at cutover time", async () => {
		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager, {
			quotaProbeDelayMs: 40,
		});

		const prepared = await supervisorTestApi?.prepareResumeSelection({
			runtime,
			pluginConfig: {},
			currentAccount: manager.getCurrentAccountForFamily(),
			signal: undefined,
		});
		expect(manager.activeIndex).toBe(0);
		await supervisorTestApi?.markCurrentAccountForRestart(
			runtime,
			manager.getCurrentAccountForFamily(),
			{
				reason: "quota-near-exhaustion",
				waitMs: 0,
				sessionId: "prepared-session",
			},
			undefined,
		);

		const committed = await supervisorTestApi?.commitPreparedSelection(
			runtime,
			prepared?.nextReady?.account,
			undefined,
		);

		expect(committed).toMatchObject({
			ok: true,
			account: { accountId: "healthy" },
		});
		expect(manager.activeIndex).toBe(1);
	});

	it("batches probe work so multiple degraded accounts do not add serial pause", async () => {
		const manager = new FakeManager([
			{ accountId: "degraded-1", access: "token-1" },
			{ accountId: "degraded-2", access: "token-2" },
			{ accountId: "degraded-3", access: "token-3" },
			{ accountId: "healthy", access: "token-4" },
		]);
		const runtime = createFakeRuntime(manager, {
			quotaProbeDelayMs: 70,
			snapshots: new Map([
				[
					"degraded-1",
					{ status: 200, primary: { usedPercent: 93 }, secondary: { usedPercent: 12 } },
				],
				[
					"degraded-2",
					{ status: 200, primary: { usedPercent: 94 }, secondary: { usedPercent: 14 } },
				],
				[
					"degraded-3",
					{ status: 200, primary: { usedPercent: 95 }, secondary: { usedPercent: 11 } },
				],
				[
					"healthy",
					{ status: 200, primary: { usedPercent: 18 }, secondary: { usedPercent: 7 } },
				],
			]),
		});

		const startedAt = performance.now();
		const result = await supervisorTestApi?.ensureLaunchableAccount(
			runtime,
			{},
			undefined,
			{ probeTimeoutMs: 250 },
		);
		const elapsedMs = performance.now() - startedAt;

		expect(result).toMatchObject({
			ok: true,
			account: { accountId: "healthy" },
		});
		expect(manager.activeIndex).toBe(3);
		expect(elapsedMs).toBeLessThan(170);
	});

	it("bypasses supervisor account gating for auth commands before account selection", async () => {
		const loadFromDisk = vi.fn(async () => {
			throw new Error("ensureLaunchableAccount should not run for bypass commands");
		});
		const forwardToRealCodex = vi.fn(async () => 0);

		await expect(
			supervisorTestApi?.runCodexSupervisorWithRuntime({
				codexBin: "dist/bin/codex.js",
				rawArgs: ["auth"],
				buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
				forwardToRealCodex,
				runtime: {
					loadPluginConfig: () => ({ codexCliSessionSupervisor: true }),
					getCodexCliSessionSupervisor: () => true,
					AccountManager: { loadFromDisk },
				},
				signal: undefined,
			}),
		).resolves.toBe(0);
		expect(forwardToRealCodex).toHaveBeenCalledWith("dist/bin/codex.js", [
			"auth",
		]);
		expect(loadFromDisk).not.toHaveBeenCalled();
	});

	it(
		"returns 1 when interactive supervision is already at the restart safety limit",
		async () => {
			const manager = new FakeManager([
				{ accountId: "near-limit", access: "token-1" },
				{ accountId: "healthy", access: "token-2" },
			]);
			const runtime = createFakeRuntime(manager);
			const spawnChild = vi.fn();

			const result = await supervisorTestApi?.runInteractiveSupervision({
				codexBin: "dist/bin/codex.js",
				initialArgs: ["resume", "session-restart-limit"],
				buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
				runtime,
				pluginConfig: {},
				manager,
				signal: undefined,
				maxSessionRestarts: 0,
				spawnChild,
			});

			expect(result).toBe(1);
			expect(spawnChild).not.toHaveBeenCalled();
		},
	);

	it("degrades a failed candidate probe and continues to the next healthy account", async () => {
		const manager = new FakeManager([
			{ accountId: "broken", access: "token-broken" },
			{ accountId: "healthy", access: "token-healthy" },
		]);
		const runtime = createFakeRuntime(manager, {
			onFetch(accountId) {
				if (accountId === "broken") {
					throw new Error("network fault");
				}
			},
		});

		const result = await supervisorTestApi?.ensureLaunchableAccount(
			runtime,
			{},
			undefined,
			{ probeTimeoutMs: 250 },
		);

		expect(result).toMatchObject({
			ok: true,
			account: { accountId: "healthy" },
		});
		expect(manager.activeIndex).toBe(1);
	});
});
