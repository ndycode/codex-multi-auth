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
	withRuntimeCredentialLock,
	redirectRuntimeRefreshCommits,
	resetRuntimeRefreshStateForTests,
} = await import("../lib/runtime/rotation-token-refresh.js");

const NOW = Date.now();
const FAMILY = "gpt-5-codex" as const;
const SKEW_MS = 30_000;
const INVALIDATION_COOLDOWN_MS = 300_000;

function storageWith(
	expiresAt: number,
	accountOverrides: Partial<AccountStorageV3["accounts"][number]> = {},
): AccountStorageV3 {
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
				...accountOverrides,
			},
		],
	};
}

const FRESH_EXPIRES = NOW + 3_600_000;
// Inside the refresh skew window: the proxy must refresh before using it.
const STALE_EXPIRES = NOW + 10_000;

const openManagers: AccountManager[] = [];

function managerWith(
	expiresAt: number,
	accountOverrides: Partial<AccountStorageV3["accounts"][number]> = {},
): AccountManager {
	const accountManager = new AccountManager(
		undefined,
		storageWith(expiresAt, accountOverrides),
	);
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
	resetRuntimeRefreshStateForTests();
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

	it("preserves a live non-auth inference cooldown when transcription refreshes credentials", async () => {
		const cooldownUntil = NOW + 120_000;
		const accountManager = managerWith(STALE_EXPIRES, {
			coolingDownUntil: cooldownUntil,
			cooldownReason: "network-error",
		});
		let persisted: AccountStorageV3 | null = null;
		withAccountStorageTransactionMock.mockImplementationOnce(async (handler) =>
			handler(null, async (storage) => {
				persisted = structuredClone(storage);
			}),
		);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: NOW + 7_200_000,
		});

		const result = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(result).toMatchObject({ ok: true, accessToken: "access-new" });
		expect(accountManager.getAccountByIndex(0)).toMatchObject({
			coolingDownUntil: cooldownUntil,
			cooldownReason: "network-error",
		});
		expect(persisted?.accounts[0]).toMatchObject({
			coolingDownUntil: cooldownUntil,
			cooldownReason: "network-error",
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

	it("redirects a late refresh commit from a superseded manager to its replacement", async () => {
		const previous = managerWith(STALE_EXPIRES);
		const replacement = managerWith(STALE_EXPIRES);
		const previousCommit = vi.spyOn(previous, "commitRefreshedAuth");
		const replacementAccount = replacement.getAccountByIndex(0);
		if (!replacementAccount) throw new Error("replacement account missing");
		const replacementCommit = vi
			.spyOn(replacement, "commitRefreshedAuth")
			.mockResolvedValue(replacementAccount);
		redirectRuntimeRefreshCommits(previous, replacement);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-after-swap",
			refresh: "refresh-after-swap",
			expires: NOW + 7_200_000,
		});

		const result = await ensureFreshAccessToken(refreshParams(previous));

		expect(previousCommit).not.toHaveBeenCalled();
		expect(replacementCommit).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.account).toBe(replacementAccount);
	});

	it("returns the replacement owner when a redirected account moves to a new index", async () => {
		const first = storageWith(STALE_EXPIRES).accounts[0]!;
		const second = {
			...structuredClone(first),
			recordId: "row-b",
			email: "account-2@example.com",
			accountId: "acc_2",
			refreshToken: "refresh-2",
			accessToken: "access-2",
		};
		first.recordId = "row-a";
		const previousStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 1,
			activeIndexByFamily: { [FAMILY]: 1 },
			accounts: [first, second],
		};
		const replacementStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { [FAMILY]: 0 },
			accounts: [structuredClone(second)],
		};
		const previous = new AccountManager(undefined, previousStorage);
		const replacement = new AccountManager(undefined, replacementStorage);
		openManagers.push(previous, replacement);
		const source = previous.getAccountByIndex(1);
		if (!source) throw new Error("source account missing");
		redirectRuntimeRefreshCommits(previous, replacement);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-2-new",
			refresh: "refresh-2-new",
			expires: NOW + 7_200_000,
		});

		const result = await ensureFreshAccessToken({
			...refreshParams(previous),
			account: source,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.accountManager).toBe(replacement);
			expect(result.account.index).toBe(0);
			expect(result.account.recordId).toBe("row-b");
			expect(result.account.access).toBe("access-2-new");
		}
	});

	it("records a redirected refresh invalidation on the replacement manager", async () => {
		const previous = managerWith(STALE_EXPIRES);
		const replacement = managerWith(STALE_EXPIRES);
		redirectRuntimeRefreshCommits(previous, replacement);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "OAuth token has been invalidated",
		});

		const result = await ensureFreshAccessToken(refreshParams(previous));

		expect(result).toMatchObject({
			ok: false,
			invalidated: true,
			accountManager: replacement,
		});
		expect(replacement.getAccountByIndex(0)).toMatchObject({
			authInvalidatedAt: expect.any(Number),
			authInvalidationErrorCode: "token_invalidated",
		});
		expect(previous.getAccountByIndex(0)?.authInvalidatedAt).toBeUndefined();
	});


	it("restarts selection when a redirected fresh-token row was removed", async () => {
		const previous = managerWith(FRESH_EXPIRES, { recordId: "row-a" });
		const replacement = managerWith(FRESH_EXPIRES, {
			recordId: "row-b",
			accountId: "acc_other",
			email: "other@example.com",
			refreshToken: "refresh-other",
			accessToken: "access-other",
		});
		redirectRuntimeRefreshCommits(previous, replacement);

		const result = await ensureFreshAccessToken(refreshParams(previous));

		expect(result).toMatchObject({
			ok: false,
			retryable: true,
			selectionRestart: true,
			accountManager: replacement,
		});
		expect(queuedRefreshMock).not.toHaveBeenCalled();
	});

	it("does not redirect a removed same-email workspace refresh into its surviving sibling", async () => {
		const previousStorage = storageWith(STALE_EXPIRES, {
			recordId: "row-a",
			email: "shared@example.com",
			accountId: "workspace-a",
			workspaces: [{ id: "workspace-a", enabled: true }],
		});
		previousStorage.accounts.push({
			recordId: "row-b",
			email: "shared@example.com",
			accountId: "workspace-b",
			workspaces: [{ id: "workspace-b", enabled: true }],
			refreshToken: "refresh-b",
			accessToken: "access-b",
			expiresAt: FRESH_EXPIRES,
			addedAt: NOW - 60_000,
			lastUsed: NOW - 30_000,
			enabled: true,
		});
		const previous = new AccountManager(undefined, previousStorage);
		const replacementStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { [FAMILY]: 0 },
			accounts: [structuredClone(previousStorage.accounts[1]!)],
		};
		const replacement = new AccountManager(undefined, replacementStorage);
		openManagers.push(previous, replacement);
		let releaseRefresh!: (value: unknown) => void;
		queuedRefreshMock.mockImplementation(
			() => new Promise((resolve) => { releaseRefresh = resolve; }),
		);

		const pending = ensureFreshAccessToken(refreshParams(previous));
		await vi.waitFor(() => expect(queuedRefreshMock).toHaveBeenCalledTimes(1));
		redirectRuntimeRefreshCommits(previous, replacement);
		releaseRefresh({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "OAuth token has been invalidated",
		});
		const result = await pending;

		expect(result).toMatchObject({ ok: false, retryable: true, selectionRestart: true, accountManager: replacement });
		expect(replacement.getAccountByIndex(0)).toMatchObject({
			recordId: "row-b",
			refreshToken: "refresh-b",
		});
		expect(replacement.getAccountByIndex(0)?.authInvalidatedAt).toBeUndefined();
	});

	it("does not re-enable a row disabled while refresh is pending", async () => {
		const previous = managerWith(STALE_EXPIRES, { recordId: "row-a" });
		const replacement = managerWith(STALE_EXPIRES, { recordId: "row-a" });
		const replacementAccount = replacement.getAccountByIndex(0);
		if (!replacementAccount) throw new Error("replacement account missing");
		const replacementCommit = vi.spyOn(replacement, "commitRefreshedAuth");
		let releaseRefresh!: (value: unknown) => void;
		queuedRefreshMock.mockImplementation(
			() => new Promise((resolve) => { releaseRefresh = resolve; }),
		);

		const pending = ensureFreshAccessToken(refreshParams(previous));
		await vi.waitFor(() => expect(queuedRefreshMock).toHaveBeenCalledTimes(1));
		replacementAccount.enabled = false;
		redirectRuntimeRefreshCommits(previous, replacement);
		releaseRefresh({
			type: "success",
			access: "must-not-commit",
			refresh: "must-not-commit-refresh",
			expires: NOW + 7_200_000,
		});

		const result = await pending;
		expect(result).toMatchObject({
			ok: false,
			retryable: true,
			selectionRestart: true,
			accountManager: replacement,
		});
		expect(replacementCommit).not.toHaveBeenCalled();
		expect(replacement.getAccountByIndex(0)).toMatchObject({
			recordId: "row-a",
			enabled: false,
			access: "access-1",
			refreshToken: "refresh-1",
		});
	});

	it("restarts selection when a sync queued ahead of the commit disables the row", async () => {
		const manager = managerWith(STALE_EXPIRES);
		const commit = vi.spyOn(manager, "commitRefreshedAuth");
		let lockHeld!: () => void;
		let releaseLock!: () => void;
		const held = new Promise<void>((resolve) => { lockHeld = resolve; });
		// A storage sync holds the credential lock and disables the row on exit.
		const sync = withRuntimeCredentialLock(manager, async () => {
			lockHeld();
			await new Promise<void>((resolve) => { releaseLock = resolve; });
			const row = manager.getAccountByIndex(0);
			if (row) row.enabled = false;
		});
		await held;
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "rotated-access",
			refresh: "rotated-refresh",
			expires: NOW + 7_200_000,
		});

		const pending = ensureFreshAccessToken(refreshParams(manager));
		// The refresh resolves while the row is still enabled, so the commit
		// queues behind the sync's lock instead of failing the earlier check.
		await vi.waitFor(() => expect(queuedRefreshMock).toHaveBeenCalledTimes(1));
		await new Promise<void>((resolve) => setImmediate(resolve));
		releaseLock();
		await sync;

		expect(await pending).toMatchObject({ ok: false, retryable: true, selectionRestart: true, accountManager: manager });
		expect(commit).not.toHaveBeenCalled();
		expect(manager.getAccountByIndex(0)).toMatchObject({ enabled: false, refreshToken: "refresh-1" });
	});

	it("ignores an old refresh invalidation after the same row is repaired by re-login", async () => {
		const previous = managerWith(STALE_EXPIRES, { recordId: "row-a" });
		const replacement = managerWith(FRESH_EXPIRES, {
			recordId: "row-a",
			accessToken: "access-repaired",
			refreshToken: "refresh-repaired",
		});
		let releaseRefresh!: (value: unknown) => void;
		queuedRefreshMock.mockImplementation(
			() => new Promise((resolve) => { releaseRefresh = resolve; }),
		);

		const pending = ensureFreshAccessToken(refreshParams(previous));
		await vi.waitFor(() => expect(queuedRefreshMock).toHaveBeenCalledTimes(1));
		redirectRuntimeRefreshCommits(previous, replacement);
		releaseRefresh({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "OAuth token has been invalidated",
		});
		const result = await pending;

		expect(result).toMatchObject({
			ok: true,
			accessToken: "access-repaired",
			accountManager: replacement,
		});
		expect(replacement.getAccountByIndex(0)).toMatchObject({
			access: "access-repaired",
			refreshToken: "refresh-repaired",
		});
		expect(replacement.getAccountByIndex(0)?.authInvalidatedAt).toBeUndefined();
	});

	it("ignores an old successful refresh after the same row is repaired by re-login", async () => {
		const previous = managerWith(STALE_EXPIRES, { recordId: "row-a" });
		const replacement = managerWith(FRESH_EXPIRES, {
			recordId: "row-a",
			accessToken: "access-repaired",
			refreshToken: "refresh-repaired",
		});
		const replacementCommit = vi.spyOn(replacement, "commitRefreshedAuth");
		let releaseRefresh!: (value: unknown) => void;
		queuedRefreshMock.mockImplementation(
			() => new Promise((resolve) => { releaseRefresh = resolve; }),
		);

		const pending = ensureFreshAccessToken(refreshParams(previous));
		await vi.waitFor(() => expect(queuedRefreshMock).toHaveBeenCalledTimes(1));
		redirectRuntimeRefreshCommits(previous, replacement);
		releaseRefresh({
			type: "success",
			access: "access-from-old-refresh",
			refresh: "refresh-from-old-refresh",
			expires: NOW + 7_200_000,
		});
		const result = await pending;

		expect(result).toMatchObject({
			ok: true,
			accessToken: "access-repaired",
			accountManager: replacement,
		});
		expect(replacementCommit).not.toHaveBeenCalled();
		expect(replacement.getAccountByIndex(0)).toMatchObject({
			access: "access-repaired",
			refreshToken: "refresh-repaired",
		});
	});

	it("clears refresh-manager redirects between tests", async () => {
		const previous = managerWith(STALE_EXPIRES);
		const replacement = managerWith(STALE_EXPIRES);
		const previousCommit = vi.spyOn(previous, "commitRefreshedAuth");
		const replacementCommit = vi.spyOn(replacement, "commitRefreshedAuth");
		redirectRuntimeRefreshCommits(previous, replacement);
		resetRuntimeRefreshStateForTests();
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-after-reset",
			refresh: "refresh-after-reset",
			expires: NOW + 7_200_000,
		});

		const result = await ensureFreshAccessToken(refreshParams(previous));

		expect(result.ok).toBe(true);
		expect(previousCommit).toHaveBeenCalledTimes(1);
		expect(replacementCommit).not.toHaveBeenCalled();
		if (result.ok) expect(result.accountManager).toBe(previous);
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
		expect(accountManager.getAccountByIndex(0)).toMatchObject({
			authInvalidatedAt: expect.any(Number),
			authInvalidationErrorCode: "token_invalidated",
		});
		expect(
			accountManager.isAccountAvailableForFamily(0, FAMILY, "gpt-5-codex"),
		).toBe(false);
	});

	it("persists the invalidation marker until a successful refresh clears it", async () => {
		let persisted: AccountStorageV3 | undefined;
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(null, async (nextStorage: AccountStorageV3) => {
				persisted = structuredClone(nextStorage);
			}),
		);
		const accountManager = managerWith(STALE_EXPIRES);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "OAuth token has been invalidated",
		});

		await ensureFreshAccessToken(refreshParams(accountManager));
		await accountManager.flushPendingSave();

		expect(persisted?.accounts[0]).toMatchObject({
			authInvalidatedAt: expect.any(Number),
			authInvalidationErrorCode: "token_invalidated",
		});

		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-recovered",
			refresh: "refresh-recovered",
			expires: NOW + 7_200_000,
		});
		const refreshed = await ensureFreshAccessToken(refreshParams(accountManager));

		expect(refreshed).toMatchObject({ ok: true, accessToken: "access-recovered" });
		expect(accountManager.getAccountByIndex(0)?.authInvalidatedAt).toBeUndefined();
		expect(
			accountManager.getAccountByIndex(0)?.authInvalidationErrorCode,
		).toBeUndefined();
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

	it("keeps serving the rotated credential when the commit write stays locked", async () => {
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

		// The old refresh token is spent; the new one is journaled and used.
		expect(result).toMatchObject({ ok: true, accessToken: "access-new" });
		expect(accountManager.getAccountByIndex(0)?.refreshToken).toBe("refresh-new");
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

it("does not penalize or invalidate a login on a local coordination failure", async () => {
  const manager = managerWith(STALE_EXPIRES);
  const before = manager.getAccountsSnapshot();
  queuedRefreshMock.mockResolvedValue({type: "failed", reason: "coordination_error"});
  const failure = vi.spyOn(manager, "recordFailure");
  const authFailure = vi.spyOn(manager, "incrementAuthFailures");
  const result = await ensureFreshAccessToken(refreshParams(manager));
  expect(result).toMatchObject({ok: false, retryable: true});
  expect(manager.getAccountsSnapshot()).toEqual(before);
  expect(failure).not.toHaveBeenCalled();
  expect(authFailure).not.toHaveBeenCalled();
  expect(saveAccountsMock).not.toHaveBeenCalled();
});
