import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStorageV3 } from "../lib/storage.js";
import * as codexCliState from "../lib/codex-cli/state.js";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import {
	getActiveSelectionForFamily,
	syncAccountStorageFromCodexCli,
} from "../lib/codex-cli/sync.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";

async function removeWithRetry(path: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
		}
	}
	if (lastError) {
		throw lastError;
	}
}

describe("codex-cli sync", () => {
	let tempDir: string;
	let accountsPath: string;
	let authPath: string;
	let configPath: string;
	let previousPath: string | undefined;
	let previousAuthPath: string | undefined;
	let previousConfigPath: string | undefined;
	let previousSync: string | undefined;
	let previousEnforceFileStore: string | undefined;

	beforeEach(async () => {
		previousPath = process.env.CODEX_CLI_ACCOUNTS_PATH;
		previousAuthPath = process.env.CODEX_CLI_AUTH_PATH;
		previousConfigPath = process.env.CODEX_CLI_CONFIG_PATH;
		previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		previousEnforceFileStore =
			process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;
		tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-sync-"));
		accountsPath = join(tempDir, "accounts.json");
		authPath = join(tempDir, "auth.json");
		configPath = join(tempDir, "config.toml");
		process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
		process.env.CODEX_CLI_AUTH_PATH = authPath;
		process.env.CODEX_CLI_CONFIG_PATH = configPath;
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "1";
		clearCodexCliStateCache();
	});

	afterEach(async () => {
		clearCodexCliStateCache();
		if (previousPath === undefined) delete process.env.CODEX_CLI_ACCOUNTS_PATH;
		else process.env.CODEX_CLI_ACCOUNTS_PATH = previousPath;
		if (previousAuthPath === undefined) delete process.env.CODEX_CLI_AUTH_PATH;
		else process.env.CODEX_CLI_AUTH_PATH = previousAuthPath;
		if (previousConfigPath === undefined) delete process.env.CODEX_CLI_CONFIG_PATH;
		else process.env.CODEX_CLI_CONFIG_PATH = previousConfigPath;
		if (previousSync === undefined) {
			delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		} else {
			process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = previousSync;
		}
		if (previousEnforceFileStore === undefined) {
			delete process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE;
		} else {
			process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE =
				previousEnforceFileStore;
		}
		await removeWithRetry(tempDir);
	});

	it("does not seed canonical storage from Codex CLI mirror files", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_mirror",
					accounts: [
						{
							accountId: "acc_mirror",
							email: "mirror@example.com",
							auth: {
								tokens: {
									access_token: "mirror-access",
									refresh_token: "mirror-refresh",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const loadSpy = vi.spyOn(codexCliState, "loadCodexCliState");
		try {
			const result = await syncAccountStorageFromCodexCli(null);
			expect(result.changed).toBe(false);
			expect(result.storage).toBeNull();
			expect(loadSpy).not.toHaveBeenCalled();
		} finally {
			loadSpy.mockRestore();
		}
	});

	it("does not merge or overwrite canonical storage from Codex CLI mirrors", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "b.access.token",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: Object.fromEntries(
				MODEL_FAMILIES.map((family) => [family, 0]),
			),
		};

		const loadSpy = vi.spyOn(codexCliState, "loadCodexCliState");
		try {
			const result = await syncAccountStorageFromCodexCli(current);
			expect(result.changed).toBe(false);
			expect(result.storage).toBe(current);
			expect(result.storage?.accounts).toEqual(current.accounts);
			expect(loadSpy).not.toHaveBeenCalled();
		} finally {
			loadSpy.mockRestore();
		}
	});

	it("normalizes local indexes without reading Codex CLI mirror state", async () => {
		const current: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					accountId: "acc_a",
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "acc_b",
					email: "b@example.com",
					refreshToken: "refresh-b",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 99,
			activeIndexByFamily: { codex: 99 },
		};

		const loadSpy = vi.spyOn(codexCliState, "loadCodexCliState");
		try {
			const result = await syncAccountStorageFromCodexCli(current);
			expect(result.changed).toBe(true);
			expect(result.storage).not.toBe(current);
			expect(result.storage?.activeIndex).toBe(1);
			for (const family of MODEL_FAMILIES) {
				expect(result.storage?.activeIndexByFamily?.[family]).toBe(1);
			}
			expect(loadSpy).not.toHaveBeenCalled();
		} finally {
			loadSpy.mockRestore();
		}
	});

	it("serializes concurrent active-selection writes to keep accounts/auth aligned", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							auth: {
								tokens: {
									access_token: "access-a",
									id_token: "id-a",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "access-b",
									id_token: "id-b",
									refresh_token: "refresh-b",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);
		await writeFile(
			authPath,
			JSON.stringify(
				{
					auth_mode: "chatgpt",
					OPENAI_API_KEY: null,
					email: "a@example.com",
					tokens: {
						access_token: "access-a",
						id_token: "id-a",
						refresh_token: "refresh-a",
						account_id: "acc_a",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const [first, second] = await Promise.all([
			setCodexCliActiveSelection({ accountId: "acc_a" }),
			setCodexCliActiveSelection({ accountId: "acc_b" }),
		]);
		expect(first).toBe(true);
		expect(second).toBe(true);

		const writtenAccounts = JSON.parse(
			await readFile(accountsPath, "utf-8"),
		) as {
			activeAccountId?: string;
			activeEmail?: string;
			accounts?: Array<{ accountId?: string; active?: boolean }>;
		};
		const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
			email?: string;
			tokens?: { account_id?: string };
		};

		expect(writtenAccounts.activeAccountId).toBe("acc_b");
		expect(writtenAccounts.activeEmail).toBe("b@example.com");
		expect(writtenAccounts.accounts?.[0]?.active).toBe(false);
		expect(writtenAccounts.accounts?.[1]?.active).toBe(true);
		expect(writtenAuth.tokens?.account_id).toBe("acc_b");
		expect(writtenAuth.email).toBe("b@example.com");
	});

	it("clamps and defaults active selection indexes by model family", () => {
		const family = MODEL_FAMILIES[0];
		expect(
			getActiveSelectionForFamily(
				{
					version: 3,
					accounts: [],
					activeIndex: 99,
					activeIndexByFamily: {},
				},
				family,
			),
		).toBe(0);

		expect(
			getActiveSelectionForFamily(
				{
					version: 3,
					accounts: [
						{ refreshToken: "a", addedAt: 1, lastUsed: 1 },
						{ refreshToken: "b", addedAt: 1, lastUsed: 1 },
					],
					activeIndex: 1,
					activeIndexByFamily: { [family]: Number.NaN },
				},
				family,
			),
		).toBe(1);

		expect(
			getActiveSelectionForFamily(
				{
					version: 3,
					accounts: [
						{ refreshToken: "a", addedAt: 1, lastUsed: 1 },
						{ refreshToken: "b", addedAt: 1, lastUsed: 1 },
					],
					activeIndex: 1,
					activeIndexByFamily: { [family]: -3 },
				},
				family,
			),
		).toBe(0);
	});
});
