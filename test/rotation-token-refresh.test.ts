import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const { queuedRefreshMock, saveAccountsMock, withAccountStorageTransactionMock } =
	vi.hoisted(() => ({
		queuedRefreshMock: vi.fn(),
		saveAccountsMock: vi.fn(),
		withAccountStorageTransactionMock: vi.fn(),
	}));

vi.mock("../lib/refresh-queue.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/refresh-queue.js")>();
	return { ...actual, queuedRefresh: queuedRefreshMock };
});

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		saveAccounts: saveAccountsMock,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
	};
});

vi.mock("../lib/codex-cli/writer.js", () => ({
	setCodexCliActiveSelection: vi.fn().mockResolvedValue(true),
}));

const {
	applyMonotonicAuthCooldown,
	DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
	ensureFreshAccessToken,
} = await import("../lib/runtime/rotation-token-refresh.js");

const NOW = Date.now();
const FAMILY = "gpt-5-codex" as const;
const SKEW_MS = 30_000;
const INVALIDATION_COOLDOWN_MS = 300_000;

function storageWith(expiresAt: number): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { [FAMILY]: 0 },
		accounts: [
			{
				email: "account-1@example.com",
				accountId: "acc_1",
				refreshToken: "refresh-1",
				accessToken: "access-1",
				expiresAt,
				addedAt: NOW - 60_000,
				lastUsed: NOW - 60_000,
				enabled: true,
			},
		],
	};
}

const FRESH_EXPIRES = NOW + 3_600_000;
// Inside the refresh skew window: the proxy must refresh before using it.
const STALE_EXPIRES = NOW + 10_000;

const openManagers: AccountManager[] = [];

function managerWith(expiresAt: number): AccountManager {
	const accountManager = new AccountManager(undefined, storageWith(expiresAt));
	openManagers.push(accountManager);
	return accountManager;
}

function refreshParams(accountManager: AccountManager) {
	const account = accountManager.getAccountByIndex(0);
	if (!account) throw new Error("fixture account missing");
	return {
		accountManager,
		account,
		family: FAMILY,
		model: null,
		now: NOW,
		tokenRefreshSkewMs: SKEW_MS,
		tokenInvalidationCooldownMs: INVALIDATION_COOLDOWN_MS,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	AccountManager.resetVolatileRuntimeState();
	saveAccountsMock.mockResolvedValue(undefined);
	withAccountStorageTransactionMock.mockImplementation(async (handler) =>
		handler(null, async () => undefined),
	);
});

afterEach(async () => {
	for (const accountManager of openManagers.splice(0, openManagers.length)) {
		await accountManager.flushPendingSave();
	}
});

