import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	type DashboardDisplaySettings,
} from "../lib/dashboard-settings.js";
import type { QuotaCacheData, QuotaCacheEntry } from "../lib/quota-cache.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";

const {
	loadCodexCliStateMock,
	setCodexCliActiveSelectionMock,
	loadRuntimeSnapshotMock,
	getAppBindStatusMock,
	readAppRuntimeHelperAccountSignalMock,
	resolveRuntimeCurrentAccountMock,
} = vi.hoisted(() => ({
	loadCodexCliStateMock: vi.fn(),
	setCodexCliActiveSelectionMock: vi.fn(),
	loadRuntimeSnapshotMock: vi.fn(),
	getAppBindStatusMock: vi.fn(),
	readAppRuntimeHelperAccountSignalMock: vi.fn(),
	resolveRuntimeCurrentAccountMock: vi.fn(),
}));

vi.mock("../lib/codex-cli/state.js", () => ({
	loadCodexCliState: loadCodexCliStateMock,
}));

vi.mock("../lib/codex-cli/writer.js", () => ({
	setCodexCliActiveSelection: setCodexCliActiveSelectionMock,
}));

vi.mock("../lib/runtime/runtime-observability.js", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../lib/runtime/runtime-observability.js")
	>();
	return {
		...actual,
		loadPersistedRuntimeObservabilitySnapshot: loadRuntimeSnapshotMock,
	};
});

vi.mock("../lib/runtime/app-bind.js", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../lib/runtime/app-bind.js")
	>();
	return { ...actual, getAppBindStatus: getAppBindStatusMock };
});

vi.mock("../lib/runtime/runtime-current-account.js", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../lib/runtime/runtime-current-account.js")
	>();
	return {
		...actual,
		readAppRuntimeHelperAccountSignal: readAppRuntimeHelperAccountSignalMock,
		resolveRuntimeCurrentAccount: resolveRuntimeCurrentAccountMock,
	};
});

const {
	countMenuQuotaRefreshTargets,
	loadRuntimeCurrentSelectionForStorage,
	syncCodexCliActiveSelectionIfDrifted,
	toExistingAccountInfo,
} = await import("../lib/codex-manager/login-menu-data.js");

const NOW = 1_700_000_000_000;
const TTL_MS = 60_000;

function account(
	id: string,
	overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
	return {
		email: `${id}@example.com`,
		accountId: `acc_${id}`,
		refreshToken: `refresh-${id}`,
		accessToken: `access-${id}`,
		expiresAt: NOW + 3_600_000,
		addedAt: NOW - 60_000,
		lastUsed: NOW - 60_000,
		...overrides,
	};
}

function storageWith(
	accounts: AccountMetadataV3[],
	activeIndex = 0,
): AccountStorageV3 {
	return { version: 3, activeIndex, activeIndexByFamily: {}, accounts };
}

function cacheEntry(
	overrides: Partial<QuotaCacheEntry> = {},
	now = NOW,
): QuotaCacheEntry {
	return {
		updatedAt: now - 1_000,
		status: 200,
		model: "gpt-5-codex",
		primary: { usedPercent: 10, windowMinutes: 300, resetAtMs: now + 3_600_000 },
		secondary: {
			usedPercent: 10,
			windowMinutes: 10_080,
			resetAtMs: now + 86_400_000,
		},
		...overrides,
	};
}

function emptyCache(): QuotaCacheData {
	return { byAccountId: {}, byEmail: {} };
}

