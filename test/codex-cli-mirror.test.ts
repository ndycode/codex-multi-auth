import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexCliAccountIdFor } from "../lib/auth/token-utils.js";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import { buildUpdatedAccount } from "../lib/codex-manager/account-pool-write.js";
import { syncCodexCliActiveSelectionIfDrifted } from "../lib/codex-manager/login-menu-data.js";
import { syncSelectionToCodex } from "../lib/codex-manager/login-oauth.js";
import { safeParseAccountStorageV3 } from "../lib/schemas.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";
import { normalizeFlaggedStorage } from "../lib/storage/flagged-storage.js";

// An explicit `login --org` / CODEX_AUTH_ACCOUNT_ID id the backend does not
// authorize is kept as chosen, and ~/.codex/auth.json gets the authorized id
// through the account's CodexCliMirror instead (Codex CLI 0.156+ refuses the
// explicit one, issue #700).

const jwt = (claims: Record<string, unknown>) =>
	`h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

const ACCESS_TOKEN = jwt({
	sub: "user-team",
	exp: 4_102_444_800,
	"https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-1" },
	"https://api.openai.com/profile": { email: "team@example.com" },
});

const EXPLICIT_ID = "ws-team-rejected";
const MIRROR = { forAccountId: EXPLICIT_ID, accountId: "ws-uuid-1" };

function explicitAccount(
	overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
	return {
		email: "team@example.com",
		accountId: EXPLICIT_ID,
		accountIdSource: "manual",
		accessToken: ACCESS_TOKEN,
		refreshToken: "refresh-team",
		expiresAt: 4_102_444_800_000,
		addedAt: 1,
		lastUsed: 1,
		codexCliMirror: MIRROR,
		...overrides,
	};
}

describe("codexCliAccountIdFor", () => {
	it("uses the mirror while it names the account's current id", () => {
		expect(codexCliAccountIdFor(explicitAccount(), ACCESS_TOKEN)).toBe("ws-uuid-1");
	});

	// The pair goes stale on its own: a re-login with a different explicit id
	// (or any other change of accountId) must not keep the old substitution.
	it("ignores a mirror left from a different explicit id", () => {
		expect(
			codexCliAccountIdFor(explicitAccount({ accountId: "ws-other" }), ACCESS_TOKEN),
		).toBe("ws-other");
	});

	it("still maps an org id to the token's workspace (#703)", () => {
		expect(
			codexCliAccountIdFor(
				{ accountId: "org-AbC123", codexCliMirror: undefined },
				ACCESS_TOKEN,
			),
		).toBe("ws-uuid-1");
	});

	it("returns an org id without a token claim unchanged so the writer can drop it", () => {
		expect(codexCliAccountIdFor({ accountId: "org-AbC123" }, "not-a-jwt")).toBe(
			"org-AbC123",
		);
	});
});

describe("CodexCliMirror persistence", () => {
	it("survives the storage schema", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [explicitAccount()],
		};
		expect(safeParseAccountStorageV3(storage)?.accounts[0]?.codexCliMirror).toEqual(
			MIRROR,
		);
	});

	it("survives flagged-storage normalization", () => {
		const flagged = normalizeFlaggedStorage(
			{
				version: 1,
				accounts: [{ ...explicitAccount(), flaggedAt: 5 }],
			},
			{
				isRecord: (value): value is Record<string, unknown> =>
					typeof value === "object" && value !== null,
				now: () => 5,
			},
		);
		expect(flagged.accounts[0]?.codexCliMirror).toEqual(MIRROR);
	});

	it("is set, kept or cleared by a login merge", () => {
		const existing = explicitAccount();
		const write = { refreshToken: "refresh-next", now: 2 };
		expect(buildUpdatedAccount(existing, write).account.codexCliMirror).toEqual(MIRROR);
		expect(
			buildUpdatedAccount(existing, { ...write, codexCliMirror: null }).account
				.codexCliMirror,
		).toBeUndefined();
		const next = { forAccountId: "ws-next", accountId: "ws-uuid-1" };
		expect(
			buildUpdatedAccount(existing, { ...write, codexCliMirror: next }).account
				.codexCliMirror,
		).toEqual(next);
	});
});

const ENV_KEYS = [
	"CODEX_CLI_ACCOUNTS_PATH",
	"CODEX_CLI_AUTH_PATH",
	"CODEX_CLI_CONFIG_PATH",
	"CODEX_MULTI_AUTH_SYNC_CODEX_CLI",
	"CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE",
] as const;

describe("explicit unauthorized id and Codex auth.json", () => {
	let tempDir: string;
	let authPath: string;
	const previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
		tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-mirror-"));
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

	const storage = (account = explicitAccount()): AccountStorageV3 => ({
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: {},
		accounts: [account],
	});

	const authAccountId = async () =>
		(JSON.parse(await readFile(authPath, "utf-8")) as { tokens?: { account_id?: string } })
			.tokens?.account_id;

	it("writes the authorized id at login and dashboard renders never write the rejected id back", async () => {
		await syncSelectionToCodex({
			type: "success",
			access: ACCESS_TOKEN,
			refresh: "refresh-team",
			expires: 4_102_444_800_000,
			accountIdOverride: EXPLICIT_ID,
			accountIdSource: "manual",
			codexCliMirror: MIRROR,
		});
		expect(await authAccountId()).toBe("ws-uuid-1");
		const firstWrite = await readFile(authPath, "utf-8");

		for (let render = 0; render < 3; render += 1) {
			await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(false);
		}

		expect(await readFile(authPath, "utf-8")).toBe(firstWrite);
	});

	it("repairs an auth.json that still holds the rejected id, once", async () => {
		await syncSelectionToCodex({
			type: "success",
			access: ACCESS_TOKEN,
			refresh: "refresh-team",
			expires: 4_102_444_800_000,
			accountIdOverride: EXPLICIT_ID,
			accountIdSource: "manual",
		});
		expect(await authAccountId()).toBe(EXPLICIT_ID);

		await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(true);
		expect(await authAccountId()).toBe("ws-uuid-1");
		await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(false);
	});

	it("follows a new explicit id once the mirror is stale", async () => {
		await syncSelectionToCodex({
			type: "success",
			access: ACCESS_TOKEN,
			refresh: "refresh-team",
			expires: 4_102_444_800_000,
			accountIdOverride: EXPLICIT_ID,
			accountIdSource: "manual",
			codexCliMirror: MIRROR,
		});

		// Re-login bound a different explicit id; the old pair no longer applies.
		await expect(
			syncCodexCliActiveSelectionIfDrifted(storage(explicitAccount({ accountId: "ws-other" }))),
		).resolves.toBe(true);
		expect(await authAccountId()).toBe("ws-other");
	});
});
