import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaCacheData } from "../lib/quota-cache.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";

const {
	loadAccountsMock,
	saveAccountsMock,
	queuedRefreshMock,
	setCodexCliActiveSelectionMock,
	loadQuotaCacheMock,
	saveQuotaCacheMock,
	fetchCodexQuotaSnapshotMock,
} = vi.hoisted(() => ({
	loadAccountsMock: vi.fn(),
	saveAccountsMock: vi.fn(),
	queuedRefreshMock: vi.fn(),
	setCodexCliActiveSelectionMock: vi.fn(),
	loadQuotaCacheMock: vi.fn(),
	saveQuotaCacheMock: vi.fn(),
	fetchCodexQuotaSnapshotMock: vi.fn(),
}));

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		loadAccounts: loadAccountsMock,
		saveAccounts: saveAccountsMock,
		setStoragePath: vi.fn(),
	};
});

vi.mock("../lib/refresh-queue.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/refresh-queue.js")>();
	return { ...actual, queuedRefresh: queuedRefreshMock };
});

vi.mock("../lib/codex-cli/writer.js", () => ({
	setCodexCliActiveSelection: setCodexCliActiveSelectionMock,
}));

vi.mock("../lib/quota-cache.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/quota-cache.js")>();
	return {
		...actual,
		loadQuotaCache: loadQuotaCacheMock,
		saveQuotaCache: saveQuotaCacheMock,
	};
});

vi.mock("../lib/quota-probe.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/quota-probe.js")>();
	return { ...actual, fetchCodexQuotaSnapshot: fetchCodexQuotaSnapshotMock };
});

const { runHealthCheck } = await import(
	"../lib/codex-manager/health-check.js"
);
const { inspectRequestedModel } = await import(
	"../lib/codex-manager/formatters/index.js"
);
const { DEFAULT_LIVE_PROBE_MODEL } = await import(
	"../lib/codex-manager/quota-cache-helpers.js"
);

// Token freshness is decided against the real clock inside runHealthCheck.
const REAL_NOW = Date.now();
const STALE_EXPIRES_AT = REAL_NOW + 60_000;

function account(
	id: string,
	overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
	return {
		email: `${id}@example.com`,
		accountId: `acc_${id}`,
		refreshToken: `refresh-${id}-long-enough-to-look-real`,
		accessToken: `access-${id}`,
		expiresAt: REAL_NOW + 3_600_000,
		addedAt: REAL_NOW - 60_000,
		lastUsed: REAL_NOW - 60_000,
		...overrides,
	};
}

function storageWith(
	accounts: AccountMetadataV3[],
	activeIndex = 0,
): AccountStorageV3 {
	return { version: 3, activeIndex, activeIndexByFamily: {}, accounts };
}

function emptyCache(): QuotaCacheData {
	return { byAccountId: {}, byEmail: {} };
}

function snapshot() {
	return {
		status: 200,
		model: "gpt-5-codex",
		primary: { usedPercent: 10, windowMinutes: 300, resetAtMs: REAL_NOW + 1 },
		secondary: {
			usedPercent: 5,
			windowMinutes: 10_080,
			resetAtMs: REAL_NOW + 2,
		},
	};
}

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function logged(): string {
	return logSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

beforeEach(() => {
	vi.clearAllMocks();
	saveAccountsMock.mockResolvedValue(undefined);
	setCodexCliActiveSelectionMock.mockResolvedValue(true);
	loadQuotaCacheMock.mockResolvedValue(emptyCache());
	saveQuotaCacheMock.mockResolvedValue(undefined);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
	warnSpy.mockRestore();
});

describe("runHealthCheck quick check", () => {
	it("reports when no accounts are configured", async () => {
		loadAccountsMock.mockResolvedValue(null);

		await runHealthCheck();

		expect(logged()).toContain("No accounts configured.");
		expect(queuedRefreshMock).not.toHaveBeenCalled();
	});

	it("trusts fresh sessions without refreshing and syncs the active account", async () => {
		const storage = storageWith([account("a"), account("b")]);
		loadAccountsMock.mockResolvedValue(storage);

		await runHealthCheck();

		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(logged()).toContain("2 working");
		expect(logged()).toContain("0 need re-login");
		// The active account's session was validated, so the CLI state is synced.
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ accountId: "acc_a" }),
		);
		// Nothing changed, so no storage write.
		expect(saveAccountsMock).not.toHaveBeenCalled();
	});

	it("re-enables a disabled-but-healthy account and persists the change", async () => {
		const storage = storageWith([account("a", { enabled: false })]);
		loadAccountsMock.mockResolvedValue(storage);

		await runHealthCheck();

		expect(storage.accounts[0].enabled).toBe(true);
		expect(saveAccountsMock).toHaveBeenCalledExactlyOnceWith(storage);
	});

	it("refreshes stale sessions and writes back rotated credentials", async () => {
		const storage = storageWith([
			account("a", { expiresAt: STALE_EXPIRES_AT }),
		]);
		loadAccountsMock.mockResolvedValue(storage);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new-long-enough-to-look-real",
			expires: REAL_NOW + 7_200_000,
			idToken: "id-new",
		});

		await runHealthCheck();

		expect(queuedRefreshMock).toHaveBeenCalledExactlyOnceWith(
			"refresh-a-long-enough-to-look-real",
		);
		expect(storage.accounts[0]).toMatchObject({
			accessToken: "access-new",
			refreshToken: "refresh-new-long-enough-to-look-real",
			expiresAt: REAL_NOW + 7_200_000,
		});
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(logged()).toContain("1 working");
		// The refreshed account is active, so its new tokens reach the CLI state.
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ accessToken: "access-new" }),
		);
	});

	it("counts an expired account with a failed refresh as needing re-login", async () => {
		const storage = storageWith([
			account("a", { expiresAt: STALE_EXPIRES_AT }),
		]);
		loadAccountsMock.mockResolvedValue(storage);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			message: "invalid_grant",
		});

		await runHealthCheck();

		expect(logged()).toContain("1 need re-login");
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
	});

	it("downgrades a failed forced refresh to a warning while the session still works", async () => {
		const storage = storageWith([account("a")]);
		loadAccountsMock.mockResolvedValue(storage);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			message: "invalid_grant",
		});

		await runHealthCheck({ forceRefresh: true });

		expect(logged()).toContain("still works right now");
		expect(logged()).toContain("0 need re-login");
		expect(logged()).toContain("1 warning");
	});
});

