import { describe, expect, it } from "vitest";
import {
	looksLikeSyntheticFixtureAccount,
	looksLikeSyntheticFixtureStorage,
} from "../lib/storage/fixture-guards.js";

describe("fixture guard helpers", () => {
	it("detects synthetic fixture accounts", () => {
		expect(
			looksLikeSyntheticFixtureAccount({
				email: "account1@example.com",
				refreshToken: "fake_refresh_token_1",
				accountId: "acc_1",
			} as never),
		).toBe(true);
		expect(
			looksLikeSyntheticFixtureAccount({
				email: "user@example.com",
				refreshToken: "real",
			} as never),
		).toBe(false);
	});

	it("detects all-synthetic storages only", () => {
		expect(
			looksLikeSyntheticFixtureStorage({
				version: 3,
				accounts: [
					{
						email: "account1@example.com",
						refreshToken: "fake_refresh_token_1",
						accountId: "acc_1",
					},
				],
				activeIndex: 0,
				activeIndexByFamily: {},
			} as never),
		).toBe(true);
		expect(
			looksLikeSyntheticFixtureStorage({
				version: 3,
				accounts: [
					{
						email: "account1@example.com",
						refreshToken: "fake_refresh_token_1",
						accountId: "acc_1",
					},
					{ email: "real@example.com", refreshToken: "real" },
				],
				activeIndex: 0,
				activeIndexByFamily: {},
			} as never),
		).toBe(false);
	});
});
