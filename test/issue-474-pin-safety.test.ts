import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import {
	readPinnedAccountIndexFromDisk,
	readStorageMetaFromDisk,
	resetPinCacheForTesting,
} from "../lib/runtime-rotation-proxy.js";
import {
	runUnpinCommand,
	type UnpinCommandDeps,
} from "../lib/codex-manager/commands/unpin.js";
import { runStatusCommand } from "../lib/codex-manager/commands/status.js";
import {
	setStoragePathDirect,
	type AccountStorageV3,
} from "../lib/storage.js";

function createStorage(
	now: number,
	count = 3,
	overrides: Partial<AccountStorageV3> = {},
): AccountStorageV3 {
	const storage: AccountStorageV3 = {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: Array.from({ length: count }, (_, index) => ({
			email: `account-${index + 1}@example.com`,
			accountId: `acc_${index + 1}`,
			refreshToken: `refresh-${index + 1}`,
			accessToken: `access-${index + 1}`,
			expiresAt: now + 3_600_000,
			addedAt: now - 60_000,
			lastUsed: now - (count - index) * 60_000,
			enabled: true,
		})),
		...overrides,
	};
	return storage;
}

const tmpDirs: string[] = [];

function makeTmpStoragePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "issue-474-safety-"));
	tmpDirs.push(dir);
	return join(dir, "openai-codex-accounts.json");
}

function writeStorageFile(path: string, storage: AccountStorageV3): void {
	writeFileSync(path, JSON.stringify(storage), "utf8");
}

beforeEach(() => {
	resetPinCacheForTesting();
});

