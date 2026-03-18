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
	__getLastSyncHistoryErrorForTests,
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

	function createDeferred(): {
		promise: Promise<void>;
		resolve: () => void;
	} {
		let resolve = (): void => {};
		const promise = new Promise<void>((resolvePromise) => {
			resolve = resolvePromise;
		});
		return { promise, resolve };
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

	it("reads tail entries when a multibyte character crosses the chunk boundary", async () => {
		const historyPath = getSyncHistoryPaths().historyPath;
		const emoji = "🙂";
		const paddedMessage = `${"x".repeat(64)}${emoji} split`;
		let historyContent = "";

		for (let padding = 0; padding < 9000; padding += 1) {
			const olderEntry = JSON.stringify({
				kind: "codex-cli-sync",
				recordedAt: 1,
				run: {
					...createCodexRun(1, "/older"),
					message: paddedMessage,
				},
			});
			const newerEntry = JSON.stringify({
				kind: "codex-cli-sync",
				recordedAt: 2,
				run: createCodexRun(2, `/newer-${"y".repeat(padding)}`),
			});
			const candidate = `${olderEntry}\n${newerEntry}\n`;
			const boundary = Buffer.byteLength(candidate) - 8 * 1024;
			if (boundary <= 0) {
				continue;
			}
			const emojiStart = Buffer.byteLength(olderEntry.split(emoji)[0] ?? "");
			const emojiEnd = emojiStart + Buffer.byteLength(emoji);
			if (boundary > emojiStart && boundary < emojiEnd) {
				historyContent = candidate;
				break;
			}
		}

		expect(historyContent).not.toBe("");
		await fs.writeFile(historyPath, historyContent, "utf8");

		const history = await readSyncHistory({ kind: "codex-cli-sync", limit: 2 });

		expect(history).toHaveLength(2);
		expect(history[0]).toMatchObject({
			kind: "codex-cli-sync",
			recordedAt: 1,
			run: expect.objectContaining({
				message: paddedMessage,
			}),
		});
		expect(history[1]).toMatchObject({
			kind: "codex-cli-sync",
			recordedAt: 2,
			run: expect.objectContaining({
				targetPath: expect.stringContaining("/newer-"),
			}),
		});
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

	it("waits for writes queued while history reads are draining", async () => {
		let releaseFirstAppend!: () => void;
		let releaseSecondAppend!: () => void;
		let resolveFirstStarted!: () => void;
		let resolveSecondStarted!: () => void;
		const firstAppendStarted = new Promise<void>((resolve) => {
			resolveFirstStarted = resolve;
		});
		const secondAppendStarted = new Promise<void>((resolve) => {
			resolveSecondStarted = resolve;
		});
		const firstAppendGate = new Promise<void>((resolve) => {
			releaseFirstAppend = resolve;
		});
		const secondAppendGate = new Promise<void>((resolve) => {
			releaseSecondAppend = resolve;
		});
		const originalAppendFile = nodeFs.appendFile;
		let appendCallCount = 0;
		vi.spyOn(nodeFs, "appendFile").mockImplementation(
			async (...args: Parameters<typeof nodeFs.appendFile>) => {
				appendCallCount += 1;
				if (appendCallCount === 1) {
					resolveFirstStarted();
					await firstAppendGate;
				} else if (appendCallCount === 2) {
					resolveSecondStarted();
					await secondAppendGate;
				}
				return originalAppendFile(...args);
			},
		);

		const firstWrite = appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 1,
			run: {
				outcome: "changed",
				runAt: 1,
				sourcePath: "source-1.json",
				targetPath: "target-1.json",
				summary: {
					sourceAccountCount: 1,
					targetAccountCountBefore: 0,
					targetAccountCountAfter: 1,
					addedAccountCount: 1,
					updatedAccountCount: 0,
					unchangedAccountCount: 0,
					destinationOnlyPreservedCount: 0,
					selectionChanged: true,
				},
			},
		});
		await firstAppendStarted;

		let readResolved = false;
		const readPromise = readSyncHistory({ kind: "codex-cli-sync" }).then((history) => {
			readResolved = true;
			return history;
		});

		const secondWrite = appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 2,
			run: {
				outcome: "noop",
				runAt: 2,
				sourcePath: "source-2.json",
				targetPath: "target-2.json",
				summary: {
					sourceAccountCount: 1,
					targetAccountCountBefore: 1,
					targetAccountCountAfter: 1,
					addedAccountCount: 0,
					updatedAccountCount: 0,
					unchangedAccountCount: 1,
					destinationOnlyPreservedCount: 0,
					selectionChanged: false,
				},
			},
		});
		releaseFirstAppend();
		await secondAppendStarted;
		await Promise.resolve();
		await Promise.resolve();
		expect(readResolved).toBe(false);

		releaseSecondAppend();
		const history = await readPromise;
		await firstWrite;
		await secondWrite;

		expect(history).toHaveLength(2);
		expect(history.at(-1)).toMatchObject({
			kind: "codex-cli-sync",
			recordedAt: 2,
			run: expect.objectContaining({
				sourcePath: "source-2.json",
			}),
		});
	});

	it("retries transient rename failures while pruning history files", async () => {
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

		const originalRename = fs.rename.bind(fs);
		let failedHistoryRename = false;
		const renameSpy = vi
			.spyOn(fs, "rename")
			.mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
				const [, targetPath] = args;
				if (
					!failedHistoryRename &&
					typeof targetPath === "string" &&
					targetPath.endsWith("sync-history.ndjson")
				) {
					failedHistoryRename = true;
					const error = new Error("locked") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				return originalRename(...args);
			});

		const result = await pruneSyncHistory({ maxEntries: 1 });

		expect(result.kept).toBe(2);
		expect(renameSpy).toHaveBeenCalled();
		expect(failedHistoryRename).toBe(true);
		expect((await readSyncHistory()).map((entry) => entry.recordedAt)).toEqual([
			2,
			3,
		]);
		expect(readLatestSyncHistorySync()?.recordedAt).toBe(3);
	});

	it("retries transient read failures before refreshing the latest sync history entry", async () => {
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 1,
			run: createCodexRun(1, "/source-1"),
		});

		const originalReadFile = fs.readFile.bind(fs);
		let failedOnce = false;
		const readSpy = vi
			.spyOn(fs, "readFile")
			.mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
				const [targetPath] = args;
				if (
					!failedOnce &&
					typeof targetPath === "string" &&
					targetPath.endsWith("sync-history.ndjson")
				) {
					failedOnce = true;
					const error = new Error("locked") as NodeJS.ErrnoException;
					error.code = "EBUSY";
					throw error;
				}
				return originalReadFile(...args);
			});

		try {
			await appendSyncHistoryEntry({
				kind: "codex-cli-sync",
				recordedAt: 2,
				run: createCodexRun(2, "/source-2"),
			});

			expect(failedOnce).toBe(true);
			expect(__getLastSyncHistoryErrorForTests()).toBeNull();
			expect(readLatestSyncHistorySync()?.recordedAt).toBe(2);
			expect((await readSyncHistory()).map((entry) => entry.recordedAt)).toEqual([
				1,
				2,
			]);
		} finally {
			readSpy.mockRestore();
		}
	});

	it("retries transient read failures before pruning sync history", async () => {
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

		const originalReadFile = fs.readFile.bind(fs);
		let failedOnce = false;
		const readSpy = vi
			.spyOn(fs, "readFile")
			.mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
				const [targetPath] = args;
				if (
					!failedOnce &&
					typeof targetPath === "string" &&
					targetPath.endsWith("sync-history.ndjson")
				) {
					failedOnce = true;
					const error = new Error("locked") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				return originalReadFile(...args);
			});

		try {
			const result = await pruneSyncHistory({ maxEntries: 1 });

			expect(result.kept).toBe(2);
			expect(failedOnce).toBe(true);
			expect(__getLastSyncHistoryErrorForTests()).toBeNull();
			expect(readLatestSyncHistorySync()?.recordedAt).toBe(3);
			expect((await readSyncHistory()).map((entry) => entry.recordedAt)).toEqual([
				2,
				3,
			]);
		} finally {
			readSpy.mockRestore();
		}
	});

	it("waits for in-flight prune rewrites before serving reads", async () => {
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

		const writeGate = createDeferred();
		const originalWriteFile = fs.writeFile.bind(fs);
		let blockedPruneWrite = false;
		vi.spyOn(fs, "writeFile").mockImplementation(
			async (...args: Parameters<typeof fs.writeFile>) => {
				const [targetPath] = args;
				if (
					!blockedPruneWrite &&
					typeof targetPath === "string" &&
					targetPath.includes("sync-history.ndjson.tmp")
				) {
					blockedPruneWrite = true;
					await writeGate.promise;
				}
				return originalWriteFile(...args);
			},
		);

		const prunePromise = pruneSyncHistory({ maxEntries: 1 });
		await vi.waitFor(() => {
			expect(blockedPruneWrite).toBe(true);
		});

		let readResolved = false;
		const readPromise = readSyncHistory().then((history) => {
			readResolved = true;
			return history;
		});

		await Promise.resolve();
		expect(readResolved).toBe(false);

		writeGate.resolve();
		const [pruneResult, history] = await Promise.all([prunePromise, readPromise]);

		expect(pruneResult.kept).toBe(2);
		expect(history.map((entry) => entry.recordedAt)).toEqual([2, 3]);
		expect(readLatestSyncHistorySync()?.recordedAt).toBe(3);
	});

	it("retries transient append failures before committing sync history", async () => {
		const originalAppendFile = fs.appendFile.bind(fs);
		let failedOnce = false;
		vi.spyOn(fs, "appendFile").mockImplementation(
			async (...args: Parameters<typeof fs.appendFile>) => {
				if (!failedOnce) {
					failedOnce = true;
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = "EBUSY";
					throw error;
				}
				return originalAppendFile(...args);
			},
		);

		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 4,
			run: createCodexRun(4, "/source-4"),
		});

		expect(failedOnce).toBe(true);
		expect(readLatestSyncHistorySync()?.recordedAt).toBe(4);
		expect(await readSyncHistory()).toHaveLength(1);
	});

	it("retries transient latest-file removal when pruning empty history", async () => {
		const latestPath = getSyncHistoryPaths().latestPath;
		await fs.writeFile(
			latestPath,
			`${JSON.stringify({
				kind: "codex-cli-sync",
				recordedAt: 7,
				run: createCodexRun(7, "/stale"),
			})}\n`,
			"utf8",
		);

		const originalRm = fs.rm.bind(fs);
		let failedLatestRemove = false;
		vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
			const [targetPath] = args;
			if (
				!failedLatestRemove &&
				typeof targetPath === "string" &&
				targetPath === latestPath
			) {
				failedLatestRemove = true;
				const error = new Error("busy") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return originalRm(...args);
		});

		const result = await pruneSyncHistory();

		expect(result.kept).toBe(0);
		expect(failedLatestRemove).toBe(true);
		expect(readLatestSyncHistorySync()).toBeNull();
	});
});
