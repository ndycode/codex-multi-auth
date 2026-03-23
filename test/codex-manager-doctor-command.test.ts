import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type DoctorCliOptions,
	type DoctorCommandDeps,
	runDoctorCommand,
} from "../lib/codex-manager/commands/doctor.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import type { TokenResult } from "../lib/types.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [],
	};
}

function createDeps(
	overrides: Partial<DoctorCommandDeps> = {},
): DoctorCommandDeps {
	return {
		setStoragePath: vi.fn(),
		getStoragePath: vi.fn(() => "/mock/openai-codex-accounts.json"),
		getCodexCliAuthPath: vi.fn(() => "/mock/auth.json"),
		getCodexCliConfigPath: vi.fn(() => "/mock/config.toml"),
		loadCodexCliState: vi.fn(async () => null),
		parseDoctorArgs: vi.fn((args: string[]) => {
			if (args.includes("--bad"))
				return { ok: false as const, message: "Unknown option: --bad" };
			return {
				ok: true as const,
				options: {
					json: true,
					fix: false,
					dryRun: false,
				} satisfies DoctorCliOptions,
			};
		}),
		printDoctorUsage: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		applyDoctorFixes: vi.fn(() => ({ changed: false, actions: [] })),
		saveAccounts: vi.fn(async () => undefined),
		resolveActiveIndex: vi.fn(() => 0),
		evaluateForecastAccounts: vi.fn(() => []),
		recommendForecastAccount: vi.fn(() => ({
			recommendedIndex: null,
			reason: "none",
		})),
		sanitizeEmail: vi.fn((email) => email),
		extractAccountEmail: vi.fn(() => undefined),
		extractAccountId: vi.fn(() => undefined),
		hasPlaceholderEmail: vi.fn(() => false),
		hasLikelyInvalidRefreshToken: vi.fn(() => false),
		getDoctorRefreshTokenKey: vi.fn(() => undefined),
		hasUsableAccessToken: vi.fn(() => true),
		queuedRefresh: vi.fn(async () => ({
			type: "failed",
			reason: "invalid_grant",
			message: "token expired",
		})),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		applyTokenAccountIdentity: vi.fn(() => false),
		setCodexCliActiveSelection: vi.fn(async () => true),
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		...overrides,
	};
}

function createDoctorFiles(files: Record<string, string>): {
	pathFor: (name: string) => string;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "doctor-command-test-"));
	const pathFor = (name: string) => join(root, name);
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(pathFor(name), contents, "utf8");
	}
	return {
		pathFor,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

describe("runDoctorCommand", () => {
	it("prints usage for help", async () => {
		const deps = createDeps();
		const result = await runDoctorCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.printDoctorUsage).toHaveBeenCalled();
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();
		const result = await runDoctorCommand(["--bad"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bad");
	});

	it("prints json diagnostics", async () => {
		const deps = createDeps();
		const result = await runDoctorCommand([], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"command": "doctor"'),
		);
	});

	it("reports an invalid Codex auth JSON shape", async () => {
		const files = createDoctorFiles({
			"storage.json": JSON.stringify(createStorage()),
			"auth.json": "123",
			"config.toml": 'cli_auth_credentials_store = "file"\n',
		});
		try {
			const deps = createDeps({
				getStoragePath: vi.fn(() => files.pathFor("storage.json")),
				getCodexCliAuthPath: vi.fn(() => files.pathFor("auth.json")),
				getCodexCliConfigPath: vi.fn(() => files.pathFor("config.toml")),
			});

			const result = await runDoctorCommand([], deps);
			expect(result).toBe(1);

			const payload = JSON.parse(
				String(vi.mocked(deps.logInfo!).mock.calls.at(-1)?.[0] ?? ""),
			) as {
				checks: Array<{ key: string; severity: string; message: string }>;
			};
			expect(payload.checks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						key: "codex-auth-readable",
						severity: "error",
						message: "Codex auth file contains invalid JSON shape",
					}),
				]),
			);
		} finally {
			files.cleanup();
		}
	});

	it("refreshes and syncs the active account once when fixing", async () => {
		const files = createDoctorFiles({
			"storage.json": JSON.stringify(createStorage()),
			"auth.json": JSON.stringify({ tokens: { access_token: "old-access" } }),
			"config.toml": 'cli_auth_credentials_store = "file"\n',
		});
		try {
			const storage = createStorage();
			storage.accounts.push({
				email: "stale@example.com",
				accountId: "acct-stale",
				accessToken: "old-access",
				refreshToken: "refresh-old",
				expiresAt: 100,
			});
			const refreshResult: TokenResult = {
				type: "success",
				access: "new-access",
				refresh: "refresh-new",
				expires: 5_000,
				idToken: "id-token-new",
			};
			const applyTokenAccountIdentity = vi.fn(
				(account: AccountStorageV3["accounts"][number], accountId: string | undefined) => {
					if (!accountId || account.accountId === accountId) return false;
					account.accountId = accountId;
					return true;
				},
			);
			const deps = createDeps({
				getStoragePath: vi.fn(() => files.pathFor("storage.json")),
				getCodexCliAuthPath: vi.fn(() => files.pathFor("auth.json")),
				getCodexCliConfigPath: vi.fn(() => files.pathFor("config.toml")),
				parseDoctorArgs: vi.fn(() => ({
					ok: true as const,
					options: {
						json: true,
						fix: true,
						dryRun: false,
					} satisfies DoctorCliOptions,
				})),
				loadAccounts: vi.fn(async () => storage),
				hasUsableAccessToken: vi.fn(() => false),
				queuedRefresh: vi.fn(async () => refreshResult),
				extractAccountEmail: vi.fn((accessToken?: string) =>
					accessToken === "new-access" ? "fresh@example.com" : undefined,
				),
				extractAccountId: vi.fn((accessToken?: string) =>
					accessToken === "new-access" ? "acct-fresh" : undefined,
				),
				applyTokenAccountIdentity,
			});

			const result = await runDoctorCommand([], deps);
			expect(result).toBe(0);
			expect(deps.queuedRefresh).toHaveBeenCalledWith("refresh-old");
			expect(deps.saveAccounts).toHaveBeenCalledTimes(1);
			expect(deps.setCodexCliActiveSelection).toHaveBeenCalledWith({
				accountId: "acct-fresh",
				email: "fresh@example.com",
				accessToken: "new-access",
				refreshToken: "refresh-new",
				expiresAt: 5_000,
				idToken: "id-token-new",
			});
			expect(storage.accounts[0]).toMatchObject({
				email: "fresh@example.com",
				accountId: "acct-fresh",
				accessToken: "new-access",
				refreshToken: "refresh-new",
				expiresAt: 5_000,
			});

			const payload = JSON.parse(
				String(vi.mocked(deps.logInfo!).mock.calls.at(-1)?.[0] ?? ""),
			) as {
				fix: { changed: boolean; actions: Array<{ key: string; message: string }> };
			};
			expect(payload.fix.changed).toBe(true);
			expect(payload.fix.actions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ key: "doctor-refresh" }),
					expect.objectContaining({ key: "codex-active-sync" }),
				]),
			);
		} finally {
			files.cleanup();
		}
	});
});