describe("ensureFreshAccessToken", () => {
	it("uses a fresh token as-is without touching the refresh queue", async () => {
		const accountManager = managerWith(FRESH_EXPIRES);

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({ ok: true, accessToken: "access-1" });
		expect(queuedRefreshMock).not.toHaveBeenCalled();
	});

	it("refreshes a stale token and commits the rotated credentials", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 7_200_000,
		});

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(queuedRefreshMock).toHaveBeenCalledExactlyOnceWith("refresh-1");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.accessToken).toBe("access-new");
			expect(result.account.access).toBe("access-new");
		}
		// The in-memory pool now carries the rotated credentials.
		expect(accountManager.getAccountByIndex(0)).toMatchObject({
			access: "access-new",
			refreshToken: "refresh-new",
		});
	});

	it("falls back to the refresh result's token when the commit cannot resolve the account", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		const original = accountManager.getAccountByIndex(0);
		if (!original) throw new Error("fixture account missing");
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 7_200_000,
		});
		// The account vanished from storage between refresh and persist: the
		// commit reports null and the caller must use the freshly refreshed
		// token, never the stale one on the original account object.
		vi.spyOn(accountManager, "commitRefreshedAuth").mockResolvedValue(null);

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.accessToken).toBe("access-new");
			expect(result.account).toBe(original);
		}
	});

	it("deduplicates concurrent commits for the same refreshed account", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		const commit = vi.spyOn(accountManager, "commitRefreshedAuth");
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 7_200_000,
		});
		// Hold the first commit open so the second caller arrives while it is
		// still in flight — that is the window the dedup queue exists for.
		let releaseCommit!: () => void;
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		withAccountStorageTransactionMock.mockImplementation(async (handler) => {
			await commitGate;
			return handler(null, async () => undefined);
		});
		const params = refreshParams(accountManager);

		const firstPending = ensureFreshAccessToken(params);
		const secondPending = ensureFreshAccessToken({ ...params });
		await new Promise<void>((resolve) => setImmediate(resolve));
		releaseCommit();
		const [first, second] = await Promise.all([firstPending, secondPending]);

		// Both callers share the single in-flight commit and the same token.
		expect(commit).toHaveBeenCalledTimes(1);
		expect(first).toMatchObject({ ok: true, accessToken: "access-new" });
		expect(second).toMatchObject({ ok: true, accessToken: "access-new" });
	});

	it("applies the short cooldown on a non-retryable auth failure", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "token expired",
		});

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({
			ok: false,
			retryable: false,
			invalidated: false,
		});
		const coolingDownUntil =
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		expect(coolingDownUntil).toBeGreaterThan(NOW);
		expect(coolingDownUntil).toBeLessThanOrEqual(
			Date.now() + DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
		);
	});

	it("marks transient refresh failures retryable", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "network_error",
			message: "fetch failed",
		});

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({ ok: false, retryable: true });
	});

	it("applies the long cooldown and signals invalidation on a revoked token", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "OAuth token has been invalidated",
		});

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({ ok: false, invalidated: true });
		const coolingDownUntil =
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		// The invalidation cooldown is the long one, far beyond the 30s default.
		expect(coolingDownUntil).toBeGreaterThan(
			NOW + INVALIDATION_COOLDOWN_MS - 10_000,
		);
	});

	it("never lets a later generic failure truncate an invalidation cooldown", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		const account = accountManager.getAccountByIndex(0);
		if (!account) throw new Error("fixture account missing");
		accountManager.markAccountCoolingDown(
			account,
			INVALIDATION_COOLDOWN_MS,
			"auth-failure",
		);
		const longDeadline =
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "token expired",
		});

		await ensureFreshAccessToken(refreshParams(accountManager));

		// Monotonic guard: the 30s generic cooldown must not shorten the
		// 5-minute invalidation cooldown set by a concurrent request.
		expect(accountManager.getAccountByIndex(0)?.coolingDownUntil).toBe(
			longDeadline,
		);
	});

	it("cools down and stays retryable when the commit itself fails", async () => {
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 7_200_000,
		});
		// Once: the post-test debounced-save flush must still see the working
		// transaction implementation from beforeEach.
		withAccountStorageTransactionMock.mockRejectedValueOnce(
			Object.assign(new Error("locked"), { code: "EBUSY" }),
		);

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({ ok: false, retryable: true });
		expect(
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0,
		).toBeGreaterThan(NOW);
	});
});

describe("applyMonotonicAuthCooldown", () => {
	it("extends an absent cooldown but never shortens an existing one", () => {
		const accountManager = managerWith(FRESH_EXPIRES);
		const account = accountManager.getAccountByIndex(0);
		if (!account) throw new Error("fixture account missing");

		applyMonotonicAuthCooldown(accountManager, account, 60_000);
		const firstDeadline =
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0;
		expect(firstDeadline).toBeGreaterThan(NOW);

		applyMonotonicAuthCooldown(accountManager, account, 1_000);
		expect(accountManager.getAccountByIndex(0)?.coolingDownUntil).toBe(
			firstDeadline,
		);

		applyMonotonicAuthCooldown(accountManager, account, 600_000);
		expect(
			accountManager.getAccountByIndex(0)?.coolingDownUntil ?? 0,
		).toBeGreaterThan(firstDeadline);
	});
});
