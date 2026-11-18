import { describe, expect, it, vi } from "vitest";
import {
	type BestCliOptions,
	type BestCommandDeps,
	runBestCommand,
} from "../lib/codex-manager/commands/best.js";
import { CodexUnavailableError } from "../lib/errors.js";
import { CODEX_UNAVAILABLE_PROBE_NOTE } from "../lib/quota-probe.js";
import { DEFAULT_LIVE_PROBE_MODEL } from "../lib/codex-manager/quota-cache-helpers.js";
import {
	getModelProfile,
	resolveNormalizedModel,
} from "../lib/request/helpers/model-map.js";
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
			"--model requires --live for codex-multi-auth best",
		);
	});

	it("threads the probe model's family and id into forecast evaluation", async () => {
		const evaluateForecastAccounts = vi.fn((inputs) => {
			void inputs;
			return [
				{
					index: 0,
					label: "1. best@example.com",
					isCurrent: true,
					availability: "ready",
					riskScore: 0,
					riskLevel: "low",
					waitMs: 0,
					reasons: [],
				},
			] as const;
		});
		const deps = createDeps({
			evaluateForecastAccounts,
			parseBestArgs: vi.fn(() => ({
				ok: true as const,
				options: {
					live: false,
					json: true,
					model: DEFAULT_LIVE_PROBE_MODEL,
					modelProvided: false,
				} satisfies BestCliOptions,
			})),
		});

		await expect(runBestCommand(["--json"], deps)).resolves.toBe(0);
		const defaulted = evaluateForecastAccounts.mock.calls.at(-1)?.[0] as
			| Array<{ family?: string; model?: string | null }>
			| undefined;
		// `best` picks the account for wrapper traffic, which is codex-family.
		// DEFAULT_LIVE_PROBE_MODEL is gpt-5.6-sol, whose family is gpt-5.2, so a
		// bare invocation must leave both unset and fall back to codex rather
		// than rank accounts against a family no wrapper request uses.
		expect(getModelProfile(DEFAULT_LIVE_PROBE_MODEL).promptFamily).not.toBe(
			"codex",
		);
		expect(defaulted?.[0]?.family).toBeUndefined();
		expect(defaulted?.[0]?.model).toBeUndefined();

		const explicitDeps = createDeps({
			evaluateForecastAccounts,
			parseBestArgs: vi.fn(() => ({
				ok: true as const,
				options: {
					live: true,
					json: true,
					// The bare alias, NOT the canonical id: resolveNormalizedModel
					// maps it to "gpt-5.6-sol", so this proves the normalized id
					// is what reaches evaluation rather than the raw flag value.
					model: "gpt-5.6",
					modelProvided: true,
				} satisfies BestCliOptions,
			})),
		});
		await expect(
			runBestCommand(["--json", "--live", "--model", "gpt-5.6"], explicitDeps),
		).resolves.toBe(0);
		const explicit = evaluateForecastAccounts.mock.calls.at(-1)?.[0] as
			| Array<{ family?: string; model?: string | null }>
			| undefined;
		expect(explicit?.[0]?.family).toBe(getModelProfile("gpt-5.6").promptFamily);
		expect(resolveNormalizedModel("gpt-5.6")).not.toBe("gpt-5.6");
		expect(explicit?.[0]?.model).toBe(resolveNormalizedModel("gpt-5.6"));
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

	it("surfaces the friendly note for codex-unavailable live probe failures", async () => {
		const deps = createDeps({
			parseBestArgs: vi.fn(() => ({
				ok: true,
				options: {
					live: true,
					json: true,
					model: "gpt-5-codex",
					modelProvided: false,
				} satisfies BestCliOptions,
			})),
			fetchCodexQuotaSnapshot: vi.fn(async () => {
				throw new CodexUnavailableError(
					"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
				);
			}),
		});

		const result = await runBestCommand(["--live"], deps);

		expect(result).toBe(0);
		const jsonCall = (deps.logInfo as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => String(call[0]))
			.find((line) => line.includes("probeErrors"));
		expect(jsonCall).toBeDefined();
		const payload = JSON.parse(jsonCall as string) as {
			probeErrors?: string[];
		};
		expect(payload.probeErrors).toBeDefined();
		expect(payload.probeErrors?.some((e) => e.includes(CODEX_UNAVAILABLE_PROBE_NOTE))).toBe(true);
		// must not leak the raw upstream error
		expect(jsonCall).not.toContain("is not supported when using Codex");
	});

	it("normalizes non-codex-unavailable probe failures without leaking raw detail", async () => {
		const deps = createDeps({
			parseBestArgs: vi.fn(() => ({
				ok: true,
				options: {
					live: true,
					json: true,
					model: "gpt-5-codex",
					modelProvided: false,
				} satisfies BestCliOptions,
			})),
			normalizeFailureDetail: vi.fn(() => "rate limited; retry later"),
			fetchCodexQuotaSnapshot: vi.fn(async () => {
				throw new Error(
					'{"error":{"message":"token sk-secret leaked"}} HTTP 429',
				);
			}),
		});

		const result = await runBestCommand(["--live"], deps);

		expect(result).toBe(0);
		const jsonCall = (deps.logInfo as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => String(call[0]))
			.find((line) => line.includes("probeErrors"));
		const payload = JSON.parse(jsonCall as string) as {
			probeErrors?: string[];
		};
		expect(payload.probeErrors?.some((e) => e.includes("rate limited; retry later"))).toBe(true);
		expect(jsonCall).not.toContain("sk-secret");
	});
});

describe("runBestCommand with a Codex CLI mirror", () => {
	it("syncs the mirror id when the current best account is refreshed", async () => {
		const storage = createStorage([
			createAccount({
				accountId: "ws-team",
				accountIdSource: "manual",
				codexCliMirror: { forAccountId: "ws-team", accountId: "ws-authorized" },
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
				access: "access-best-next",
				refresh: "refresh-best-next",
				expires: Date.now() + 120_000,
				idToken: "id-token",
			})),
			// No claim: best's refresh then keeps the saved explicit id.
			extractAccountId: vi.fn(() => undefined),
			extractAccountEmail: vi.fn(() => "best@example.com"),
		});

		expect(await runBestCommand(["--live"], deps)).toBe(0);

		expect(deps.setCodexCliActiveSelection).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ accountId: "ws-authorized" }),
		);
	});
});

// A refresh may only move a token-derived id: an explicit (manual) binding
// has to survive a token whose claim names another workspace, exactly as on
// every other refresh path.
describe("runBestCommand refresh keeps explicit bindings", () => {
	it("keeps a manual id and source across a refresh and syncs codexCliAccountIdFor's id", async () => {
		const storage = createStorage([
			createAccount({
				accountId: "ws-team",
				accountIdSource: "manual",
				codexCliMirror: { forAccountId: "ws-team", accountId: "ws-authorized" },
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
				access: "access-best-next",
				refresh: "refresh-best-next",
				expires: Date.now() + 120_000,
				idToken: "id-token",
			})),
			extractAccountId: vi.fn(() => "ws-token-claim"),
			extractAccountEmail: vi.fn(() => "best@example.com"),
		});

		expect(await runBestCommand(["--live"], deps)).toBe(0);

		expect(storage.accounts[0]).toMatchObject({
			accountId: "ws-team",
			accountIdSource: "manual",
		});
		expect(deps.fetchCodexQuotaSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "ws-team" }),
		);
		expect(deps.setCodexCliActiveSelection).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ accountId: "ws-authorized" }),
		);
	});
});
