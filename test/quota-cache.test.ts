import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("quota cache", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-multi-auth-quota-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		vi.resetModules();
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("returns empty cache by default", async () => {
		const { loadQuotaCache } = await import("../lib/quota-cache.js");
		const data = await loadQuotaCache();
		expect(data).toEqual({ byAccountId: {}, byEmail: {} });
	});

	it("saves and reloads quota entries", async () => {
		const { loadQuotaCache, saveQuotaCache, getQuotaCachePath } = await import(
			"../lib/quota-cache.js"
		);

		await saveQuotaCache({
			byAccountId: {
				acc_1: {
					updatedAt: Date.now(),
					status: 200,
					model: "gpt-5-codex",
					planType: "plus",
					primary: { usedPercent: 40, windowMinutes: 300 },
					secondary: { usedPercent: 20, windowMinutes: 10080 },
				},
			},
			byEmail: {},
		});

		const loaded = await loadQuotaCache();
		expect(loaded.byAccountId.acc_1?.primary.usedPercent).toBe(40);

		const fileContent = await fs.readFile(getQuotaCachePath(), "utf8");
		expect(fileContent).toContain("\"version\": 1");
	});

	it("ignores cache files with unsupported version", async () => {
		const { loadQuotaCache, getQuotaCachePath } = await import("../lib/quota-cache.js");
		await fs.writeFile(
			getQuotaCachePath(),
			JSON.stringify({
				version: 2,
				byAccountId: {
					acc_1: {
						updatedAt: Date.now(),
						status: 200,
						model: "gpt-5-codex",
						primary: { usedPercent: 10 },
						secondary: { usedPercent: 5 },
					},
				},
				byEmail: {},
			}),
			"utf8",
		);

		const loaded = await loadQuotaCache();
		expect(loaded).toEqual({ byAccountId: {}, byEmail: {} });
	});

	it.each(["EBUSY", "EPERM"] as const)(
		"retries atomic rename on transient %s errors",
		async (code) => {
			const { saveQuotaCache, loadQuotaCache } = await import("../lib/quota-cache.js");
			const realRename = fs.rename;
			const renameSpy = vi.spyOn(fs, "rename");
			let attempts = 0;
			renameSpy.mockImplementation(async (...args) => {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error(`rename failed: ${code}`) as NodeJS.ErrnoException;
					error.code = code;
					throw error;
				}
				return realRename(...args);
			});

			try {
				await saveQuotaCache({
					byAccountId: {
						acc_1: {
							updatedAt: Date.now(),
							status: 200,
							model: "gpt-5-codex",
							primary: { usedPercent: 40, windowMinutes: 300 },
							secondary: { usedPercent: 20, windowMinutes: 10080 },
						},
					},
					byEmail: {},
				});
				const loaded = await loadQuotaCache();
				expect(loaded.byAccountId.acc_1?.model).toBe("gpt-5-codex");
				expect(attempts).toBe(3);
			} finally {
				renameSpy.mockRestore();
			}
		},
	);

	it("cleans up temp files when rename keeps failing", async () => {
		const { saveQuotaCache } = await import("../lib/quota-cache.js");
		const renameSpy = vi.spyOn(fs, "rename");
		const unlinkSpy = vi.spyOn(fs, "unlink");
		renameSpy.mockImplementation(async () => {
			const error = new Error("locked") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});

		try {
			await saveQuotaCache({
				byAccountId: {
					acc_1: {
						updatedAt: Date.now(),
						status: 200,
						model: "gpt-5-codex",
						primary: { usedPercent: 40, windowMinutes: 300 },
						secondary: { usedPercent: 20, windowMinutes: 10080 },
					},
				},
				byEmail: {},
			});

			expect(unlinkSpy).toHaveBeenCalledTimes(1);
			const entries = await fs.readdir(tempDir);
			expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
		} finally {
			unlinkSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});
});
