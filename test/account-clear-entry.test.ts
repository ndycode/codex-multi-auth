import { describe, expect, it, vi } from "vitest";
import { clearAccountsEntry } from "../lib/storage/account-clear-entry.js";

describe("account clear entry", () => {
	it("delegates clear through the storage lock and backup resolver", async () => {
		const clearAccountStorageArtifacts = vi.fn(async () => undefined);
		const withStorageLock = vi.fn(async (fn: () => Promise<void>) => fn());
		await clearAccountsEntry({
			path: "/tmp/accounts.json",
			withStorageLock,
			resetMarkerPath: "/tmp/accounts.reset-intent",
			walPath: "/tmp/accounts.wal",
			getBackupPaths: async () => ["/tmp/accounts.json.bak"],
			clearAccountStorageArtifacts,
			logError: vi.fn(),
		});

		expect(withStorageLock).toHaveBeenCalledOnce();
		expect(clearAccountStorageArtifacts).toHaveBeenCalledTimes(1);
		expect(clearAccountStorageArtifacts).toHaveBeenCalledWith({
			path: "/tmp/accounts.json",
			resetMarkerPath: "/tmp/accounts.reset-intent",
			walPath: "/tmp/accounts.wal",
			backupPaths: ["/tmp/accounts.json.bak"],
			logError: expect.any(Function),
		});
	});

	it("serializes concurrent clears through the shared storage lock", async () => {
		const events: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let queue = Promise.resolve();
		const withStorageLock = vi.fn(async <T>(fn: () => Promise<T>) => {
			const run = queue.then(fn);
			queue = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		});
		const clearAccountStorageArtifacts = vi.fn(
			async ({ path }: { path: string }) => {
				events.push(`start:${path}`);
				if (path === "/tmp/first.json") {
					await firstGate;
				}
				events.push(`end:${path}`);
			},
		);

		const firstCall = clearAccountsEntry({
			path: "/tmp/first.json",
			withStorageLock,
			resetMarkerPath: "/tmp/first.reset-intent",
			walPath: "/tmp/first.wal",
			getBackupPaths: async () => ["/tmp/first.json.bak"],
			clearAccountStorageArtifacts,
			logError: vi.fn(),
		});
		const secondCall = clearAccountsEntry({
			path: "/tmp/second.json",
			withStorageLock,
			resetMarkerPath: "/tmp/second.reset-intent",
			walPath: "/tmp/second.wal",
			getBackupPaths: async () => ["/tmp/second.json.bak"],
			clearAccountStorageArtifacts,
			logError: vi.fn(),
		});

		await Promise.resolve();
		await Promise.resolve();

		expect(events).toEqual(["start:/tmp/first.json"]);
		releaseFirst?.();
		await Promise.all([firstCall, secondCall]);

		expect(withStorageLock).toHaveBeenCalledTimes(2);
		expect(events).toEqual([
			"start:/tmp/first.json",
			"end:/tmp/first.json",
			"start:/tmp/second.json",
			"end:/tmp/second.json",
		]);
	});

	it("preserves windows-style paths when clearing storage artifacts", async () => {
		const windowsPath = "C:\\codex\\accounts.json";
		const resetMarkerPath = "C:\\codex\\accounts.reset-intent";
		const walPath = "C:\\codex\\accounts.wal";
		const backupPath = "C:\\codex\\accounts.json.bak";
		const withStorageLock = vi.fn(async (fn: () => Promise<void>) => fn());
		const clearAccountStorageArtifacts = vi.fn(async () => undefined);

		await clearAccountsEntry({
			path: windowsPath,
			withStorageLock,
			resetMarkerPath,
			walPath,
			getBackupPaths: async () => [backupPath],
			clearAccountStorageArtifacts,
			logError: vi.fn(),
		});

		expect(withStorageLock).toHaveBeenCalledOnce();
		expect(clearAccountStorageArtifacts).toHaveBeenCalledWith({
			path: windowsPath,
			resetMarkerPath,
			walPath,
			backupPaths: [backupPath],
			logError: expect.any(Function),
		});
	});
});
