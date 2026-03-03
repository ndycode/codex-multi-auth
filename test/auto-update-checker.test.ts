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
		mockPackageJson.version = "4.12.0";

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

		it("handles versions with v-prefix", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "v4.13.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(true);
		});

		it("treats stable releases as newer than prerelease", async () => {
			mockPackageJson.version = "0.1.0-beta.0";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "0.1.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(true);
		});

		it("does not treat prerelease as newer than stable", async () => {
			mockPackageJson.version = "0.1.0";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "0.1.0-beta.1" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(false);
		});

		it("treats prerelease with additional segment as newer", async () => {
			mockPackageJson.version = "1.2.3-beta";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.2.3-beta.1" }),
			} as Response);

			const result = await checkForUpdates(true);
			expect(result.hasUpdate).toBe(true);
		});

		it("treats shorter prerelease as older than longer current prerelease", async () => {
			mockPackageJson.version = "1.2.3-beta.1";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.2.3-beta" }),
			} as Response);

			const result = await checkForUpdates(true);
			expect(result.hasUpdate).toBe(false);
		});

		it("compares numeric prerelease segments", async () => {
			mockPackageJson.version = "1.2.3-beta.2";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.2.3-beta.10" }),
			} as Response);

			const result = await checkForUpdates(true);
			expect(result.hasUpdate).toBe(true);
		});

		it("does not treat lower numeric prerelease as newer", async () => {
			mockPackageJson.version = "1.2.3-beta.10";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.2.3-beta.2" }),
			} as Response);

			const result = await checkForUpdates(true);
			expect(result.hasUpdate).toBe(false);
		});

		it("continues prerelease comparison after equal numeric segments", async () => {
			mockPackageJson.version = "1.2.3-beta.2.omega";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.2.3-beta.2.zeta" }),
			} as Response);

			const result = await checkForUpdates(true);
			expect(result.hasUpdate).toBe(true);
		});

		it("handles numeric current vs lexical latest prerelease segment", async () => {
			mockPackageJson.version = "1.2.3-beta.2";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.2.3-beta.alpha" }),
			} as Response);

			const result = await checkForUpdates(true);
			expect(result.hasUpdate).toBe(true);
		});

		it("handles lexical current vs numeric latest prerelease segment", async () => {
			mockPackageJson.version = "1.2.3-beta.alpha";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.2.3-beta.2" }),
			} as Response);

			const result = await checkForUpdates(true);
			expect(result.hasUpdate).toBe(false);
		});

		it("compares lexical prerelease segments by locale order", async () => {
			mockPackageJson.version = "1.2.3-beta.omega";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.2.3-beta.zeta" }),
			} as Response);

			const result = await checkForUpdates(true);
			expect(result.hasUpdate).toBe(true);
		});

		it("does not treat lexically lower prerelease as newer", async () => {
			mockPackageJson.version = "1.2.3-beta.zeta";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.2.3-beta.alpha" }),
			} as Response);

			const result = await checkForUpdates(true);
			expect(result.hasUpdate).toBe(false);
		});

		it("handles invalid semver parts and build metadata safely", async () => {
			mockPackageJson.version = "v1.x.0+build.1";
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "1.0.1+build.2" }),
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

		it("handles cached null latestVersion without update", async () => {
			const cacheData = {
				lastCheck: Date.now() - 1000 * 60 * 60,
				latestVersion: null,
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
			expect(result.hasUpdate).toBe(false);
			expect(result.latestVersion).toBeNull();
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

			const pending = checkForUpdates(true);
			await vi.runAllTimersAsync();
			const result = await pending;

			expect(result.hasUpdate).toBe(false);
			expect(result.latestVersion).toBe(null);
		});

		it("handles non-ok response", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: false,
				status: 500,
			} as Response);

			const pending = checkForUpdates(true);
			await vi.runAllTimersAsync();
			const result = await pending;

			expect(result.hasUpdate).toBe(false);
			expect(result.latestVersion).toBe(null);
		});

		it("retries retryable HTTP statuses and succeeds on a later attempt", async () => {
			vi.mocked(globalThis.fetch)
				.mockResolvedValueOnce(new Response("busy-1", { status: 500 }))
				.mockResolvedValueOnce(new Response("busy-2", { status: 500 }))
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ version: "5.0.1" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const pending = checkForUpdates(true);
			await vi.runAllTimersAsync();
			const result = await pending;

			expect(globalThis.fetch).toHaveBeenCalledTimes(3);
			expect(result.latestVersion).toBe("5.0.1");
			expect(result.hasUpdate).toBe(true);
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

		it.each(["EBUSY", "EPERM"] as const)(
			"retries cache writes when filesystem is transiently locked (%s)",
			async (code) => {
			let attempts = 0;
			vi.mocked(fs.writeFileSync).mockClear();
			vi.mocked(fs.writeFileSync).mockImplementation(() => {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = code;
					throw error;
				}
				return undefined;
			});
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			await checkForUpdates(true);

			expect(fs.writeFileSync).toHaveBeenCalledTimes(3);
			},
		);

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

			const pending = checkAndNotify(showToast);
			await vi.runAllTimersAsync();
			await expect(pending).resolves.toBeUndefined();
			expect(showToast).not.toHaveBeenCalled();
		});

		it("catches toast callback errors", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);
			const showToast = vi.fn().mockRejectedValue(new Error("toast failed"));

			await expect(checkAndNotify(showToast)).resolves.toBeUndefined();
			expect(showToast).toHaveBeenCalledTimes(1);
			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining("v5.0.0"),
				"info",
			);
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
