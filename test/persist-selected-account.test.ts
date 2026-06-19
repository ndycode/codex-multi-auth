import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";

const {
	queuedRefreshMock,
	setCodexCliActiveSelectionMock,
	saveAccountsMock,
	readAffinityGenerationFromDiskMock,
} = vi.hoisted(() => ({
	queuedRefreshMock: vi.fn(),
	setCodexCliActiveSelectionMock: vi.fn(),
	saveAccountsMock: vi.fn(),
	readAffinityGenerationFromDiskMock: vi.fn(),
}));

vi.mock("../lib/refresh-queue.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/refresh-queue.js")>();
	return { ...actual, queuedRefresh: queuedRefreshMock };
});

vi.mock("../lib/codex-cli/writer.js", () => ({
	setCodexCliActiveSelection: setCodexCliActiveSelectionMock,
}));

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		saveAccounts: saveAccountsMock,
		getStoragePath: () => "/tmp/accounts.json",
		readAffinityGenerationFromDisk: readAffinityGenerationFromDiskMock,
	};
});

const { persistAndSyncSelectedAccount } = await import(
	"../lib/codex-manager/persist-selected-account.js"
);

// Fixtures must be relative to the real clock: the function calls Date.now()
// internally to decide token freshness.
const REAL_NOW = Date.now();

function account(
	id: string,
	overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
	return {
		email: `${id}@example.com`,
		accountId: `acc_${id}`,
		refreshToken: `refresh-${id}`,
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
	activeIndexByFamily: Record<string, number> = {},
): AccountStorageV3 {
	return { version: 3, activeIndex, activeIndexByFamily, accounts };
}

// Token inside the 5-minute freshness window forces the validation refresh.
const STALE_EXPIRES_AT = REAL_NOW + 60_000;

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	saveAccountsMock.mockResolvedValue(undefined);
	setCodexCliActiveSelectionMock.mockResolvedValue(true);
	readAffinityGenerationFromDiskMock.mockReturnValue(0);
	// Loud default: only the stale-token tests may reach the refresh queue,
	// and they install their own result. Anything else is a test bug.
	queuedRefreshMock.mockRejectedValue(new Error("unexpected refresh call"));
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warnSpy.mockRestore();
});

