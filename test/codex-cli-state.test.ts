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
	let previousPath: string | undefined;
	let previousSync: string | undefined;
	let previousLegacySync: string | undefined;

	beforeEach(async () => {
		previousPath = process.env.CODEX_CLI_ACCOUNTS_PATH;
		previousSync = process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI;
		previousLegacySync = process.env.CODEX_AUTH_SYNC_CODEX_CLI;

		tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-state-"));
		accountsPath = join(tempDir, "accounts.json");
		process.env.CODEX_CLI_ACCOUNTS_PATH = accountsPath;
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

		const lookup = await lookupCodexCliTokensByEmail("B@EXAMPLE.com");
		expect(lookup?.refreshToken).toBe("refresh-b");
		expect(lookup?.accountId).toBe("acc_b");
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
});
