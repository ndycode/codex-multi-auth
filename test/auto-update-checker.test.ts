import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

describe("auto-update-checker", () => {
	let fs: typeof import("node:fs");
	let checkForUpdates: typeof import("../lib/auto-update-checker.js").checkForUpdates;
	let checkAndNotify: typeof import("../lib/auto-update-checker.js").checkAndNotify;
	let clearUpdateCache: typeof import("../lib/auto-update-checker.js").clearUpdateCache;

	const mockPackageJson = { version: "4.12.0" };

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));

		fs = await import("node:fs");
		vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
			if (String(path).includes("package.json")) {
				return JSON.stringify(mockPackageJson);
			}
			throw new Error("File not found");
		});
		vi.mocked(fs.existsSync).mockReturnValue(false);

		globalThis.fetch = vi.fn();

		const module = await import("../lib/auto-update-checker.js");
		checkForUpdates = module.checkForUpdates;
		checkAndNotify = module.checkAndNotify;
		clearUpdateCache = module.clearUpdateCache;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe("compareVersions (tested via checkForUpdates)", () => {
		it("returns hasUpdate=true when latest > current", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(true);
			expect(result.currentVersion).toBe("4.12.0");
			expect(result.latestVersion).toBe("5.0.0");
		});

		it("returns hasUpdate=false when latest < current", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "3.0.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(false);
		});

		it("returns hasUpdate=false when versions are equal", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "4.12.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(false);
		});

		it("handles semver with different segment counts", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "4.12.0.1" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(true);
		});
	});

	describe("checkForUpdates", () => {
		it("uses cache when check is recent", async () => {
			const cacheData = {
				lastCheck: Date.now() - 1000 * 60 * 60,
				latestVersion: "5.0.0",
				currentVersion: "4.12.0",
			};
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
				if (String(path).includes("package.json")) {
					return JSON.stringify(mockPackageJson);
				}
				if (String(path).includes("update-check-cache.json")) {
					return JSON.stringify(cacheData);
				}
				throw new Error("File not found");
			});

			const result = await checkForUpdates();

			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(result.hasUpdate).toBe(true);
			expect(result.latestVersion).toBe("5.0.0");
		});

		it("fetches when cache is expired", async () => {
			const oldCache = {
				lastCheck: Date.now() - 1000 * 60 * 60 * 25,
				latestVersion: "4.11.0",
				currentVersion: "4.12.0",
			};
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
				if (String(path).includes("package.json")) {
					return JSON.stringify(mockPackageJson);
				}
				if (String(path).includes("update-check-cache.json")) {
					return JSON.stringify(oldCache);
				}
				throw new Error("File not found");
			});
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			const result = await checkForUpdates();

			expect(globalThis.fetch).toHaveBeenCalled();
			expect(result.latestVersion).toBe("5.0.0");
		});

		it("fetches when force=true regardless of cache", async () => {
			const freshCache = {
				lastCheck: Date.now(),
				latestVersion: "4.12.0",
				currentVersion: "4.12.0",
			};
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
				if (String(path).includes("package.json")) {
					return JSON.stringify(mockPackageJson);
				}
				if (String(path).includes("update-check-cache.json")) {
					return JSON.stringify(freshCache);
				}
				throw new Error("File not found");
			});
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "6.0.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(globalThis.fetch).toHaveBeenCalled();
			expect(result.latestVersion).toBe("6.0.0");
		});

		it("handles fetch failure gracefully", async () => {
			vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Network error"));

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(false);
			expect(result.latestVersion).toBe(null);
		});

		it("handles non-ok response", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: false,
				status: 500,
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(false);
			expect(result.latestVersion).toBe(null);
		});

		it("saves cache after successful fetch", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			await checkForUpdates(true);

			expect(fs.writeFileSync).toHaveBeenCalled();
			const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
			const savedData = JSON.parse(writeCall[1] as string) as {
				latestVersion: string;
			};
			expect(savedData.latestVersion).toBe("5.0.0");
		});

		it("creates cache directory if missing", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			await checkForUpdates(true);

			expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), {
				recursive: true,
			});
		});

		it("includes updateCommand in result", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.updateCommand).toContain("npm update -g");
		});
	});

	describe("checkAndNotify", () => {
		it("shows toast when update available", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);
			const showToast = vi.fn().mockResolvedValue(undefined);

			await checkAndNotify(showToast);

			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining("v5.0.0"),
				"info"
			);
		});

		it("does not show toast when no update", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "4.12.0" }),
			} as Response);
			const showToast = vi.fn().mockResolvedValue(undefined);

			await checkAndNotify(showToast);

			expect(showToast).not.toHaveBeenCalled();
		});

		it("handles missing showToast callback", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			await expect(checkAndNotify()).resolves.toBeUndefined();
		});

		it("catches and ignores errors", async () => {
			vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Network error"));
			const showToast = vi.fn().mockResolvedValue(undefined);

			await expect(checkAndNotify(showToast)).resolves.toBeUndefined();
			expect(showToast).not.toHaveBeenCalled();
		});
	});

	describe("clearUpdateCache", () => {
		it("writes empty object when cache exists", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.writeFileSync).mockClear();

			clearUpdateCache();

			expect(fs.writeFileSync).toHaveBeenCalledWith(
				expect.stringContaining("update-check-cache.json"),
				"{}",
				"utf8"
			);
		});

		it("does nothing when cache does not exist", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			vi.mocked(fs.writeFileSync).mockClear();

			clearUpdateCache();

			expect(fs.writeFileSync).not.toHaveBeenCalled();
		});
	});
});
