import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetLastCodexCliSyncRunForTests,
	getLastCodexCliSyncRun,
} from "../lib/codex-cli/sync.js";
import {
	__resetSyncHistoryForTests,
	appendSyncHistoryEntry,
	configureSyncHistoryForTests,
	getSyncHistoryPaths,
	readSyncHistory,
} from "../lib/sync-history.js";

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
			await nodeFs.rm(targetPath, options);
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

describe("sync history", () => {
	let workDir = "";

	beforeEach(async () => {
		workDir = await nodeFs.mkdtemp(join(tmpdir(), "codex-sync-history-"));
		configureSyncHistoryForTests(join(workDir, "logs"));
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

	it("reads the last matching history entry without loading the whole file", async () => {
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 1,
			run: {
				outcome: "noop",
				runAt: 1,
				sourcePath: "source-1.json",
				targetPath: "target.json",
				summary: {
					sourceAccountCount: 0,
					targetAccountCountBefore: 0,
					targetAccountCountAfter: 0,
					addedAccountCount: 0,
					updatedAccountCount: 0,
					unchangedAccountCount: 0,
					destinationOnlyPreservedCount: 0,
					selectionChanged: false,
				},
			},
		});
		await appendSyncHistoryEntry({
			kind: "live-account-sync",
			recordedAt: 2,
			reason: "watch",
			outcome: "success",
			path: "openai-codex-accounts.json",
			snapshot: {
				path: "openai-codex-accounts.json",
				running: true,
				lastReason: "watch",
				lastError: null,
				lastSuccessAt: 2,
				lastAttemptAt: 2,
				reloadCount: 1,
				errorCount: 0,
			},
		});
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 3,
			run: {
				outcome: "changed",
				runAt: 3,
				sourcePath: "source-2.json",
				targetPath: "target.json",
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

		const readFileSpy = vi.spyOn(nodeFs, "readFile");

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
			run: {
				outcome: "changed",
				runAt: 11,
				sourcePath: "source.json",
				targetPath: "target.json",
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

		await nodeFs.rm(getSyncHistoryPaths().latestPath, { force: true });
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
