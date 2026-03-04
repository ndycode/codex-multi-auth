import { describe, expect, it } from "vitest";
import { assertSyncBenchmarkMergeResult } from "../scripts/benchmark-runtime-path-helpers.mjs";

describe("benchmark-runtime-path helpers", () => {
	it("fails when codex CLI sync merge result is unchanged", () => {
		expect(() =>
			assertSyncBenchmarkMergeResult(
				{
					storage: {
						accounts: [{ refreshToken: "sync.refresh.0" }],
					},
					changed: false,
				},
				{
					caseName: "codexCliSync_merge_1000",
					minimumAccounts: 1,
					expectedRefreshToken: "sync.refresh.0",
				},
			),
		).toThrow("codexCliSync_merge_1000 failed");
	});

	it("fails when repaired refresh token does not match expectation", () => {
		expect(() =>
			assertSyncBenchmarkMergeResult(
				{
					storage: {
						accounts: [{ refreshToken: "stale.refresh.token" }],
					},
					changed: true,
				},
				{
					caseName: "codexCliSync_merge_1000",
					minimumAccounts: 1,
					expectedRefreshToken: "sync.refresh.0",
				},
			),
		).toThrow("codexCliSync_merge_1000 failed");
	});

	it("accepts changed merges that repair refresh tokens", () => {
		expect(() =>
			assertSyncBenchmarkMergeResult(
				{
					storage: {
						accounts: [{ refreshToken: "sync.refresh.0" }],
					},
					changed: true,
				},
				{
					caseName: "codexCliSync_merge_1000",
					minimumAccounts: 1,
					expectedRefreshToken: "sync.refresh.0",
				},
			),
		).not.toThrow();
	});
});
