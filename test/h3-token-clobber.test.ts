import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { AccountManager } from "../lib/accounts.js";
import {
	setStoragePathDirect,
	type AccountStorageV3,
} from "../lib/storage.js";

// Stress audit H3: a routine saveToDisk() by one process must not clobber a
// single-use refresh token that a SECOND process rotated to disk meanwhile.
describe("H3 - cross-process token clobber protection", () => {
	const tmpDirs: string[] = [];
	const managers: AccountManager[] = [];

	function makeStoragePath(): string {
		const dir = mkdtempSync(join(tmpdir(), "h3-clobber-"));
		tmpDirs.push(dir);
		return join(dir, "openai-codex-accounts.json");
	}

	beforeEach(() => {
		setStoragePathDirect(null);
	});

	afterEach(async () => {
		for (const m of managers.splice(0, managers.length)) {
			await m.flushPendingSave();
		}
		setStoragePathDirect(null);
		for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
			try {
				await removeWithRetry(dir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	});

	it("preserves a refresh token another process rotated to disk during a routine save", async () => {
		const now = Date.now();
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					accountId: "acc-a",
					email: "a@example.com",
					refreshToken: "RT_A1",
					accessToken: "AT_A1",
					expiresAt: now + 60_000,
					addedAt: now,
					lastUsed: now,
				},
				{
					accountId: "acc-b",
					email: "b@example.com",
					refreshToken: "RT_B1",
					accessToken: "AT_B1",
					expiresAt: now + 60_000,
					addedAt: now,
					lastUsed: now,
				},
			],
		};
		const storagePath = makeStoragePath();
		writeFileSync(storagePath, JSON.stringify(storage), "utf8");
		setStoragePathDirect(storagePath);

		const proc1 = new AccountManager(undefined, storage);
		managers.push(proc1);

		// proc2 (simulated): rotates B's token and writes a NEWER copy to disk.
		const rotated = JSON.parse(
			readFileSync(storagePath, "utf8"),
		) as AccountStorageV3;
		const diskB = rotated.accounts[1]!;
		diskB.refreshToken = "RT_B2";
		diskB.accessToken = "AT_B2";
		diskB.expiresAt = now + 3_600_000;
		writeFileSync(storagePath, JSON.stringify(rotated), "utf8");

		// proc1 fires a routine save (touched only A in memory).
		await proc1.saveToDisk();

		const after = JSON.parse(
			readFileSync(storagePath, "utf8"),
		) as AccountStorageV3;
		const afterB = after.accounts.find((a) => a.accountId === "acc-b");
		expect(afterB?.refreshToken).toBe("RT_B2");
		expect(afterB?.accessToken).toBe("AT_B2");
	});
});
