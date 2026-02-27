import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__resetCodexCliWarningCacheForTests,
	clearCodexCliStateCache,
	isCodexCliSyncEnabled,
	loadCodexCliState,
	lookupCodexCliTokensByEmail,
} from "../lib/codex-cli/state.js";
import {
	getCodexCliMetricsSnapshot,
	resetCodexCliMetricsForTests,
} from "../lib/codex-cli/observability.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";

describe("codex-cli state", () => {
	let tempDir: string;
	let accountsPath: string;
	let authPath: string;
	let previousPath: string | undefined;
	let previousAuthPath: string | undefined;
	let previousSync: string | undefined;
	let previousLegacySync: string | undefined;

	beforeEach(async () => {
		previousPath = process.env.CODEX_CLI_ACCOUNTS_PATH;
		previousAuthPath = process.env.CODEX_CLI_AUTH_PATH;
		previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		previousLegacySync = process.env.CODEX_AUTH_SYNC_CODEX_CLI;

		tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-state-"));
		accountsPath = join(tempDir, "accounts.json");
		authPath = join(tempDir, "auth.json");
		process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
		process.env.CODEX_CLI_AUTH_PATH = authPath;
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		delete process.env.CODEX_AUTH_SYNC_CODEX_CLI;
		clearCodexCliStateCache();
		__resetCodexCliWarningCacheForTests();
		resetCodexCliMetricsForTests();
	});

	afterEach(async () => {
		clearCodexCliStateCache();
		__resetCodexCliWarningCacheForTests();
		if (previousPath === undefined) delete process.env.CODEX_CLI_ACCOUNTS_PATH;
		else process.env.CODEX_CLI_ACCOUNTS_PATH = previousPath;
		if (previousAuthPath === undefined) delete process.env.CODEX_CLI_AUTH_PATH;
		else process.env.CODEX_CLI_AUTH_PATH = previousAuthPath;
		if (previousSync === undefined) delete process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		else process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = previousSync;
		if (previousLegacySync === undefined) delete process.env.CODEX_AUTH_SYNC_CODEX_CLI;
		else process.env.CODEX_AUTH_SYNC_CODEX_CLI = previousLegacySync;
		resetCodexCliMetricsForTests();
		await rm(tempDir, { recursive: true, force: true });
	});

	it("loads Codex CLI accounts and active selection", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					codexMultiAuthSyncVersion: 123456,
					activeAccountId: "acc_b",
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							auth: {
								tokens: {
									access_token: "a.b.c",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "x.y.z",
									refresh_token: "refresh-b",
								},
							},
							active: true,
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const state = await loadCodexCliState({ forceRefresh: true });
		expect(state?.activeAccountId).toBe("acc_b");
		expect(state?.accounts.length).toBe(2);
		expect(state?.syncVersion).toBe(123456);
		expect(typeof state?.sourceUpdatedAtMs).toBe("number");

		const lookup = await lookupCodexCliTokensByEmail("B@EXAMPLE.com");
		expect(lookup?.refreshToken).toBe("refresh-b");
		expect(lookup?.accountId).toBe("acc_b");
	});

	it("falls back to Codex auth.json when accounts.json is missing", async () => {
		await writeFile(
			authPath,
			JSON.stringify(
				{
					auth_mode: "chatgpt",
					OPENAI_API_KEY: null,
					tokens: {
						access_token:
							"eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2NfYXV0aCJ9LCJlbWFpbCI6ImF1dGhAZXhhbXBsZS5jb20ifQ.",
						refresh_token: "refresh-auth",
						account_id: "acc_auth",
					},
					last_refresh: "2026-02-25T21:36:07.864Z",
				},
				null,
				2,
			),
			"utf-8",
		);

		const state = await loadCodexCliState({ forceRefresh: true });
		expect(state?.path).toBe(authPath);
		expect(state?.accounts.length).toBe(1);
		expect(state?.activeAccountId).toBe("acc_auth");
		expect(state?.activeEmail).toBe("auth@example.com");

		const lookup = await lookupCodexCliTokensByEmail("AUTH@EXAMPLE.COM");
		expect(lookup?.refreshToken).toBe("refresh-auth");
		expect(lookup?.accountId).toBe("acc_auth");
	});

	it("falls back to auth.json when accounts.json is malformed", async () => {
		await writeFile(accountsPath, "{ malformed json", "utf-8");
		await writeFile(
			authPath,
			JSON.stringify(
				{
					auth_mode: "chatgpt",
					OPENAI_API_KEY: null,
					tokens: {
						access_token:
							"eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2NfYXV0aCJ9LCJlbWFpbCI6ImF1dGhAZXhhbXBsZS5jb20ifQ.",
						refresh_token: "refresh-auth",
						account_id: "acc_auth",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const state = await loadCodexCliState({ forceRefresh: true });
		expect(state?.path).toBe(authPath);
		expect(state?.activeAccountId).toBe("acc_auth");
		expect(state?.accounts.length).toBe(1);
	});

	it("derives active selection from per-account active flag", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							accountId: "acc_a",
							email: "a@example.com",
							active: true,
							auth: {
								tokens: {
									access_token: "a.b.c",
									refresh_token: "refresh-a",
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

		const state = await loadCodexCliState({ forceRefresh: true });
		expect(state?.activeAccountId).toBe("acc_a");
		expect(state?.activeEmail).toBe("a@example.com");
	});

	it("returns null for malformed Codex CLI payload", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: {
						accountId: "acc_a",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const state = await loadCodexCliState({ forceRefresh: true });
		expect(state).toBeNull();
	});

	it("returns null when sync is disabled", async () => {
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "0";
		clearCodexCliStateCache();

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
									access_token: "a.b.c",
									refresh_token: "refresh-a",
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

		const state = await loadCodexCliState({ forceRefresh: true });
		expect(state).toBeNull();
		const lookup = await lookupCodexCliTokensByEmail("a@example.com");
		expect(lookup).toBeNull();
	});

	it("prefers modern sync env over legacy env", () => {
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		process.env.CODEX_AUTH_SYNC_CODEX_CLI = "0";
		expect(isCodexCliSyncEnabled()).toBe(true);
	});

	it("tracks read/write metrics counters", async () => {
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
									access_token: "a.b.c",
									refresh_token: "refresh-a",
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

		await loadCodexCliState({ forceRefresh: true });
		await setCodexCliActiveSelection({ accountId: "acc_a" });

		const metrics = getCodexCliMetricsSnapshot();
		expect(metrics.readAttempts).toBeGreaterThan(0);
		expect(metrics.readSuccesses).toBeGreaterThan(0);
		expect(metrics.writeAttempts).toBeGreaterThan(0);
		expect(metrics.writeSuccesses).toBeGreaterThan(0);
	});

	it("persists active selection back to Codex CLI state", async () => {
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
									access_token: "a.b.c",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "x.y.z",
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

		const updated = await setCodexCliActiveSelection({ accountId: "acc_b" });
		expect(updated).toBe(true);

		const written = JSON.parse(await readFile(accountsPath, "utf-8")) as {
			activeAccountId?: string;
			accounts?: Array<{ active?: boolean }>;
		};
		expect(written.activeAccountId).toBe("acc_b");
		expect(written.accounts?.[0]?.active).toBe(false);
		expect(written.accounts?.[1]?.active).toBe(true);
	});

	it("updates both accounts.json and auth.json when both files exist", async () => {
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
					tokens: {
						access_token: "old-access",
						id_token: "old-id-token",
						refresh_token: "old-refresh",
						account_id: "old-account",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const updated = await setCodexCliActiveSelection({ accountId: "acc_b" });
		expect(updated).toBe(true);

		const writtenAccounts = JSON.parse(await readFile(accountsPath, "utf-8")) as {
			activeAccountId?: string;
			accounts?: Array<{ active?: boolean }>;
		};
		expect(writtenAccounts.activeAccountId).toBe("acc_b");
		expect(writtenAccounts.accounts?.[0]?.active).toBe(false);
		expect(writtenAccounts.accounts?.[1]?.active).toBe(true);

		const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
			tokens?: { access_token?: string; id_token?: string; refresh_token?: string; account_id?: string };
		};
		expect(writtenAuth.tokens?.access_token).toBe("access-b");
		expect(writtenAuth.tokens?.id_token).toBe("id-b");
		expect(writtenAuth.tokens?.refresh_token).toBe("refresh-b");
		expect(writtenAuth.tokens?.account_id).toBe("acc_b");
	});

	it("prefers explicit selection tokens over stale accounts.json tokens", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: [
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "stale-access",
									id_token: "stale-id",
									refresh_token: "stale-refresh",
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
					tokens: {
						access_token: "old-access",
						id_token: "old-id-token",
						refresh_token: "old-refresh",
						account_id: "old-account",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const updated = await setCodexCliActiveSelection({
			accountId: "acc_b",
			email: "explicit@example.com",
			accessToken: "fresh-access",
			refreshToken: "fresh-refresh",
			idToken: "fresh-id-token",
		});
		expect(updated).toBe(true);

		const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
			email?: string;
			tokens?: { access_token?: string; id_token?: string; refresh_token?: string };
		};
		expect(writtenAuth.email).toBe("explicit@example.com");
		expect(writtenAuth.tokens?.access_token).toBe("fresh-access");
		expect(writtenAuth.tokens?.id_token).toBe("fresh-id-token");
		expect(writtenAuth.tokens?.refresh_token).toBe("fresh-refresh");
	});

	it("persists active selection by email match when accountId is omitted", async () => {
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
									access_token: "a.b.c",
									refresh_token: "refresh-a",
								},
							},
						},
						{
							accountId: "acc_b",
							email: "b@example.com",
							auth: {
								tokens: {
									access_token: "x.y.z",
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

		const updated = await setCodexCliActiveSelection({ email: "B@EXAMPLE.COM" });
		expect(updated).toBe(true);

		const written = JSON.parse(await readFile(accountsPath, "utf-8")) as {
			activeAccountId?: string;
			activeEmail?: string;
		};
		expect(written.activeAccountId).toBe("acc_b");
		expect(written.activeEmail).toBe("b@example.com");
	});

	it("returns false when selection has no matching Codex CLI account", async () => {
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
									access_token: "a.b.c",
									refresh_token: "refresh-a",
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

		const updated = await setCodexCliActiveSelection({ accountId: "missing-account" });
		expect(updated).toBe(false);
	});

	it("still updates auth.json when accounts.json has no match", async () => {
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
									refresh_token: "refresh-a",
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
					tokens: {
						access_token: "old-access",
						id_token: "old-id-token",
						refresh_token: "old-refresh",
						account_id: "old-account",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const updated = await setCodexCliActiveSelection({
			accountId: "missing-account",
			email: "b@example.com",
			accessToken: "fresh-access",
			refreshToken: "fresh-refresh",
		});
		expect(updated).toBe(true);

		const writtenAuth = JSON.parse(await readFile(authPath, "utf-8")) as {
			email?: string;
			tokens?: { access_token?: string; id_token?: string; refresh_token?: string };
		};
		expect(writtenAuth.email).toBe("b@example.com");
		expect(writtenAuth.tokens?.access_token).toBe("fresh-access");
		expect(writtenAuth.tokens?.id_token).toBe("old-id-token");
		expect(writtenAuth.tokens?.refresh_token).toBe("fresh-refresh");
	});

	it("does not update auth.json when no account match and selection lacks tokens", async () => {
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
									refresh_token: "refresh-a",
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
					tokens: {
						access_token: "old-access",
						id_token: "old-id-token",
						refresh_token: "old-refresh",
						account_id: "old-account",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const before = await readFile(authPath, "utf-8");
		const updated = await setCodexCliActiveSelection({
			accountId: "missing-account",
			email: "b@example.com",
		});
		expect(updated).toBe(false);
		const after = await readFile(authPath, "utf-8");
		expect(after).toBe(before);
	});

	it("returns false when writer sync is disabled", async () => {
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "0";
		clearCodexCliStateCache();

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
									access_token: "a.b.c",
									refresh_token: "refresh-a",
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

		const updated = await setCodexCliActiveSelection({ accountId: "acc_a" });
		expect(updated).toBe(false);
	});

	it("returns false for malformed writer payload", async () => {
		await writeFile(
			accountsPath,
			JSON.stringify(
				{
					accounts: {
						accountId: "acc_a",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const updated = await setCodexCliActiveSelection({ accountId: "acc_a" });
		expect(updated).toBe(false);
	});

	it("writes selected tokens to Codex auth.json when accounts.json is absent", async () => {
		await writeFile(
			authPath,
			JSON.stringify(
				{
					auth_mode: "chatgpt",
					OPENAI_API_KEY: null,
					tokens: {
						access_token: "old.access.token",
						id_token: "old.id.token",
						refresh_token: "old-refresh",
						account_id: "old-id",
					},
					last_refresh: "2026-01-01T00:00:00.000Z",
				},
				null,
				2,
			),
			"utf-8",
		);

		const updated = await setCodexCliActiveSelection({
			accountId: "acc_new",
			email: "new@example.com",
			accessToken: "new.access.token",
			refreshToken: "new-refresh-token",
			expiresAt: Date.parse("2026-03-01T00:00:00.000Z"),
		});
		expect(updated).toBe(true);

		const written = JSON.parse(await readFile(authPath, "utf-8")) as {
			tokens?: {
				access_token?: string;
				id_token?: string;
				refresh_token?: string;
				account_id?: string;
			};
		};
		expect(written.tokens?.access_token).toBe("new.access.token");
		expect(written.tokens?.id_token).toBe("old.id.token");
		expect(written.tokens?.refresh_token).toBe("new-refresh-token");
		expect(written.tokens?.account_id).toBe("acc_new");
	});
});
