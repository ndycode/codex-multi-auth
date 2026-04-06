import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("inspectStorageHealth", () => {
	async function withStorageModule<T>(
		testName: string,
		runner: (args: { workDir: string; storagePath: string; resetMarkerPath: string; walPath: string; storageModule: typeof import("../lib/storage.js") }) => Promise<T>,
	): Promise<T> {
		const workDir = join(tmpdir(), `${testName}-${Date.now()}`);
		await fs.mkdir(workDir, { recursive: true });
		const storagePath = join(workDir, "accounts.json");
		const resetMarkerPath = `${storagePath}.reset-intent`;
		const walPath = `${storagePath}.wal`;
		const storageModule = await import("../lib/storage.js");
		storageModule.setStoragePathDirect(storagePath);
		try {
			return await runner({ workDir, storagePath, resetMarkerPath, walPath, storageModule });
		} finally {
			storageModule.setStoragePathDirect(null);
			await fs.rm(workDir, { recursive: true, force: true });
		}
	}

	afterEach(() => {
		vi.resetModules();
	});

	it("keeps WAL inspection read-only and silent", async () => {
		const logWarn = vi.fn();
		const logInfo = vi.fn();
		vi.doMock("../lib/logger.js", () => ({
			createLogger: () => ({
				warn: logWarn,
				info: logInfo,
				debug: vi.fn(),
				error: vi.fn(),
			}),
		}));

		const workDir = join(tmpdir(), `storage-health-${Date.now()}`);
		await fs.mkdir(workDir, { recursive: true });
		const storagePath = join(workDir, "accounts.json");
		const walPath = `${storagePath}.wal`;

		const content = JSON.stringify({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					refreshToken: "refresh-token",
					accountId: "acc-1",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});
		await fs.writeFile(
			walPath,
			JSON.stringify({ version: 1, content, checksum: sha256(content) }),
			"utf-8",
		);

		const storageModule = await import("../lib/storage.js");
		storageModule.setStoragePathDirect(storagePath);

		try {
			const summary = await storageModule.inspectStorageHealth();
			expect(summary.state).toBe("recoverable");
			expect(summary.recoverySource).toBe("wal");
			expect(existsSync(storagePath)).toBe(false);
			expect(logWarn).not.toHaveBeenCalledWith(
				"Recovered account storage from WAL journal",
				expect.anything(),
			);
			expect(logInfo).not.toHaveBeenCalled();
		} finally {
			storageModule.setStoragePathDirect(null);
			await fs.rm(workDir, { recursive: true, force: true });
		}
	});

	it("reports healthy storage when primary storage is valid", async () => {
		await withStorageModule("storage-health-healthy", async ({ storagePath, storageModule }) => {
			await fs.writeFile(
				storagePath,
				JSON.stringify({
					version: 3,
					activeIndex: 0,
					activeIndexByFamily: { codex: 0 },
					accounts: [{ refreshToken: "r", addedAt: 1, lastUsed: 1 }],
				}),
				"utf-8",
			);
			const summary = await storageModule.inspectStorageHealth();
			expect(summary.state).toBe("healthy");
		});
	});

	it("reports empty storage when primary storage is valid but has no accounts", async () => {
		await withStorageModule("storage-health-empty", async ({ storagePath, storageModule }) => {
			await fs.writeFile(
				storagePath,
				JSON.stringify({ version: 3, activeIndex: 0, activeIndexByFamily: { codex: 0 }, accounts: [] }),
				"utf-8",
			);
			const summary = await storageModule.inspectStorageHealth();
			expect(summary.state).toBe("empty");
		});
	});

	it("reports intentional-reset when the reset marker exists", async () => {
		await withStorageModule("storage-health-reset", async ({ resetMarkerPath, storageModule }) => {
			await fs.writeFile(resetMarkerPath, "", "utf-8");
			const summary = await storageModule.inspectStorageHealth();
			expect(summary.state).toBe("intentional-reset");
		});
	});

	it("reports corrupt storage when primary storage is malformed and WAL is unavailable", async () => {
		await withStorageModule("storage-health-corrupt-json", async ({ storagePath, storageModule }) => {
			await fs.writeFile(storagePath, "{ malformed-json", "utf-8");
			const summary = await storageModule.inspectStorageHealth();
			expect(summary.state).toBe("corrupt");
		});
	});

	it("reports recoverable storage when invalid primary storage has a valid WAL", async () => {
		await withStorageModule("storage-health-recoverable-invalid", async ({ storagePath, walPath, storageModule }) => {
			await fs.writeFile(storagePath, "{ malformed-json", "utf-8");
			const content = JSON.stringify({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [{ refreshToken: "refresh-token", addedAt: 1, lastUsed: 1 }],
			});
			await fs.writeFile(walPath, JSON.stringify({ version: 1, content, checksum: sha256(content) }), "utf-8");
			const summary = await storageModule.inspectStorageHealth();
			expect(summary.state).toBe("recoverable");
			expect(summary.recoverySource).toBe("wal");
		});
	});
});
