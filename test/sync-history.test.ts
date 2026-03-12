import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexCliSyncRun } from "../lib/codex-cli/sync.js";
import type { LiveAccountSyncSnapshot } from "../lib/live-account-sync.js";
import {
	__resetSyncHistoryForTests,
	appendSyncHistoryEntry,
	configureSyncHistoryForTests,
	pruneSyncHistory,
	pruneSyncHistoryEntries,
	readLatestSyncHistorySync,
	readSyncHistory,
} from "../lib/sync-history.js";

describe("sync history pruning", () => {
	let workDir = "";
	let logDir = "";

	beforeEach(async () => {
		workDir = join(
			process.cwd(),
			"tmp-sync-history",
			`sync-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		logDir = join(workDir, "logs");
		configureSyncHistoryForTests(logDir);
		await fs.mkdir(logDir, { recursive: true });
		await __resetSyncHistoryForTests();
	});

	afterEach(async () => {
		await __resetSyncHistoryForTests();
		configureSyncHistoryForTests(null);
		await fs
			.rm(workDir, { recursive: true, force: true })
			.catch(() => undefined);
	});

	function createCodexSummary(): CodexCliSyncRun["summary"] {
		return {
			sourceAccountCount: 0,
			targetAccountCountBefore: 0,
			targetAccountCountAfter: 0,
			addedAccountCount: 0,
			updatedAccountCount: 0,
			unchangedAccountCount: 0,
			destinationOnlyPreservedCount: 0,
			selectionChanged: false,
		};
	}

	function createCodexRun(runAt: number, targetPath: string): CodexCliSyncRun {
		return {
			outcome: "noop",
			runAt,
			sourcePath: null,
			targetPath,
			summary: createCodexSummary(),
			trigger: "manual",
			rollbackSnapshot: null,
		};
	}

	function createLiveSnapshot(now: number): LiveAccountSyncSnapshot {
		return {
			path: `/live-${now}`,
			running: true,
			lastKnownMtimeMs: now,
			lastSyncAt: now,
			reloadCount: 1,
			errorCount: 0,
		};
	}

	it("keeps the latest codex-cli-sync entry when trimming aggressively", () => {
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
				snapshot: createLiveSnapshot(2),
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
				outcome: "success" as const,
				path: "/live/second",
				snapshot: createLiveSnapshot(4),
			},
		];
		const result = pruneSyncHistoryEntries(entries, 1);
		const latestCodex = result.entries.find(
			(entry) => entry.kind === "codex-cli-sync",
		);
		expect(latestCodex).toBeDefined();
		expect(latestCodex?.recordedAt).toBe(3);
		expect(result.removed).toBe(2);
	});

	it("keeps the latest live-account-sync entry when trimming aggressively", () => {
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
				snapshot: createLiveSnapshot(2),
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
				snapshot: createLiveSnapshot(4),
			},
		];
		const result = pruneSyncHistoryEntries(entries, 1);
		const latestLive = result.entries.find(
			(entry) => entry.kind === "live-account-sync",
		);
		expect(latestLive).toBeDefined();
		expect(latestLive?.recordedAt).toBe(4);
		expect(result.removed).toBe(2);
	});

	it("keeps latest entry on disk after pruning and mirrors latest file", async () => {
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
			snapshot: createLiveSnapshot(2),
		});
		await appendSyncHistoryEntry({
			kind: "codex-cli-sync",
			recordedAt: 3,
			run: createCodexRun(3, "/source-2"),
		});
		await appendSyncHistoryEntry({
			kind: "live-account-sync",
			recordedAt: 4,
			reason: "poll",
			outcome: "error",
			path: "/poll-2",
			snapshot: createLiveSnapshot(4),
		});

		const result = await pruneSyncHistory({ maxEntries: 1 });
		const latestOnDisk = readLatestSyncHistorySync();
		expect(latestOnDisk).toEqual(result.latest);
		const history = await readSyncHistory();
		expect(history.at(-1)).toEqual(result.latest);
		expect(history).toHaveLength(2);
	});
});
