import { describe, expect, it } from "vitest";
import { normalizeFlaggedStorage } from "../lib/storage/flagged-storage.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

describe("flagged storage helper", () => {
	it("returns empty storage for invalid payloads", () => {
		expect(normalizeFlaggedStorage(null, { isRecord, now: () => 1 })).toEqual({
			version: 1,
			accounts: [],
		});
	});

	it("deduplicates by refresh token and normalizes fields", () => {
		const result = normalizeFlaggedStorage(
			{
				version: 1,
				accounts: [
					{ refreshToken: "token-1", flaggedAt: 10, accountIdSource: "token" },
					{ refreshToken: "token-1", flaggedAt: 20, lastError: "oops" },
				],
			},
			{ isRecord, now: () => 99 },
		);

		expect(result.accounts).toHaveLength(1);
		expect(result.accounts[0]?.refreshToken).toBe("token-1");
		expect(result.accounts[0]?.lastError).toBe("oops");
	});
});
