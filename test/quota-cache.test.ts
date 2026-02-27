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
});
