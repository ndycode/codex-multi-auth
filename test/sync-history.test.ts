import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetLastCodexCliSyncRunForTests,
	getLastCodexCliSyncRun,
	loadLastCodexCliSyncRun,
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
		await expect(loadLastCodexCliSyncRun()).resolves.toMatchObject({
			outcome: "changed",
			sourcePath: "source.json",
			targetPath: "target.json",
			summary: expect.objectContaining({
				addedAccountCount: 1,
			}),
		});
	});

	it("trims oversized history without re-reading the full history file", async () => {
		const readFileSpy = vi.spyOn(nodeFs, "readFile");

		for (let index = 1; index <= 205; index += 1) {
			await appendSyncHistoryEntry({
				kind: "codex-cli-sync",
				recordedAt: index,
				run: {
					outcome: "changed",
					runAt: index,
					sourcePath: `source-${index}.json`,
					targetPath: "target.json",
					summary: {
						sourceAccountCount: index,
						targetAccountCountBefore: index - 1,
						targetAccountCountAfter: index,
						addedAccountCount: 1,
						updatedAccountCount: 0,
						unchangedAccountCount: 0,
						destinationOnlyPreservedCount: 0,
						selectionChanged: false,
					},
				},
			});
		}

		expect(readFileSpy).not.toHaveBeenCalled();
		const history = await readSyncHistory({ kind: "codex-cli-sync" });
		expect(history).toHaveLength(200);
		expect(history[0]).toMatchObject({
			kind: "codex-cli-sync",
			recordedAt: 6,
		});
		expect(history.at(-1)).toMatchObject({
			kind: "codex-cli-sync",
			recordedAt: 205,
		});
	});
});