describe("runHealthCheck live probe", () => {
	it("probes quota, updates the cache, and reports Codex availability", async () => {
		const storage = storageWith([account("a")]);
		loadAccountsMock.mockResolvedValue(storage);
		fetchCodexQuotaSnapshotMock.mockResolvedValue(snapshot());

		await runHealthCheck({ liveProbe: true });

		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledExactlyOnceWith({
			accountId: "acc_a",
			accessToken: "access-a",
			model: inspectRequestedModel(DEFAULT_LIVE_PROBE_MODEL).normalized,
		});
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		const saved = saveQuotaCacheMock.mock.calls[0][0] as QuotaCacheData;
		expect(saved.byAccountId.acc_a).toMatchObject({ status: 200 });
		expect(logged()).toContain("1 Codex available");
		expect(logged()).toContain("0 signed in only");
	});

	it("probes with the refreshed token after a stale session is renewed", async () => {
		// The refresh-then-probe branch must use the rotated access token, not
		// the stale pre-refresh one.
		const storage = storageWith([
			account("a", { expiresAt: STALE_EXPIRES_AT }),
		]);
		loadAccountsMock.mockResolvedValue(storage);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new-long-enough-to-look-real",
			expires: REAL_NOW + 7_200_000,
			idToken: "id-new",
		});
		fetchCodexQuotaSnapshotMock.mockResolvedValue(snapshot());

		await runHealthCheck({ liveProbe: true });

		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				accountId: "acc_a",
				accessToken: "access-new",
			}),
		);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		const saved = saveQuotaCacheMock.mock.calls[0][0] as QuotaCacheData;
		expect(saved.byAccountId.acc_a).toMatchObject({ status: 200 });
		expect(logged()).toContain("1 Codex available");
	});

	it("treats a probe failure as signed-in-only without touching the cache", async () => {
		const storage = storageWith([account("a")]);
		loadAccountsMock.mockResolvedValue(storage);
		fetchCodexQuotaSnapshotMock.mockRejectedValue(new Error("probe boom"));

		await runHealthCheck({ liveProbe: true });

		expect(saveQuotaCacheMock).not.toHaveBeenCalled();
		expect(logged()).toContain("1 signed in only");
		expect(logged()).toContain("live check failed");
	});

	it("skips the live probe when the account has no resolvable id", async () => {
		const storage = storageWith([account("a", { accountId: undefined })]);
		loadAccountsMock.mockResolvedValue(storage);

		await runHealthCheck({ liveProbe: true });

		// "access-a" is not a decodable JWT, so no account id can be extracted.
		expect(fetchCodexQuotaSnapshotMock).not.toHaveBeenCalled();
		expect(logged()).toContain("live check skipped: missing account ID");
		expect(logged()).toContain("1 signed in only");
	});

	it("survives a quota cache save failure with a warning", async () => {
		const storage = storageWith([account("a")]);
		loadAccountsMock.mockResolvedValue(storage);
		fetchCodexQuotaSnapshotMock.mockResolvedValue(snapshot());
		saveQuotaCacheMock.mockRejectedValue(new Error("EBUSY"));

		await expect(runHealthCheck({ liveProbe: true })).resolves.toBeUndefined();

		expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
			"Quota cache save failed: EBUSY",
		);
		// The check still completed and reported availability.
		expect(logged()).toContain("1 Codex available");
	});
});
