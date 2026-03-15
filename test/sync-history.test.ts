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
});
