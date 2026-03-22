import { describe, expect, it, vi } from "vitest";
import {
	type FixAccountReport,
	runFixCommand,
	type FixCliOptions,
	type FixCommandDeps,
} from "../lib/codex-manager/commands/fix.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [],
	};
}

function createDeps(overrides: Partial<FixCommandDeps> = {}): FixCommandDeps {
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		parseFixArgs: vi.fn((args: string[]) => {
			if (args.includes("--bad")) return { ok: false as const, message: "Unknown option: --bad" };
			return { ok: true as const, options: { dryRun: false, json: true, live: false, model: "gpt-5-codex" } satisfies FixCliOptions };
		}),
		printFixUsage: vi.fn(),
		loadQuotaCache: vi.fn(async () => null),
		saveQuotaCache: vi.fn(async () => undefined),
		cloneQuotaCacheData: vi.fn((cache) => structuredClone(cache)),
		buildQuotaEmailFallbackState: vi.fn(() => new Map()),
		updateQuotaCacheForAccount: vi.fn(() => false),
		pruneUnsafeQuotaEmailCacheEntry: vi.fn(() => false),
		resolveActiveIndex: vi.fn(() => 0),
		hasUsableAccessToken: vi.fn(() => true),
		fetchCodexQuotaSnapshot: vi.fn(async () => ({ status: 200, model: "gpt-5-codex", primary: {}, secondary: {} })),
		formatCompactQuotaSnapshot: vi.fn(() => "5h 75%"),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		hasLikelyInvalidRefreshToken: vi.fn(() => false),
		queuedRefresh: vi.fn(async () => ({ type: "success", access: "access-fix", refresh: "refresh-fix", expires: Date.now() + 60_000 })),
		sanitizeEmail: vi.fn((email) => email),
		extractAccountEmail: vi.fn(() => undefined),
		extractAccountId: vi.fn(() => undefined),
		applyTokenAccountIdentity: vi.fn(() => false),
		isHardRefreshFailure: vi.fn(() => false),
		evaluateForecastAccounts: vi.fn(() => []),
		recommendForecastAccount: vi.fn(() => ({ recommendedIndex: null, reason: "none" })),
		saveAccounts: vi.fn(async () => undefined),
		formatAccountLabel: vi.fn((_account, index) => `${index + 1}. fix@example.com`),
		stylePromptText: vi.fn((text) => text),
		formatResultSummary: vi.fn((segments) => segments.map((segment) => segment.text).join(" | ")),
		styleAccountDetailText: vi.fn((text) => text),
		defaultDisplay: {
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			menuAutoFetchLimits: true,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		},
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		...overrides,
	};
}

