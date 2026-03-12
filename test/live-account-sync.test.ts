import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetLastLiveAccountSyncSnapshotForTests,
	getLastLiveAccountSyncSnapshot,
	LiveAccountSync,
} from "../lib/live-account-sync.js";
import * as syncHistory from "../lib/sync-history.js";

describe("live-account-sync", () => {
	let workDir = "";
	let storagePath = "";

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-26T12:00:00.000Z"));
		__resetLastLiveAccountSyncSnapshotForTests();
		workDir = join(
			process.cwd(),
			"tmp-live-sync",
			`codex-live-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		syncHistory.configureSyncHistoryForTests(join(workDir, "logs"));
		await syncHistory.__resetSyncHistoryForTests();
		storagePath = join(workDir, "openai-codex-accounts.json");
		await fs.mkdir(workDir, { recursive: true });
		await fs.writeFile(
			storagePath,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf-8",
		);
	});

	afterEach(async () => {
		const keepWorkDir = process.env.DEBUG_SYNC_HISTORY === "1";
		vi.useRealTimers();
		__resetLastLiveAccountSyncSnapshotForTests();
		await syncHistory.__resetSyncHistoryForTests();
		syncHistory.configureSyncHistoryForTests(null);
		if (!keepWorkDir) {
			await fs.rm(workDir, { recursive: true, force: true });
		}
	});

	it("publishes watcher state for sync-center status surfaces", async () => {
		const reload = vi.fn(async () => undefined);
		const sync = new LiveAccountSync(reload, {
			pollIntervalMs: 500,
			debounceMs: 50,
		});

		expect(getLastLiveAccountSyncSnapshot().running).toBe(false);
		await sync.syncToPath(storagePath);
		expect(getLastLiveAccountSyncSnapshot()).toEqual(
			expect.objectContaining({
				path: storagePath,
				running: true,
			}),
		);

		sync.stop();
		expect(getLastLiveAccountSyncSnapshot()).toEqual(
			expect.objectContaining({
				path: storagePath,
				running: false,
			}),
		);
	});

	it("reloads when file changes are detected by polling", async () => {
		const reload = vi.fn(async () => undefined);
		const sync = new LiveAccountSync(reload, {
			pollIntervalMs: 500,
			debounceMs: 50,
		});

		await sync.syncToPath(storagePath);
		await fs.writeFile(
			storagePath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "a" }],
			}),
			"utf-8",
		);
		const bumped = new Date(Date.now() + 1_000);
		await fs.utimes(storagePath, bumped, bumped);

		await vi.advanceTimersByTimeAsync(900);

		expect(reload).toHaveBeenCalled();
		const snapshot = sync.getSnapshot();
		expect(snapshot.reloadCount).toBeGreaterThan(0);
		expect(snapshot.lastSyncAt).not.toBeNull();
		sync.stop();
	});

	it("records errors when reload fails", async () => {
		const reload = vi.fn(async () => {
			throw new Error("reload failed");
		});
		const appendSpy = vi.spyOn(syncHistory, "appendSyncHistoryEntry");
		const sync = new LiveAccountSync(reload, {
			pollIntervalMs: 500,
			debounceMs: 50,
		});

		await sync.syncToPath(storagePath);
		await fs.writeFile(
			storagePath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "b" }],
			}),
			"utf-8",
		);
		const bumped = new Date(Date.now() + 2_000);
		await fs.utimes(storagePath, bumped, bumped);

		await vi.advanceTimersByTimeAsync(900);

		const snapshot = sync.getSnapshot();
		expect(snapshot.errorCount).toBeGreaterThan(0);
		expect(snapshot.reloadCount).toBe(0);
		expect(appendSpy).toHaveBeenCalled();
		expect(syncHistory.__getLastSyncHistoryErrorForTests()).toBeNull();
		const paths = syncHistory.getSyncHistoryPaths();
		expect(paths.directory).toBe(join(workDir, "logs"));
		const lastAppendPaths = syncHistory.__getLastSyncHistoryPathsForTests();
		expect(lastAppendPaths?.directory).toBe(paths.directory);
		const dirExists = await fs
			.stat(paths.directory)
			.then(() => true)
			.catch(() => false);
		expect(dirExists).toBe(true);
		const content = await fs
			.readFile(paths.historyPath, "utf-8")
			.catch(() => "");
		expect(content.length).toBeGreaterThan(0);
		const history = await syncHistory.readSyncHistory({
			kind: "live-account-sync",
		});
		const last = history.at(-1);
		expect(last?.outcome).toBe("error");
		expect(["poll", "watch"]).toContain(last?.reason);
		sync.stop();
		appendSpy.mockRestore();
	});

	it("stops watching cleanly and prevents further reloads", async () => {
		const reload = vi.fn(async () => undefined);
		const sync = new LiveAccountSync(reload, {
			pollIntervalMs: 500,
			debounceMs: 50,
		});

		await sync.syncToPath(storagePath);
		sync.stop();
		await fs.writeFile(
			storagePath,
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "c" }],
			}),
			"utf-8",
		);
		const bumped = new Date(Date.now() + 3_000);
		await fs.utimes(storagePath, bumped, bumped);

		await vi.advanceTimersByTimeAsync(1_200);

		expect(reload).not.toHaveBeenCalled();
		expect(sync.getSnapshot().running).toBe(false);
	});

	it("counts poll errors when stat throws non-retryable errors", async () => {
		const reload = vi.fn(async () => undefined);
		const sync = new LiveAccountSync(reload, {
			pollIntervalMs: 500,
			debounceMs: 50,
		});

		await sync.syncToPath(storagePath);
		const statSpy = vi.spyOn(fs, "stat");
		statSpy.mockRejectedValueOnce(
			Object.assign(new Error("disk fault"), { code: "EIO" }),
		);

		await vi.advanceTimersByTimeAsync(600);

		expect(sync.getSnapshot().errorCount).toBeGreaterThan(0);
		statSpy.mockRestore();
		sync.stop();
	});

	it("coalesces overlapping reload attempts into a single in-flight reload", async () => {
		let resolveReload: (() => void) | undefined;
		const reloadStarted = new Promise<void>((resolve) => {
			resolveReload = resolve;
		});
		const reload = vi.fn(async () => reloadStarted);
		const sync = new LiveAccountSync(reload, {
			pollIntervalMs: 500,
			debounceMs: 50,
		});
		await sync.syncToPath(storagePath);

		const runReload = Reflect.get(sync, "runReload") as (
			reason: "watch" | "poll",
		) => Promise<void>;
		const invoke = (reason: "watch" | "poll") =>
			Reflect.apply(
				runReload as (...args: unknown[]) => unknown,
				sync as object,
				[reason],
			) as Promise<void>;
		const first = invoke("poll");
		const second = invoke("watch");
		resolveReload?.();
		await Promise.all([first, second]);

		expect(reload).toHaveBeenCalledTimes(1);
		const history = await syncHistory.readSyncHistory({
			kind: "live-account-sync",
		});
		expect(history[history.length - 1]?.outcome).toBe("success");
		sync.stop();
	});
});
