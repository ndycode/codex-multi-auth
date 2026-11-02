import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { PreemptiveQuotaScheduler } from "../lib/preemptive-quota-scheduler.js";
import type { RotationProxyStateInit } from "../lib/runtime/rotation-proxy-state.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const { recordRuntimeResetMock, recordRuntimeReloadMock, queuedRefreshMock } = vi.hoisted(() => ({
	recordRuntimeResetMock: vi.fn(),
	recordRuntimeReloadMock: vi.fn(),
	queuedRefreshMock: vi.fn(),
}));

vi.mock("../lib/runtime/runtime-observability.js", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../lib/runtime/runtime-observability.js")
	>();
	return {
		...actual,
		recordRuntimeReset: recordRuntimeResetMock,
		recordRuntimeReload: recordRuntimeReloadMock,
	};
});

vi.mock("../lib/refresh-queue.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/refresh-queue.js")>();
	return { ...actual, queuedRefresh: queuedRefreshMock };
});

const { createRotationProxyState, recoverStaleRuntimeState, reloadRuntimeCredentials } = await import(
	"../lib/runtime/rotation-proxy-state.js"
);
const { ensureFreshAccessToken, resetRuntimeRefreshStateForTests } = await import(
	"../lib/runtime/rotation-token-refresh.js"
);
const { redirectRuntimeRefreshCommits, resolveRuntimeRefreshTarget } = await import(
	"../lib/runtime/rotation-token-refresh.js"
);

const NOW = Date.now();

function storageWith(count: number): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: {},
		accounts: Array.from({ length: count }, (_unused, index) => ({
			email: `account-${index + 1}@example.com`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: NOW + 3_600_000,
			addedAt: NOW - 60_000,
			lastUsed: NOW - 60_000,
			enabled: true,
		})),
	};
}

function stateInit(): RotationProxyStateInit {
	return {
		activeAccountManager: new AccountManager(undefined, storageWith(1)),
		routingMutexMode: "enabled",
		schedulingStrategy: "hybrid",
		fetchImpl: fetch,
		upstreamFetchImpl: fetch,
		upstreamBaseUrl: "https://upstream.example",
		clientApiKey: "key",
		now: () => NOW,
		tokenRefreshSkewMs: 30_000,
		networkErrorCooldownMs: 10_000,
		serverErrorCooldownMs: 10_000,
		tokenInvalidationCooldownMs: 300_000,
		minRotationIntervalMs: 0,
		pidOffsetEnabled: false,
		fetchTimeoutMs: 30_000,
		streamStallTimeoutMs: 30_000,
		maxRuntimeAccountAttempts: 3,
		maxRequestBodyBytes: 1024,
		quotaRemainingPercentThreshold: 0,
		preemptiveQuotaScheduler: new PreemptiveQuotaScheduler(),
		sessionAffinityStore: null,
		lastObservedAffinityGeneration: 0,
		forcedAccountIndex: null,
	};
}

let loadFromDisk: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	resetRuntimeRefreshStateForTests();
	loadFromDisk = vi.spyOn(AccountManager, "loadFromDisk");
});

afterEach(() => {
	loadFromDisk.mockRestore();
});

describe("createRotationProxyState", () => {
	it("seeds the known-manager set and a zeroed status from the injected clock", () => {
		const init = stateInit();

		const state = createRotationProxyState(init);

		expect([...state.knownAccountManagers]).toEqual([
			init.activeAccountManager,
		]);
		expect(state.status).toStrictEqual({
			startedAt: NOW,
			totalRequests: 0,
			upstreamRequests: 0,
			retries: 0,
			rotations: 0,
			streamsStarted: 0,
			lastError: null,
			lastAccountIndex: null,
			lastAccountLabel: null,
			lastAccountId: null,
			lastAccountUpdatedAt: null,
		});
		expect(state.lastGlobalAccountIndex).toBeNull();
		expect(state.lastStaleRuntimeReloadAt).toBe(0);
	});
});