function settings(
	overrides: Partial<DashboardDisplaySettings> = {},
): DashboardDisplaySettings {
	return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS, ...overrides };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("countMenuQuotaRefreshTargets", () => {
	it("counts enabled accounts with usable tokens and no fresh cache entry", () => {
		const storage = storageWith([account("a"), account("b")]);
		expect(
			countMenuQuotaRefreshTargets(storage, emptyCache(), TTL_MS, NOW),
		).toBe(2);
	});

	it("skips disabled accounts", () => {
		const storage = storageWith([
			account("a", { enabled: false }),
			account("b"),
		]);
		expect(
			countMenuQuotaRefreshTargets(storage, emptyCache(), TTL_MS, NOW),
		).toBe(1);
	});

	it("skips accounts whose access token is about to expire", () => {
		// hasUsableAccessToken requires more than the 5-minute freshness window.
		const storage = storageWith([
			account("a", { expiresAt: NOW + 60_000 }),
			account("b"),
		]);
		expect(
			countMenuQuotaRefreshTargets(storage, emptyCache(), TTL_MS, NOW),
		).toBe(1);
	});

	it("skips fresh cache entries but counts stale ones", () => {
		const storage = storageWith([account("a"), account("b")]);
		const cache: QuotaCacheData = {
			byAccountId: {
				acc_a: cacheEntry({ updatedAt: NOW - TTL_MS / 2 }),
				acc_b: cacheEntry({ updatedAt: NOW - TTL_MS * 2 }),
			},
			byEmail: {},
		};
		expect(countMenuQuotaRefreshTargets(storage, cache, TTL_MS, NOW)).toBe(1);
	});

	it("skips accounts whose probe result could not be stored safely", () => {
		// Duplicate accountIds with no email fallback: a cached snapshot could
		// not be attributed to either account later, so neither is probed.
		const storage = storageWith([
			account("a", { accountId: "acc_dup", email: undefined }),
			account("b", { accountId: "acc_dup", email: undefined }),
		]);
		expect(
			countMenuQuotaRefreshTargets(storage, emptyCache(), TTL_MS, NOW),
		).toBe(0);
	});
});

