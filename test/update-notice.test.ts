import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	renameSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

describe("update-notice", () => {
	let fs: typeof import("node:fs");
	let checkForUpdates: typeof import("../lib/update-notice.js").checkForUpdates;
	let checkAndNotify: typeof import("../lib/update-notice.js").checkAndNotify;
	let clearUpdateCache: typeof import("../lib/update-notice.js").clearUpdateCache;
	let formatManualUpdateNotice: typeof import("../lib/update-notice.js").formatManualUpdateNotice;
	let resolvePackageRootFromModuleDir: typeof import("../lib/update-notice.js").resolvePackageRootFromModuleDir;
	let logger: {
		debug: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
	};

	const packageRoot = "/tmp/node_modules/codex-multi-auth";
	const packageJsonPath = `${packageRoot}/package.json`;
	const cacheFilePath = "/tmp/codex-cache/update-check-cache.json";
	const mockPackageJson = { name: "codex-multi-auth", version: "4.12.0" };
	let cacheContents: string | null;

	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
		cacheContents = null;
		mockPackageJson.version = "4.12.0";
		logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		};
		vi.doMock("../lib/logger.js", () => ({
			createLogger: () => logger,
		}));
		vi.doMock("../lib/runtime-paths.js", () => ({
			getCodexCacheDir: () => "/tmp/codex-cache",
		}));

		fs = await import("node:fs");
		vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
			const normalized = String(path).replace(/\\/g, "/");
			if (
				normalized === packageJsonPath ||
				normalized.endsWith("/codex-multi-auth-notice-only/package.json")
			) {
				return JSON.stringify(mockPackageJson);
			}
			if (normalized.endsWith("/package.json")) {
				return JSON.stringify({ name: "other-package", version: "1.0.0" });
			}
			if (normalized === cacheFilePath && cacheContents !== null) {
				return cacheContents;
			}
			throw Object.assign(new Error("File not found"), { code: "ENOENT" });
		});
		vi.mocked(fs.existsSync).mockImplementation((path: unknown) => {
			const normalized = String(path).replace(/\\/g, "/");
			return (
				normalized === packageJsonPath ||
				normalized.endsWith("/codex-multi-auth-notice-only/package.json") ||
				(normalized === cacheFilePath && cacheContents !== null)
			);
		});
		vi.mocked(fs.writeFileSync).mockImplementation((path: unknown, data: unknown) => {
			const normalized = String(path).replace(/\\/g, "/");
			if (normalized.includes("update-check-cache.json")) {
				cacheContents = String(data);
			}
		});
		vi.mocked(fs.renameSync).mockImplementation((from: unknown, to: unknown) => {
			const normalizedTo = String(to).replace(/\\/g, "/");
			if (normalizedTo === cacheFilePath && cacheContents !== null) return;
		});
		globalThis.fetch = vi.fn();

		const module = await import("../lib/update-notice.js");
		checkForUpdates = module.checkForUpdates;
		checkAndNotify = module.checkAndNotify;
		clearUpdateCache = module.clearUpdateCache;
		formatManualUpdateNotice = module.formatManualUpdateNotice;
		resolvePackageRootFromModuleDir = module.resolvePackageRootFromModuleDir;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("reports newer registry versions and the manual install command", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ name: "codex-multi-auth", version: "5.0.0" }),
		} as Response);

		const result = await checkForUpdates(true);

		expect(result).toMatchObject({
			hasUpdate: true,
			currentVersion: "4.12.0",
			latestVersion: "5.0.0",
			updateCommand: "npm install -g codex-multi-auth@latest",
		});
		expect(formatManualUpdateNotice(result)).toContain(
			"npm install -g codex-multi-auth@latest",
		);
	});

	it.each([
		["older latest", "4.11.0", false],
		["same latest", "4.12.0", false],
		["v-prefixed newer latest", "v4.13.0", true],
		["stable over prerelease", "0.1.0", true, "0.1.0-beta.0"],
		["prerelease below stable", "0.1.0-beta.1", false, "0.1.0"],
	] as const)("handles semver comparison for %s", async (_label, latest, hasUpdate, current) => {
		if (current) mockPackageJson.version = current;
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ name: "codex-multi-auth", version: latest }),
		} as Response);

		const result = await checkForUpdates(true);

		expect(result.hasUpdate).toBe(hasUpdate);
	});

	it("reuses the daily cache without another registry fetch", async () => {
		cacheContents = JSON.stringify({
			lastCheck: Date.now() - 1_000,
			latestVersion: "5.0.0",
			currentVersion: "4.12.0",
		});

		const result = await checkForUpdates(false);

		expect(result.hasUpdate).toBe(true);
		expect(result.latestVersion).toBe("5.0.0");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("refreshes the daily cache when the installed version changes", async () => {
		cacheContents = JSON.stringify({
			lastCheck: Date.now() - 1_000,
			latestVersion: "4.13.0",
			currentVersion: "4.11.0",
		});
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ name: "codex-multi-auth", version: "5.0.0" }),
		} as Response);

		const result = await checkForUpdates(false);

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(result.latestVersion).toBe("5.0.0");
		expect(result.hasUpdate).toBe(true);
	});

	it("refreshes stale cache entries and writes the new result", async () => {
		cacheContents = JSON.stringify({
			lastCheck: Date.now() - (25 * 60 * 60 * 1_000),
			latestVersion: "4.13.0",
			currentVersion: "4.12.0",
		});
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ name: "codex-multi-auth", version: "5.0.0" }),
		} as Response);

		const result = await checkForUpdates(false);

		expect(result.latestVersion).toBe("5.0.0");
		expect(fs.writeFileSync).toHaveBeenCalled();
		expect(fs.renameSync).toHaveBeenCalled();
	});

	it("retries transient cache write failures without blocking the event loop", async () => {
		cacheContents = JSON.stringify({
			lastCheck: Date.now() - (25 * 60 * 60 * 1_000),
			latestVersion: "4.13.0",
			currentVersion: "4.12.0",
		});
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ name: "codex-multi-auth", version: "5.0.0" }),
		} as Response);
		let renameCalls = 0;
		vi.mocked(fs.renameSync).mockImplementation((from: unknown, to: unknown) => {
			const normalizedTo = String(to).replace(/\\/g, "/");
			if (normalizedTo !== cacheFilePath) return;
			renameCalls += 1;
			if (renameCalls === 1) {
				throw Object.assign(new Error("busy"), { code: "EBUSY" });
			}
		});
		const atomicsWait = vi.spyOn(Atomics, "wait");
		let settled = false;

		const resultPromise = checkForUpdates(false).then((result) => {
			settled = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(14);

		expect(settled).toBe(false);
		expect(atomicsWait).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		const result = await resultPromise;

		expect(result.latestVersion).toBe("5.0.0");
		expect(renameCalls).toBe(2);
		expect(atomicsWait).not.toHaveBeenCalled();
	});

	it("fails silently apart from debug logging when the registry is unavailable", async () => {
		vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network down"));

		const result = await checkForUpdates(true);

		expect(result.hasUpdate).toBe(false);
		expect(result.latestVersion).toBeNull();
		expect(logger.warn).not.toHaveBeenCalled();
		expect(logger.debug).toHaveBeenCalledWith(
			"Failed to check for updates",
			expect.objectContaining({ error: "network down" }),
		);
	});

	it("shows plugin toasts with the manual update command only", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			json: async () => ({ name: "codex-multi-auth", version: "5.0.0" }),
		} as Response);
		const toast = vi.fn(async () => undefined);

		await checkAndNotify(toast);

		expect(toast).toHaveBeenCalledWith(
			"Plugin update available: v5.0.0. Run: npm install -g codex-multi-auth@latest",
			"info",
		);
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("npm install -g codex-multi-auth@latest"),
		);
	});

	it("exposes no automatic update execution API", async () => {
		const module = await import("../lib/update-notice.js");

		expect("autoUpdateIfAvailable" in module).toBe(false);
		expect("isAutoUpdateEnabled" in module).toBe(false);
		expect("runUpdateCommand" in module).toBe(false);
	});

	it("resolves the package root by walking up to package metadata", () => {
		const result = resolvePackageRootFromModuleDir(`${packageRoot}/dist/lib`);

		expect(result).toBe(packageRoot);
	});

	it("clears the cached notice file without throwing", async () => {
		cacheContents = JSON.stringify({
			lastCheck: Date.now(),
			latestVersion: "5.0.0",
			currentVersion: "4.12.0",
		});

		clearUpdateCache();
		await vi.runAllTimersAsync();

		expect(fs.writeFileSync).toHaveBeenCalled();
	});
});
