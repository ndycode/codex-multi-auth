import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { refreshLunaReserveUsage } from "../lib/runtime/luna-reserve-usage.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const mocks = vi.hoisted(() => ({
	ensureFreshAccessToken: vi.fn(),
	nativeRateLimitsRpc: vi.fn(),
}));

vi.mock("../lib/runtime/rotation-token-refresh.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/runtime/rotation-token-refresh.js")>();
	return { ...actual, ensureFreshAccessToken: mocks.ensureFreshAccessToken };
});

vi.mock("../lib/runtime/native-rate-limits.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/runtime/native-rate-limits.js")>();
	return { ...actual, nativeRateLimitsRpc: mocks.nativeRateLimitsRpc };
});

const NOW = 1_790_000_000_000;

function storageFixture(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: [0, 1, 2, 3].map((index) => ({
			recordId: `record-${index}`,
			email: `fixture-${index}@example.test`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index}`,
			accessToken: `access-${index}`,
			expiresAt: NOW + 3_600_000,
			addedAt: 1,
			lastUsed: 1,
			enabled: index !== 3,
		})),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	mocks.ensureFreshAccessToken.mockReset();
	mocks.nativeRateLimitsRpc.mockReset();
});

describe("refreshLunaReserveUsage", () => {
	it("uses refreshed credentials, matches replies to accounts, isolates failures, and skips disabled accounts", async () => {
		const storage = storageFixture();
		mocks.ensureFreshAccessToken.mockImplementation(async ({ account }) => ({
			ok: true,
			account,
			accessToken: `fresh-${account.index}`,
		}));
		mocks.nativeRateLimitsRpc.mockImplementation(async (auth) => {
			if (auth.accountId === "acc_2") return { accountId: "different-account", rateLimitsByLimitId: {} };
			if (auth.accountId === "acc_3") throw new Error("fixture failure");
			return {
				accountId: auth.accountId,
				rateLimitsByLimitId: {
					base_model_inference: {
						limitName: "gpt-reserve",
						primary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_790_604_800 },
					},
				},
			};
		});
		const flush = vi.spyOn(AccountManager.prototype, "flushPendingSave");

		const result = await refreshLunaReserveUsage(storage, () => NOW);

		expect(Object.keys(result)).toEqual(["0"]);
		expect(result[0]).toMatchObject({ offered: true, available: true, primary: { usedPercent: 25, remainingPercent: 75 } });
		expect(mocks.ensureFreshAccessToken).toHaveBeenCalledTimes(3);
		expect(mocks.nativeRateLimitsRpc).toHaveBeenCalledTimes(3);
		expect(mocks.nativeRateLimitsRpc.mock.calls.every(([auth]) => String(auth.accessToken).startsWith("fresh-"))).toBe(true);
		expect(mocks.nativeRateLimitsRpc).toHaveBeenCalledWith(
			expect.anything(),
			"account/rateLimits/read",
			{ supportsLunaReserve: true, excludeResetCreditDetails: true },
		);
		expect(flush).toHaveBeenCalledTimes(1);
	});
});
