import { describe, expect, it, vi } from "vitest";
import type { ForecastAccountResult } from "../lib/forecast.js";
import type { CodexQuotaSnapshot } from "../lib/quota-probe.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";
import type { TokenFailure } from "../lib/types.js";

// persistRefreshedAccountPatch is fully deps-injected and the rest of the
// module is pure, so this suite runs without any module mocks: the real
// findMatchingAccountIndex identity matching and the real retry wrapper run.
import {
	applyRefreshedAccountPatch,
	persistRefreshedAccountPatch,
	serializeForecastResults,
} from "../lib/codex-manager/forecast-report-shared.js";
import {
	isRetryableStorageWriteError,
	saveAccountsWithRetry,
} from "../lib/storage/save-retry.js";

const NOW = 1_700_000_000_000;

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

function storageWith(accounts: AccountMetadataV3[]): AccountStorageV3 {
	return { version: 3, activeIndex: 0, activeIndexByFamily: {}, accounts };
}

function errnoError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

const PATCH = {
	refreshToken: "refresh-rotated",
	accessToken: "access-rotated",
	expiresAt: NOW + 7_200_000,
};

describe("isRetryableStorageWriteError", () => {
	it("retries only on the Windows sharing-violation codes", () => {
		expect(isRetryableStorageWriteError(errnoError("EBUSY"))).toBe(true);
		expect(isRetryableStorageWriteError(errnoError("EPERM"))).toBe(true);
		expect(isRetryableStorageWriteError(errnoError("ENOENT"))).toBe(false);
		expect(isRetryableStorageWriteError(new Error("plain"))).toBe(false);
		expect(isRetryableStorageWriteError("EBUSY")).toBe(false);
		expect(isRetryableStorageWriteError(undefined)).toBe(false);
	});
});

