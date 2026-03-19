import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexCliSyncRun } from "../lib/codex-cli/sync.js";
import {
	__resetLastCodexCliSyncRunForTests,
	getLastCodexCliSyncRun,
} from "../lib/codex-cli/sync.js";
import type { LiveAccountSyncSnapshot } from "../lib/live-account-sync.js";
import {
	__resetSyncHistoryForTests,
	appendSyncHistoryEntry,
	configureSyncHistoryForTests,
	getSyncHistoryPaths,
	pruneSyncHistory,
	pruneSyncHistoryEntries,
	readLatestSyncHistorySync,
	readSyncHistory,
} from "../lib/sync-history.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("sync history", () => {
	let workDir = "";
	let logDir = "";

	beforeEach(async () => {
		workDir = await fs.mkdtemp(join(tmpdir(), "codex-sync-history-"));
		logDir = join(workDir, "logs");
		configureSyncHistoryForTests(logDir);
		await fs.mkdir(logDir, { recursive: true });
		await __resetSyncHistoryForTests();
		__resetLastCodexCliSyncRunForTests();
	});

	afterEach(async () => {
		__resetLastCodexCliSyncRunForTests();
		await __resetSyncHistoryForTests();
		configureSyncHistoryForTests(null);
		await removeWithRetry(workDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function createSummary(
		overrides: Partial<CodexCliSyncRun["summary"]> = {},
	): CodexCliSyncRun["summary"] {
		return {
			sourceAccountCount: 0,
			targetAccountCountBefore: 0,
			targetAccountCountAfter: 0,
			addedAccountCount: 0,
			updatedAccountCount: 0,
			unchangedAccountCount: 0,
			destinationOnlyPreservedCount: 0,
			selectionChanged: false,
			...overrides,
		};
	}

	function createCodexRun(
		runAt: number,
		targetPath: string,
		options: {
			outcome?: CodexCliSyncRun["outcome"];
			sourcePath?: string | null;
			summary?: Partial<CodexCliSyncRun["summary"]>;
		} = {},
	): CodexCliSyncRun {
		return {
			outcome: options.outcome ?? "noop",
			runAt,
			sourcePath: options.sourcePath ?? null,
			targetPath,
			summary: createSummary(options.summary),
			trigger: "manual",
			rollbackSnapshot: null,
		};
	}

	function createLiveSnapshot(
		now: number,
		path: string = `/live-${now}`,
	): LiveAccountSyncSnapshot {
		return {
			path,
			running: true,
			lastKnownMtimeMs: now,
			lastSyncAt: now,
			reloadCount: 1,
			errorCount: 0,
		};
	}

	it("reads the last matching history entry without loading the whole file", async () => {
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 1,
			run: createCodexRun(1, "target.json", {
				sourcePath: "source-1.json",
			}),
		});
		await appendSyncHistoryEntry({
			kind: "live-account-sync",
			recordedAt: 2,
			reason: "watch",
			outcome: "success",
			path: "openai-codex-accounts.json",
			snapshot: createLiveSnapshot(2, "openai-codex-accounts.json"),
		});
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 3,
			run: createCodexRun(3, "target.json", {
				outcome: "changed",
				sourcePath: "source-2.json",
				summary: {
					sourceAccountCount: 1,
					targetAccountCountAfter: 1,
					addedAccountCount: 1,
					selectionChanged: true,
				},
			}),
		});

		const readFileSpy = vi.spyOn(fs, "readFile");
		const history = await readSyncHistory({ kind: "codex-cli-sync", limit: 1 });

		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			kind: "codex-cli-sync",
			recordedAt: 3,
			run: expect.objectContaining({
				outcome: "changed",
				sourcePath: "source-2.json",
			}),
		});
		expect(readFileSpy).not.toHaveBeenCalled();
	});

	it("recovers the last codex-cli sync run from history when the latest snapshot is missing", async () => {
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 11,
			run: createCodexRun(11, "target.json", {
				outcome: "changed",
				sourcePath: "source.json",
				summary: {
					sourceAccountCount: 1,
					targetAccountCountAfter: 1,
					addedAccountCount: 1,
					selectionChanged: true,
				},
			}),
		});

		await fs.rm(getSyncHistoryPaths().latestPath, { force: true });
		__resetLastCodexCliSyncRunForTests();

		expect(getLastCodexCliSyncRun()).toBeNull();

		await vi.waitFor(() => {
			expect(getLastCodexCliSyncRun()).toMatchObject({
				outcome: "changed",
				sourcePath: "source.json",
				targetPath: "target.json",
				summary: expect.objectContaining({
					addedAccountCount: 1,
				}),
			});
		});
	});

	it("keeps the latest entry for each kind when trimming aggressively", () => {
		const entries = [
			{
				kind: "codex-cli-sync" as const,
				recordedAt: 1,
				run: createCodexRun(1, "/first"),
			},
			{
				kind: "live-account-sync" as const,
				recordedAt: 2,
				reason: "watch" as const,
				outcome: "success" as const,
				path: "/live/first",
				snapshot: createLiveSnapshot(2, "/live/first"),
			},
			{
				kind: "codex-cli-sync" as const,
				recordedAt: 3,
				run: createCodexRun(3, "/second"),
			},
			{
				kind: "live-account-sync" as const,
				recordedAt: 4,
				reason: "poll" as const,
				outcome: "error" as const,
				path: "/live/second",
				snapshot: createLiveSnapshot(4, "/live/second"),
			},
		];

		const result = pruneSyncHistoryEntries(entries, 1);

		expect(result.entries.map((entry) => entry.recordedAt)).toEqual([3, 4]);
		expect(result.removed).toBe(2);
		expect(result.latest?.recordedAt).toBe(4);
	});

	it("prunes history on disk while keeping latest pointers aligned", async () => {
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 1,
			run: createCodexRun(1, "/source-1"),
		});
		await appendSyncHistoryEntry({
			kind: "live-account-sync",
			recordedAt: 2,
			reason: "watch",
			outcome: "success",
			path: "/watch-1",
			snapshot: createLiveSnapshot(2, "/watch-1"),
		});
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 3,
			run: createCodexRun(3, "/source-2"),
		});

		const result = await pruneSyncHistory({ maxEntries: 1 });
		const latestOnDisk = readLatestSyncHistorySync();
		const history = await readSyncHistory();

		expect(result.kept).toBe(2);
		expect(history.map((entry) => entry.recordedAt)).toEqual([2, 3]);
		expect(history.at(-1)).toEqual(result.latest);
		expect(latestOnDisk).toEqual(result.latest);
	});

	it("preserves the latest entry per kind when appends exceed the default cap", async () => {
		for (let index = 0; index < 205; index += 1) {
			await appendSyncHistoryEntry({
				kind: "codex-cli-sync",
				recordedAt: index + 1,
				run: createCodexRun(index + 1, `/codex-${index + 1}`),
			});
		}
		await appendSyncHistoryEntry({
			kind: "live-account-sync",
			recordedAt: 10_000,
			reason: "poll",
			outcome: "success",
			path: "/live-latest",
			snapshot: createLiveSnapshot(10_000, "/live-latest"),
		});

		const history = await readSyncHistory();
		const latestCodex = history
			.filter((entry) => entry.kind === "codex-cli-sync")
			.at(-1);
		const latestLive = history
			.filter((entry) => entry.kind === "live-account-sync")
			.at(-1);

		expect(history.length).toBeLessThanOrEqual(201);
		expect(latestCodex?.recordedAt).toBe(205);
		expect(latestLive?.recordedAt).toBe(10_000);
		expect(readLatestSyncHistorySync()?.recordedAt).toBe(10_000);
	});

	it("skips trim reads until the reload guard band is reached", async () => {
		const historyPath = getSyncHistoryPaths().historyPath;
		const readFileSpy = vi.spyOn(fs, "readFile");

		for (let index = 0; index < 179; index += 1) {
			await appendSyncHistoryEntry({
				kind: "codex-cli-sync",
				recordedAt: index + 1,
				run: createCodexRun(index + 1, `/codex-${index + 1}`),
			});
		}

		const historyReads = readFileSpy.mock.calls.filter(
			([target]) => target === historyPath,
		);
		expect(historyReads).toHaveLength(0);
	});

	it("reloads and trims once when append count crosses the default cap", async () => {
		const historyPath = getSyncHistoryPaths().historyPath;
		const readFileSpy = vi.spyOn(fs, "readFile");

		for (let index = 0; index < 201; index += 1) {
			await appendSyncHistoryEntry({
				kind: "codex-cli-sync",
				recordedAt: index + 1,
				run: createCodexRun(index + 1, `/codex-${index + 1}`),
			});
		}

		const historyReads = readFileSpy.mock.calls.filter(
			([target]) => target === historyPath,
		);
		expect(historyReads.length).toBeGreaterThan(0);
		expect((await readSyncHistory()).length).toBeLessThanOrEqual(200);
	});

	it("reloads near the trim threshold before appending when external writes grew the file", async () => {
		const historyPath = getSyncHistoryPaths().historyPath;

		for (let index = 0; index < 181; index += 1) {
			await appendSyncHistoryEntry({
				kind: "codex-cli-sync",
				recordedAt: index + 1,
				run: createCodexRun(index + 1, `/codex-${index + 1}`),
			});
		}

		const existingLines = (await fs.readFile(historyPath, "utf8"))
			.split("\n")
			.filter((line) => line.length > 0);
		const replayLine = existingLines.at(-1);
		expect(replayLine).toBeTruthy();

		await fs.appendFile(
			historyPath,
			Array.from({ length: 25 }, () => replayLine).join("\n") + "\n",
			"utf8",
		);

		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 999,
			run: createCodexRun(999, "/codex-999"),
		});

		expect((await readSyncHistory()).length).toBeLessThanOrEqual(200);
	});

	it("resets the cached append estimate when trim reload finds an externally cleared file", async () => {
		const historyPath = getSyncHistoryPaths().historyPath;
		const originalReadFile = fs.readFile.bind(fs);
		let truncateOnNextTrimRead = false;
		const readFileSpy = vi
			.spyOn(fs, "readFile")
			.mockImplementation(async (path, ...args) => {
				if (
					truncateOnNextTrimRead &&
					path === historyPath
				) {
					truncateOnNextTrimRead = false;
					await fs.writeFile(historyPath, "", "utf8");
				}
				return originalReadFile(path, ...args);
			});

		for (let index = 0; index < 200; index += 1) {
			await appendSyncHistoryEntry({
				kind: "codex-cli-sync",
				recordedAt: index + 1,
				run: createCodexRun(index + 1, `/codex-${index + 1}`),
			});
		}

		truncateOnNextTrimRead = true;
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 201,
			run: createCodexRun(201, "/codex-201"),
		});
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 202,
			run: createCodexRun(202, "/codex-202"),
		});

		const historyReads = readFileSpy.mock.calls.filter(
			([target]) => target === historyPath,
		);
		expect(historyReads.length).toBeGreaterThan(0);
		expect((await readSyncHistory()).map((entry) => entry.recordedAt)).toEqual([
			201,
			202,
		]);
	});

	it("waits for writes queued while history reads are draining", async () => {
		const paths = getSyncHistoryPaths();
		const originalAppendFile = fs.appendFile.bind(fs);
		let appendCalls = 0;
		let releaseFirstAppend: (() => void) | null = null;
		let secondAppendPromise: Promise<void> | null = null;
		const firstAppendGate = new Promise<void>((resolve) => {
			releaseFirstAppend = resolve;
		});
		const appendFileSpy = vi.spyOn(fs, "appendFile").mockImplementation(
			async (path, data, options) => {
				if (path === paths.historyPath && appendCalls === 0) {
					appendCalls += 1;
					queueMicrotask(() => {
						secondAppendPromise = appendSyncHistoryEntry({
							kind: "codex-cli-sync",
							recordedAt: 2,
							run: createCodexRun(2, "/sync-history-second"),
						});
					});
					await firstAppendGate;
				}
				return originalAppendFile(path, data, options);
			},
		);

		const firstAppendPromise = appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 1,
			run: createCodexRun(1, "/sync-history-first"),
		});
		const readPromise = readSyncHistory();
		await Promise.resolve();
		releaseFirstAppend?.();

		await firstAppendPromise;
		await secondAppendPromise;
		const history = await readPromise;

		expect(history.map((entry) => entry.recordedAt)).toEqual([1, 2]);
		expect(appendFileSpy).toHaveBeenCalled();
	});

	it("retries transient append and latest-write lock errors during append", async () => {
		const paths = getSyncHistoryPaths();
		const originalAppendFile = fs.appendFile.bind(fs);
		const originalWriteFile = fs.writeFile.bind(fs);
		let appendFailures = 0;
		let latestFailures = 0;
		const setTimeoutSpy = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation(((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
				if (typeof handler !== "function") {
					throw new Error("Expected function timer handler in sync-history retry test.");
				}
				handler(...args);
				return 0 as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout);
		const appendFileSpy = vi
			.spyOn(fs, "appendFile")
			.mockImplementation(async (path, data, options) => {
				if (path === paths.historyPath && appendFailures === 0) {
					appendFailures += 1;
					const error = new Error("history locked") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return originalAppendFile(path, data, options);
			});
		const writeFileSpy = vi
			.spyOn(fs, "writeFile")
			.mockImplementation(async (path, data, options) => {
				if (path === paths.latestPath && latestFailures === 0) {
					latestFailures += 1;
					const error = new Error("latest locked") as NodeJS.ErrnoException;
					error.code = "EBUSY";
					throw error;
				}
				return originalWriteFile(path, data, options);
			});

		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 1,
			run: createCodexRun(1, "/retry-append"),
		});

		expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
		expect(appendFileSpy.mock.calls.filter(([path]) => path === paths.historyPath)).toHaveLength(2);
		expect(writeFileSpy.mock.calls.filter(([path]) => path === paths.latestPath)).toHaveLength(2);
		expect((await readSyncHistory()).map((entry) => entry.recordedAt)).toEqual([1]);
		expect(readLatestSyncHistorySync()?.recordedAt).toBe(1);
	});

	it("retries transient trim rewrite lock errors when the history cap is exceeded", async () => {
		const paths = getSyncHistoryPaths();
		const originalWriteFile = fs.writeFile.bind(fs);
		let trimWriteFailures = 0;
		const setTimeoutSpy = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation(((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
				if (typeof handler !== "function") {
					throw new Error("Expected function timer handler in sync-history retry test.");
				}
				handler(...args);
				return 0 as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout);

		for (let index = 0; index < 200; index += 1) {
			await appendSyncHistoryEntry({
				kind: "codex-cli-sync",
				recordedAt: index + 1,
				run: createCodexRun(index + 1, `/seed-${index + 1}`),
			});
		}

		const writeFileSpy = vi
			.spyOn(fs, "writeFile")
			.mockImplementation(async (path, data, options) => {
				if (path === paths.historyPath && trimWriteFailures === 0) {
					trimWriteFailures += 1;
					const error = new Error("trim locked") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				return originalWriteFile(path, data, options);
			});

		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 201,
			run: createCodexRun(201, "/seed-201"),
		});

		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
		expect(writeFileSpy.mock.calls.filter(([path]) => path === paths.historyPath)).toHaveLength(2);
		const history = await readSyncHistory();
		expect(history.length).toBeLessThanOrEqual(200);
		expect(history.at(-1)?.recordedAt).toBe(201);
		expect(readLatestSyncHistorySync()?.recordedAt).toBe(201);
	});

	it("re-reads seeded history after configureSyncHistoryForTests resets the estimate to null", async () => {
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 1,
			run: createCodexRun(1, "/seeded"),
		});
		configureSyncHistoryForTests(logDir);
		const historyPath = getSyncHistoryPaths().historyPath;
		const readFileSpy = vi.spyOn(fs, "readFile");

		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 2,
			run: createCodexRun(2, "/after-reset"),
		});

		const historyReads = readFileSpy.mock.calls.filter(
			([target]) => target === historyPath,
		);
		expect(historyReads).toHaveLength(1);
	});
});
