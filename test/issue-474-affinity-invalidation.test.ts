import {
	mkdtempSync,
	promises as fs,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	runUnpinCommand,
	type UnpinCommandDeps,
} from "../lib/codex-manager/commands/unpin.js";
import {
	maybeInvalidateAffinityFromDisk,
	readStorageMetaFromDisk,
	resetPinCacheForTesting,
} from "../lib/runtime-rotation-proxy.js";
import { SessionAffinityStore } from "../lib/session-affinity.js";
import {
	type AccountStorageV3,
	normalizeAccountStorage,
} from "../lib/storage.js";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN", "ENOTEMPTY"]);
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
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

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
	const dir = mkdtempSync(join(tmpdir(), "issue-474-affinity-"));
	tmpDirs.push(dir);
	return join(dir, "openai-codex-accounts.json");
}

function writeStorageFile(path: string, storage: AccountStorageV3): void {
	writeFileSync(path, JSON.stringify(storage), "utf8");
}

beforeEach(() => {
	resetPinCacheForTesting();
});

afterEach(async () => {
	resetPinCacheForTesting();
	for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
		try {
			await removeWithRetry(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("issue #474 — affinity invalidation on user storage events", () => {
	describe("storage normalization of affinityGeneration", () => {
		it("preserves a valid integer", () => {
			const now = Date.now();
			const normalized = normalizeAccountStorage(
				createStorage(now, 2, { affinityGeneration: 7 }),
			);
			expect(normalized?.affinityGeneration).toBe(7);
		});

		it("treats undefined as undefined (logically zero in callers)", () => {
			const now = Date.now();
			const normalized = normalizeAccountStorage(createStorage(now, 2));
			expect(normalized?.affinityGeneration).toBeUndefined();
		});

		it("drops a negative affinityGeneration", () => {
			const now = Date.now();
			const normalized = normalizeAccountStorage({
				...createStorage(now, 2),
				affinityGeneration: -1,
			} as AccountStorageV3);
			expect(normalized?.affinityGeneration).toBeUndefined();
		});

		it("drops a non-integer (NaN) affinityGeneration", () => {
			const now = Date.now();
			const normalized = normalizeAccountStorage({
				...createStorage(now, 2),
				affinityGeneration: Number.NaN,
			} as AccountStorageV3);
			expect(normalized?.affinityGeneration).toBeUndefined();
		});

		it("drops a non-integer float", () => {
			const now = Date.now();
			const normalized = normalizeAccountStorage({
				...createStorage(now, 2),
				affinityGeneration: 1.5,
			} as AccountStorageV3);
			expect(normalized?.affinityGeneration).toBeUndefined();
		});
	});

	describe("SessionAffinityStore.clearAll", () => {
		it("removes every entry so subsequent lookups return null", () => {
			const store = new SessionAffinityStore({
				ttlMs: 60_000,
				maxEntries: 16,
			});
			store.remember("session-a", 0);
			store.remember("session-b", 1);
			store.remember("session-c", 2);
			expect(store.size()).toBe(3);

			store.clearAll();

			expect(store.size()).toBe(0);
			expect(store.getPreferredAccountIndex("session-a")).toBeNull();
			expect(store.getPreferredAccountIndex("session-b")).toBeNull();
			expect(store.getPreferredAccountIndex("session-c")).toBeNull();
		});

		it("is a no-op on an empty store", () => {
			const store = new SessionAffinityStore();
			expect(() => store.clearAll()).not.toThrow();
			expect(store.size()).toBe(0);
		});

		it("preserves the configured TTL after clearAll", () => {
			const store = new SessionAffinityStore({
				ttlMs: 60_000,
				maxEntries: 16,
			});
			store.remember("session-a", 0);
			store.clearAll();
			store.remember("session-a", 1);
			expect(store.getPreferredAccountIndex("session-a")).toBe(1);
		});
	});

	describe("readStorageMetaFromDisk", () => {
		it("returns affinityGeneration 0 when missing", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(path, createStorage(Date.now(), 2));
			const meta = readStorageMetaFromDisk(path);
			expect(meta.affinityGeneration).toBe(0);
			expect(meta.pinnedAccountIndex).toBeNull();
		});

		it("returns the affinityGeneration that was written", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(
				path,
				createStorage(Date.now(), 2, { affinityGeneration: 3 }),
			);
			expect(readStorageMetaFromDisk(path).affinityGeneration).toBe(3);
		});

		it("invalidates the cache when generation changes", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(
				path,
				createStorage(Date.now(), 2, { affinityGeneration: 1 }),
			);
			expect(readStorageMetaFromDisk(path).affinityGeneration).toBe(1);

			writeStorageFile(
				path,
				createStorage(Date.now(), 2, { affinityGeneration: 2 }),
			);
			expect(readStorageMetaFromDisk(path).affinityGeneration).toBe(2);
		});

		it("returns both pinnedAccountIndex and affinityGeneration in one read", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(path, {
				...createStorage(Date.now(), 3),
				pinnedAccountIndex: 1,
				affinityGeneration: 5,
			});
			const meta = readStorageMetaFromDisk(path);
			expect(meta.pinnedAccountIndex).toBe(1);
			expect(meta.affinityGeneration).toBe(5);
		});

		it("falls back to defaults on malformed JSON", () => {
			const path = makeTmpStoragePath();
			writeFileSync(path, "{not json", "utf8");
			const meta = readStorageMetaFromDisk(path);
			expect(meta.pinnedAccountIndex).toBeNull();
			expect(meta.affinityGeneration).toBe(0);
		});

		it("rejects invalid affinityGeneration values (negative)", () => {
			const path = makeTmpStoragePath();
			writeFileSync(
				path,
				JSON.stringify({
					...createStorage(Date.now(), 2),
					affinityGeneration: -3,
				}),
				"utf8",
			);
			expect(readStorageMetaFromDisk(path).affinityGeneration).toBe(0);
		});

		// L3: the hot path must short-circuit on stat (mtime+size) without
		// re-reading or re-hashing the file when nothing has changed and the
		// file has been quiescent. We prove this behaviorally: age the file's
		// mtime past the settle window, read once (caches the snapshot), then
		// rewrite with DIFFERENT bytes while forcing mtime+size back to the
		// previously-seen (aged) values. A correct short-circuit returns the
		// stale cached snapshot because it never read the new bytes.
		it("skips re-reading the file when mtime and size are unchanged and settled", () => {
			const path = makeTmpStoragePath();
			const a = JSON.stringify(
				createStorage(Date.now(), 2, { affinityGeneration: 1 }),
			);
			const b = JSON.stringify(
				createStorage(Date.now(), 2, { affinityGeneration: 2 }),
			);
			// Sanity: same byte length so size cannot betray the change. The two
			// payloads differ only in the single-digit affinityGeneration value.
			expect(Buffer.byteLength(a)).toBe(Buffer.byteLength(b));

			writeFileSync(path, a, "utf8");
			// Age the mtime well past the settle window so the short-circuit is
			// allowed to trust mtime equality on the next read.
			const aged = Date.now() / 1000 - 60;
			utimesSync(path, aged, aged);
			expect(readStorageMetaFromDisk(path).affinityGeneration).toBe(1);

			// Overwrite with different content, then pin mtime+atime back to the
			// cached (aged) value; size is already identical. Short-circuit fires.
			writeFileSync(path, b, "utf8");
			utimesSync(path, aged, aged);
			expect(readStorageMetaFromDisk(path).affinityGeneration).toBe(1);
		});

		// L3 safety: within the settle window mtime equality is NOT trusted (two
		// rapid same-size CLI bumps can share a coarse mtime tick), so the read +
		// sha1 path must still observe a content change. This guards the
		// Windows/coarse-FS collision the content hash exists to defeat.
		it("does not short-circuit on a freshly written file (settle window)", () => {
			const path = makeTmpStoragePath();
			writeStorageFile(
				path,
				createStorage(Date.now(), 2, { affinityGeneration: 1 }),
			);
			expect(readStorageMetaFromDisk(path).affinityGeneration).toBe(1);

			// Rewrite immediately. Even if the OS reports an identical mtime for
			// both writes, the file is inside the settle window so we re-read and
			// the sha1 mismatch surfaces the new generation.
			writeStorageFile(
				path,
				createStorage(Date.now(), 2, { affinityGeneration: 2 }),
			);
			expect(readStorageMetaFromDisk(path).affinityGeneration).toBe(2);
		});
	});

	describe("persistAndSyncSelectedAccount: bumpAffinityGeneration via unpin", () => {
		it("increments from undefined to 1 on first bump", async () => {
			const storage = createStorage(Date.now(), 2, { pinnedAccountIndex: 0 });
			const saveAccounts = vi.fn(async () => undefined);
			const deps: UnpinCommandDeps = {
				setStoragePath: vi.fn(),
				loadAccounts: vi.fn(async () => storage),
				saveAccounts,
				logInfo: vi.fn(),
				logError: vi.fn(),
			};

			const exit = await runUnpinCommand(deps);

			expect(exit).toBe(0);
			expect(storage.affinityGeneration).toBe(1);
			expect(saveAccounts).toHaveBeenCalledWith(storage);
		});

		it("increments from 5 to 6 when a prior value exists", async () => {
			const storage = createStorage(Date.now(), 2, {
				pinnedAccountIndex: 0,
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

	describe("maybeInvalidateAffinityFromDisk (proxy integration shape)", () => {
		it("clears affinity when the disk generation advances", () => {
			const path = makeTmpStoragePath();
			const sessionKey = "thread-abc";
			const sessionAffinityStore = new SessionAffinityStore({
				ttlMs: 60_000,
				maxEntries: 16,
			});
			sessionAffinityStore.remember(sessionKey, 2);
			expect(sessionAffinityStore.getPreferredAccountIndex(sessionKey)).toBe(2);

			writeStorageFile(
				path,
				createStorage(Date.now(), 3, { affinityGeneration: 1 }),
			);
			// Establish baseline by reading once before the simulated CLI bump.
			const baseline = readStorageMetaFromDisk(path).affinityGeneration;
			expect(baseline).toBe(1);

			// Simulate a CLI command (`switch`/`unpin`/`best`) bumping the generation.
			writeStorageFile(
				path,
				createStorage(Date.now(), 3, { affinityGeneration: 2 }),
			);

			const updated = maybeInvalidateAffinityFromDisk(
				sessionAffinityStore,
				baseline,
				path,
			);

			expect(updated).toBe(2);
			expect(sessionAffinityStore.size()).toBe(0);
			expect(
				sessionAffinityStore.getPreferredAccountIndex(sessionKey),
			).toBeNull();
		});

		it("does not clear affinity when the generation is unchanged", () => {
			const path = makeTmpStoragePath();
			const sessionAffinityStore = new SessionAffinityStore({
				ttlMs: 60_000,
				maxEntries: 16,
			});
			sessionAffinityStore.remember("thread-stable", 1);

			writeStorageFile(
				path,
				createStorage(Date.now(), 3, { affinityGeneration: 4 }),
			);
			const baseline = readStorageMetaFromDisk(path).affinityGeneration;

			const updated = maybeInvalidateAffinityFromDisk(
				sessionAffinityStore,
				baseline,
				path,
			);

			expect(updated).toBe(baseline);
			expect(
				sessionAffinityStore.getPreferredAccountIndex("thread-stable"),
			).toBe(1);
		});

		it("treats a missing storage file as generation 0 and does not throw", () => {
			const path = makeTmpStoragePath();
			const sessionAffinityStore = new SessionAffinityStore();
			expect(() =>
				maybeInvalidateAffinityFromDisk(sessionAffinityStore, 0, path),
			).not.toThrow();
		});
	});
});