afterEach(() => {
	resetPinCacheForTesting();
	vi.restoreAllMocks();
	for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("issue #474 — pin-honored review feedback", () => {
	describe("unpin saveAccountsWithRetry wrapper", () => {
		it("retries the save on a transient EBUSY and clears the pin", async () => {
			const storage = createStorage(Date.now(), 2, { pinnedAccountIndex: 1 });
			let calls = 0;
			const saveAccounts = vi.fn(async () => {
				calls += 1;
				if (calls === 1) {
					const error = Object.assign(new Error("EBUSY: locked"), {
						code: "EBUSY",
					});
					throw error;
				}
			});
			const deps: UnpinCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storage),
				saveAccounts,
				logInfo: vi.fn(),
				logError: vi.fn(),
			};

			const exit = await runUnpinCommand(deps);

			expect(exit).toBe(0);
			expect(storage.pinnedAccountIndex).toBeUndefined();
			expect(saveAccounts).toHaveBeenCalledTimes(2);
		});
	});

	describe("STORAGE_META_CACHE per-path isolation", () => {
		it("does not share a snapshot across distinct storage paths", () => {
			const pathA = makeTmpStoragePath();
			const pathB = makeTmpStoragePath();
			writeStorageFile(pathA, createStorage(Date.now(), 3, { pinnedAccountIndex: 0 }));
			writeStorageFile(pathB, createStorage(Date.now(), 3, { pinnedAccountIndex: 1 }));

			expect(readPinnedAccountIndexFromDisk(pathA)).toBe(0);
			expect(readPinnedAccountIndexFromDisk(pathB)).toBe(1);
			// Re-read to confirm both paths still resolve to their own values
			// (no cross-contamination from the most-recent read).
			expect(readPinnedAccountIndexFromDisk(pathA)).toBe(0);
			expect(readPinnedAccountIndexFromDisk(pathB)).toBe(1);
		});

		it("invalidates only the affected path when its content changes", () => {
			const pathA = makeTmpStoragePath();
			const pathB = makeTmpStoragePath();
			writeStorageFile(pathA, createStorage(Date.now(), 2, { pinnedAccountIndex: 0 }));
			writeStorageFile(pathB, createStorage(Date.now(), 2, { pinnedAccountIndex: 1 }));

			expect(readPinnedAccountIndexFromDisk(pathA)).toBe(0);
			expect(readPinnedAccountIndexFromDisk(pathB)).toBe(1);

			// Mutate only path A; path B should still serve its cached value.
			writeStorageFile(
				pathA,
				createStorage(Date.now(), 2, { pinnedAccountIndex: 1 }),
			);
			expect(readPinnedAccountIndexFromDisk(pathA)).toBe(1);
			expect(readPinnedAccountIndexFromDisk(pathB)).toBe(1);
		});
	});

	describe("readStorageMetaFromDisk transient FS error handling", () => {
		it("returns the cached snapshot on a partial-write parse error", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(
				path,
				createStorage(Date.now(), 3, {
					pinnedAccountIndex: 2,
					affinityGeneration: 4,
				}),
			);

			// Prime the cache with the current on-disk content.
			expect(readStorageMetaFromDisk(path).pinnedAccountIndex).toBe(2);

			// Simulate reading mid atomic-rename: file exists but content is a
			// half-written truncated payload that JSON.parse rejects. The proxy's
			// transient-error path treats SyntaxError the same as EBUSY/EPERM and
			// must keep serving the previously-cached value rather than blowing
			// away affinity. See P0-3 in the review.
			writeFileSync(path, "{\"pinnedAccountIndex\":2,\"af", "utf8");
			const meta = readStorageMetaFromDisk(path);
			expect(meta.pinnedAccountIndex).toBe(2);
			expect(meta.affinityGeneration).toBe(4);
		});

		it("returns defaults on a partial-write parse error when no cache exists", () => {
			const path = makeTmpStoragePath();
			// File exists but content is malformed and there is no prior cache
			// entry for this path (resetPinCacheForTesting in beforeEach).
			writeFileSync(path, "{not json", "utf8");
			const meta = readStorageMetaFromDisk(path);
			expect(meta.pinnedAccountIndex).toBeNull();
			expect(meta.affinityGeneration).toBe(0);
		});
	});

	describe("status command bounds-check on pin index", () => {
		it("reports an out-of-range pin and points the user at unpin", async () => {
			const storage = createStorage(Date.now(), 2);
			storage.pinnedAccountIndex = 99;
			const logInfo = vi.fn();
			const exit = await runStatusCommand({
				setStoragePath: vi.fn(),
				getStoragePath: vi.fn(() => "/tmp/accounts.json"),
				loadAccounts: vi.fn(async () => storage),
				resolveActiveIndex: vi.fn(() => 0),
				formatRateLimitEntry: vi.fn(() => null),
				logInfo,
			});

			expect(exit).toBe(0);
			expect(
				logInfo.mock.calls.some(([msg]) =>
					String(msg).includes("invalid account index 100"),
				),
			).toBe(true);
			expect(
				logInfo.mock.calls.some(([msg]) =>
					/Pinned: account 100 \(set by switch\)/.test(String(msg)),
				),
			).toBe(false);
		});

		it("reports an out-of-range pin when the index is negative", async () => {
			const storage = createStorage(Date.now(), 2);
			storage.pinnedAccountIndex = -1;
			const logInfo = vi.fn();
			await runStatusCommand({
				setStoragePath: vi.fn(),
				getStoragePath: vi.fn(() => "/tmp/accounts.json"),
				loadAccounts: vi.fn(async () => storage),
				resolveActiveIndex: vi.fn(() => 0),
				formatRateLimitEntry: vi.fn(() => null),
				logInfo,
			});
			expect(
				logInfo.mock.calls.some(([msg]) =>
					String(msg).includes("invalid account index"),
				),
			).toBe(true);
		});
	});

	describe("readAffinityGenerationFromDisk monotonic bumping", () => {
		it("two concurrent unpin processes bumping the same file converge to >= initial+2", async () => {
			// Simulates two CLI processes both reading a stale in-memory
			// snapshot (gen=5) and concurrently issuing unpin against the same
			// on-disk file. With the lost-update fix the final disk value must
			// be at least 7 (5 + 2 increments). Without it, both writers would
			// land on 6.
			const path = makeTmpStoragePath();
			writeStorageFile(
				path,
				createStorage(Date.now(), 2, {
					pinnedAccountIndex: 0,
					affinityGeneration: 5,
				}),
			);

			// Each process gets its own in-memory storage snapshot starting at
			// gen=5 — modelling a real load() before the other process bumped.
			const storageA = createStorage(Date.now(), 2, {
				pinnedAccountIndex: 0,
				affinityGeneration: 5,
			});
			const storageB = createStorage(Date.now(), 2, {
				pinnedAccountIndex: 0,
				affinityGeneration: 5,
			});

			// Real save: write the file synchronously so each subsequent
			// readAffinityGenerationFromDisk call observes prior writers.
			const realSave = async (s: AccountStorageV3) => {
				writeFileSync(path, JSON.stringify(s), "utf8");
			};

			const depsA: UnpinCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storageA),
				saveAccounts: realSave,
				getStoragePath: () => path,
				logInfo: vi.fn(),
				logError: vi.fn(),
			};
			const depsB: UnpinCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storageB),
				saveAccounts: realSave,
				getStoragePath: () => path,
				logInfo: vi.fn(),
				logError: vi.fn(),
			};

			await Promise.all([runUnpinCommand(depsA), runUnpinCommand(depsB)]);

			const finalContent = JSON.parse(readFileSync(path, "utf8")) as {
				affinityGeneration?: number;
			};
			expect(finalContent.affinityGeneration).toBeGreaterThanOrEqual(7);
		});
	});

	describe("unpin atomic affinityGeneration via getStoragePath", () => {
		it("uses Math.max(inMemory, disk) + 1 when the disk value is ahead", async () => {
			const path = makeTmpStoragePath();
			// On-disk state is ahead of the in-memory snapshot the caller loaded —
			// e.g. another CLI process bumped the generation between load and save.
			writeStorageFile(
				path,
				createStorage(Date.now(), 2, {
					pinnedAccountIndex: 0,
					affinityGeneration: 9,
				}),
			);
			const storage = createStorage(Date.now(), 2, {
				pinnedAccountIndex: 0,
				affinityGeneration: 5,
			});
			const saveAccounts = vi.fn(async () => undefined);
			const deps: UnpinCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storage),
				saveAccounts,
				getStoragePath: () => path,
				logInfo: vi.fn(),
				logError: vi.fn(),
			};

			const exit = await runUnpinCommand(deps);
			expect(exit).toBe(0);
			// Math.max(5, 9) + 1 = 10
			expect(storage.affinityGeneration).toBe(10);
			expect(saveAccounts).toHaveBeenCalledTimes(1);
		});

		it("falls back to in-memory + 1 when getStoragePath is not provided", async () => {
			const storage = createStorage(Date.now(), 2, {
				pinnedAccountIndex: 1,
				affinityGeneration: 5,
			});
			const deps: UnpinCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storage),
				saveAccounts: vi.fn(async () => undefined),
				logInfo: vi.fn(),
				logError: vi.fn(),
			};
			await runUnpinCommand(deps);
			expect(storage.affinityGeneration).toBe(6);
		});
	});

	describe("AccountManager.buildStorageSnapshot preserves pin/gen", () => {
		afterEach(() => {
			setStoragePathDirect(null);
		});

		it("round-trips pinnedAccountIndex and affinityGeneration through saveToDisk", async () => {
			const path = makeTmpStoragePath();
			const storage = createStorage(Date.now(), 3, {
				pinnedAccountIndex: 0,
				affinityGeneration: 5,
			});
			writeStorageFile(path, storage);
			setStoragePathDirect(path);

			const manager = new AccountManager(undefined, storage);
			await manager.saveToDisk();

			const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
				pinnedAccountIndex?: unknown;
				affinityGeneration?: unknown;
			};
			expect(onDisk.pinnedAccountIndex).toBe(0);
			expect(onDisk.affinityGeneration).toBe(5);
		});

		it("preserves a CLI-bumped affinityGeneration that lands between load and save", async () => {
			const path = makeTmpStoragePath();
			const initial = createStorage(Date.now(), 3, {
				pinnedAccountIndex: 0,
				affinityGeneration: 5,
			});
			writeStorageFile(path, initial);
			setStoragePathDirect(path);

			// AccountManager loads gen=5, pin=0.
			const manager = new AccountManager(undefined, initial);

			// Simulate the CLI (different process) bumping gen and changing the
			// pin between proxy startup and a routine save.
			writeStorageFile(
				path,
				createStorage(Date.now(), 3, {
					pinnedAccountIndex: 2,
					affinityGeneration: 8,
				}),
			);

			// Routine save (e.g. rate-limit hit). With the race-protected snapshot
			// the on-disk gen/pin must NOT be clobbered.
			await manager.saveToDisk();

			const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
				pinnedAccountIndex?: unknown;
				affinityGeneration?: unknown;
			};
			expect(onDisk.affinityGeneration).toBeGreaterThanOrEqual(8);
			expect(onDisk.pinnedAccountIndex).toBe(2);
		});

		it("omits pinnedAccountIndex when storage has no pin", async () => {
			const path = makeTmpStoragePath();
			const storage = createStorage(Date.now(), 2);
			writeStorageFile(path, storage);
			setStoragePathDirect(path);

			const manager = new AccountManager(undefined, storage);
			await manager.saveToDisk();

			const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<
				string,
				unknown
			>;
			expect(onDisk.pinnedAccountIndex).toBeUndefined();
		});
	});

	describe("readStorageMetaFromDisk first-read EBUSY", () => {
		it("returns defaults when no cache exists and the file read throws", () => {
			// Use a path that exists but throw on read by pointing at a directory
			// path (readFileSync raises EISDIR/EPERM on Windows).
			const dir = mkdtempSync(join(tmpdir(), "issue-474-ebusy-"));
			tmpDirs.push(dir);
			// Reading a directory as a file → ENOENT/EISDIR depending on the OS;
			// either way the catch path runs with no cached snapshot for this
			// path, and we must return safe defaults rather than crash.
			const meta = readStorageMetaFromDisk(dir);
			expect(meta.pinnedAccountIndex).toBeNull();
			expect(meta.affinityGeneration).toBe(0);
		});
	});
});
