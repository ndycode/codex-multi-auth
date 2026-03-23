import { describe, expect, it } from "vitest";
import {
	clampActiveIndices,
	isFlaggableFailure,
} from "../lib/runtime/account-check-helpers.js";
import type { AccountStorageV3 } from "../lib/storage.js";

describe("account check helpers", () => {
	it("clamps active indices across families", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			accounts: [
				{ refreshToken: "a" },
				{ refreshToken: "b" },
			] as AccountStorageV3["accounts"],
			activeIndex: 9,
			activeIndexByFamily: {
				codex: -2,
				"gpt-5.1": 8,
			},
		};

		clampActiveIndices(storage, ["codex", "gpt-5.1"]);

		expect(storage.activeIndex).toBe(1);
		expect(storage.activeIndexByFamily).toEqual({
			codex: 0,
			"gpt-5.1": 1,
		});
	});

	it("resets empty storage indices", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			accounts: [],
			activeIndex: 3,
			activeIndexByFamily: { codex: 2 },
		};

		clampActiveIndices(storage, ["codex"]);

		expect(storage.activeIndex).toBe(0);
		expect(storage.activeIndexByFamily).toEqual({});
	});

	it("flags known refresh token failures", () => {
		expect(
			isFlaggableFailure({ type: "failed", reason: "missing_refresh" }),
		).toBe(true);
		expect(
			isFlaggableFailure({
				type: "failed",
				statusCode: 400,
				message: "invalid_grant: token has been revoked",
			}),
		).toBe(true);
		expect(
			isFlaggableFailure({
				type: "failed",
				statusCode: 400,
				message: "different bad request",
			}),
		).toBe(false);
	});
});
