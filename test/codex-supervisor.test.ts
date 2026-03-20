import { EventEmitter } from "node:events";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testOnly as supervisorTestApi } from "../scripts/codex-supervisor.js";

const createdDirs: string[] = [];
const envKeys = [
	"CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS",
	"CODEX_AUTH_CLI_SESSION_BINDING_POLL_MS",
	"CODEX_AUTH_CLI_SESSION_CAPTURE_TIMEOUT_MS",
	"CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS",
	"CODEX_AUTH_CLI_SESSION_LOCK_TTL_MS",
	"CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS",
	"CODEX_AUTH_CLI_SESSION_MAX_ACCOUNT_SELECTION_ATTEMPTS",
	"CODEX_AUTH_CLI_SESSION_MAX_RESTARTS",
	"CODEX_AUTH_CLI_SESSION_SUPERVISOR",
	"CODEX_AUTH_CLI_SESSION_SUPERVISOR_POLL_MS",
	"CODEX_AUTH_CLI_SESSION_SUPERVISOR_IDLE_MS",
	"CODEX_AUTH_CLI_SESSION_SNAPSHOT_CACHE_TTL_MS",
	"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
	"CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED",
	"CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT",
	"CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT",
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
	supervisorTestApi?.clearSessionBindingPathCache?.();
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

	it("reuses the cached rollout path for a known session before scanning the sessions tree again", async () => {
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

	it("parses option-prefixed interactive commands consistently", () => {
		expect(
			supervisorTestApi?.isInteractiveCommand([
				"-c",
				'profile="dev"',
				"resume",
				"session-123",
			]),
		).toBe(true);
		expect(
			supervisorTestApi?.readResumeSessionId([
				"--config",
				'env="dev"',
				"resume",
				"session-123",
			]),
		).toBe("session-123");
		expect(
			supervisorTestApi?.isInteractiveCommand([
				"--config=env=\"dev\"",
				"fork",
			]),
		).toBe(true);
	});

	it("caches the session file listing across binding wait polls", async () => {
		const codexHome = createTempDir();
		const cwd = createTempDir();
		process.env.CODEX_HOME = codexHome;
		process.env.CODEX_AUTH_CLI_SESSION_BINDING_POLL_MS = "5";

		const sessionsDir = join(codexHome, "sessions", "2026", "03", "20");
		await fs.mkdir(sessionsDir, { recursive: true });
		await fs.writeFile(
			join(sessionsDir, "no-binding.jsonl"),
			JSON.stringify({ type: "event", seq: 1 }),
			"utf8",
		);

		const readdirSpy = vi.spyOn(fs, "readdir");
		try {
			const binding = await supervisorTestApi?.waitForSessionBinding({
				cwd,
				sinceMs: Date.now(),
				sessionId: "missing-session",
				rolloutPathHint: null,
				timeoutMs: 40,
				signal: undefined,
			});
			expect(binding).toBeNull();
			expect(readdirSpy.mock.calls.length).toBeLessThan(10);
		} finally {
			readdirSpy.mockRestore();
		}
	});

	it("tries recent session entries before falling back to the full scan for known session ids", () => {
		const recentEntry = { filePath: "recent.jsonl", mtimeMs: 5_000 };
		const staleEntry = { filePath: "stale.jsonl", mtimeMs: 100 };

		expect(
			supervisorTestApi?.getSessionBindingEntryPasses(
				[staleEntry, recentEntry],
				4_000,
				"known-session",
				false,
			),
		).toEqual([[recentEntry], [staleEntry]]);
		expect(
			supervisorTestApi?.getSessionBindingEntryPasses(
				[staleEntry, recentEntry],
				4_000,
				"known-session",
				true,
			),
		).toEqual([[recentEntry]]);
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

	it("uses stable snapshot cache keys without embedding refresh tokens", () => {
		const cacheKey = supervisorTestApi?.getSnapshotCacheKey({
			index: 2,
			accountId: "healthy",
			email: "healthy@example.com",
			refreshToken: "super-secret-refresh-token",
		});
		expect(cacheKey).toBe("healthy|healthy@example.com|2");
		expect(cacheKey).not.toContain("super-secret-refresh-token");
	});

	it("honors env overrides in runtime accessor fallbacks", () => {
		process.env.CODEX_AUTH_CLI_SESSION_SUPERVISOR = "1";
		process.env.CODEX_AUTH_RETRY_ALL_RATE_LIMITED = "0";
		process.env.CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED = "0";
		process.env.CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT = "17";
		process.env.CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT = "23";

		const accessors = supervisorTestApi?.createRuntimeConfigAccessors({});
		expect(accessors).toBeTruthy();
		expect(
			accessors?.getCodexCliSessionSupervisor({
				codexCliSessionSupervisor: false,
			}),
		).toBe(true);
		expect(
			accessors?.getRetryAllAccountsRateLimited({
				retryAllAccountsRateLimited: true,
			}),
		).toBe(false);
		expect(
			accessors?.getPreemptiveQuotaEnabled({
				preemptiveQuotaEnabled: true,
			}),
		).toBe(false);
		expect(
			accessors?.getPreemptiveQuotaRemainingPercent5h({
				preemptiveQuotaRemainingPercent5h: 5,
			}),
		).toBe(17);
		expect(
			accessors?.getPreemptiveQuotaRemainingPercent7d({
				preemptiveQuotaRemainingPercent7d: 5,
			}),
		).toBe(23);
	});

	it("clamps runtime quota threshold env overrides to 100 percent", () => {
		process.env.CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT = "200";
		process.env.CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT = "101";

		const accessors = supervisorTestApi?.createRuntimeConfigAccessors({});
		expect(accessors).toBeTruthy();
		expect(
			accessors?.getPreemptiveQuotaRemainingPercent5h({
				preemptiveQuotaRemainingPercent5h: 5,
			}),
		).toBe(100);
		expect(
			accessors?.getPreemptiveQuotaRemainingPercent7d({
				preemptiveQuotaRemainingPercent7d: 7,
			}),
		).toBe(100);
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

	it("refuses to delete a lock when the owner changes before cleanup", async () => {
		const dir = createTempDir();
		const lockPath = join(dir, "openai-codex-accounts.json.supervisor.lock");
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				ownerId: "new-owner",
				pid: 2,
				acquiredAt: Date.now(),
				expiresAt: Date.now() + 60_000,
			}),
			"utf8",
		);

		await expect(
			supervisorTestApi?.safeUnlinkOwnedSupervisorLock(lockPath, "old-owner"),
		).resolves.toBe(false);
		await expect(fs.readFile(lockPath, "utf8")).resolves.toContain("new-owner");
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

	it("only treats EPERM and EBUSY as transient lock errors on Windows", () => {
		expect(
			supervisorTestApi?.isTransientSupervisorLockAcquireError("EEXIST", "linux"),
		).toBe(true);
		expect(
			supervisorTestApi?.isTransientSupervisorLockAcquireError("EPERM", "linux"),
		).toBe(false);
		expect(
			supervisorTestApi?.isTransientSupervisorLockAcquireError("EBUSY", "linux"),
		).toBe(false);
		expect(
			supervisorTestApi?.isTransientSupervisorLockAcquireError("EPERM", "win32"),
		).toBe(true);
		expect(
			supervisorTestApi?.isTransientSupervisorLockAcquireError("EBUSY", "win32"),
		).toBe(true);
	});

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

	it("aborts prepared prewarm selection when the session exits without rotating", async () => {
		class FakeChild extends EventEmitter {
			exitCode: number | null = null;

			constructor(exitCode: number) {
				super();
				setTimeout(() => {
					this.exitCode = exitCode;
					this.emit("exit", exitCode, null);
				}, 25);
			}

			kill(_signal: string) {
				return true;
			}
		}

		const manager = new FakeManager();
		const storageDir = createTempDir();
		let preparedProbeSignal: AbortSignal | undefined;
		const runtime = {
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
				if (accountId === "near-limit") {
					return {
						status: 200,
						primary: { usedPercent: 86 },
						secondary: { usedPercent: 12 },
					};
				}
				preparedProbeSignal = signal;
				return await new Promise((_resolve, reject) => {
					const onAbort = () => {
						const error = new Error("Quota probe aborted");
						error.name = "AbortError";
						reject(error);
					};
					signal?.addEventListener("abort", onAbort, { once: true });
				});
			},
		};

		const result = await supervisorTestApi?.runInteractiveSupervision({
			codexBin: "dist/bin/codex.js",
			initialArgs: ["resume", "prewarm-clean-exit"],
			buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
			runtime,
			pluginConfig: {},
			manager,
			signal: undefined,
			maxSessionRestarts: 1,
			spawnChild: () => new FakeChild(0),
			findBinding: async ({ sessionId }: { sessionId?: string }) => ({
				sessionId: sessionId ?? "prewarm-clean-exit",
				rolloutPath: null,
				lastActivityAtMs: Date.now(),
			}),
		});

		expect(result).toBe(0);
		expect(preparedProbeSignal?.aborted).toBe(true);
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

	it("treats another caller's probe abort as unavailable instead of aborting live waiters", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_SNAPSHOT_CACHE_TTL_MS = "5000";
		const manager = new FakeManager();
		const calls: string[] = [];
		const probeStarted = createDeferred<void>();
		const runtime = createFakeRuntime(manager, {
			delayByAccountId: new Map([["near-limit", 80]]),
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
		const firstController = new AbortController();
		const secondController = new AbortController();

		await supervisorTestApi?.clearProbeSnapshotCache(account);
		const first = supervisorTestApi?.probeAccountSnapshot(
			runtime,
			account,
			firstController.signal,
			250,
		);
		await probeStarted.promise;
		const second = supervisorTestApi?.probeAccountSnapshot(
			runtime,
			account,
			secondController.signal,
			250,
		);

		firstController.abort();

		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		await expect(second).rejects.toMatchObject({
			name: "QuotaProbeUnavailableError",
		});
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

	it("commits the prepared account after the stored token refreshes before cutover", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS = "40";

		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			kill = vi.fn((_signal: string) => {
				setTimeout(() => {
					this.exitCode = 0;
					this.emit("exit", 0, null);
				}, 0);
				return true;
			});
		}

		const calls: string[] = [];
		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager, {
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
		const stalePreparedAccount = prepared?.nextReady?.account
			? { ...prepared.nextReady.account }
			: null;
		expect(stalePreparedAccount).toMatchObject({
			accountId: "healthy",
			refreshToken: "rt-healthy",
		});
		expect(calls).toEqual(["healthy"]);

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
		const refreshedStoredAccount = manager.getAccountByIndex(1);
		expect(refreshedStoredAccount).not.toBeNull();
		if (!refreshedStoredAccount) {
			return;
		}
		refreshedStoredAccount.refreshToken = "rt-healthy-refreshed";
		refreshedStoredAccount.access = "token-2-refreshed";
		await supervisorTestApi?.requestChildRestart(new FakeChild(), "win32");

		const committed = await supervisorTestApi?.commitPreparedSelection(
			runtime,
			stalePreparedAccount,
			undefined,
		);

		expect(committed).toMatchObject({
			ok: true,
			account: {
				accountId: "healthy",
				refreshToken: "rt-healthy-refreshed",
				access: "token-2-refreshed",
			},
		});
		expect(calls).toEqual(["healthy"]);
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

	it("preserves caller CLI options when rebuilding resume args after rotation", async () => {
		class FakeChild extends EventEmitter {
			exitCode: number | null = null;

			constructor(exitCode: number) {
				super();
				setTimeout(() => {
					this.exitCode = exitCode;
					this.emit("exit", exitCode, null);
				}, 0);
			}

			kill(_signal: string) {
				return true;
			}
		}

		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager);
		const spawnedArgs: string[][] = [];
		const exitCodes = [1, 0];

		const result = await supervisorTestApi?.runInteractiveSupervision({
			codexBin: "dist/bin/codex.js",
			initialArgs: [
				"-c",
				'profile="dev"',
				"resume",
				"seed-session",
				"-c",
				'cli_auth_credentials_store="file"',
			],
			buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
			runtime,
			pluginConfig: {},
			manager,
			signal: undefined,
			maxSessionRestarts: 2,
			spawnChild: (_codexBin: string, args: string[]) => {
				spawnedArgs.push([...args]);
				return new FakeChild(exitCodes.shift() ?? 0);
			},
			findBinding: async ({ sessionId }: { sessionId?: string }) =>
				sessionId
					? {
							sessionId,
							rolloutPath: null,
							lastActivityAtMs: Date.now(),
						}
					: null,
		});

		expect(result).toBe(0);
		expect(spawnedArgs).toEqual([
			[
				"-c",
				'profile="dev"',
				"resume",
				"seed-session",
				"-c",
				'cli_auth_credentials_store="file"',
			],
			[
				"-c",
				'profile="dev"',
				"resume",
				"seed-session",
				"-c",
				'cli_auth_credentials_store="file"',
			],
		]);
	});

	it("starts degraded candidate probes in the same batch before waiting on results", async () => {
		const manager = new FakeManager([
			{ accountId: "degraded-1", access: "token-1" },
			{ accountId: "degraded-2", access: "token-2" },
			{ accountId: "degraded-3", access: "token-3" },
			{ accountId: "healthy", access: "token-4" },
		]);
		const degradedProbeGate = createDeferred<void>();
		const firstProbeStarted = createDeferred<void>();
		const allProbesStarted = createDeferred<void>();
		const startedAccounts = new Set<string>();
		const runtime = createFakeRuntime(manager, {
			quotaProbeDelayMs: 70,
			waitForFetchByAccountId: new Map([
				["degraded-1", degradedProbeGate.promise],
				["degraded-2", degradedProbeGate.promise],
				["degraded-3", degradedProbeGate.promise],
			]),
			onFetchStart(accountId) {
				if (accountId.startsWith("degraded-")) {
					startedAccounts.add(accountId);
					if (startedAccounts.size === 1) {
						firstProbeStarted.resolve();
					}
					if (startedAccounts.size === 3) {
						allProbesStarted.resolve();
					}
				}
			},
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

		const pendingResult = supervisorTestApi?.ensureLaunchableAccount(
			runtime,
			{},
			undefined,
			{ probeTimeoutMs: 250 },
		);
		await firstProbeStarted.promise;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error("Timed out waiting for degraded probes to start"));
			}, 250);
			allProbesStarted.promise.then(
				() => {
					clearTimeout(timeout);
					resolve();
				},
				(error) => {
					clearTimeout(timeout);
					reject(error);
				},
			);
		});
		expect([...startedAccounts].sort()).toEqual([
			"degraded-1",
			"degraded-2",
			"degraded-3",
		]);
		degradedProbeGate.resolve();
		const result = await pendingResult;

		expect(result).toMatchObject({
			ok: true,
			account: { accountId: "healthy" },
		});
		expect(manager.activeIndex).toBe(3);
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

	it.each([
		["--help"],
		["--version"],
	])(
		"bypasses supervisor account gating for top-level %s flags before account selection",
		async (flag) => {
			const loadFromDisk = vi.fn(async () => {
				throw new Error("ensureLaunchableAccount should not run for top-level help/version");
			});
			const forwardToRealCodex = vi.fn(async () => 0);

			await expect(
				supervisorTestApi?.runCodexSupervisorWithRuntime({
					codexBin: "dist/bin/codex.js",
					rawArgs: [flag],
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
			expect(forwardToRealCodex).toHaveBeenCalledWith("dist/bin/codex.js", [flag]);
			expect(loadFromDisk).not.toHaveBeenCalled();
		},
	);

	it("does not bypass supervisor account gating for nested version flags after --", async () => {
		const loadFromDisk = vi.fn(async () => {
			throw new Error("ensureLaunchableAccount reached");
		});
		const forwardToRealCodex = vi.fn(async () => 0);

		await expect(
			supervisorTestApi?.runCodexSupervisorWithRuntime({
				codexBin: "dist/bin/codex.js",
				rawArgs: ["exec", "--", "--version"],
				buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
				forwardToRealCodex,
				runtime: {
					loadPluginConfig: () => ({ codexCliSessionSupervisor: true }),
					getCodexCliSessionSupervisor: () => true,
					AccountManager: { loadFromDisk },
				},
				signal: undefined,
			}),
		).rejects.toThrow("ensureLaunchableAccount reached");
		expect(forwardToRealCodex).not.toHaveBeenCalled();
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

	it("returns 1 when no launchable account is available before the first spawn", async () => {
		const manager = new FakeManager([
			{
				accountId: "cool-1",
				access: "token-1",
				coolingDownUntil: Date.now() + 60_000,
			},
			{
				accountId: "cool-2",
				access: "token-2",
				coolingDownUntil: Date.now() + 120_000,
			},
		]);
		const runtime = {
			...createFakeRuntime(manager),
			loadPluginConfig() {
				return { codexCliSessionSupervisor: true };
			},
			getCodexCliSessionSupervisor() {
				return true;
			},
			getRetryAllAccountsRateLimited() {
				return false;
			},
		};
		const forwardToRealCodex = vi.fn(async () => 0);

		await expect(
			supervisorTestApi?.runCodexSupervisorWithRuntime({
				codexBin: "dist/bin/codex.js",
				rawArgs: ["chat"],
				buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
				forwardToRealCodex,
				runtime,
				signal: undefined,
			}),
		).resolves.toBe(1);
		expect(forwardToRealCodex).not.toHaveBeenCalled();
	});

	it(
		"stops waiting on the child when the outer signal aborts",
		{ timeout: 10_000 },
		async () => {
			process.env.CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS = "10";

			class HangingChild extends EventEmitter {
				exitCode: number | null = null;
				killSignals: string[] = [];
				kill = vi.fn((signal: string) => {
					this.killSignals.push(signal);
					setTimeout(() => {
						this.exitCode = 130;
						this.emit("exit", 130, signal);
					}, 0);
					return true;
				});
			}

			const manager = new FakeManager();
			const runtime = {
				...createFakeRuntime(manager),
				getPreemptiveQuotaEnabled() {
					return false;
				},
			};
			const controller = new AbortController();
			const child = new HangingChild();
			const runPromise = supervisorTestApi?.runInteractiveSupervision({
				codexBin: "dist/bin/codex.js",
				initialArgs: ["chat"],
				buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
				runtime,
				pluginConfig: {},
				manager,
				signal: controller.signal,
				maxSessionRestarts: 1,
				spawnChild: () => child,
			});

			setTimeout(() => controller.abort(), 10);

			await expect(runPromise).resolves.toBe(130);
			expect(child.kill).toHaveBeenCalled();
			expect(child.killSignals.length).toBeGreaterThan(0);
		},
	);

	it("cleans up the parent abort listener for each linked abort controller", () => {
		const controller = new AbortController();
		const addSpy = vi.spyOn(controller.signal, "addEventListener");
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

		try {
			const first = supervisorTestApi?.createLinkedAbortController(
				controller.signal,
			);
			first?.cleanup();
			const second = supervisorTestApi?.createLinkedAbortController(
				controller.signal,
			);
			second?.cleanup();

			expect(addSpy).toHaveBeenCalledTimes(2);
			expect(removeSpy).toHaveBeenCalledTimes(2);
		} finally {
			addSpy.mockRestore();
			removeSpy.mockRestore();
		}
	});

	it.each([
		[
			"throws",
			() => {
				throw new Error("boom");
			},
			/Failed to resolve supervisor storage path via runtime\.getStoragePath\(\): boom/,
		],
		[
			"returns empty whitespace",
			() => "   ",
			/Failed to resolve supervisor storage path via runtime\.getStoragePath\(\): received an empty path/,
		],
	])(
		"does not fall back to the default Codex home lock path when runtime.getStoragePath %s",
		async (_label, getStoragePath, expectedError) => {
			const codexHome = createTempDir();
			process.env.CODEX_HOME = codexHome;
			const loadFromDisk = vi.fn(async () => new FakeManager());
			const runtime = {
				AccountManager: { loadFromDisk },
				getStoragePath,
			};
			const defaultLockPath = join(
				codexHome,
				"multi-auth",
				"openai-codex-accounts.json.supervisor.lock",
			);

			await expect(
				supervisorTestApi?.withLockedManager(runtime, async () => "ok", undefined),
			).rejects.toThrow(expectedError);
			expect(loadFromDisk).not.toHaveBeenCalled();
			await expect(fs.access(defaultLockPath)).rejects.toMatchObject({
				code: "ENOENT",
			});
		},
	);

	it("renews the supervisor storage lock while a critical section is still running", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_LOCK_TTL_MS = "40";
		process.env.CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS = "5";
		process.env.CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS = "500";

		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager);
		const firstEntered = createDeferred<void>();
		const releaseFirst = createDeferred<void>();
		let firstReleased = false;
		let secondEntered = false;

		const first = supervisorTestApi?.withLockedManager(
			runtime,
			async () => {
				firstEntered.resolve();
				await releaseFirst.promise;
				firstReleased = true;
				return "first";
			},
			undefined,
		);
		await firstEntered.promise;

		const second = supervisorTestApi?.withLockedManager(
			runtime,
			async () => {
				secondEntered = true;
				expect(firstReleased).toBe(true);
				return "second";
			},
			undefined,
		);

		await new Promise((resolve) => setTimeout(resolve, 140));
		expect(secondEntered).toBe(false);

		releaseFirst.resolve();
		await expect(Promise.all([first, second])).resolves.toEqual([
			"first",
			"second",
		]);
	});

	it(
		"fails fast when the supervisor lock heartbeat loses the lease mid-section",
		{ timeout: 10_000 },
		async () => {
			process.env.CODEX_AUTH_CLI_SESSION_LOCK_TTL_MS = "30";
			process.env.CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS = "200";

			const manager = new FakeManager();
			const runtime = createFakeRuntime(manager);
			const entered = createDeferred<void>();
			const observedAbort = createDeferred<void>();
			const lifecycle: string[] = [];
			let firstExited = false;
			let secondEntered = false;
			const criticalSection = supervisorTestApi?.withLockedManager(
				runtime,
				async (_freshManager, lockSignal) => {
					entered.resolve();
					await new Promise<void>((resolve) => {
						lockSignal?.addEventListener(
							"abort",
							() => {
								lifecycle.push("first-abort-observed");
								observedAbort.resolve();
								resolve();
							},
							{ once: true },
						);
					});
					expect(lockSignal?.aborted).toBe(true);
					firstExited = true;
					lifecycle.push("first-exit");
					return "held";
				},
				undefined,
			);
			await entered.promise;

			const lockPath = supervisorTestApi?.getSupervisorStorageLockPath(runtime);
			expect(lockPath).toBeTruthy();
			if (!lockPath) {
				return;
			}
			await fs.unlink(lockPath);
			await observedAbort.promise;

			const secondSection = supervisorTestApi?.withLockedManager(
				runtime,
				async () => {
					secondEntered = true;
					expect(firstExited).toBe(true);
					lifecycle.push("second-after-first-exit");
					return "second";
				},
				undefined,
			);

			await expect(criticalSection).rejects.toThrow(
				`Supervisor lock heartbeat lost lease at ${lockPath} for owner`,
			);
			await expect(secondSection).resolves.toBe("second");
			expect(secondEntered).toBe(true);
			expect(lifecycle).toEqual([
				"first-abort-observed",
				"first-exit",
				"second-after-first-exit",
			]);
		},
	);

	it(
		"returns a failure exit code when the monitor loop fails after startup",
		{ timeout: 10_000 },
		async () => {
			class FakeChild extends EventEmitter {
				exitCode: number | null = null;

				constructor(exitCode: number) {
					super();
					setTimeout(() => {
						this.exitCode = exitCode;
						this.emit("exit", exitCode, null);
					}, 25);
				}

				kill(_signal: string) {
					return true;
				}
			}

			const stderrSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			const manager = new FakeManager();
			const runtime = createFakeRuntime(manager);

			try {
				const result = await supervisorTestApi?.runInteractiveSupervision({
					codexBin: "dist/bin/codex.js",
					initialArgs: ["resume", "monitor-failure-session"],
					buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
					runtime,
					pluginConfig: {},
					manager,
					signal: undefined,
					maxSessionRestarts: 1,
					spawnChild: () => new FakeChild(0),
					findBinding: async ({ sessionId }: { sessionId?: string }) => ({
						sessionId: sessionId ?? "monitor-failure-session",
						rolloutPath: null,
						lastActivityAtMs: Date.now(),
					}),
					loadCurrentState: async () => {
						throw new Error("Timed out waiting for supervisor storage lock");
					},
				});

				expect(result).toBe(1);
				expect(stderrSpy).toHaveBeenCalledWith(
					expect.stringContaining("monitor loop failed: Timed out waiting for supervisor storage lock"),
				);
			} finally {
				stderrSpy.mockRestore();
			}
		},
	);

	it(
		"logs monitor loop failures even when the outer signal is already aborted",
		{ timeout: 10_000 },
		async () => {
			const controller = new AbortController();
			class FakeChild extends EventEmitter {
				exitCode: number | null = null;

				constructor(exitCode: number) {
					super();
					setTimeout(() => {
						this.exitCode = exitCode;
						this.emit("exit", exitCode, null);
					}, 25);
				}

				kill(_signal: string) {
					return true;
				}
			}

			const stderrSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			const manager = new FakeManager();
			const runtime = createFakeRuntime(manager);

			try {
				await expect(
					supervisorTestApi?.runInteractiveSupervision({
						codexBin: "dist/bin/codex.js",
						initialArgs: ["resume", "monitor-failure-aborted-session"],
						buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
						runtime,
						pluginConfig: {},
						manager,
						signal: controller.signal,
						maxSessionRestarts: 1,
						spawnChild: () => new FakeChild(0),
						findBinding: async ({ sessionId }: { sessionId?: string }) => ({
							sessionId: sessionId ?? "monitor-failure-aborted-session",
							rolloutPath: null,
							lastActivityAtMs: Date.now(),
						}),
						loadCurrentState: async () => {
							controller.abort();
							throw new Error("Timed out waiting for supervisor storage lock");
						},
					}),
				).rejects.toMatchObject({ name: "AbortError" });
				expect(stderrSpy).toHaveBeenCalledWith(
					expect.stringContaining(
						"monitor loop failed: Timed out waiting for supervisor storage lock",
					),
				);
			} finally {
				stderrSpy.mockRestore();
			}
		},
	);

	it("cools down accounts when the quota probe is unavailable", async () => {
		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager, {
			onFetch(accountId) {
				if (accountId === "near-limit") {
					const error = new Error("quota probe unavailable");
					error.name = "QuotaProbeUnavailableError";
					throw error;
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
		expect(manager.getAccountByIndex(0)?.coolingDownUntil).toBeGreaterThan(0);
		expect(manager.activeIndex).toBe(1);
	});

	it("does not unlink a refreshed lock when the owner heartbeat extends it", async () => {
		const lockPath = join(createTempDir(), "supervisor.lock");
		const ownerId = "owner-1";
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				ownerId,
				acquiredAt: Date.now() - 500,
				expiresAt: Date.now() + 30_000,
			}),
		);

		const removed = await supervisorTestApi?.safeUnlinkOwnedSupervisorLock(
			lockPath,
			ownerId,
			Date.now() - 1_000,
		);

		expect(removed).toBe(false);
		await expect(fs.access(lockPath)).resolves.toBeUndefined();
	});

	it("strips CODEX_AUTH_* variables from the child process env", () => {
		const childEnv = supervisorTestApi?.buildCodexChildEnv({
			PATH: "C:/bin",
			HOME: "C:/Users/neil",
			CODEX_AUTH_REFRESH_TOKEN: "secret",
			CODEX_AUTH_CLI_SESSION_SUPERVISOR: "1",
		});

		expect(childEnv).toMatchObject({
			PATH: "C:/bin",
			HOME: "C:/Users/neil",
		});
		expect(childEnv?.CODEX_AUTH_REFRESH_TOKEN).toBeUndefined();
		expect(childEnv?.CODEX_AUTH_CLI_SESSION_SUPERVISOR).toBeUndefined();
	});

	it("honors the account-selection-attempt env override at call time", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_MAX_ACCOUNT_SELECTION_ATTEMPTS = "1";

		const manager = new FakeManager([
			{ accountId: "retry-a", access: "token-a" },
			{ accountId: "retry-b", access: "token-b" },
		]);
		let fetchAttempts = 0;
		const runtime = createFakeRuntime(manager, {
			onFetch() {
				fetchAttempts += 1;
				const error = new Error("quota probe unavailable");
				error.name = "QuotaProbeUnavailableError";
				throw error;
			},
		});

		const result = await supervisorTestApi?.ensureLaunchableAccount(
			runtime,
			{},
			undefined,
			{ probeTimeoutMs: 250 },
		);

		expect(result?.ok).toBe(false);
		expect(result?.account).toBeNull();
		expect(result?.aborted).toBeUndefined();
		expect(fetchAttempts).toBe(2);
	});

	it(
		"paces repeated quota probe outages instead of hot-looping the monitor",
		{ timeout: 10_000 },
		async () => {
			process.env.CODEX_AUTH_CLI_SESSION_SUPERVISOR_POLL_MS = "30";

			class HangingChild extends EventEmitter {
				exitCode: number | null = null;
				kill = vi.fn((signal: string) => {
					setTimeout(() => {
						this.exitCode = 130;
						this.emit("exit", 130, signal);
					}, 0);
					return true;
				});
			}

			const manager = new FakeManager();
			const controller = new AbortController();
			let fetchAttempts = 0;
			const runtime = createFakeRuntime(manager, {
				onFetch(accountId) {
					if (accountId === "near-limit") {
						fetchAttempts += 1;
						if (fetchAttempts === 2) {
							controller.abort();
						}
						throw new Error("quota endpoint unavailable");
					}
				},
			});
			const child = new HangingChild();

			const runPromise = supervisorTestApi?.runInteractiveSupervision({
				codexBin: "dist/bin/codex.js",
				initialArgs: ["chat"],
				buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
				runtime,
				pluginConfig: {},
				manager,
				signal: controller.signal,
				maxSessionRestarts: 1,
				spawnChild: () => child,
				loadCurrentState: async () => ({
					manager,
					currentAccount: manager.getCurrentAccountForFamily(),
				}),
				waitForBinding: async () => ({
					sessionId: "probe-unavailable-session",
					rolloutPath: null,
					lastActivityAtMs: Date.now(),
				}),
				refreshBinding: async (binding: {
					sessionId: string;
					rolloutPath: string | null;
					lastActivityAtMs: number;
				}) => binding,
			});

			for (let attempt = 0; attempt < 20 && fetchAttempts === 0; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(fetchAttempts).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fetchAttempts).toBe(1);
			await expect(runPromise).rejects.toMatchObject({
				name: "AbortError",
				message: "Supervisor storage lock wait aborted",
			});
			expect(fetchAttempts).toBe(2);
			expect(child.kill).toHaveBeenCalled();
		},
	);

	it("honors the restart-limit env override at call time", async () => {
		process.env.CODEX_AUTH_CLI_SESSION_MAX_RESTARTS = "1";

		class ImmediateChild extends EventEmitter {
			exitCode: number | null = 0;

			constructor() {
				super();
				queueMicrotask(() => {
					this.emit("exit", 0, null);
				});
			}

			kill(_signal: string) {
				return true;
			}
		}

		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager);
		const spawnChild = vi.fn(() => new ImmediateChild());

		const result = await supervisorTestApi?.runInteractiveSupervision({
			codexBin: "dist/bin/codex.js",
			initialArgs: ["chat"],
			buildForwardArgs: (rawArgs: string[]) => [...rawArgs],
			runtime,
			pluginConfig: {},
			manager,
			signal: undefined,
			spawnChild,
		});

		expect(result).toBe(0);
		expect(spawnChild).toHaveBeenCalledTimes(1);
	});

	it("syncs startup state before the first interactive launch", async () => {
		class ImmediateChild extends EventEmitter {
			exitCode: number | null = 0;

			constructor() {
				super();
				queueMicrotask(() => {
					this.emit("exit", 0, null);
				});
			}

			kill(_signal: string) {
				return true;
			}
		}

		const manager = new FakeManager();
		const runtime = createFakeRuntime(manager);
		const events: string[] = [];
		const syncBeforeLaunch = vi.fn(async () => {
			events.push("sync");
		});
		const spawnChild = vi.fn(() => {
			events.push("spawn");
			return new ImmediateChild();
		});

		const result = await supervisorTestApi?.runInteractiveSupervision({
			codexBin: "dist/bin/codex.js",
			initialArgs: ["chat"],
			runtime,
			pluginConfig: {},
			manager,
			signal: undefined,
			spawnChild,
			syncBeforeLaunch,
		});

		expect(result).toBe(0);
		expect(syncBeforeLaunch).toHaveBeenCalledTimes(1);
		expect(spawnChild).toHaveBeenCalledTimes(1);
		expect(events).toEqual(["sync", "spawn"]);
	});

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
