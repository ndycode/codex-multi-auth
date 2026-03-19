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
});
