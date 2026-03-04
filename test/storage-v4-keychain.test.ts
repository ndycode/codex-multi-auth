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

type KeytarMockState = {
	secrets: Map<string, string>;
};

function installKeytarMock(): KeytarMockState {
	const secrets = new Map<string, string>();
	const keytarModule = {
		setPassword: async (_service: string, account: string, password: string) => {
			secrets.set(account, password);
		},
		getPassword: async (_service: string, account: string) => secrets.get(account) ?? null,
		deletePassword: async (_service: string, account: string) => secrets.delete(account),
	};
	vi.doMock("keytar", () => ({
		...keytarModule,
		default: keytarModule,
	}));
	return { secrets };
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
		installKeytarMock();
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

	it("serializes concurrent saveAccounts calls without torn storage JSON", async () => {
		installKeytarMock();
		const { saveAccounts, loadAccounts, getStoragePath } = await import("../lib/storage.js");

		await Promise.all([
			saveAccounts({
				version: 3,
				accounts: [
					{
						accountId: "acct_a",
						email: "a@example.com",
						refreshToken: "refresh-token-a",
						accessToken: "access-token-a",
						addedAt: 11,
						lastUsed: 12,
						enabled: true,
					},
				],
				activeIndex: 0,
			}),
			saveAccounts({
				version: 3,
				accounts: [
					{
						accountId: "acct_b",
						email: "b@example.com",
						refreshToken: "refresh-token-b",
						accessToken: "access-token-b",
						addedAt: 21,
						lastUsed: 22,
						enabled: true,
					},
				],
				activeIndex: 0,
			}),
		]);

		const filePath = getStoragePath();
		const persistedRaw = await fs.readFile(filePath, "utf8");
		const persisted = JSON.parse(persistedRaw) as {
			version: number;
			accounts: Array<Record<string, unknown>>;
		};
		expect(persisted.version).toBe(4);
		expect(Array.isArray(persisted.accounts)).toBe(true);
		expect(persisted.accounts[0]?.refreshToken).toBeUndefined();
		expect(typeof persisted.accounts[0]?.refreshTokenRef).toBe("string");

		const loaded = await loadAccounts();
		const loadedTokenPair = `${loaded?.accounts[0]?.refreshToken}|${loaded?.accounts[0]?.accessToken}`;
		expect(
			new Set(["refresh-token-a|access-token-a", "refresh-token-b|access-token-b"]).has(loadedTokenPair),
		).toBe(true);
	});

	it("retries save rename on windows-style EPERM and persists successfully", async () => {
		installKeytarMock();
		const { saveAccounts, loadAccounts } = await import("../lib/storage.js");
		const originalRename = fs.rename.bind(fs);
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementationOnce(async () => {
			const error = new Error("locked") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		renameSpy.mockImplementation(originalRename);
		let renameCallCount = 0;

		try {
			await saveAccounts({
				version: 3,
				accounts: [
					{
						accountId: "acct_retry",
						email: "retry@example.com",
						refreshToken: "refresh-token-retry",
						accessToken: "access-token-retry",
						addedAt: 30,
						lastUsed: 31,
						enabled: true,
					},
				],
				activeIndex: 0,
			});
		} finally {
			renameCallCount = renameSpy.mock.calls.length;
			renameSpy.mockRestore();
		}

		expect(renameCallCount).toBeGreaterThanOrEqual(2);
		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.refreshToken).toBe("refresh-token-retry");
	});

	it("rolls back keychain refs when save fails after refs are written", async () => {
		const { secrets } = installKeytarMock();
		const { saveAccounts } = await import("../lib/storage.js");
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementation(async () => {
			const error = new Error("rename denied") as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		});

		try {
			await expect(
				saveAccounts({
					version: 3,
					accounts: [
						{
							accountId: "acct_fail",
							email: "fail@example.com",
							refreshToken: "refresh-token-fail",
							accessToken: "access-token-fail",
							addedAt: 40,
							lastUsed: 41,
							enabled: true,
						},
					],
					activeIndex: 0,
				}),
			).rejects.toThrow();
		} finally {
			renameSpy.mockRestore();
		}

		expect([...secrets.keys()]).toEqual([]);
	});

	it("adjusts activeIndex when v4 hydration skips accounts with missing keychain secrets", async () => {
		const { secrets } = installKeytarMock();
		const { getStoragePath, loadAccounts } = await import("../lib/storage.js");
		const storagePath = getStoragePath();
		secrets.set("acct-2:refresh", "refresh-token-2");
		secrets.set("acct-2:access", "access-token-2");
		await fs.writeFile(
			storagePath,
			JSON.stringify(
				{
					version: 4,
					accounts: [
						{
							accountId: "acct_1",
							email: "first@example.com",
							refreshTokenRef: "acct-1:refresh",
							accessTokenRef: "acct-1:access",
							addedAt: 1,
							lastUsed: 1,
							enabled: true,
						},
						{
							accountId: "acct_2",
							email: "second@example.com",
							refreshTokenRef: "acct-2:refresh",
							accessTokenRef: "acct-2:access",
							addedAt: 2,
							lastUsed: 2,
							enabled: true,
						},
					],
					activeIndex: 1,
				},
				null,
				2,
			),
			"utf8",
		);

		const loaded = await loadAccounts();
		expect(loaded?.accounts).toHaveLength(1);
		expect(loaded?.accounts[0]?.accountId).toBe("acct_2");
		expect(loaded?.activeIndex).toBe(0);
	});

	it("clears keychain refs from WAL payload even when runtime mode flips to plaintext", async () => {
		const { secrets } = installKeytarMock();
		const { clearAccounts, getStoragePath } = await import("../lib/storage.js");
		const storagePath = getStoragePath();
		const walPath = `${storagePath}.wal`;
		secrets.set("acct-wal:refresh", "refresh-token-wal");
		secrets.set("acct-wal:access", "access-token-wal");
		await fs.mkdir(tempDir, { recursive: true });
		await fs.writeFile(
			walPath,
			JSON.stringify({
				version: 1,
				createdAt: Date.now(),
				path: storagePath,
				checksum: "checksum",
				content: JSON.stringify({
					version: 4,
					accounts: [
						{
							refreshTokenRef: "acct-wal:refresh",
							accessTokenRef: "acct-wal:access",
							addedAt: 1,
							lastUsed: 1,
						},
					],
					activeIndex: 0,
				}),
			}),
			"utf8",
		);

		process.env.CODEX_SECRET_STORAGE_MODE = "plaintext";
		await clearAccounts();
		expect(secrets.has("acct-wal:refresh")).toBe(false);
		expect(secrets.has("acct-wal:access")).toBe(false);
		await expect(fs.stat(walPath)).rejects.toThrow();
	});
});
