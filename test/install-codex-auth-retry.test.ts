import { afterEach, describe, expect, it, vi } from "vitest";
import { renameWithRetry } from "../scripts/install-codex-auth-utils.js";

function makeRenameError(code: string): NodeJS.ErrnoException {
	const error = new Error(`rename failed: ${code}`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("install-codex-auth renameWithRetry", () => {
	it("retries EPERM/EBUSY/EACCES with exponential backoff, jitter, and logs", async () => {
		const renameMock = vi
			.fn()
			.mockRejectedValueOnce(makeRenameError("EPERM"))
			.mockRejectedValueOnce(makeRenameError("EBUSY"))
			.mockRejectedValueOnce(makeRenameError("EACCES"))
			.mockResolvedValue(undefined);
		const random = vi.fn().mockReturnValue(0.5);
		const delays: number[] = [];
		const logs: string[] = [];
		await renameWithRetry("config.json.tmp", "config.json", {
			rename: renameMock,
			random,
			sleep: async (delayMs) => {
				delays.push(delayMs);
			},
			log: (message) => {
				logs.push(message);
			},
		});

		expect(renameMock).toHaveBeenCalledTimes(4);
		expect(delays).toEqual([25, 45, 85]);
		expect(logs.length).toBe(3);
		expect(logs[0]).toContain("code=EPERM");
		expect(logs[1]).toContain("code=EBUSY");
		expect(logs[2]).toContain("code=EACCES");
		expect(random).toHaveBeenCalledTimes(3);
	});

	it.each(["EBUSY", "ENOTEMPTY"] as const)(
		"throws after exhausting retries for retryable %s errors",
		async (code) => {
			const renameMock = vi.fn().mockRejectedValue(makeRenameError(code));
			const random = vi.fn().mockReturnValue(0.5);
			const delays: number[] = [];
			const logs: string[] = [];
			await expect(
				renameWithRetry("config.json.tmp", "config.json", {
					rename: renameMock,
					maxRetries: 3,
					random,
					sleep: async (delayMs) => {
						delays.push(delayMs);
					},
					log: (message) => {
						logs.push(message);
					},
				}),
			).rejects.toMatchObject({ code });
			expect(renameMock).toHaveBeenCalledTimes(3);
			expect(delays).toEqual([25, 45]);
			expect(random).toHaveBeenCalledTimes(2);
			expect(logs.length).toBe(2);
			expect(logs[0]).toContain(`code=${code}`);
			expect(logs[1]).toContain(`code=${code}`);
		},
	);

	it("throws immediately for non-retryable rename errors", async () => {
		const renameMock = vi.fn().mockRejectedValue(makeRenameError("EINVAL"));
		const delays: number[] = [];
		await expect(
			renameWithRetry("config.json.tmp", "config.json", {
				rename: renameMock,
				sleep: async (delayMs) => {
					delays.push(delayMs);
				},
			}),
		).rejects.toMatchObject({ code: "EINVAL" });
		expect(renameMock).toHaveBeenCalledTimes(1);
		expect(delays).toEqual([]);
	});
});
