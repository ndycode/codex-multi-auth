import { describe, expect, it, vi } from "vitest";
import {
	type ForecastCommandDeps,
	runForecastCommand,
} from "../lib/codex-manager/commands/forecast.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "forecast@example.com",
				refreshToken: "refresh-forecast",
				accessToken: "access-forecast",
				expiresAt: Date.now() + 60_000,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
		],
	};
}

function createDeps(
	overrides: Partial<
		ForecastCommandDeps & {
			formatQuotaSnapshotLine: (snapshot: unknown) => string;
		}
	> = {},
): ForecastCommandDeps & {
	formatQuotaSnapshotLine: (snapshot: unknown) => string;
} {
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		resolveActiveIndex: vi.fn(() => 0),
		loadQuotaCache: vi.fn(async () => ({ byAccountId: {}, byEmail: {} })),
		saveQuotaCache: vi.fn(async () => undefined),
		cloneQuotaCacheData: vi.fn((cache) => structuredClone(cache)),
		buildQuotaEmailFallbackState: vi.fn(() => new Map()),
		updateQuotaCacheForAccount: vi.fn(() => false),
		hasUsableAccessToken: vi.fn(() => true),
		queuedRefresh: vi.fn(async () => ({
			type: "success",
			access: "access-forecast",
			refresh: "refresh-forecast",
			expires: Date.now() + 60_000,
		})),
		fetchCodexQuotaSnapshot: vi.fn(async () => ({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		})),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		formatAccountLabel: vi.fn(
			(_account, index) => `${index + 1}. forecast@example.com`,
		),
		extractAccountId: vi.fn(() => "account-id"),
		evaluateForecastAccounts: vi.fn(() => [
			{
				index: 0,
				label: "1. forecast@example.com",
				isCurrent: true,
				availability: "ready",
				riskScore: 0,
				riskLevel: "low",
				waitMs: 0,
				reasons: ["healthy"],
			},
		]),
		summarizeForecast: vi.fn(() => ({
			total: 1,
			ready: 1,
			delayed: 0,
			unavailable: 0,
			highRisk: 0,
		})),
		recommendForecastAccount: vi.fn(() => ({
			recommendedIndex: 0,
			reason: "lowest risk",
		})),
		stylePromptText: vi.fn((text) => text),
		formatResultSummary: vi.fn((segments) =>
			segments.map((segment) => segment.text).join(" | "),
		),
		styleQuotaSummary: vi.fn((summary) => summary),
		formatCompactQuotaSnapshot: vi.fn(() => "5h 75%"),
		availabilityTone: vi.fn(() => "success"),
		riskTone: vi.fn(() => "success"),
		formatWaitTime: vi.fn(() => "1m"),
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
		formatQuotaSnapshotLine: vi.fn(() => "quota summary"),
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		...overrides,
	} as ForecastCommandDeps & {
		formatQuotaSnapshotLine: (snapshot: unknown) => string;
	};
}

describe("runForecastCommand", () => {
	it("prints usage for help", async () => {
		const deps = createDeps();
		const result = await runForecastCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining("codex auth forecast"),
		);
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();
		const result = await runForecastCommand(["--bogus"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bogus");
	});

	it("prints json output for populated storage", async () => {
		const deps = createDeps();
		const result = await runForecastCommand(["--json"], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"command": "forecast"'),
		);
	});
});