describe("persistAndSyncSelectedAccount", () => {
	it("throws for an out-of-range selection", async () => {
		await expect(
			persistAndSyncSelectedAccount({
				storage: storageWith([account("a")]),
				targetIndex: 3,
				parsed: 4,
				switchReason: "manual",
			}),
		).rejects.toThrow("Account 4 not found.");
		expect(saveAccountsMock).not.toHaveBeenCalled();
	});

	it("persists the selection across every family and syncs fresh tokens as-is", async () => {
		const storage = storageWith([account("a"), account("b")], 0, { codex: 0 });

		const result = await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 1,
			parsed: 2,
			switchReason: "manual",
		});

		expect(result).toEqual({ synced: true, wasDisabled: false });
		// A fresh token must not trigger a validation refresh.
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(storage.activeIndex).toBe(1);
		for (const family of MODEL_FAMILIES) {
			expect(storage.activeIndexByFamily[family]).toBe(1);
		}
		expect(storage.accounts[1].lastSwitchReason).toBe("manual");
		expect(storage.accounts[1].lastUsed).toBeGreaterThanOrEqual(REAL_NOW);
		expect(saveAccountsMock).toHaveBeenCalledExactlyOnceWith(storage);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledExactlyOnceWith({
			accountId: "acc_b",
			email: "b@example.com",
			accessToken: "access-b",
			refreshToken: "refresh-b",
			expiresAt: storage.accounts[1].expiresAt,
		});
	});

	it("re-enables a disabled account and reports it", async () => {
		const storage = storageWith([account("a", { enabled: false })]);

		const result = await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "manual",
		});

		expect(result.wasDisabled).toBe(true);
		expect(storage.accounts[0].enabled).toBe(true);
	});

	it("refreshes a stale token and syncs the refreshed credentials", async () => {
		const storage = storageWith([
			account("a", { expiresAt: STALE_EXPIRES_AT }),
		]);
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: REAL_NOW + 7_200_000,
			idToken: "id-new",
		});

		const result = await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "rotation",
		});

		expect(result.synced).toBe(true);
		expect(queuedRefreshMock).toHaveBeenCalledExactlyOnceWith("refresh-a");
		// The stored account is updated in place before saving...
		expect(storage.accounts[0]).toMatchObject({
			refreshToken: "refresh-new",
			accessToken: "access-new",
			expiresAt: REAL_NOW + 7_200_000,
		});
		// ...and the CLI sync carries the refreshed tokens, including the id token.
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledExactlyOnceWith({
			accountId: "acc_a",
			email: "a@example.com",
			accessToken: "access-new",
			refreshToken: "refresh-new",
			expiresAt: REAL_NOW + 7_200_000,
			idToken: "id-new",
		});
	});

	it("warns and syncs the old tokens when the validation refresh fails", async () => {
		const storage = storageWith([
			account("a", { expiresAt: STALE_EXPIRES_AT }),
		]);
		queuedRefreshMock.mockResolvedValue({
			type: "failed",
			message: "invalid_grant",
		});

		const result = await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "manual",
		});

		// A failed validation refresh degrades gracefully: warn, keep the old
		// credentials, still persist and sync.
		expect(result.synced).toBe(true);
		expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
			"Switch validation refresh failed for account 1",
		);
		expect(storage.accounts[0].refreshToken).toBe("refresh-a");
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ accessToken: "access-a" }),
		);
	});

	it("preserves per-family selections when re-selecting the active account", async () => {
		const storage = storageWith([account("a"), account("b")], 1, {
			codex: 0,
			"gpt-5-codex": 9, // stale out-of-range entry must clamp
		});

		await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 1,
			parsed: 2,
			switchReason: "restore",
			preserveActiveIndexByFamily: true,
		});

		expect(storage.activeIndex).toBe(1);
		expect(storage.activeIndexByFamily.codex).toBe(0);
		expect(storage.activeIndexByFamily["gpt-5-codex"]).toBe(1);
		// Families without an entry fall back to the target index.
		expect(storage.activeIndexByFamily["gpt-5.1"]).toBe(1);
	});

	it("ignores the preserve flag when switching to a different account", async () => {
		const storage = storageWith([account("a"), account("b")], 0, { codex: 0 });

		await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 1,
			parsed: 2,
			switchReason: "manual",
			preserveActiveIndexByFamily: true,
		});

		expect(storage.activeIndexByFamily.codex).toBe(1);
	});

	it("sets and clears the pinned account index", async () => {
		const storage = storageWith([account("a"), account("b")]);

		await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 1,
			parsed: 2,
			switchReason: "manual",
			setPin: true,
		});
		expect(storage.pinnedAccountIndex).toBe(1);

		await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "manual",
			clearPin: true,
		});
		expect(storage.pinnedAccountIndex).toBeUndefined();
	});

	it("bumps the affinity generation past the freshest on-disk value", async () => {
		// Issue #474: a concurrent CLI process may have incremented the on-disk
		// generation since this storage snapshot was loaded; the bump must build
		// on max(disk, memory) so no invalidation is lost.
		const storage = {
			...storageWith([account("a")]),
			affinityGeneration: 3,
		};
		readAffinityGenerationFromDiskMock.mockReturnValue(7);

		await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "manual",
			bumpAffinityGeneration: true,
		});

		expect(storage.affinityGeneration).toBe(8);
		expect(readAffinityGenerationFromDiskMock).toHaveBeenCalledWith(
			"/tmp/accounts.json",
		);
	});

	it("keeps the in-memory generation when it is ahead of the disk", async () => {
		// The normal case after several in-process switches: memory leads disk,
		// and a swapped Math.max argument order would regress this silently.
		const storage = {
			...storageWith([account("a")]),
			affinityGeneration: 7,
		};
		readAffinityGenerationFromDiskMock.mockReturnValue(3);

		await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "manual",
			bumpAffinityGeneration: true,
		});

		expect(storage.affinityGeneration).toBe(8);
	});

	it("retries the storage write through a transient EBUSY before succeeding", async () => {
		const storage = storageWith([account("a")]);
		saveAccountsMock
			.mockRejectedValueOnce(
				Object.assign(new Error("locked"), { code: "EBUSY" }),
			)
			.mockResolvedValueOnce(undefined);

		const result = await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "manual",
		});

		// The Windows sharing violation is absorbed by the retry wrapper.
		expect(result.synced).toBe(true);
		expect(saveAccountsMock).toHaveBeenCalledTimes(2);
	});

	it("does not touch the affinity generation without the bump flag", async () => {
		const storage = {
			...storageWith([account("a")]),
			affinityGeneration: 3,
		};

		await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "manual",
		});

		expect(storage.affinityGeneration).toBe(3);
		expect(readAffinityGenerationFromDiskMock).not.toHaveBeenCalled();
	});

	it("passes an explicit initial id token through to the CLI sync", async () => {
		const storage = storageWith([account("a")]);

		await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "manual",
			initialSyncIdToken: "id-initial",
		});

		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ idToken: "id-initial" }),
		);
	});

	it("reports synced=false when the CLI write is skipped", async () => {
		setCodexCliActiveSelectionMock.mockResolvedValue(false);
		const storage = storageWith([account("a")]);

		const result = await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "manual",
		});

		expect(result.synced).toBe(false);
	});
});