describe("toExistingAccountInfo", () => {
	it("maps account state and cache entries onto row statuses", () => {
		const now = Date.now();
		const storage = storageWith([
			account("current"),
			account("disabled", { enabled: false }),
			account("cooling", { coolingDownUntil: now + 60_000 }),
			account("exhausted"),
			account("limited"),
			account("plain"),
		]);
		const cache: QuotaCacheData = {
			byAccountId: {
				acc_exhausted: cacheEntry(
					{ primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: now + 3_600_000 } },
					now,
				),
				acc_limited: cacheEntry({ status: 429 }, now),
			},
			byEmail: {},
		};

		const rows = toExistingAccountInfo(
			storage,
			cache,
			settings({ menuSortEnabled: false }),
		);

		expect(rows.map((row) => row.status)).toEqual([
			"active",
			"disabled",
			"cooldown",
			"quota-exhausted",
			"rate-limited",
			"ok",
		]);
		expect(rows[3].quota5hLeftPercent).toBe(0);
		expect(rows[4].quotaRateLimited).toBe(true);
		expect(rows[0].isCurrentAccount).toBe(true);
		expect(rows[0].isDefaultAccount).toBe(true);
	});

	it("orders rows ready-first and renumbers display indexes", () => {
		const now = Date.now();
		const storage = storageWith([
			account("low"),
			account("empty"),
			account("high"),
		]);
		const cache: QuotaCacheData = {
			byAccountId: {
				acc_low: cacheEntry(
					{ primary: { usedPercent: 70, windowMinutes: 300, resetAtMs: now + 3_600_000 }, secondary: { usedPercent: 70, windowMinutes: 10_080, resetAtMs: now + 86_400_000 } },
					now,
				),
				acc_empty: cacheEntry(
					{ primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: now + 3_600_000 } },
					now,
				),
				acc_high: cacheEntry(
					{ primary: { usedPercent: 10, windowMinutes: 300, resetAtMs: now + 3_600_000 }, secondary: { usedPercent: 10, windowMinutes: 10_080, resetAtMs: now + 86_400_000 } },
					now,
				),
			},
			byEmail: {},
		};

		const rows = toExistingAccountInfo(
			storage,
			cache,
			settings({
				menuSortEnabled: true,
				menuSortMode: "ready-first",
				menuSortPinCurrent: false,
			}),
		);

		// Most quota headroom first, exhausted account last.
		expect(rows.map((row) => row.accountId)).toEqual([
			"acc_high",
			"acc_low",
			"acc_empty",
		]);
		// index is the display position; sourceIndex still points at storage.
		expect(rows.map((row) => row.index)).toEqual([0, 1, 2]);
		expect(rows.map((row) => row.sourceIndex)).toEqual([2, 0, 1]);
		// Quick-switch numbers follow visible rows by default.
		expect(rows.map((row) => row.quickSwitchNumber)).toEqual([1, 2, 3]);
		// The default (active) account marker survives reordering.
		expect(rows.find((row) => row.accountId === "acc_low")?.isDefaultAccount).toBe(
			true,
		);
	});

	it("numbers quick-switch by storage position when visible-row numbering is off", () => {
		const now = Date.now();
		const storage = storageWith([account("low"), account("high")]);
		const cache: QuotaCacheData = {
			byAccountId: {
				acc_low: cacheEntry(
					{ primary: { usedPercent: 90, windowMinutes: 300, resetAtMs: now + 3_600_000 }, secondary: { usedPercent: 90, windowMinutes: 10_080, resetAtMs: now + 86_400_000 } },
					now,
				),
				acc_high: cacheEntry(
					{ primary: { usedPercent: 5, windowMinutes: 300, resetAtMs: now + 3_600_000 }, secondary: { usedPercent: 5, windowMinutes: 10_080, resetAtMs: now + 86_400_000 } },
					now,
				),
			},
			byEmail: {},
		};

		const rows = toExistingAccountInfo(
			storage,
			cache,
			settings({
				menuSortEnabled: true,
				menuSortMode: "ready-first",
				menuSortQuickSwitchVisibleRow: false,
			}),
		);

		expect(rows.map((row) => row.accountId)).toEqual(["acc_high", "acc_low"]);
		expect(rows.map((row) => row.quickSwitchNumber)).toEqual([2, 1]);
	});

	it("preserves storage order when sorting is disabled", () => {
		const storage = storageWith([account("b"), account("a")]);

		const rows = toExistingAccountInfo(
			storage,
			null,
			settings({ menuSortEnabled: false }),
		);

		expect(rows.map((row) => row.accountId)).toEqual(["acc_b", "acc_a"]);
		expect(rows.map((row) => row.quickSwitchNumber)).toEqual([1, 2]);
	});
});

describe("syncCodexCliActiveSelectionIfDrifted", () => {
	it("does nothing when the CLI state matches the active account id", async () => {
		loadCodexCliStateMock.mockResolvedValue({ activeAccountId: "acc_a" });

		const result = await syncCodexCliActiveSelectionIfDrifted(
			storageWith([account("a")]),
		);

		expect(result).toBe(false);
		expect(loadCodexCliStateMock).toHaveBeenCalledWith({ forceRefresh: true });
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
	});

	it("does nothing when there is no CLI state to compare against", async () => {
		loadCodexCliStateMock.mockResolvedValue(null);

		const result = await syncCodexCliActiveSelectionIfDrifted(
			storageWith([account("a")]),
		);

		expect(result).toBe(false);
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
	});

	it("rewrites the CLI selection when the account id drifted", async () => {
		loadCodexCliStateMock.mockResolvedValue({ activeAccountId: "acc_other" });
		setCodexCliActiveSelectionMock.mockResolvedValue(true);
		const active = account("a");

		const result = await syncCodexCliActiveSelectionIfDrifted(
			storageWith([active, account("b")]),
		);

		expect(result).toBe(true);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith({
			accountId: active.accountId,
			email: active.email,
			accessToken: active.accessToken,
			refreshToken: active.refreshToken,
			expiresAt: active.expiresAt,
		});
	});

	it("propagates a skipped CLI write as false", async () => {
		// e.g. Windows EBUSY preventing the auth.json write: the writer reports
		// false and the caller must see that, not a swallowed true.
		loadCodexCliStateMock.mockResolvedValue({ activeAccountId: "acc_other" });
		setCodexCliActiveSelectionMock.mockResolvedValue(false);

		const result = await syncCodexCliActiveSelectionIfDrifted(
			storageWith([account("a")]),
		);

		expect(result).toBe(false);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
	});

	it("matches by sanitized email when account ids are unavailable", async () => {
		loadCodexCliStateMock.mockResolvedValue({
			activeEmail: "  A@EXAMPLE.COM ",
		});

		const result = await syncCodexCliActiveSelectionIfDrifted(
			storageWith([account("a", { accountId: undefined })]),
		);

		expect(result).toBe(false);
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
	});

	it("treats CLI state read failures as no drift", async () => {
		loadCodexCliStateMock.mockRejectedValue(new Error("corrupt state"));

		const result = await syncCodexCliActiveSelectionIfDrifted(
			storageWith([account("a")]),
		);

		expect(result).toBe(false);
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
	});

	it("does nothing for an empty account pool", async () => {
		const result = await syncCodexCliActiveSelectionIfDrifted(storageWith([]));

		expect(result).toBe(false);
		expect(loadCodexCliStateMock).not.toHaveBeenCalled();
	});
});

