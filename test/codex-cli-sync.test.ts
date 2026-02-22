import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountStorageV3 } from "../lib/storage.js";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import { syncAccountStorageFromCodexCli } from "../lib/codex-cli/sync.js";

describe("codex-cli sync", () => {
	let tempDir: string;
	let accountsPath: string;
	let previousPath: string | undefined;
	let previousSync: string | undefined;

	beforeEach(async () => {
		previousPath = process.env.CODEX_CLI_ACCOUNTS_PATH;
		previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-sync-"));
		accountsPath = join(tempDir, "accounts.json");
		process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		clearCodexCliStateCache();
	});

	afterEach(async () => {
		clearCodexCliStateCache();
		if (previousPath === undefined) delete process.env.CODEX_CLI_ACCOUNTS_PATH;
		else process.env.CODEX_CLI_ACCOUNTS_PATH = previousPath;
		if (previousSync === undefined) delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		else process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = previousSync;
		await rm(tempDir, { recursive: true, force: true });
	});

	it("merges Codex CLI accounts and sets active index", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					activeAccountId: "acc_c",
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
						{
							accountId: "acc_c",
							email: "c@example.com",
							auth: {
								tokens: {
									access_token: "c.access.token",
									refresh_token: "refresh-c",
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
				{
					accountId: "acc_b",
					email: "b@example.com",
					refreshToken: "refresh-b-old",
					addedAt: 2,
					lastUsed: 2,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		const result = await syncAccountStorageFromCodexCli(current);
		expect(result.changed).toBe(true);
		expect(result.storage?.accounts.length).toBe(3);

		const mergedB = result.storage?.accounts.find((account) => account.accountId === "acc_b");
		expect(mergedB?.refreshToken).toBe("refresh-b");

		const active = result.storage?.accounts[result.storage.activeIndex ?? 0];
		expect(active?.accountId).toBe("acc_c");
	});

	it("creates storage from Codex CLI accounts when local storage is missing", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							email: "a@example.com",
							active: true,
							auth: {
								tokens: {
									access_token: "a.access.token",
									refresh_token: "refresh-a",
								},
							},
						},
						{
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

		const result = await syncAccountStorageFromCodexCli(null);
		expect(result.changed).toBe(true);
		expect(result.storage?.accounts.length).toBe(2);
		expect(result.storage?.accounts[0]?.refreshToken).toBe("refresh-a");
		expect(result.storage?.activeIndex).toBe(0);
	});

	it("matches existing account by normalized email", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							email: "user@example.com",
							auth: {
								tokens: {
									access_token: "new.access.token",
									refresh_token: "refresh-new",
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
					email: "USER@EXAMPLE.COM",
					refreshToken: "refresh-old",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};

		const result = await syncAccountStorageFromCodexCli(current);
		expect(result.changed).toBe(true);
		expect(result.storage?.accounts.length).toBe(1);
		expect(result.storage?.accounts[0]?.refreshToken).toBe("refresh-new");
	});

	it("returns unchanged storage when sync is disabled", async () => {
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "0";
		clearCodexCliStateCache();

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
			activeIndexByFamily: { codex: 0 },
		};

		const result = await syncAccountStorageFromCodexCli(current);
		expect(result.changed).toBe(false);
		expect(result.storage).toBe(current);
	});
});
