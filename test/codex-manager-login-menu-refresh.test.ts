import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaCacheData } from "../lib/quota-cache.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const { loadQuotaCacheMock, saveQuotaCacheMock, fetchCodexQuotaSnapshotMock } =
	vi.hoisted(() => ({
		loadQuotaCacheMock: vi.fn(),
		saveQuotaCacheMock: vi.fn(),
		fetchCodexQuotaSnapshotMock: vi.fn(),
	}));

vi.mock("../lib/quota-cache.js", () => ({
	loadQuotaCache: loadQuotaCacheMock,
	saveQuotaCache: saveQuotaCacheMock,
}));

vi.mock("../lib/quota-probe.js", () => ({
	fetchCodexQuotaSnapshot: fetchCodexQuotaSnapshotMock,
}));

const { refreshQuotaCacheForMenu } = await import(
	"../lib/codex-manager/login-menu-data.js"
);

function createStorage(now: number): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "a@example.com",
				accountId: "acc_a",
				refreshToken: "refresh-a",
				accessToken: "access-a",
				expiresAt: now + 3_600_000,
				addedAt: now - 60_000,
				lastUsed: now - 60_000,
			},
			{
				email: "b@example.com",
				accountId: "acc_b",
				refreshToken: "refresh-b",
				accessToken: "access-b",
				expiresAt: now + 3_600_000,
				addedAt: now - 60_000,
				lastUsed: now - 60_000,
			},
		],
	};
}

function emptyCache(): QuotaCacheData {
	return { byAccountId: {}, byEmail: {} };
}

function snapshotFor(model: string) {
	return {
		status: 200,
		model,
		primary: { usedPercent: 10, windowMinutes: 300, resetAtMs: 1 },
		secondary: { usedPercent: 5, windowMinutes: 10080, resetAtMs: 2 },
	};
}

const CONCURRENT_ENTRY = {
	updatedAt: 1,
	status: 429,
	model: "gpt-5-codex",
	primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: 99 },
	secondary: {},
};

beforeEach(() => {
	loadQuotaCacheMock.mockReset();
	saveQuotaCacheMock.mockReset();
	fetchCodexQuotaSnapshotMock.mockReset();
	saveQuotaCacheMock.mockResolvedValue(undefined);
	fetchCodexQuotaSnapshotMock.mockResolvedValue(snapshotFor("gpt-5-codex"));
});

describe("refreshQuotaCacheForMenu", () => {
	it("rebases its results onto the freshest persisted cache before saving", async () => {
		// Regression for the last-write-wins clobber: a concurrent writer (deep
		// check, second session) saved acc_concurrent while the menu refresh was
		// probing against its stale snapshot clone. The whole-file save must keep
		// that entry, not silently discard it.
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: { acc_concurrent: { ...CONCURRENT_ENTRY } },
			byEmail: {},
		});

		const result = await refreshQuotaCacheForMenu(
			createStorage(Date.now()),
			emptyCache(),
			60_000,
		);

		expect(loadQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		const saved = saveQuotaCacheMock.mock.calls[0][0] as QuotaCacheData;
		expect(saved.byAccountId.acc_concurrent).toMatchObject({ status: 429 });
		expect(saved.byAccountId.acc_a).toMatchObject({ status: 200 });
		expect(saved.byAccountId.acc_b).toMatchObject({ status: 200 });
		expect(result).toBe(saved);
	});

	it("falls back to saving its own snapshot clone when the reload fails", async () => {
		loadQuotaCacheMock.mockRejectedValue(new Error("EBUSY"));

		const result = await refreshQuotaCacheForMenu(
			createStorage(Date.now()),
			emptyCache(),
			60_000,
		);

		expect(loadQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		const saved = saveQuotaCacheMock.mock.calls[0][0] as QuotaCacheData;
		expect(saved.byAccountId.acc_a).toMatchObject({ status: 200 });
		expect(saved.byAccountId.acc_b).toMatchObject({ status: 200 });
		expect(result).toBe(saved);
	});

	it("resolves and surfaces a warning when the save itself fails", async () => {
		// The save is best-effort (Windows EBUSY/EPERM must not fail the menu
		// refresh), but the failure must reach console.warn, not vanish into the
		// caller's background .catch.
		loadQuotaCacheMock.mockResolvedValue(emptyCache());
		saveQuotaCacheMock.mockRejectedValue(new Error("EBUSY: locked"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const result = await refreshQuotaCacheForMenu(
				createStorage(Date.now()),
				emptyCache(),
				60_000,
			);

			expect(result.byAccountId.acc_a).toMatchObject({ status: 200 });
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Quota cache save failed: EBUSY: locked"),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("still resolves and warns when both the reload and the save fail", async () => {
		// Windows can hold the cache file locked across the whole refresh cycle:
		// the reload falls back to the snapshot clone AND the save then rejects.
		// The refresh must resolve with the clone and surface the same warning.
		loadQuotaCacheMock.mockRejectedValue(new Error("EBUSY"));
		saveQuotaCacheMock.mockRejectedValue(new Error("EBUSY: locked"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const result = await refreshQuotaCacheForMenu(
				createStorage(Date.now()),
				emptyCache(),
				60_000,
			);

			expect(loadQuotaCacheMock).toHaveBeenCalledTimes(1);
			expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
			expect(result.byAccountId.acc_a).toMatchObject({ status: 200 });
			expect(result.byAccountId.acc_b).toMatchObject({ status: 200 });
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Quota cache save failed: EBUSY: locked"),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not reload or save when every probe fails", async () => {
		fetchCodexQuotaSnapshotMock.mockRejectedValue(new Error("network"));

		const cache = emptyCache();
		const result = await refreshQuotaCacheForMenu(
			createStorage(Date.now()),
			cache,
			60_000,
		);

		expect(loadQuotaCacheMock).not.toHaveBeenCalled();
		expect(saveQuotaCacheMock).not.toHaveBeenCalled();
		expect(result).toEqual(cache);
		// The function works on a clone; the caller's snapshot is never mutated.
		expect(result).not.toBe(cache);
	});

	it("returns the input cache untouched when there are no accounts", async () => {
		const cache = emptyCache();
		const result = await refreshQuotaCacheForMenu(
			{ version: 3, activeIndex: 0, activeIndexByFamily: {}, accounts: [] },
			cache,
			60_000,
		);
		expect(result).toBe(cache);
		expect(fetchCodexQuotaSnapshotMock).not.toHaveBeenCalled();
		expect(saveQuotaCacheMock).not.toHaveBeenCalled();
	});
});