describe("reloadRuntimeCredentials", () => {
	it("keeps the resident manager when a credential probe finds no inventory change", async () => {
		const state = createRotationProxyState(stateInit());
		const resident = state.activeAccountManager;
		const duplicate = new AccountManager(undefined, storageWith(1));
		loadFromDisk.mockResolvedValueOnce(duplicate);

		const result = await reloadRuntimeCredentials(state);

		expect(result).toBe(resident);
		expect(state.activeAccountManager).toBe(resident);
		expect(state.knownAccountManagers.has(duplicate)).toBe(false);
	});

	it("merges a newer persisted auth cooldown without replacing the resident manager", async () => {
		const state = createRotationProxyState(stateInit());
		const resident = state.activeAccountManager;
		const diskStorage = storageWith(1);
		diskStorage.accounts[0]!.coolingDownUntil = NOW + 90_000;
		diskStorage.accounts[0]!.cooldownReason = "auth-failure";
		loadFromDisk.mockResolvedValueOnce(new AccountManager(undefined, diskStorage));

		const result = await reloadRuntimeCredentials(state);
		const active = resident.getAccountByIndex(0);

		expect(result).toBe(resident);
		expect(state.activeAccountManager).toBe(resident);
		expect(active?.coolingDownUntil).toBe(NOW + 90_000);
		expect(active?.cooldownReason).toBe("auth-failure");
	});

	it("preserves a non-empty resident pool when disk loading produced no valid snapshot", async () => {
		const state = createRotationProxyState(stateInit());
		const resident = state.activeAccountManager;
		const failedEmptyLoad = new AccountManager(undefined, null);
		loadFromDisk.mockResolvedValueOnce(failedEmptyLoad);

		const result = await reloadRuntimeCredentials(state);

		expect(result).toBe(resident);
		expect(state.activeAccountManager).toBe(resident);
		expect(state.activeAccountManager.getAccountsSnapshot()).toHaveLength(1);
		expect(state.knownAccountManagers.has(failedEmptyLoad)).toBe(false);
	});

	it("accepts a parsed empty snapshot as an intentional inventory change", async () => {
		const state = createRotationProxyState(stateInit());
		const emptyStorage: AccountStorageV3 = {
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		const intentionalEmpty = new AccountManager(undefined, emptyStorage);
		loadFromDisk.mockResolvedValueOnce(intentionalEmpty);

		const result = await reloadRuntimeCredentials(state);

		expect(result).toBe(intentionalEmpty);
		expect(state.activeAccountManager).toBe(intentionalEmpty);
		expect(state.activeAccountManager.getAccountsSnapshot()).toHaveLength(0);
	});

	it("waits for a refresh commit that overlaps disk loading before publishing the replacement", async () => {
		const state = createRotationProxyState(stateInit());
		const resident = state.activeAccountManager;
		const previous = resident.getAccountByIndex(0);
		if (!previous) throw new Error("missing resident account");
		previous.expires = NOW + 10_000;

		const diskStorage = storageWith(2);
		diskStorage.accounts[0]!.expiresAt = previous.expires;
		const reloaded = new AccountManager(undefined, diskStorage);
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return reloaded;
		});

		let releaseCommit!: () => void;
		const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
		vi.spyOn(resident, "commitRefreshedAuth").mockImplementationOnce(async (_source, auth) => {
			await commitGate;
			previous.access = auth.access;
			previous.refreshToken = auth.refresh;
			previous.expires = auth.expires;
			return previous;
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-rotated-after-load",
			refresh: "refresh-rotated-after-load",
			expires: NOW + 7_200_000,
		});

		const reloadPending = reloadRuntimeCredentials(state);
		await loadStarted;
		const refreshPending = ensureFreshAccessToken({
			accountManager: resident,
			account: previous,
			family: "gpt-5-codex",
			model: null,
			now: NOW,
			tokenRefreshSkewMs: 30_000,
			tokenInvalidationCooldownMs: 300_000,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		releaseLoad();
		let reloadResolved = false;
		void reloadPending.then(() => { reloadResolved = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(reloadResolved).toBe(false);

		releaseCommit();
		await refreshPending;
		const active = (await reloadPending)?.getAccountByIndex(0);

		expect(active?.access).toBe("access-rotated-after-load");
		expect(active?.refreshToken).toBe("refresh-rotated-after-load");
		expect(active?.expires).toBe(NOW + 7_200_000);
		expect(state.activeAccountManager).toBe(reloaded);
	});

	it("freezes workspace state captured before disk loading", async () => {
		const initialStorage = storageWith(1);
		initialStorage.accounts[0]!.recordId = "row-a";
		initialStorage.accounts[0]!.accountId = "workspace-a";
		initialStorage.accounts[0]!.workspaces = [{ id: "workspace-a", enabled: true }];
		initialStorage.accounts[0]!.currentWorkspaceIndex = 0;
		const resident = new AccountManager(undefined, initialStorage);
		const state = createRotationProxyState({ ...stateInit(), activeAccountManager: resident });
		const duplicate = new AccountManager(undefined, structuredClone(initialStorage));
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return duplicate;
		});

		const pending = reloadRuntimeCredentials(state);
		await loadStarted;
		const live = resident.getAccountByIndex(0);
		if (!live?.workspaces?.[0]) throw new Error("workspace missing");
		live.workspaces[0].enabled = false;
		live.workspaces[0].disabledAt = NOW;
		releaseLoad();

		const result = await pending;

		expect(result).toBe(resident);
		expect(state.activeAccountManager).toBe(resident);
		expect(resident.getAccountByIndex(0)?.workspaces?.[0]).toMatchObject({
			enabled: false,
			disabledAt: NOW,
		});
		expect(state.knownAccountManagers.has(duplicate)).toBe(false);
	});

	it("reserves the surviving same-email workspace before carrying runtime waits", async () => {
		const initialStorage = storageWith(2);
		initialStorage.accounts[0]!.recordId = "row-a";
		initialStorage.accounts[0]!.email = "shared@example.com";
		initialStorage.accounts[0]!.accountId = "workspace-a";
		initialStorage.accounts[0]!.workspaces = [{ id: "workspace-a", enabled: true }];
		initialStorage.accounts[1]!.recordId = "row-b";
		initialStorage.accounts[1]!.email = "shared@example.com";
		initialStorage.accounts[1]!.accountId = "workspace-b";
		initialStorage.accounts[1]!.workspaces = [{ id: "workspace-b", enabled: true }];
		const resident = new AccountManager(undefined, initialStorage);
		const state = createRotationProxyState({ ...stateInit(), activeAccountManager: resident });
		const removed = resident.getAccountByIndex(0);
		const survivor = resident.getAccountByIndex(1);
		if (!removed || !survivor) throw new Error("missing same-email test accounts");
		removed.rateLimitResetTimes["codex:workspace-a"] = NOW + 60_000;
		survivor.rateLimitResetTimes["codex:workspace-b"] = NOW + 120_000;

		const diskStorage = storageWith(1);
		diskStorage.accounts[0] = structuredClone(initialStorage.accounts[1]!);
		diskStorage.accounts[0]!.rateLimitResetTimes = {};
		const reloaded = new AccountManager(undefined, diskStorage);
		loadFromDisk.mockResolvedValueOnce(reloaded);

		const result = await reloadRuntimeCredentials(state);
		const active = result?.getAccountByIndex(0);

		expect(active?.recordId).toBe("row-b");
		expect(active?.accountId).toBe("workspace-b");
		expect(active?.rateLimitResetTimes["codex:workspace-b"]).toBe(NOW + 120_000);
		expect(active?.rateLimitResetTimes["codex:workspace-a"]).toBeUndefined();
	});

	it("carries rejection chronology so an old receipt cannot clear a later 429 after reload", async () => {
  const disk = storageWith(1); const resident = new AccountManager(undefined,disk);
  const account = resident.getAccountByIndex(0)!;
  const {workspaceModelScopes} = await import("../lib/runtime/workspace-model-scopes.js");
  const {ConfirmedResetReconciler} = await import("../lib/runtime/confirmed-reset-reconciler.js");
  const scope = workspaceModelScopes(account)[0]!;
  account.resetReceiptGenerations = {[scope.id]:7};
  resident.markRateLimitedWithReason(account,60000,"codex","quota");
  const observedAt = account.rateLimitObservations!.codex!.observedAt;
  const state = createRotationProxyState({...stateInit(),now:()=>observedAt,activeAccountManager:resident});
  const replacementDisk = storageWith(2);
  const replacement = new AccountManager(undefined,replacementDisk); loadFromDisk.mockResolvedValueOnce(replacement);
  await reloadRuntimeCredentials(state);
  const current = replacement.getAccountByIndex(0)!;
  expect(current.rateLimitObservations?.codex).toEqual(account.rateLimitObservations!.codex);
  expect(current.resetReceiptGenerations).toEqual(account.resetReceiptGenerations);
  expect(current.rateLimitResetTimes.codex).toBe(account.rateLimitResetTimes.codex);
  const read = vi.fn();
  expect(await new ConfirmedResetReconciler().reconcile({
   state:{version:1,policy:"manual",snapshots:{},lastRedemption:{key:scope.id,at:observedAt-1,outcome:"reset",automatic:false}},
   manager:replacement,account:current,scope,model:"chat-test",family:"codex",now:()=>observedAt,
   isCurrent:()=>true,read,observations:new Map(),clearQuotaScheduler:vi.fn(),
  })).toBe(false);
  expect(read).not.toHaveBeenCalled();
 });

	it("carries a token rotation that lands while disk loading is pending", async () => {
		const state = createRotationProxyState(stateInit());
		const previous = state.activeAccountManager.getAccountByIndex(0);
		if (!previous) throw new Error("missing previous account");
		previous.accountIdSource = "token";
		const reloadedStorage = storageWith(1);
		reloadedStorage.accounts[0]!.accountIdSource = "token";
		reloadedStorage.accounts[0]!.workspaces = [{ id: "workspace-preserved", enabled: true }];
		reloadedStorage.accounts[0]!.currentWorkspaceIndex = 0;
		const reloaded = new AccountManager(undefined, reloadedStorage);
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return reloaded;
		});

		const pending = reloadRuntimeCredentials(state);
		await loadStarted;
		previous.access = "rotated-access";
		previous.refreshToken = "rotated-refresh";
		previous.expires = NOW + 7_200_000;
		previous.accountId = "acc_rotated";
		previous.accountIdSource = "token";
		previous.email = "rotated@example.com";
		releaseLoad();

		const result = await pending;
		const active = result?.getAccountByIndex(0);
		expect(active?.access).toBe("rotated-access");
		expect(active?.refreshToken).toBe("rotated-refresh");
		expect(active?.expires).toBe(NOW + 7_200_000);
		expect(active?.accountId).toBe("acc_rotated");
		expect(active?.accountIdSource).toBe("token");
		expect(active?.email).toBe("rotated@example.com");
		expect(active?.workspaces).toEqual([{ id: "workspace-preserved", enabled: true }]);
		expect(active?.currentWorkspaceIndex).toBe(0);
		expect(state.activeAccountManager).toBe(reloaded);
	});

	it("keeps an explicit disk workspace binding while carrying rotated tokens", async () => {
		const state = createRotationProxyState(stateInit());
		const previous = state.activeAccountManager.getAccountByIndex(0);
		if (!previous) throw new Error("missing previous account");
		previous.accountIdSource = "token";
		const reloadedStorage = storageWith(1);
		reloadedStorage.accounts[0]!.accountId = "workspace-manual";
		reloadedStorage.accounts[0]!.accountIdSource = "manual";
		reloadedStorage.accounts[0]!.workspaces = [{ id: "workspace-manual", enabled: true }];
		const reloaded = new AccountManager(undefined, reloadedStorage);
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return reloaded;
		});

		const pending = reloadRuntimeCredentials(state);
		await loadStarted;
		previous.access = "rotated-access";
		previous.refreshToken = "rotated-refresh";
		previous.expires = NOW + 7_200_000;
		previous.accountId = "token-workspace-new";
		previous.accountIdSource = "token";
		releaseLoad();

		const active = (await pending)?.getAccountByIndex(0);
		expect(active?.access).toBe("rotated-access");
		expect(active?.refreshToken).toBe("rotated-refresh");
		expect(active?.accountId).toBe("workspace-manual");
		expect(active?.accountIdSource).toBe("manual");
		expect(active?.workspaces).toEqual([{ id: "workspace-manual", enabled: true }]);
	});

	it("abandons the reloaded manager when a concurrent swap wins mid-load", async () => {
		const state = createRotationProxyState(stateInit());
		const previousManager = state.activeAccountManager;
		const previous = previousManager.getAccountByIndex(0);
		if (!previous) throw new Error("missing resident account");
		const reloaded = new AccountManager(undefined, storageWith(2));
		const nativeSwap = new AccountManager(undefined, storageWith(2));
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return reloaded;
		});

		const pending = reloadRuntimeCredentials(state);
		await loadStarted;
		// The native storage-sync path swaps the active manager while this reload
		// is suspended on disk I/O, including its own commit redirect.
		redirectRuntimeRefreshCommits(previousManager, nativeSwap);
		state.activeAccountManager = nativeSwap;
		state.knownAccountManagers.add(nativeSwap);
		releaseLoad();

		const result = await pending;

		expect(result).toBe(nativeSwap);
		expect(state.activeAccountManager).toBe(nativeSwap);
		expect(state.knownAccountManagers.has(reloaded)).toBe(false);
		// The earlier redirect must survive: a late refresh commit on the
		// superseded manager still resolves to the live swap, not the load this
		// function discarded.
		expect(resolveRuntimeRefreshTarget(previousManager, previous)?.accountManager).toBe(
			nativeSwap,
		);
	});

	it("carries auth invalidation and disabled workspaces on a same-credential swap", async () => {
		const initialStorage = storageWith(1);
		initialStorage.accounts[0]!.workspaces = [{ id: "w-1", enabled: true }];
		const resident = new AccountManager(undefined, initialStorage);
		const state = createRotationProxyState({ ...stateInit(), activeAccountManager: resident });
		const previous = resident.getAccountByIndex(0);
		if (!previous?.workspaces?.[0]) throw new Error("missing resident account");

		const diskStorage = storageWith(2);
		diskStorage.accounts[0]!.workspaces = [{ id: "w-1", enabled: true }];
		const reloaded = new AccountManager(undefined, diskStorage);
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return reloaded;
		});

		const pending = reloadRuntimeCredentials(state);
		await loadStarted;
		// An auth-failure mark and a workspace disable land inside the debounced
		// save window: visible on the resident row but not yet on disk.
		previous.authInvalidatedAt = NOW;
		previous.authInvalidationErrorCode = "invalid_token";
		previous.workspaces[0].enabled = false;
		previous.workspaces[0].disabledAt = NOW;
		releaseLoad();

		const result = await pending;
		const active = result?.getAccountByIndex(0);
		if (!active) throw new Error("missing reloaded account");

		expect(result).toBe(reloaded);
		expect(state.activeAccountManager).toBe(reloaded);
		expect(reloaded.isAccountAuthInvalidated(active)).toBe(true);
		expect(active.authInvalidatedAt).toBe(NOW);
		expect(active.authInvalidationErrorCode).toBe("invalid_token");
		expect(active.workspaces?.[0]).toMatchObject({
			id: "w-1",
			enabled: false,
			disabledAt: NOW,
		});
	});

	it("does not resurrect a pre-existing disable over an external re-enable", async () => {
		const initialStorage = storageWith(1);
		initialStorage.accounts[0]!.workspaces = [{ id: "w-1", enabled: true }];
		const resident = new AccountManager(undefined, initialStorage);
		const state = createRotationProxyState({ ...stateInit(), activeAccountManager: resident });
		const previous = resident.getAccountByIndex(0);
		if (!previous?.workspaces?.[0]) throw new Error("missing resident account");
		// The disable lands BEFORE the reload starts, so it is part of the
		// baseline — another process has since re-enabled the workspace on disk.
		previous.workspaces[0].enabled = false;
		previous.workspaces[0].disabledAt = NOW - 5_000;
		previous.authInvalidatedAt = NOW - 5_000;

		const diskStorage = storageWith(2);
		diskStorage.accounts[0]!.workspaces = [{ id: "w-1", enabled: true }];
		const reloaded = new AccountManager(undefined, diskStorage);
		loadFromDisk.mockResolvedValueOnce(reloaded);

		const result = await reloadRuntimeCredentials(state);
		const active = result?.getAccountByIndex(0);
		if (!active) throw new Error("missing reloaded account");

		// Disk is authoritative for pre-existing markers: the external re-enable
		// and cleared invalidation must not be undone by the resident's stale state.
		expect(result).toBe(reloaded);
		expect(active.workspaces?.[0]).toMatchObject({ id: "w-1", enabled: true });
		expect(reloaded.isAccountAuthInvalidated(active)).toBe(false);
	});
});