describe("loadRuntimeCurrentSelectionForStorage", () => {
	const SELECTION = {
		index: 1,
		source: "app-bind" as const,
		matchedBy: "account-id" as const,
		updatedAt: NOW,
	};

	it("feeds all three runtime signals into the resolver and returns its result", async () => {
		const snapshot = { generatedAt: NOW };
		const router = { running: true, port: 4242 };
		const helperSignal = { source: "app-helper" as const };
		loadRuntimeSnapshotMock.mockResolvedValue(snapshot);
		getAppBindStatusMock.mockResolvedValue({ running: true, router });
		readAppRuntimeHelperAccountSignalMock.mockReturnValue(helperSignal);
		resolveRuntimeCurrentAccountMock.mockReturnValue(SELECTION);
		const storage = storageWith([account("a"), account("b")]);

		const result = await loadRuntimeCurrentSelectionForStorage(storage, NOW);

		expect(result).toBe(SELECTION);
		expect(resolveRuntimeCurrentAccountMock).toHaveBeenCalledExactlyOnceWith(
			storage,
			{
				runtimeSnapshot: snapshot,
				appBindStatus: router,
				appHelperStatus: helperSignal,
			},
			{ now: NOW },
		);
	});

	it("drops the app-bind signal when the router is not running", async () => {
		loadRuntimeSnapshotMock.mockResolvedValue(null);
		getAppBindStatusMock.mockResolvedValue({ running: false, router: { running: false } });
		readAppRuntimeHelperAccountSignalMock.mockReturnValue(null);
		resolveRuntimeCurrentAccountMock.mockReturnValue(null);

		const result = await loadRuntimeCurrentSelectionForStorage(
			storageWith([account("a")]),
			NOW,
		);

		expect(result).toBeNull();
		expect(resolveRuntimeCurrentAccountMock).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			expect.objectContaining({ appBindStatus: null }),
			{ now: NOW },
		);
	});

	it("treats failing signal sources as absent instead of throwing", async () => {
		loadRuntimeSnapshotMock.mockRejectedValue(new Error("corrupt snapshot"));
		getAppBindStatusMock.mockRejectedValue(new Error("no router"));
		readAppRuntimeHelperAccountSignalMock.mockReturnValue(null);
		resolveRuntimeCurrentAccountMock.mockReturnValue(null);

		await expect(
			loadRuntimeCurrentSelectionForStorage(storageWith([account("a")]), NOW),
		).resolves.toBeNull();

		expect(resolveRuntimeCurrentAccountMock).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			{ runtimeSnapshot: null, appBindStatus: null, appHelperStatus: null },
			{ now: NOW },
		);
	});
});