describe("runFixCommand", () => {
	it("prints usage for help", async () => {
		const deps = createDeps();
		const result = await runFixCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.printFixUsage).toHaveBeenCalled();
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();
		const result = await runFixCommand(["--bad"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bad");
	});

	it("prints json output for empty storage", async () => {
		const deps = createDeps({
			loadAccounts: vi.fn(async () => null),
		});
		const result = await runFixCommand([], deps);
		expect(result).toBe(0);
		const payload = JSON.parse(String((deps.logInfo as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])) as {
			command: string;
			reports: FixAccountReport[];
			recommendation: { recommendedIndex: number | null; reason: string };
		};
		expect(payload.command).toBe("fix");
		expect(payload.reports).toEqual([]);
		expect(payload.recommendation).toEqual({
			recommendedIndex: null,
			reason: "No accounts configured.",
		});
	});

	it("keeps usable access tokens healthy when the live probe fails", async () => {
		const storage = createStorage();
		storage.accounts.push({
			email: "fix@example.com",
			refreshToken: "refresh-token",
			accessToken: "access-token",
			accountId: "acc_1",
			expiresAt: 9_999,
			addedAt: 0,
			lastUsed: 0,
			enabled: true,
		});
		const deps = createDeps({
			loadAccounts: vi.fn(async () => structuredClone(storage)),
			parseFixArgs: vi.fn(() => ({
				ok: true as const,
				options: {
					dryRun: false,
					json: true,
					live: true,
					model: "gpt-5-codex",
				} satisfies FixCliOptions,
			})),
			fetchCodexQuotaSnapshot: vi
				.fn()
				.mockRejectedValueOnce(new Error("probe exploded")),
			extractAccountId: vi.fn((accessToken?: string) =>
				accessToken ? "acc_1" : undefined,
			),
		});

		const result = await runFixCommand([], deps);

		expect(result).toBe(0);
		expect(deps.queuedRefresh).not.toHaveBeenCalled();
		const payload = JSON.parse(String((deps.logInfo as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])) as {
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(payload.reports).toHaveLength(2);
		expect(payload.reports[0]).toMatchObject({
			outcome: "warning-soft-failure",
			message: "live probe failed (probe exploded), trying refresh fallback",
		});
		expect(payload.reports[1]).toMatchObject({
			outcome: "healthy",
			message: "access token still valid",
		});
	});

	it("does not persist accounts or quota cache during dry-run json mode", async () => {
		const storage = createStorage();
		storage.accounts.push({
			email: "fix@example.com",
			refreshToken: "refresh-token",
			accessToken: "access-token",
			accountId: "acc_1",
			expiresAt: 9_999,
			addedAt: 0,
			lastUsed: 0,
			enabled: true,
		});
		const deps = createDeps({
			loadAccounts: vi.fn(async () => structuredClone(storage)),
			parseFixArgs: vi.fn(() => ({
				ok: true as const,
				options: {
					dryRun: true,
					json: true,
					live: true,
					model: "gpt-5-codex",
				} satisfies FixCliOptions,
			})),
			loadQuotaCache: vi.fn(async () => ({
				version: 1,
				byAccountId: {},
				byEmail: {},
			})),
			updateQuotaCacheForAccount: vi.fn(() => true),
			extractAccountId: vi.fn((accessToken?: string) =>
				accessToken ? "acc_1" : undefined,
			),
		});

		const result = await runFixCommand([], deps);

		expect(result).toBe(0);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
		expect(deps.saveQuotaCache).not.toHaveBeenCalled();
	});

	it("renders preview output without saving in human mode", async () => {
		const storage = createStorage();
		storage.accounts.push({
			email: "fix@example.com",
			refreshToken: "refresh-token",
			accessToken: "access-token",
			accountId: "acc_1",
			expiresAt: 900,
			addedAt: 0,
			lastUsed: 0,
			enabled: true,
		});
		const deps = createDeps({
			loadAccounts: vi.fn(async () => structuredClone(storage)),
			parseFixArgs: vi.fn(() => ({
				ok: true as const,
				options: {
					dryRun: true,
					json: false,
					live: false,
					model: "gpt-5-codex",
				} satisfies FixCliOptions,
			})),
			hasUsableAccessToken: vi.fn(() => false),
			queuedRefresh: vi.fn(async () => ({
				type: "success",
				access: "access-refreshed",
				refresh: "refresh-refreshed",
				expires: 8_000,
				idToken: "id-token",
			})),
		});

		const result = await runFixCommand([], deps);

		expect(result).toBe(0);
		expect(deps.stylePromptText).toHaveBeenCalledWith(
			"Auto-fix scan (preview)",
			"accent",
		);
		expect(deps.formatResultSummary).toHaveBeenCalledWith([
			{ text: "1 working", tone: "success" },
			{ text: "0 disabled", tone: "muted" },
			{ text: "0 warnings", tone: "muted" },
			{ text: "0 already disabled", tone: "muted" },
		]);
		expect(deps.styleAccountDetailText).toHaveBeenCalledWith(
			"refresh succeeded",
			"muted",
		);
		expect(deps.saveAccounts).not.toHaveBeenCalled();
		expect(deps.saveQuotaCache).not.toHaveBeenCalled();

		const infoLines = (deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.map(
			([message]) => String(message),
		);
		expect(infoLines).toContain("Auto-fix scan (preview)");
		expect(infoLines).toContain(
			"1 working | 0 disabled | 0 warnings | 0 already disabled",
		);
		expect(infoLines).toContain("\nPreview only: no changes were saved.");
	});
});