describe("saveAccountsWithRetry", () => {
	it("retries transient EBUSY failures and eventually succeeds", async () => {
		const storage = storageWith([account("a")]);
		const save = vi
			.fn()
			.mockRejectedValueOnce(errnoError("EBUSY"))
			.mockRejectedValueOnce(errnoError("EPERM"))
			.mockResolvedValueOnce(undefined);

		await saveAccountsWithRetry(storage, save);

		expect(save).toHaveBeenCalledTimes(3);
		expect(save).toHaveBeenLastCalledWith(storage);
	});

	it("rethrows non-retryable errors immediately", async () => {
		const save = vi.fn().mockRejectedValue(errnoError("ENOSPC"));

		await expect(
			saveAccountsWithRetry(storageWith([account("a")]), save),
		).rejects.toThrow("ENOSPC");
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("gives up after four attempts of retryable failures", async () => {
		const save = vi.fn().mockRejectedValue(errnoError("EBUSY"));

		await expect(
			saveAccountsWithRetry(storageWith([account("a")]), save),
		).rejects.toThrow("EBUSY");
		expect(save).toHaveBeenCalledTimes(4);
	});
});

describe("applyRefreshedAccountPatch", () => {
	it("always rotates the credential triple and only conditionally identity", () => {
		const target = account("a");

		applyRefreshedAccountPatch(target, PATCH);

		expect(target).toMatchObject({
			refreshToken: "refresh-rotated",
			accessToken: "access-rotated",
			expiresAt: NOW + 7_200_000,
			// No email/accountId in the patch: identity is untouched.
			email: "a@example.com",
			accountId: "acc_a",
		});
		expect(target.accountIdSource).toBeUndefined();
	});

	it("adopts a new identity when the patch carries one", () => {
		const target = account("a");

		applyRefreshedAccountPatch(target, {
			...PATCH,
			email: "new@example.com",
			accountId: "acc_new",
			accountIdSource: "token",
		});

		expect(target.email).toBe("new@example.com");
		expect(target.accountId).toBe("acc_new");
		expect(target.accountIdSource).toBe("token");
	});

	it("clears accountIdSource when a patch rebinds the id without a source", () => {
		// Deliberate behavior pin: accountIdSource follows patch.accountId, so a
		// patch that rebinds the id without declaring a source strips the old
		// one rather than leaving a stale "token"/"manual" attribution behind.
		const target = account("a", { accountIdSource: "token" });

		applyRefreshedAccountPatch(target, { ...PATCH, accountId: "acc_new" });

		expect(target.accountId).toBe("acc_new");
		expect(target.accountIdSource).toBeUndefined();
	});
});

describe("persistRefreshedAccountPatch", () => {
	const match = {
		accountId: "acc_a",
		email: "a@example.com",
		refreshToken: "refresh-a",
	};

	it("re-resolves the account in the freshly loaded storage and saves a patched clone", async () => {
		const inMemory = storageWith([account("a")]);
		// On disk the account moved to index 1 — identity matching must find it.
		const onDisk = storageWith([account("x"), account("a")]);
		const saved: AccountStorageV3[] = [];

		await persistRefreshedAccountPatch(
			inMemory,
			match,
			PATCH,
			async () => onDisk,
			async (storage) => {
				saved.push(storage);
			},
		);

		expect(saved).toHaveLength(1);
		expect(saved[0].accounts[1]).toMatchObject({
			accountId: "acc_a",
			refreshToken: "refresh-rotated",
		});
		// The loaded storage is cloned before mutation; neither input changes.
		expect(onDisk.accounts[1].refreshToken).toBe("refresh-a");
		expect(inMemory.accounts[0].refreshToken).toBe("refresh-a");
	});

	it("falls back to the caller's storage when the reload returns nothing", async () => {
		const inMemory = storageWith([account("a")]);
		const saved: AccountStorageV3[] = [];

		await persistRefreshedAccountPatch(
			inMemory,
			match,
			PATCH,
			async () => null,
			async (storage) => {
				saved.push(storage);
			},
		);

		expect(saved[0].accounts[0].refreshToken).toBe("refresh-rotated");
		expect(inMemory.accounts[0].refreshToken).toBe("refresh-a");
	});

	it("matches on the first pass when identity survives a concurrent rotation", async () => {
		// The common case: a concurrent writer rotated the tokens but the
		// account kept its accountId/email, so the first identity pass matches
		// without falling back to the patch credentials.
		const onDisk = storageWith([
			account("a", { refreshToken: "refresh-already-rotated" }),
		]);
		const saved: AccountStorageV3[] = [];

		await persistRefreshedAccountPatch(
			storageWith([account("a")]),
			match,
			PATCH,
			async () => onDisk,
			async (storage) => {
				saved.push(storage);
			},
		);

		expect(saved).toHaveLength(1);
		expect(saved[0].accounts[0]).toMatchObject({
			accountId: "acc_a",
			refreshToken: "refresh-rotated",
			accessToken: "access-rotated",
		});
	});

	it("matches by the patched credentials when the on-disk copy already rotated", async () => {
		// A concurrent writer already persisted the rotated refresh token, so
		// the pre-rotation identity no longer matches; the patch identity does.
		const rotated = account("a", {
			refreshToken: "refresh-rotated",
			accountId: undefined,
			email: undefined,
		});
		const onDisk = storageWith([rotated]);
		const saved: AccountStorageV3[] = [];

		await persistRefreshedAccountPatch(
			storageWith([account("a")]),
			{ accountId: undefined, email: undefined, refreshToken: "refresh-old" },
			PATCH,
			async () => onDisk,
			async (storage) => {
				saved.push(storage);
			},
		);

		expect(saved).toHaveLength(1);
		expect(saved[0].accounts[0].accessToken).toBe("access-rotated");
	});

	it("throws when the account cannot be resolved in the latest storage", async () => {
		const onDisk = storageWith([account("x")]);
		const save = vi.fn();

		await expect(
			persistRefreshedAccountPatch(
				storageWith([account("a")]),
				match,
				PATCH,
				async () => onDisk,
				save,
			),
		).rejects.toThrow("Unable to resolve refreshed account for persistence");
		expect(save).not.toHaveBeenCalled();
	});
});

describe("serializeForecastResults", () => {
	function result(
		index: number,
		overrides: Partial<ForecastAccountResult> = {},
	): ForecastAccountResult {
		return {
			index,
			label: `Account ${index + 1}`,
			isCurrent: index === 0,
			availability: "ready",
			riskScore: 10,
			riskLevel: "low",
			waitMs: 0,
			reasons: ["plenty of quota", "recently refreshed"],
			hardFailure: false,
			disabled: false,
			exhausted: false,
			...overrides,
		};
	}

	it("joins forecast rows with live quota and refresh failures by index", () => {
		const snapshot: CodexQuotaSnapshot = {
			status: 200,
			model: "gpt-5-codex",
			planType: "plus",
			activeLimit: 100,
			primary: { usedPercent: 10, windowMinutes: 300, resetAtMs: NOW + 1 },
			secondary: { usedPercent: 5, windowMinutes: 10_080, resetAtMs: NOW + 2 },
		};
		const failure: TokenFailure = { type: "failed", message: "invalid_grant" };

		const rows = serializeForecastResults(
			[result(0), result(1, { availability: "delayed", waitMs: 9_000 })],
			new Map([[0, snapshot]]),
			new Map([[1, failure]]),
			(entry) => `summary:${entry.model}`,
		);

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			index: 0,
			label: "Account 1",
			isCurrent: true,
			selected: false,
			primaryReason: "plenty of quota",
			liveQuota: {
				status: 200,
				planType: "plus",
				activeLimit: 100,
				model: "gpt-5-codex",
				summary: "summary:gpt-5-codex",
			},
		});
		expect(rows[0].refreshFailure).toBeUndefined();
		expect(rows[1]).toMatchObject({
			index: 1,
			availability: "delayed",
			waitMs: 9_000,
			refreshFailure: failure,
		});
		expect(rows[1].liveQuota).toBeUndefined();
	});

	it("leaves primaryReason undefined when a row has no reasons", () => {
		const rows = serializeForecastResults(
			[result(0, { reasons: [] })],
			new Map(),
			new Map(),
			() => "unused",
		);

		expect(rows[0].primaryReason).toBeUndefined();
		expect(rows[0].reasons).toEqual([]);
	});
});
