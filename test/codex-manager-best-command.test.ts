import { describe, expect, it, vi } from "vitest";
import {
	type BestCliOptions,
	type BestCommandDeps,
	runBestCommand,
} from "../lib/codex-manager/commands/best.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createAccount(
	overrides: Partial<AccountStorageV3["accounts"][number]> = {},
): AccountStorageV3["accounts"][number] {
	return {
		email: "best@example.com",
		refreshToken: "refresh-best",
		accessToken: "access-best",
		expiresAt: Date.now() + 60_000,
		addedAt: 1,
		lastUsed: 1,
		enabled: true,
		...overrides,
	};
}

function createStorage(
	accounts: AccountStorageV3["accounts"] = [createAccount()],
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts,
	};
}

function createDeps(overrides: Partial<BestCommandDeps> = {}): BestCommandDeps {
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		saveAccounts: vi.fn(async () => undefined),
		parseBestArgs: vi.fn((args: string[]) => {
			if (args.includes("--bad"))
				return { ok: false as const, message: "Unknown option: --bad" };
			return {
				ok: true as const,
				options: {
					live: false,
					json: true,
					model: "gpt-5-codex",
					modelProvided: false,
				} satisfies BestCliOptions,
			};
		}),
		printBestUsage: vi.fn(),
		resolveActiveIndex: vi.fn(() => 0),
		hasUsableAccessToken: vi.fn(() => true),
		queuedRefresh: vi.fn(async () => ({
			type: "success",
			access: "access-best",
			refresh: "refresh-best",
			expires: Date.now() + 60_000,
		})),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		extractAccountId: vi.fn(() => "account-id"),
		extractAccountEmail: vi.fn(() => "best@example.com"),
		sanitizeEmail: vi.fn((email) => email),
		formatAccountLabel: vi.fn(
			(_account, index) => `${index + 1}. best@example.com`,
		),
		fetchCodexQuotaSnapshot: vi.fn(async () => ({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		})),
		evaluateForecastAccounts: vi.fn(() => [
			{
				index: 0,
				label: "1. best@example.com",
				isCurrent: true,
				availability: "ready",
				riskScore: 0,
				riskLevel: "low",
				waitMs: 0,
				reasons: ["healthy"],
			},
		]),
		recommendForecastAccount: vi.fn(() => ({
			recommendedIndex: 0,
			reason: "lowest risk",
		})),
		persistAndSyncSelectedAccount: vi.fn(async () => ({
			synced: true,
			wasDisabled: false,
		})),
		setCodexCliActiveSelection: vi.fn(async () => true),
		logInfo: vi.fn(),
		logWarn: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		...overrides,
	};
}