describe("recoverStaleRuntimeState", () => {
	it("reloads from disk, swaps the active manager, and records observability", async () => {
		const state = createRotationProxyState(stateInit());
		const previousManager = state.activeAccountManager;
		const reloaded = new AccountManager(undefined, storageWith(2));
		loadFromDisk.mockResolvedValue(reloaded);

		const result = await recoverStaleRuntimeState(state);

		expect(result).toBe(reloaded);
		expect(state.activeAccountManager).toBe(reloaded);
		// The previous manager stays known so in-flight requests can finish.
		expect(state.knownAccountManagers.has(previousManager)).toBe(true);
		expect(state.knownAccountManagers.has(reloaded)).toBe(true);
		// The configured mutex mode carries over to the reloaded pool.
		expect(reloaded.getRoutingMutexMode()).toBe("enabled");
		expect(state.lastStaleRuntimeReloadAt).toBeGreaterThan(0);
		expect(recordRuntimeResetMock).toHaveBeenCalledExactlyOnceWith(
			"pool-exhausted-no-account",
		);
		expect(recordRuntimeReloadMock).toHaveBeenCalledExactlyOnceWith(
			"pool-exhausted-no-account",
		);
	});

	it("dedupes within the 1s window and reloads again once it expires", async () => {
		// The dedupe guard runs on the real wall clock (deliberately not the
		// injected now()), so fake timers make the window deterministic.
		vi.useFakeTimers();
		try {
			const state = createRotationProxyState(stateInit());
			const reloaded = new AccountManager(undefined, storageWith(2));
			loadFromDisk.mockResolvedValue(reloaded);

			await recoverStaleRuntimeState(state);
			const second = await recoverStaleRuntimeState(state);

			// The second call lands inside the 1s dedupe window: no second reload.
			expect(second).toBe(reloaded);
			expect(loadFromDisk).toHaveBeenCalledTimes(1);

			// Once the window expires, the next call reloads from disk again.
			vi.advanceTimersByTime(1_001);
			const freshest = new AccountManager(undefined, storageWith(3));
			loadFromDisk.mockResolvedValue(freshest);
			await expect(recoverStaleRuntimeState(state)).resolves.toBe(freshest);
			expect(loadFromDisk).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares one in-flight reload between concurrent callers", async () => {
		const state = createRotationProxyState(stateInit());
		const reloaded = new AccountManager(undefined, storageWith(2));
		let releaseReload!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseReload = resolve;
		});
		loadFromDisk.mockImplementation(async () => {
			await gate;
			return reloaded;
		});

		const firstPending = recoverStaleRuntimeState(state);
		const secondPending = recoverStaleRuntimeState(state);
		releaseReload();
		const [first, second] = await Promise.all([firstPending, secondPending]);

		expect(first).toBe(reloaded);
		expect(second).toBe(reloaded);
		expect(loadFromDisk).toHaveBeenCalledTimes(1);
	});

	it("shares an in-flight stale recovery with credential-only reloads", async () => {
		const state = createRotationProxyState(stateInit());
		const recovered = new AccountManager(undefined, storageWith(2));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			await gate;
			return recovered;
		});

		const stalePending = recoverStaleRuntimeState(state);
		const credentialPending = reloadRuntimeCredentials(state);
		release();
		const [staleResult, credentialResult] = await Promise.all([stalePending, credentialPending]);

		expect(staleResult).toBe(recovered);
		expect(credentialResult).toBe(recovered);
		expect(state.activeAccountManager).toBe(recovered);
		expect(loadFromDisk).toHaveBeenCalledTimes(1);
	});

	it("runs stale recovery after an earlier credential reload finishes", async () => {
		const state = createRotationProxyState(stateInit());
		const credentialReloaded = new AccountManager(undefined, storageWith(2));
		const staleRecovered = new AccountManager(undefined, storageWith(3));
		let releaseCredential!: () => void;
		const credentialGate = new Promise<void>((resolve) => { releaseCredential = resolve; });
		loadFromDisk
			.mockImplementationOnce(async () => {
				await credentialGate;
				return credentialReloaded;
			})
			.mockResolvedValueOnce(staleRecovered);

		const credentialPending = reloadRuntimeCredentials(state);
		const stalePending = recoverStaleRuntimeState(state);
		releaseCredential();
		const [credentialResult, staleResult] = await Promise.all([credentialPending, stalePending]);

		expect(credentialResult).toBe(credentialReloaded);
		expect(staleResult).toBe(staleRecovered);
		expect(state.activeAccountManager).toBe(staleRecovered);
		expect(loadFromDisk).toHaveBeenCalledTimes(2);
	});

	it("reports a failed reload and allows the next attempt to retry", async () => {
		const state = createRotationProxyState(stateInit());
		loadFromDisk.mockRejectedValueOnce(new Error("disk exploded"));

		const failed = await recoverStaleRuntimeState(state);

		expect(failed).toBeNull();
		expect(state.status.lastError).toBe("disk exploded");
		// The failure must not arm the dedupe window.
		expect(state.lastStaleRuntimeReloadAt).toBe(0);
		// The failure does not arm the dedupe window or leak a stale promise:
		// the next call retries the reload.
		const reloaded = new AccountManager(undefined, storageWith(2));
		loadFromDisk.mockResolvedValue(reloaded);
		await expect(recoverStaleRuntimeState(state)).resolves.toBe(reloaded);
		expect(loadFromDisk).toHaveBeenCalledTimes(2);
	});

	it("drains a queued refresh commit and carries the rotated credential", async () => {
		const state = createRotationProxyState(stateInit());
		const resident = state.activeAccountManager;
		const previous = resident.getAccountByIndex(0);
		if (!previous) throw new Error("missing resident account");
		previous.expires = NOW + 10_000;

		const reloaded = new AccountManager(undefined, storageWith(1));
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return reloaded;
		});

		let releaseCommit!: () => void;
		const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
		vi.spyOn(resident, "commitRefreshedAuth").mockImplementationOnce(async (_source, auth) => {
			await commitGate;
			previous.access = auth.access;
			previous.refreshToken = auth.refresh;
			previous.expires = auth.expires;
			return previous;
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-rotated-during-recovery",
			refresh: "refresh-rotated-during-recovery",
			expires: NOW + 7_200_000,
		});

		const recoveryPending = recoverStaleRuntimeState(state);
		await loadStarted;
		const refreshPending = ensureFreshAccessToken({
			accountManager: resident,
			account: previous,
			family: "gpt-5-codex",
			model: null,
			now: NOW,
			tokenRefreshSkewMs: 30_000,
			tokenInvalidationCooldownMs: 300_000,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		releaseLoad();
		let recoveryResolved = false;
		void recoveryPending.then(() => { recoveryResolved = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		// The swap must not publish while the queued commit is still in flight:
		// otherwise the reloaded row keeps the spent single-use refresh token.
		expect(recoveryResolved).toBe(false);

		releaseCommit();
		await refreshPending;
		const result = await recoveryPending;
		const active = result?.getAccountByIndex(0);

		expect(state.activeAccountManager).toBe(reloaded);
		expect(active?.access).toBe("access-rotated-during-recovery");
		expect(active?.refreshToken).toBe("refresh-rotated-during-recovery");
		expect(active?.expires).toBe(NOW + 7_200_000);
	});

	it("carries token-bound identity alongside the rotated credential", async () => {
		const initialStorage = storageWith(1);
		initialStorage.accounts[0]!.recordId = "row-a";
		const resident = new AccountManager(undefined, initialStorage);
		const state = createRotationProxyState({ ...stateInit(), activeAccountManager: resident });
		const previous = resident.getAccountByIndex(0);
		if (!previous) throw new Error("missing resident account");
		previous.expires = NOW + 10_000;

		const reloaded = new AccountManager(undefined, structuredClone(initialStorage));
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return reloaded;
		});

		let releaseCommit!: () => void;
		const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
		vi.spyOn(resident, "commitRefreshedAuth").mockImplementationOnce(async (_source, auth) => {
			await commitGate;
			previous.access = auth.access;
			previous.refreshToken = auth.refresh;
			previous.expires = auth.expires;
			// The refresh response also rebinds the token-derived identity; both
			// must land on the reloaded row or it keeps a stale workspace binding.
			previous.accountId = "acc_rotated_workspace";
			previous.accountIdSource = "token";
			previous.email = "rotated@example.com";
			return previous;
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: NOW + 7_200_000,
		});

		const recoveryPending = recoverStaleRuntimeState(state);
		await loadStarted;
		const refreshPending = ensureFreshAccessToken({
			accountManager: resident,
			account: previous,
			family: "gpt-5-codex",
			model: null,
			now: NOW,
			tokenRefreshSkewMs: 30_000,
			tokenInvalidationCooldownMs: 300_000,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		releaseLoad();
		releaseCommit();
		await refreshPending;
		const result = await recoveryPending;
		const active = result?.getAccountByIndex(0);

		expect(state.activeAccountManager).toBe(reloaded);
		expect(active?.access).toBe("access-rotated");
		expect(active?.refreshToken).toBe("refresh-rotated");
		expect(active?.accountId).toBe("acc_rotated_workspace");
		expect(active?.accountIdSource).toBe("token");
		expect(active?.email).toBe("rotated@example.com");
	});

	it("abandons the recovered snapshot when a concurrent swap wins mid-load", async () => {
		const state = createRotationProxyState(stateInit());
		const previousManager = state.activeAccountManager;
		const reloaded = new AccountManager(undefined, storageWith(2));
		const nativeSwap = new AccountManager(undefined, storageWith(2));
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return reloaded;
		});

		const pending = recoverStaleRuntimeState(state);
		await loadStarted;
		// The native storage-sync path wins the race while recovery is suspended.
		redirectRuntimeRefreshCommits(previousManager, nativeSwap);
		state.activeAccountManager = nativeSwap;
		state.knownAccountManagers.add(nativeSwap);
		releaseLoad();

		const result = await pending;

		expect(result).toBe(nativeSwap);
		expect(state.activeAccountManager).toBe(nativeSwap);
		expect(state.knownAccountManagers.has(reloaded)).toBe(false);
	});

	it("carries a rotation only onto the matching row when same-email siblings exist", async () => {
		const initialStorage = storageWith(2);
		initialStorage.accounts[0]!.recordId = "row-a";
		initialStorage.accounts[0]!.email = "shared@example.com";
		initialStorage.accounts[0]!.accountId = "workspace-a";
		initialStorage.accounts[0]!.workspaces = [{ id: "workspace-a", enabled: true }];
		initialStorage.accounts[1]!.recordId = "row-b";
		initialStorage.accounts[1]!.email = "shared@example.com";
		initialStorage.accounts[1]!.accountId = "workspace-b";
		initialStorage.accounts[1]!.workspaces = [{ id: "workspace-b", enabled: true }];
		const resident = new AccountManager(undefined, initialStorage);
		const state = createRotationProxyState({ ...stateInit(), activeAccountManager: resident });
		const rotatedRow = resident.getAccountByIndex(0);
		if (!rotatedRow) throw new Error("missing resident account");

		const reloaded = new AccountManager(undefined, structuredClone(initialStorage));
		let signalLoadStarted!: () => void;
		const loadStarted = new Promise<void>((resolve) => { signalLoadStarted = resolve; });
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
		loadFromDisk.mockImplementationOnce(async () => {
			signalLoadStarted();
			await loadGate;
			return reloaded;
		});

		const pending = recoverStaleRuntimeState(state);
		await loadStarted;
		// The rotation lands while recovery is suspended: only the row that
		// rotated must receive the new credential — the sibling keeps its own.
		rotatedRow.access = "rotated-access";
		rotatedRow.refreshToken = "rotated-refresh";
		rotatedRow.expires = NOW + 7_200_000;
		releaseLoad();

		const result = await pending;
		const carried = result?.getAccountByIndex(0);
		const sibling = result?.getAccountByIndex(1);

		expect(state.activeAccountManager).toBe(reloaded);
		expect(carried?.access).toBe("rotated-access");
		expect(carried?.refreshToken).toBe("rotated-refresh");
		expect(sibling?.access).toBe("access-2");
		expect(sibling?.refreshToken).toBe("refresh-2");
	});
});

