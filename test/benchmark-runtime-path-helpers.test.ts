import { describe, expect, it, vi } from "vitest";
import {
	assertSyncBenchmarkMergeResult,
	removeWithRetry,
} from "../scripts/benchmark-runtime-path-helpers.mjs";

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

	it("fails deterministically when reconciled storage shape is malformed", () => {
		expect(() =>
			assertSyncBenchmarkMergeResult(
				{
					storage: {
						accounts: "invalid-shape",
					},
					changed: true,
				},
				{
					caseName: "codexCliSync_merge_1000",
				},
			),
		).toThrow("codexCliSync_merge_1000 failed");
	});

	it.each(["EPERM", "EBUSY", "ENOTEMPTY"] as const)(
		"retries removeWithRetry on transient lock error %s",
		async (code) => {
			const remove = vi
				.fn()
				.mockRejectedValueOnce(Object.assign(new Error("busy"), { code }))
				.mockResolvedValueOnce(undefined);
			const sleep = vi.fn(async () => {});

			await expect(
				removeWithRetry("/tmp/benchmark-target", { recursive: true, force: true }, {
					remove,
					sleep,
				}),
			).resolves.toBeUndefined();
			expect(remove).toHaveBeenCalledTimes(2);
			expect(sleep).toHaveBeenCalledWith(25);
		},
	);

	it("throws removeWithRetry errors for non-retryable failures", async () => {
		const remove = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES_NONRETRY" }));

		await expect(
			removeWithRetry("/tmp/benchmark-target", { recursive: true, force: true }, {
				remove,
				sleep: async () => {},
			}),
		).rejects.toThrow("denied");
		expect(remove).toHaveBeenCalledTimes(1);
	});
});
