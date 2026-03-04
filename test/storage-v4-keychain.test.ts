import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

describe("storage v4 keychain persistence", () => {
	let tempDir = "";
	const originalDir = process.env.CODEX_MULTI_AUTH_DIR;
	const originalMode = process.env.CODEX_SECRET_STORAGE_MODE;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-storage-v4-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		process.env.CODEX_SECRET_STORAGE_MODE = "keychain";
		vi.resetModules();
	});

	afterEach(async () => {
		vi.doUnmock("keytar");
		vi.restoreAllMocks();
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		if (originalMode === undefined) {
			delete process.env.CODEX_SECRET_STORAGE_MODE;
		} else {
			process.env.CODEX_SECRET_STORAGE_MODE = originalMode;
		}
		if (tempDir) {
			await removeWithRetry(tempDir, { recursive: true, force: true });
		}
	});

	it("writes refs to disk and resolves tokens from keychain", async () => {
		const secrets = new Map<string, string>();
		vi.doMock("keytar", () => ({
			setPassword: async (_service: string, account: string, password: string) => {
				secrets.set(account, password);
			},
			getPassword: async (_service: string, account: string) => secrets.get(account) ?? null,
			deletePassword: async (_service: string, account: string) => secrets.delete(account),
		}));

		const { saveAccounts, loadAccounts, getStoragePath } = await import("../lib/storage.js");

		await saveAccounts({
			version: 3,
			accounts: [
				{
					accountId: "acct_1",
					email: "user@example.com",
					refreshToken: "refresh-token-1",
					accessToken: "access-token-1",
					addedAt: 1,
					lastUsed: 2,
					enabled: true,
				},
			],
			activeIndex: 0,
		});

		const filePath = getStoragePath();
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as {
			version: number;
			accounts: Array<Record<string, unknown>>;
		};
		expect(parsed.version).toBe(4);
		expect(parsed.accounts[0]?.refreshToken).toBeUndefined();
		expect(parsed.accounts[0]?.refreshTokenRef).toBeTypeOf("string");

		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.refreshToken).toBe("refresh-token-1");
		expect(loaded?.accounts[0]?.accessToken).toBe("access-token-1");
	});
});
