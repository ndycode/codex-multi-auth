import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetLastLiveAccountSyncSnapshotForTests,
	getLastLiveAccountSyncSnapshot,
	LiveAccountSync,
} from "../lib/live-account-sync.js";

const RETRYABLE_REMOVE_CODES = new Set([
	"EBUSY",
	"EPERM",
	"ENOTEMPTY",
	"EACCES",
	"ETIMEDOUT",
]);

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return;
			}
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("live-account-sync", () => {
	let workDir = "";
	let storagePath = "";

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-26T12:00:00.000Z"));
		__resetLastLiveAccountSyncSnapshotForTests();
		workDir = join(
			tmpdir(),
			`codex-live-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		storagePath = join(workDir, "openai-codex-accounts.json");
		await fs.mkdir(workDir, { recursive: true });
		await fs.writeFile(
			storagePath,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf-8",
		);
	});

	afterEach(async () => {
		vi.useRealTimers();
		__resetLastLiveAccountSyncSnapshotForTests();
		await removeWithRetry(workDir, { recursive: true, force: true });
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

	it("keeps the newest watcher snapshot published when older instances stop later", async () => {
		const secondStoragePath = join(workDir, "openai-codex-accounts-secondary.json");
		await fs.writeFile(
			secondStoragePath,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf-8",
		);
		const first = new LiveAccountSync(async () => undefined, {
			pollIntervalMs: 500,
			debounceMs: 50,
		});
		const second = new LiveAccountSync(async () => undefined, {
			pollIntervalMs: 500,
			debounceMs: 50,
		});

		await first.syncToPath(storagePath);
		expect(getLastLiveAccountSyncSnapshot()).toEqual(
			expect.objectContaining({
				path: storagePath,
				running: true,
			}),
		);

		await second.syncToPath(secondStoragePath);
		expect(getLastLiveAccountSyncSnapshot()).toEqual(
			expect.objectContaining({
				path: secondStoragePath,
				running: true,
			}),
		);

		first.stop();
		expect(getLastLiveAccountSyncSnapshot()).toEqual(
			expect.objectContaining({
				path: secondStoragePath,
				running: true,
			}),
		);

		second.stop();
		expect(getLastLiveAccountSyncSnapshot()).toEqual(
			expect.objectContaining({
				path: secondStoragePath,
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
		sync.stop();
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
		sync.stop();
	});

	it("drops stale reload completions after switching to a new path", async () => {
		const secondStoragePath = join(workDir, "openai-codex-accounts-second.json");
		await fs.writeFile(
			secondStoragePath,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf-8",
		);

		const firstReloadStarted = createDeferred<void>();
		const firstReloadFinished = createDeferred<void>();
		const secondReloadStarted = createDeferred<void>();
		const seenPaths: string[] = [];
		let reloadCall = 0;
		let sync: LiveAccountSync;

		const reload = vi.fn(async () => {
			reloadCall += 1;
			const currentPath = Reflect.get(sync, "currentPath") as string | null;
			seenPaths.push(currentPath ?? "<null>");
			if (reloadCall === 1) {
				firstReloadStarted.resolve(undefined);
				await firstReloadFinished.promise;
				return;
			}
			secondReloadStarted.resolve(undefined);
		});

		sync = new LiveAccountSync(reload, {
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
		await firstReloadStarted.promise;

		await sync.syncToPath(secondStoragePath);
		const second = invoke("watch");
		await secondReloadStarted.promise;

		firstReloadFinished.resolve(undefined);
		await Promise.all([first, second]);

		expect(seenPaths).toEqual([storagePath, secondStoragePath]);
		expect(reload).toHaveBeenCalledTimes(2);
		expect(sync.getSnapshot()).toEqual(
			expect.objectContaining({
				path: secondStoragePath,
				running: true,
				reloadCount: 1,
				errorCount: 0,
			}),
		);
		expect(getLastLiveAccountSyncSnapshot()).toEqual(
			expect.objectContaining({
				path: secondStoragePath,
				running: true,
				reloadCount: 1,
				errorCount: 0,
			}),
		);

		sync.stop();
	});
});