describe("resolveRuntimeRefreshTarget", () => {
	it("treats a derived recordId as weak identity across manager swaps", () => {
		const previousManager = new AccountManager(undefined, storageWith(1));
		const previous = previousManager.getAccountByIndex(0);
		if (!previous) throw new Error("missing resident account");
		// The storage row carried no explicit recordId, so the managed id is
		// derived from the credential and must not strict-match after rotation.
		expect(previous.recordId).toBeTruthy();
		expect(previousManager.hasPersistedRecordId(previous)).toBe(false);

		const replacementStorage = storageWith(1);
		replacementStorage.accounts[0]!.recordId = "row-persisted-1";
		const replacement = new AccountManager(undefined, replacementStorage);
		redirectRuntimeRefreshCommits(previousManager, replacement);

		const target = resolveRuntimeRefreshTarget(previousManager, previous);

		expect(target?.accountManager).toBe(replacement);
		expect(target?.account.index).toBe(0);
	});

	it("keeps strict recordId matching when the row persisted one", () => {
		const initialStorage = storageWith(1);
		initialStorage.accounts[0]!.recordId = "row-persisted-1";
		const previousManager = new AccountManager(undefined, initialStorage);
		const previous = previousManager.getAccountByIndex(0);
		if (!previous) throw new Error("missing resident account");
		expect(previousManager.hasPersistedRecordId(previous)).toBe(true);

		// The persisted row was removed from the replacement pool; a same-email
		// sibling must not absorb the in-flight refresh.
		const replacementStorage = storageWith(1);
		replacementStorage.accounts[0]!.recordId = "row-persisted-2";
		const replacement = new AccountManager(undefined, replacementStorage);
		redirectRuntimeRefreshCommits(previousManager, replacement);

		expect(resolveRuntimeRefreshTarget(previousManager, previous)).toBeNull();
	});

	it("rejects an accountId fallback onto a different-email workspace member", () => {
		const initialStorage = storageWith(1);
		initialStorage.accounts[0]!.accountId = "workspace-shared";
		initialStorage.accounts[0]!.workspaces = [{ id: "workspace-shared", enabled: true }];
		const previousManager = new AccountManager(undefined, initialStorage);
		const previous = previousManager.getAccountByIndex(0);
		if (!previous) throw new Error("missing resident account");
		// Legacy login: derived record id, so the refresh falls through to the
		// accountId fallback. The original row was removed from the pool.
		expect(previousManager.hasPersistedRecordId(previous)).toBe(false);

		const replacementStorage = storageWith(1);
		replacementStorage.accounts[0]!.email = "other-member@example.com";
		replacementStorage.accounts[0]!.accountId = "workspace-shared";
		replacementStorage.accounts[0]!.refreshToken = "refresh-other";
		replacementStorage.accounts[0]!.workspaces = [{ id: "workspace-shared", enabled: true }];
		const replacement = new AccountManager(undefined, replacementStorage);
		redirectRuntimeRefreshCommits(previousManager, replacement);

		// The sibling member shares the workspace accountId but is a different
		// login — the refresh belongs to the removed row, so it must not commit
		// onto the sibling (which would skip its own cooldown/policy checks).
		expect(resolveRuntimeRefreshTarget(previousManager, previous)).toBeNull();
	});
});
