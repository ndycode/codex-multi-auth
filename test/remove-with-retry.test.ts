import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeWithRetry } from "../scripts/remove-with-retry.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("remove-with-retry", () => {
	it("retries transient Windows delete errors including EACCES", async () => {
		let attempts = 0;
		vi.spyOn(fs, "rm").mockImplementation(async () => {
			attempts += 1;
			if (attempts < 3) {
				const error = Object.assign(new Error("busy"), {
					code: attempts === 1 ? "EACCES" : "EBUSY",
				});
				throw error;
			}
		});

		await expect(
			removeWithRetry("C:\\temp\\target", { recursive: true, force: true }),
		).resolves.toBeUndefined();
		expect(attempts).toBe(3);
	});

	it("throws immediately for non-retryable errors", async () => {
		let attempts = 0;
		vi.spyOn(fs, "rm").mockImplementation(async () => {
			attempts += 1;
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});

		await expect(
			removeWithRetry("C:\\temp\\missing", { recursive: true, force: true }),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(attempts).toBe(1);
	});

	it("gives up after the final retryable failure", async () => {
		let attempts = 0;
		vi.spyOn(fs, "rm").mockImplementation(async () => {
			attempts += 1;
			throw Object.assign(new Error("locked"), { code: "EPERM" });
		});

		await expect(
			removeWithRetry("C:\\temp\\locked", { recursive: true, force: true }),
		).rejects.toMatchObject({ code: "EPERM" });
		expect(attempts).toBe(6);
	});
});
