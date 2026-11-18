import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";
import { syncCodexCliActiveSelectionIfDrifted } from "../lib/codex-manager/login-menu-data.js";
import type { AccountStorageV3 } from "../lib/storage.js";

// #700: the writer maps a stored "org-..." id to the token's
// chatgpt_account_id. The drift check has to apply the same mapping, or every
// org-sourced account reads as drifted and each login-menu render rewrites
// auth.json (replacing the real id_token with the access token).

const jwt = (claims: Record<string, unknown>) =>
	`h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

const ACCESS_TOKEN = jwt({
	sub: "user-org",
	exp: 4_102_444_800,
	"https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-1" },
	"https://api.openai.com/profile": { email: "org@example.com" },
});
const ID_TOKEN = jwt({
	sub: "user-org",
	email: "org@example.com",
	"https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-1" },
});

const ENV_KEYS = [
	"CODEX_CLI_ACCOUNTS_PATH",
	"CODEX_CLI_AUTH_PATH",
	"CODEX_CLI_CONFIG_PATH",
	"CODEX_MULTI_AUTH_SYNC_CODEX_CLI",
	"CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE",
] as const;

describe("org-sourced account alignment with Codex auth.json (#700)", () => {
	let tempDir: string;
	let authPath: string;
	const previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
		tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-org-align-"));
		authPath = join(tempDir, "auth.json");
		process.env.CODEX_CLI_ACCOUNTS_PATH = join(tempDir, "accounts.json");
		process.env.CODEX_CLI_AUTH_PATH = authPath;
		process.env.CODEX_CLI_CONFIG_PATH = join(tempDir, "config.toml");
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "0";
		clearCodexCliStateCache();
	});

	afterEach(async () => {
		clearCodexCliStateCache();
		for (const key of ENV_KEYS) {
			if (previousEnv[key] === undefined) delete process.env[key];
			else process.env[key] = previousEnv[key];
		}
		await rm(tempDir, { recursive: true, force: true });
	});

	function storage(): AccountStorageV3 {
		return {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [
				{
					email: "org@example.com",
					accountId: "org-AbC123",
					accessToken: ACCESS_TOKEN,
					refreshToken: "refresh-org",
					expiresAt: 4_102_444_800_000,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};
	}

	it("reads a writer-written org account back as aligned and never rewrites it", async () => {
		const account = storage().accounts[0]!;
		await setCodexCliActiveSelection({
			accountId: account.accountId,
			email: account.email,
			accessToken: account.accessToken,
			refreshToken: account.refreshToken,
			idToken: ID_TOKEN,
		});
		const firstWrite = await readFile(authPath, "utf-8");
		const written = JSON.parse(firstWrite) as {
			tokens?: { account_id?: string; id_token?: string };
		};
		expect(written.tokens?.account_id).toBe("ws-uuid-1");
		expect(written.tokens?.id_token).toBe(ID_TOKEN);

		// Several login-menu renders in a row.
		for (let render = 0; render < 3; render += 1) {
			await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(
				false,
			);
		}

		expect(await readFile(authPath, "utf-8")).toBe(firstWrite);
	});

	it("stays aligned when the legacy accounts.json keeps the raw org id", async () => {
		const accountsPath = process.env.CODEX_CLI_ACCOUNTS_PATH!;
		await writeFile(
			accountsPath,
			JSON.stringify({
				accounts: [
					{
						accountId: "org-AbC123",
						email: "org@example.com",
						auth: {
							tokens: { access_token: ACCESS_TOKEN, refresh_token: "refresh-org" },
						},
					},
				],
			}),
			"utf-8",
		);
		const account = storage().accounts[0]!;
		await setCodexCliActiveSelection({
			accountId: account.accountId,
			email: account.email,
			accessToken: account.accessToken,
			refreshToken: account.refreshToken,
			idToken: ID_TOKEN,
		});
		const accountsWrite = await readFile(accountsPath, "utf-8");
		const authWrite = await readFile(authPath, "utf-8");
		expect(
			(JSON.parse(accountsWrite) as { activeAccountId?: string }).activeAccountId,
		).toBe("org-AbC123");
		expect(
			(JSON.parse(authWrite) as { tokens?: { account_id?: string } }).tokens
				?.account_id,
		).toBe("ws-uuid-1");

		for (let render = 0; render < 3; render += 1) {
			await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(
				false,
			);
		}

		expect(await readFile(accountsPath, "utf-8")).toBe(accountsWrite);
		expect(await readFile(authPath, "utf-8")).toBe(authWrite);
	});

	it("rewrites an org account_id left in auth.json by an older release, once", async () => {
		// Written before #700: Codex CLI 0.156+ rejects this account_id.
		await writeFile(
			authPath,
			JSON.stringify({
				auth_mode: "chatgpt",
				tokens: {
					access_token: ACCESS_TOKEN,
					refresh_token: "refresh-org",
					id_token: ID_TOKEN,
					account_id: "org-AbC123",
				},
			}),
			"utf-8",
		);

		await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(true);
		const rewritten = await readFile(authPath, "utf-8");
		const tokens = (
			JSON.parse(rewritten) as {
				tokens?: { account_id?: string; id_token?: string };
			}
		).tokens;
		expect(tokens?.account_id).toBe("ws-uuid-1");
		expect(tokens?.id_token).toBe(ID_TOKEN);

		await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(
			false,
		);
		expect(await readFile(authPath, "utf-8")).toBe(rewritten);
	});

	it("rewrites an org auth.json account_id even when a valid accounts.json exists, once", async () => {
		const accountsPath = process.env.CODEX_CLI_ACCOUNTS_PATH!;
		const accountsJson = JSON.stringify({
			activeAccountId: "org-AbC123",
			activeEmail: "org@example.com",
			accounts: [
				{
					accountId: "org-AbC123",
					email: "org@example.com",
					active: true,
					auth: {
						tokens: { access_token: ACCESS_TOKEN, refresh_token: "refresh-org" },
					},
				},
			],
		});
		const writeAuth = (accountId: string) =>
			writeFile(
				authPath,
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: {
						access_token: ACCESS_TOKEN,
						refresh_token: "refresh-org",
						id_token: ID_TOKEN,
						account_id: accountId,
					},
				}),
				"utf-8",
			);
		await writeFile(accountsPath, accountsJson, "utf-8");

		// aligned pair: nothing to do
		await writeAuth("ws-uuid-1");
		const alignedAuth = await readFile(authPath, "utf-8");
		await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(
			false,
		);
		expect(await readFile(authPath, "utf-8")).toBe(alignedAuth);
		expect(await readFile(accountsPath, "utf-8")).toBe(accountsJson);

		// auth.json left with an org id by an older release: rewritten once
		await writeAuth("org-AbC123");
		await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(true);
		const rewrittenAuth = await readFile(authPath, "utf-8");
		expect(
			(JSON.parse(rewrittenAuth) as { tokens?: { account_id?: string } }).tokens
				?.account_id,
		).toBe("ws-uuid-1");
		const rewrittenAccounts = await readFile(accountsPath, "utf-8");

		await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(
			false,
		);
		expect(await readFile(authPath, "utf-8")).toBe(rewrittenAuth);
		expect(await readFile(accountsPath, "utf-8")).toBe(rewrittenAccounts);
	});
});