describe("runBestCommand", () => {
	it("prints usage for help", async () => {
		const deps = createDeps();
		const result = await runBestCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.printBestUsage).toHaveBeenCalled();
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();
		const result = await runBestCommand(["--bad"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bad");
	});

	it("rejects --model without --live", async () => {
		const deps = createDeps({
			parseBestArgs: vi.fn(() => ({
				ok: true,
				options: {
					live: false,
					json: true,
					model: "gpt-5-codex",
					modelProvided: true,
				} satisfies BestCliOptions,
			})),
		});
		const result = await runBestCommand(["--model", "gpt-5-codex"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"--model requires --live for codex auth best",
		);
	});

	it("emits json output when no accounts are configured", async () => {
		const deps = createDeps({
			loadAccounts: vi.fn(async () => ({
				...createStorage([]),
				accounts: [],
			})),
		});
		const result = await runBestCommand([], deps);
		expect(result).toBe(1);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"error": "No accounts configured."'),
		);
	});

	it("prints json output when already on the best account", async () => {
		const deps = createDeps();
		const result = await runBestCommand([], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"accountIndex": 1'),
		);
	});

	it("persists refreshed probe tokens before an early-exit recommendation failure", async () => {
		const storage = createStorage([
			createAccount({
				accessToken: "expired-access",
				refreshToken: "expired-refresh",
				expiresAt: 0,
			}),
		]);
		const deps = createDeps({
			loadAccounts: vi.fn(async () => storage),
			parseBestArgs: vi.fn(() => ({
				ok: true,
				options: {
					live: true,
					json: true,
					model: "gpt-5-codex",
					modelProvided: false,
				} satisfies BestCliOptions,
			})),
			hasUsableAccessToken: vi.fn(() => false),
			queuedRefresh: vi.fn(async () => ({
				type: "success",
				access: "fresh-access",
				refresh: "fresh-refresh",
				expires: 9_999,
			})),
			extractAccountId: vi.fn(() => "account-id"),
			extractAccountEmail: vi.fn(() => "best@example.com"),
			recommendForecastAccount: vi.fn(() => ({
				recommendedIndex: null,
				reason: "all accounts exhausted",
			})),
		});

		const result = await runBestCommand(["--live"], deps);

		expect(result).toBe(1);
		expect(deps.saveAccounts).toHaveBeenCalledTimes(1);
		expect(deps.saveAccounts).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({
						accessToken: "fresh-access",
						refreshToken: "fresh-refresh",
						expiresAt: 9_999,
					}),
				],
			}),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"error": "all accounts exhausted"'),
		);
	});

	it("persists changed accounts even when the current best account did not refresh", async () => {
		const storage = createStorage([
			createAccount({
				email: "best@example.com",
				accessToken: "best-access",
				refreshToken: "best-refresh",
				expiresAt: 10_000,
				lastUsed: 10,
			}),
			createAccount({
				email: "backup@example.com",
				accessToken: "stale-access",
				refreshToken: "stale-refresh",
				expiresAt: 0,
				lastUsed: 20,
			}),
		]);
		const deps = createDeps({
			loadAccounts: vi.fn(async () => storage),
			parseBestArgs: vi.fn(() => ({
				ok: true,
				options: {
					live: true,
					json: true,
					model: "gpt-5-codex",
					modelProvided: false,
				} satisfies BestCliOptions,
			})),
			hasUsableAccessToken: vi.fn((account) => account.accessToken === "best-access"),
			queuedRefresh: vi.fn(async () => ({
				type: "success",
				access: "backup-access",
				refresh: "backup-refresh",
				expires: 20_000,
			})),
			extractAccountId: vi.fn((accessToken?: string) =>
				accessToken === "backup-access" ? "backup-id" : "best-id",
			),
			extractAccountEmail: vi.fn((accessToken?: string) =>
				accessToken === "backup-access"
					? "backup@example.com"
					: "best@example.com",
			),
			formatAccountLabel: vi.fn((account, index) => `${index + 1}. ${account.email}`),
			evaluateForecastAccounts: vi.fn(() => [
				{
					index: 0,
					label: "1. best@example.com",
					isCurrent: true,
					availability: "ready",
					riskScore: 0,
					riskLevel: "low",
					waitMs: 0,
					reasons: ["healthy"],
				},
				{
					index: 1,
					label: "2. backup@example.com",
					isCurrent: false,
					availability: "ready",
					riskScore: 1,
					riskLevel: "low",
					waitMs: 0,
					reasons: ["healthy"],
				},
			]),
			recommendForecastAccount: vi.fn(() => ({
				recommendedIndex: 0,
				reason: "best account already active",
			})),
		});

		const result = await runBestCommand(["--live"], deps);

		expect(result).toBe(0);
		expect(deps.saveAccounts).toHaveBeenCalledTimes(1);
		expect(deps.setCodexCliActiveSelection).not.toHaveBeenCalled();
		expect(deps.saveAccounts).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({ lastUsed: 1_000 }),
					expect.objectContaining({
						accessToken: "backup-access",
						refreshToken: "backup-refresh",
						expiresAt: 20_000,
					}),
				],
			}),
		);
	});

	it("avoids saving when a live refresh returns identical token state", async () => {
		const storage = createStorage([
			createAccount({
				accountId: "account-id",
				accountIdSource: "token",
				expiresAt: 0,
			}),
		]);
		const deps = createDeps({
			loadAccounts: vi.fn(async () => storage),
			parseBestArgs: vi.fn(() => ({
				ok: true,
				options: {
					live: true,
					json: true,
					model: "gpt-5-codex",
					modelProvided: false,
				} satisfies BestCliOptions,
			})),
			hasUsableAccessToken: vi.fn(() => false),
			queuedRefresh: vi.fn(async () => ({
				type: "success",
				access: "access-best",
				refresh: "refresh-best",
				expires: storage.accounts[0]!.expiresAt!,
				idToken: "id-token",
			})),
			extractAccountId: vi.fn(() => "account-id"),
			extractAccountEmail: vi.fn(() => "best@example.com"),
		});

		const result = await runBestCommand(["--live"], deps);

		expect(result).toBe(0);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
		expect(deps.setCodexCliActiveSelection).toHaveBeenCalledTimes(1);
	});

	it("switches to the recommended account when a better account is found", async () => {
		const storage = createStorage([
			createAccount({ email: "best@example.com" }),
			createAccount({ email: "current@example.com" }),
		]);
		const deps = createDeps({
			loadAccounts: vi.fn(async () => storage),
			resolveActiveIndex: vi.fn(() => 1),
			recommendForecastAccount: vi.fn(() => ({
				recommendedIndex: 0,
				reason: "lower risk",
			})),
			formatAccountLabel: vi.fn((account, index) => `${index + 1}. ${account.email}`),
		});

		const result = await runBestCommand([], deps);

		expect(result).toBe(0);
		expect(deps.persistAndSyncSelectedAccount).toHaveBeenCalledWith(
			expect.objectContaining({
				storage,
				targetIndex: 0,
				parsed: 1,
				switchReason: "best",
			}),
		);
	});
});
