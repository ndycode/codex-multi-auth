import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { __testOnly } from "../scripts/codex-supervisor.js";
import { removeWithRetry } from "../scripts/remove-with-retry.js";

const createdDirs: string[] = [];
const supervisorTestApi = __testOnly!;
type LockState = {
	activeIndex: number;
	blockedUntilByIndex: Record<string, number>;
};
type LockAccount = {
	index: number;
	refreshToken: string;
	accountId: string;
	email: string;
};

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-supervisor-test-"));
	createdDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of createdDirs.splice(0, createdDirs.length).reverse()) {
		await removeWithRetry(dir, { recursive: true, force: true });
	}
});

function withLockEnv<T>(overrides: Record<string, string>, run: () => Promise<T>): Promise<T> {
	const keys = Object.keys(overrides);
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(overrides)) {
		process.env[key] = value;
	}

	return run().finally(() => {
		for (const key of keys) {
			const value = previous.get(key);
			if (typeof value === "string") {
				process.env[key] = value;
			} else {
				delete process.env[key];
			}
		}
	});
}

describe("codex supervisor internals", () => {
	it("interrupts abortable sleeps immediately", async () => {
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending = supervisorTestApi.sleep(10_000, controller.signal);
		setTimeout(() => controller.abort(), 25);

		await expect(pending).resolves.toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	it("reloads the latest manager state while holding the supervisor storage lock", async () => {
		const dir = createTempDir();
		const storagePath = join(dir, "openai-codex-accounts.json");
		await fs.writeFile(
			storagePath,
			JSON.stringify({
				activeIndex: 0,
				blockedUntilByIndex: {},
			}),
			"utf8",
		);

		class FakeManager {
			state: LockState;
			accounts: LockAccount[];

			constructor(state: LockState) {
				this.state = state;
				this.accounts = [
					{ index: 0, refreshToken: "refresh-1", accountId: "acc-1", email: "one@example.com" },
					{ index: 1, refreshToken: "refresh-2", accountId: "acc-2", email: "two@example.com" },
				];
			}

			getAccountByIndex(index: number): LockAccount | null {
				return this.accounts[index] ?? null;
			}

			markRateLimitedWithReason(account: LockAccount, waitMs: number) {
				this.state.blockedUntilByIndex[account.index] = Date.now() + waitMs;
			}

			setActiveIndex(index: number) {
				this.state.activeIndex = index;
			}

			async saveToDisk() {
				await fs.writeFile(storagePath, JSON.stringify(this.state), "utf8");
			}

			static async loadFromDisk() {
				const raw = JSON.parse(await fs.readFile(storagePath, "utf8"));
				return new FakeManager(raw);
			}
		}

		const runtime = {
			AccountManager: FakeManager,
			getStoragePath: () => storagePath,
		};

		await Promise.all([
			supervisorTestApi.withLockedManager(runtime, async (manager) => {
				manager.markRateLimitedWithReason(manager.getAccountByIndex(0), 30_000);
				await supervisorTestApi.sleep(100);
				await manager.saveToDisk();
			}),
			supervisorTestApi.withLockedManager(runtime, async (manager) => {
				manager.setActiveIndex(1);
				await manager.saveToDisk();
			}),
		]);

		const finalState = JSON.parse(await fs.readFile(storagePath, "utf8"));
		expect(finalState.activeIndex).toBe(1);
		expect(finalState.blockedUntilByIndex["0"]).toBeTypeOf("number");
	});

	it("times out when another process keeps the supervisor storage lock", async () => {
		const dir = createTempDir();
		const storagePath = join(dir, "openai-codex-accounts.json");
		const runtime = {
			AccountManager: class FakeManager {
				static async loadFromDisk() {
					return {
						async saveToDisk() {},
					};
				}
			},
			getStoragePath: () => storagePath,
		};
		const lockPath = supervisorTestApi.getSupervisorStorageLockPath(runtime);
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				expiresAt: Date.now() + 60_000,
			}),
			"utf8",
		);

		await withLockEnv(
			{
				CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS: "50",
				CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS: "10",
				CODEX_AUTH_CLI_SESSION_LOCK_TTL_MS: "60000",
			},
			async () => {
				await expect(
					supervisorTestApi.withLockedManager(runtime, async () => "unreachable"),
				).rejects.toThrow(/Timed out waiting for supervisor storage lock/);
			},
		);
	});

	it("aborts lock polling when the caller signal is cancelled", async () => {
		const dir = createTempDir();
		const storagePath = join(dir, "openai-codex-accounts.json");
		const runtime = {
			AccountManager: class FakeManager {
				static async loadFromDisk() {
					return {
						async saveToDisk() {},
					};
				}
			},
			getStoragePath: () => storagePath,
		};
		const lockPath = supervisorTestApi.getSupervisorStorageLockPath(runtime);
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				expiresAt: Date.now() + 60_000,
			}),
			"utf8",
		);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 25);

		await withLockEnv(
			{
				CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS: "1000",
				CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS: "50",
				CODEX_AUTH_CLI_SESSION_LOCK_TTL_MS: "60000",
			},
			async () => {
				await expect(
					supervisorTestApi.withLockedManager(runtime, async () => "unreachable", controller.signal),
				).rejects.toMatchObject({ name: "AbortError" });
			},
		);
	});

	it("evicts expired supervisor locks before mutating state", async () => {
		const dir = createTempDir();
		const storagePath = join(dir, "openai-codex-accounts.json");
		await fs.writeFile(storagePath, JSON.stringify({ activeIndex: 0 }), "utf8");

		class FakeManager {
			constructor(state: { activeIndex: number }) {
				this.state = state;
			}

			state: { activeIndex: number };

			setActiveIndex(index: number) {
				this.state.activeIndex = index;
			}

			async saveToDisk() {
				await fs.writeFile(storagePath, JSON.stringify(this.state), "utf8");
			}

			static async loadFromDisk() {
				const raw = JSON.parse(await fs.readFile(storagePath, "utf8"));
				return new FakeManager(raw);
			}
		}

		const runtime = {
			AccountManager: FakeManager,
			getStoragePath: () => storagePath,
		};
		const lockPath = supervisorTestApi.getSupervisorStorageLockPath(runtime);
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				expiresAt: Date.now() - 1_000,
			}),
			"utf8",
		);

		await withLockEnv(
			{
				CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS: "50",
				CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS: "10",
				CODEX_AUTH_CLI_SESSION_LOCK_TTL_MS: "50",
			},
			async () => {
				await supervisorTestApi.withLockedManager(runtime, async (manager) => {
					manager.setActiveIndex(1);
					await manager.saveToDisk();
				});
			},
		);

		const finalState = JSON.parse(await fs.readFile(storagePath, "utf8"));
		expect(finalState.activeIndex).toBe(1);
		await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects flag-like resume ids and skips unsafe session payload ids", async () => {
		expect(supervisorTestApi.readResumeSessionId(["resume", "--bad-flag"])).toBeNull();
		expect(supervisorTestApi.isValidSessionId("safe_session-01")).toBe(true);
		expect(supervisorTestApi.isValidSessionId("--bad-flag")).toBe(false);

		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		await fs.writeFile(
			filePath,
			[
				JSON.stringify({
					session_meta: {
						payload: { id: "--bad-flag", cwd: dir },
					},
				}),
				JSON.stringify({
					session_meta: {
						payload: { id: "safe_session-01", cwd: dir },
					},
				}),
			].join("\n"),
			"utf8",
		);

		await expect(supervisorTestApi.extractSessionMeta(filePath)).resolves.toEqual({
			sessionId: "safe_session-01",
			cwd: dir,
		});
	});

	it("finds session metadata after a verbose preamble", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "verbose-session.jsonl");
		const preamble = Array.from({ length: 120 }, (_, index) =>
			JSON.stringify({ type: "event", seq: index + 1 }),
		);
		await fs.writeFile(
			filePath,
			[
				...preamble,
				JSON.stringify({
					session_meta: {
						payload: { id: "safe_session-verbose", cwd: dir },
					},
				}),
			].join("\n"),
			"utf8",
		);

		await expect(supervisorTestApi.extractSessionMeta(filePath)).resolves.toEqual({
			sessionId: "safe_session-verbose",
			cwd: dir,
		});
	});

	it("scans only the bounded prefix of large session logs", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "large-session.jsonl");
		const preamble = Array.from({ length: 80 }, (_, index) =>
			JSON.stringify({ type: "event", seq: index + 1 }),
		);
		const verboseTail = Array.from({ length: 5_000 }, (_, index) =>
			JSON.stringify({ type: "output", seq: index + 1, text: "x".repeat(32) }),
		);
		await fs.writeFile(
			filePath,
			[
				...preamble,
				JSON.stringify({
					session_meta: {
						payload: { id: "safe_session-large", cwd: dir },
					},
				}),
				...verboseTail,
			].join("\n"),
			"utf8",
		);

		await expect(supervisorTestApi.extractSessionMeta(filePath)).resolves.toEqual({
			sessionId: "safe_session-large",
			cwd: dir,
		});
	});

	it("misses session metadata at the first non-empty line beyond the scan limit", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "over-limit-session.jsonl");
		const preamble = Array.from({ length: 200 }, (_, index) =>
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

		await expect(supervisorTestApi.extractSessionMeta(filePath)).resolves.toBeNull();
	});

	it("keeps same-cwd session metadata isolated per rollout file", async () => {
		const dir = createTempDir();
		const cwd = join(dir, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		const fileA = join(dir, "session-A.jsonl");
		const fileB = join(dir, "session-B.jsonl");
		const preambleA = Array.from({ length: 40 }, (_, index) =>
			JSON.stringify({ type: "event", seq: index + 1, stream: "A" }),
		);
		const preambleB = Array.from({ length: 75 }, (_, index) =>
			JSON.stringify({ type: "event", seq: index + 1, stream: "B" }),
		);

		await fs.writeFile(
			fileA,
			[
				...preambleA,
				JSON.stringify({
					session_meta: {
						payload: { id: "same-cwd-session-a", cwd },
					},
				}),
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			fileB,
			[
				...preambleB,
				JSON.stringify({
					session_meta: {
						payload: { id: "same-cwd-session-b", cwd },
					},
				}),
			].join("\n"),
			"utf8",
		);

		await expect(supervisorTestApi.extractSessionMeta(fileA)).resolves.toEqual({
			sessionId: "same-cwd-session-a",
			cwd,
		});
		await expect(supervisorTestApi.extractSessionMeta(fileB)).resolves.toEqual({
			sessionId: "same-cwd-session-b",
			cwd,
		});
	});

	it("ignores blank cwd rollout files when binding by cwd", async () => {
		const sessionsDir = createTempDir();
		const cwd = createTempDir();
		const sessionRoot = join(sessionsDir, "2026", "03", "20");
		await fs.mkdir(sessionRoot, { recursive: true });
		const blankPath = join(sessionRoot, "blank.jsonl");
		const validPath = join(sessionRoot, "valid.jsonl");

		await fs.writeFile(
			validPath,
			JSON.stringify({
				session_meta: {
					payload: { id: "valid-session", cwd },
				},
			}),
			"utf8",
		);
		await fs.writeFile(
			blankPath,
			JSON.stringify({
				session_meta: {
					payload: { id: "blank-session", cwd: "   " },
				},
			}),
			"utf8",
		);
		const now = new Date();
		await fs.utimes(validPath, now, now);
		await fs.utimes(blankPath, new Date(now.getTime() + 1_000), new Date(now.getTime() + 1_000));

		await withLockEnv(
			{
				CODEX_MULTI_AUTH_CLI_SESSIONS_DIR: sessionsDir,
			},
			async () => {
				await expect(
					supervisorTestApi.findSessionBinding({
						cwd,
						sinceMs: 0,
						sessionId: null,
					}),
				).resolves.toEqual(
					expect.objectContaining({
						sessionId: "valid-session",
						rolloutPath: validPath,
					}),
				);
			},
		);
	});

	it("aborts rate-limit waits while selecting a launchable account", async () => {
		const dir = createTempDir();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 25);

		const runtime = {
			getRetryAllAccountsRateLimited: () => true,
			getStoragePath: () => join(dir, "openai-codex-accounts.json"),
			AccountManager: class FakeManager {
				static async loadFromDisk() {
					return {
						getCurrentOrNextForFamilyHybrid() {
							return null;
						},
						getMinWaitTimeForFamily() {
							return 10_000;
						},
					};
				}
			},
		};

		await expect(
			supervisorTestApi.ensureLaunchableAccount(runtime, {}, controller.signal),
		).resolves.toMatchObject({
			ok: false,
			aborted: true,
		});
	});

	it("aborts an in-flight quota probe while selecting a launchable account", async () => {
		const dir = createTempDir();
		const controller = new AbortController();
		const candidate = {
			index: 0,
			accountId: "acc-1",
			access: "access-1",
		};

		const runtime = {
			getRetryAllAccountsRateLimited: () => true,
			getStoragePath: () => join(dir, "openai-codex-accounts.json"),
			fetchCodexQuotaSnapshot: ({ signal }: { signal?: AbortSignal }) =>
				new Promise((_, reject) => {
					signal?.addEventListener(
						"abort",
						() => {
							const error = new Error("Quota probe aborted");
							error.name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				}),
			AccountManager: class FakeManager {
				static async loadFromDisk() {
					return {
						getCurrentOrNextForFamilyHybrid() {
							return candidate;
						},
						getAccountByIndex(index: number) {
							return index === candidate.index ? candidate : null;
						},
					};
				}
			},
		};

		const pending = supervisorTestApi.ensureLaunchableAccount(runtime, {}, controller.signal);
		setTimeout(() => controller.abort(), 25);

		await expect(pending).resolves.toMatchObject({
			ok: false,
			aborted: true,
		});
	});

	it("does not expose test helpers when imported outside test mode", () => {
		const scriptPath = join(process.cwd(), "scripts", "codex-supervisor.js");
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`process.env.NODE_ENV='production'; const mod = await import(${JSON.stringify(`file://${scriptPath.replace(/\\/g, "/")}`)}); console.log(String(mod.__testOnly));`,
			],
			{
				encoding: "utf8",
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("undefined");
	});

	it("skips SIGINT escalation on Windows restarts", async () => {
		const exitListeners: Array<() => void> = [];
		const signals: string[] = [];
		const child = {
			exitCode: null as number | null,
			once(event: string, listener: () => void) {
				if (event === "exit") {
					exitListeners.push(listener);
				}
			},
			kill(signal: string) {
				signals.push(signal);
				if (signal === "SIGTERM") {
					this.exitCode = 0;
					for (const listener of exitListeners.splice(0, exitListeners.length)) {
						listener();
					}
				}
			},
		};

		await supervisorTestApi.requestChildRestart(child, "win32");
		expect(signals).toEqual(["SIGTERM"]);
	});

	it("interrupts restart escalation waits when the caller aborts", async () => {
		const controller = new AbortController();
		const signals: string[] = [];
		const startedAt = Date.now();
		const child = {
			exitCode: null as number | null,
			once(_event: string, _listener: () => void) {},
			kill(signal: string) {
				signals.push(signal);
			},
		};

		await withLockEnv(
			{
				CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS: "1000",
			},
			async () => {
				const pending = supervisorTestApi.requestChildRestart(child, "win32", controller.signal);
				setTimeout(() => controller.abort(), 25);
				await pending;
			},
		);

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
