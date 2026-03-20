import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testOnly } from "../scripts/codex-supervisor.js";

const createdDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-supervisor-test-"));
	createdDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of createdDirs.splice(0, createdDirs.length).reverse()) {
		rmSync(dir, { recursive: true, force: true });
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
		const pending = __testOnly.sleep(10_000, controller.signal);
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
			constructor(state) {
				this.state = state;
				this.accounts = [
					{ index: 0, refreshToken: "refresh-1", accountId: "acc-1", email: "one@example.com" },
					{ index: 1, refreshToken: "refresh-2", accountId: "acc-2", email: "two@example.com" },
				];
			}

			getAccountByIndex(index) {
				return this.accounts[index] ?? null;
			}

			markRateLimitedWithReason(account, waitMs) {
				this.state.blockedUntilByIndex[account.index] = Date.now() + waitMs;
			}

			setActiveIndex(index) {
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
			__testOnly.withLockedManager(runtime, async (manager) => {
				manager.markRateLimitedWithReason(manager.getAccountByIndex(0), 30_000);
				await __testOnly.sleep(100);
				await manager.saveToDisk();
			}),
			__testOnly.withLockedManager(runtime, async (manager) => {
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
		const lockPath = __testOnly.getSupervisorStorageLockPath(runtime);
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
					__testOnly.withLockedManager(runtime, async () => "unreachable"),
				).rejects.toThrow(/Timed out waiting for supervisor storage lock/);
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
		const lockPath = __testOnly.getSupervisorStorageLockPath(runtime);
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
				await __testOnly.withLockedManager(runtime, async (manager) => {
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
		expect(__testOnly.readResumeSessionId(["resume", "--bad-flag"])).toBeNull();
		expect(__testOnly.isValidSessionId("safe_session-01")).toBe(true);
		expect(__testOnly.isValidSessionId("--bad-flag")).toBe(false);

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

		await expect(__testOnly.extractSessionMeta(filePath)).resolves.toEqual({
			sessionId: "safe_session-01",
			cwd: dir,
		});
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

		await __testOnly.requestChildRestart(child, "win32");
		expect(signals).toEqual(["SIGTERM"]);
	});
});
