import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { withRetry } from "../fs-retry.js";
import { tempPathFor } from "../temp-path.js";
import { withFileTransactionLock } from "./file-lock.js";

/**
 * Shared concurrency machinery for the file-backed governance JSON stores
 * (config, unified settings, budget guards, routing profiles, account
 * policies, local client tokens, quota cache).
 *
 * Three cooperating guards, extracted from lib/config.ts's save path so every
 * store gets the same semantics instead of each re-deriving a subset:
 *
 * 1. {@link withJsonStoreWriteQueue} — a per-path in-process promise queue
 *    that serializes writers inside this process (replaces each store's
 *    hand-rolled `writeQueue` module variable).
 * 2. {@link withJsonStoreFileLock} — a cross-process lock directory
 *    (`<path>.write-lock`) delegated to {@link withFileTransactionLock}: a
 *    pre-populated candidate directory is published by atomic rename, and a
 *    crashed holder's lock is recovered only when its owner PID is dead —
 *    live holders are NEVER evicted, so a takeover can never unlink a newly
 *    acquired lock (the stale-check→unlink TOCTOU that a single lockfile
 *    cannot close: POSIX has no delete-if-unchanged primitive, and renaming
 *    the file aside leaves an empty path another `wx` create can claim).
 *    The promise queue only serializes THIS process; the lock directory
 *    closes the read→check→merge→rename TOCTOU window against OTHER
 *    processes. Re-entrant within one async context so a nested write on the
 *    same path cannot deadlock itself.
 * 3. mtime compare-and-swap — {@link getJsonStoreFileMtimeMs} /
 *    {@link assertJsonStoreFileMtimeUnchanged} /
 *    {@link writeJsonStoreFileAtomicWithRetry} plus
 *    {@link withJsonStoreCasRetry}: each attempt re-stats, re-reads, and
 *    re-merges against the latest on-disk state before writing, aborting with
 *    `ESTALE` when another writer moved the file under us. This stays on as a
 *    second-line guard for writers that do not take the lockfile.
 *
 * Storage layer: this module sits below the governance stores (which live in
 * lib/ root) and below lib/config.ts; it must only depend on leaf utilities.
 */

const JSON_STORE_WRITE_RETRY_CODES = new Set(["EBUSY", "EPERM"]);
const JSON_STORE_READ_RETRY_CODES = new Set(["EBUSY", "EPERM", "EAGAIN"]);

const JSON_STORE_CAS_MAX_ATTEMPTS = 3;

/**
 * Stamp `updatedAt` for a per-key governance entry with a hybrid logical
 * floor: when the wall clock regressed below the timestamp the entry being
 * overwritten already carries, stamp `prior + 1` instead of `now`. Every
 * upsert-only store merges with `updatedAt >=`, so a backward clock jump
 * would otherwise stamp a semantically-newer write below its own
 * predecessor and the merge would silently drop it. Equal or forward wall
 * times pass through unchanged — ties already resolve to the caller's
 * write under `>=`.
 *
 * `prior` is the entry the writer saw, which can trail the freshest on-disk
 * entry when a concurrent writer lands between the caller's load and its
 * save; baseline-aware save merges re-apply this same floor against the
 * on-disk entry at merge time so the edit still cannot be lost.
 */
export function stampUpdatedAt(now: number, prior: number | undefined): number {
	return typeof prior === "number" && Number.isFinite(prior) && now < prior
		? prior + 1
		: now;
}

// ---------------------------------------------------------------------------
// 1. Per-path in-process write queue
// ---------------------------------------------------------------------------

const jsonStoreWriteQueues = new Map<string, Promise<void>>();

interface JsonStoreLease {
	active: boolean;
}

// Async-local re-entrancy map for the write queue (keyed by the raw path
// string, matching the queue key): a nested withJsonStoreWriteQueue on the
// same path inside one async context runs inside the outer critical section
// instead of deadlocking on its own queue slot — e.g. config.ts wraps
// saveUnifiedPluginConfig (which queues on settings.json) in an outer queue
// for the same path.
const jsonStoreQueueLeases = new AsyncLocalStorage<
	Map<string, JsonStoreLease>
>();

/**
 * Serialize `task` behind the previous write queued for `path`, so same-file
 * writers inside this process run one at a time in submission order. A failed
 * predecessor never blocks or fails successors. Re-entrant for the same path
 * within one async context.
 *
 * This is the per-path generalization of the module-local `writeQueue`
 * variables the governance stores used to keep by hand.
 */
export async function withJsonStoreWriteQueue<T>(
	path: string,
	task: () => Promise<T>,
): Promise<T> {
	const held = jsonStoreQueueLeases.getStore();
	if (held?.get(path)?.active) {
		return task();
	}
	const previous = jsonStoreWriteQueues.get(path) ?? Promise.resolve();
	const lease: JsonStoreLease = { active: true };
	const context = new Map(held);
	context.set(path, lease);
	const queued = previous.catch(() => {}).then(async () => {
		try {
			return await jsonStoreQueueLeases.run(context, task);
		} finally {
			lease.active = false;
		}
	});
	// Store the settled (never-rejecting) wrapper so successors chain cleanly;
	// keep the reference for the same-object check below.
	const stored: Promise<void> = queued.then(
		() => undefined,
		() => undefined,
	);
	jsonStoreWriteQueues.set(path, stored);
	try {
		return await queued;
	} finally {
		if (jsonStoreWriteQueues.get(path) === stored) {
			jsonStoreWriteQueues.delete(path);
		}
	}
}

/** Test helper: drop queued-write bookkeeping (all paths, or one when given). */
export function resetJsonStoreWriteQueuesForTests(path?: string): void {
	if (path !== undefined) {
		jsonStoreWriteQueues.delete(path);
		return;
	}
	jsonStoreWriteQueues.clear();
}

// ---------------------------------------------------------------------------
// 2. mtime compare-and-swap + atomic JSON write
// ---------------------------------------------------------------------------

/**
 * Stat `filePath` for its mtime with bounded transient-FS retry (the save
 * path is Windows-sensitive: a single transient EBUSY/EPERM/EAGAIN from an
 * AV/indexer lock must not abort the whole save). ENOENT returns `null`
 * immediately; on exhaustion the last failure surfaces so the caller treats
 * it as a real save error rather than a phantom missing file.
 */
export async function getJsonStoreFileMtimeMs(
	filePath: string,
): Promise<number | null> {
	return withRetry(
		async () => {
			try {
				return (await fs.stat(filePath)).mtimeMs;
			} catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
					return null;
				}
				throw error;
			}
		},
		{
			maxAttempts: 5,
			backoffMs: (attempt) => 10 * 2 ** (attempt - 1),
			retryableCodes: JSON_STORE_READ_RETRY_CODES,
		},
	);
}

/**
 * The `ESTALE` signal used by the CAS retry loop: the file's mtime moved
 * between the caller's stat and its write, so the attempt must re-read and
 * re-merge against the latest on-disk state instead of clobbering it.
 */
export function createJsonStoreStaleError(
	filePath: string,
): NodeJS.ErrnoException {
	const staleError = new Error(
		`JSON store at ${filePath} changed on disk during save; retrying with latest state.`,
	) as NodeJS.ErrnoException;
	staleError.code = "ESTALE";
	return staleError;
}

/**
 * Throw `ESTALE` when `filePath`'s current mtime differs from
 * `expectedMtimeMs` (`null` means "file must still be absent"). Writers that
 * keep their own temp+rename flow call this just before the rename, matching
 * {@link writeJsonStoreFileAtomicWithRetry}'s inline check.
 */
export async function assertJsonStoreFileMtimeUnchanged(
	filePath: string,
	expectedMtimeMs: number | null,
): Promise<void> {
	const currentMtimeMs = await getJsonStoreFileMtimeMs(filePath);
	if (currentMtimeMs !== expectedMtimeMs) {
		throw createJsonStoreStaleError(filePath);
	}
}

export interface JsonStoreAtomicWriteOptions {
	/**
	 * When present (including explicit `null` = "expect the file to be
	 * absent"), compare-and-swap guard: abort with `ESTALE` if the target's
	 * mtime moved since the caller read it, so the caller can re-read and
	 * merge instead of clobbering a concurrent write. Omit the key entirely
	 * to skip the check.
	 */
	expectedMtimeMs?: number | null;
	/** Temp file mode (and therefore the final file's mode when created). */
	mode?: number;
	/** fsync the temp file before rename so a crash/power-loss cannot leave a truncated store. */
	fsync?: boolean;
	/** Rename retry codes; defaults to EBUSY/EPERM. */
	retryableCodes?: ReadonlySet<string>;
}

/**
 * Atomic JSON write: serialize `payload` pretty-printed with a trailing
 * newline to a crypto-random sibling temp file, then rename it over
 * `filePath` with bounded transient-FS retry. Optionally CAS-checks the
 * target mtime first and fsyncs the temp file; on failure the temp is
 * removed best-effort.
 */
export async function writeJsonStoreFileAtomicWithRetry(
	filePath: string,
	payload: unknown,
	options?: JsonStoreAtomicWriteOptions,
): Promise<void> {
	const tempPath = tempPathFor(filePath);
	await fs.mkdir(dirname(filePath), { recursive: true });
	const handle = await fs.open(tempPath, "w", options?.mode);
	try {
		await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
		if (options?.fsync) {
			await handle.sync();
		}
	} finally {
		await handle.close();
	}
	let renamed = false;
	try {
		if (options && "expectedMtimeMs" in options) {
			await assertJsonStoreFileMtimeUnchanged(
				filePath,
				options.expectedMtimeMs ?? null,
			);
		}
		await withRetry(() => fs.rename(tempPath, filePath), {
			maxAttempts: 5,
			backoffMs: (attempt) => 10 * 2 ** (attempt - 1),
			retryableCodes: options?.retryableCodes ?? JSON_STORE_WRITE_RETRY_CODES,
		});
		renamed = true;
	} finally {
		if (!renamed) {
			try {
				await fs.unlink(tempPath);
			} catch {
				// Best-effort temp cleanup.
			}
		}
	}
}

/**
 * Run `task`, retrying `ESTALE` CAS aborts so each attempt can re-read and
 * re-merge against the latest on-disk state (matches the config save loop:
 * 3 attempts, immediate retry, ESTALE-only).
 */
export async function withJsonStoreCasRetry<T>(
	task: () => Promise<T>,
): Promise<T> {
	return withRetry(task, {
		maxAttempts: JSON_STORE_CAS_MAX_ATTEMPTS,
		backoffMs: 0,
		retryableCodes: ["ESTALE"],
	});
}

// ---------------------------------------------------------------------------
// 3. Cross-process lockfile
// ---------------------------------------------------------------------------

const JSON_STORE_LOCK_WAIT_TIMEOUT_MS = 10_000;

export interface JsonStoreFileLockOptions {
	/**
	 * How long to wait for a lock held by a LIVE foreign process before
	 * failing with `ELOCKTIMEOUT` (default 10s). A crashed holder's lock is
	 * reclaimed as soon as its dead PID is observed; a live holder is never
	 * evicted — including a reused PID, which fails closed here rather than
	 * risking two writers in the critical section.
	 */
	waitTimeoutMs?: number;
}

/**
 * Cross-process mutex for a JSON store file, delegated to the proven
 * candidate-directory transaction lock in lib/storage/file-lock.ts: each
 * acquirer stages `<path>.write-lock.candidate-*` containing its unique
 * `<host>.<pid>.<uuid>` owner file, then publishes it with a single atomic
 * `rename` (which only succeeds while the lock directory is absent or empty,
 * so there is no ownerless acquisition window). A crashed holder's lock is
 * recovered by unlinking exactly that dead owner's unique filename and
 * removing the directory only while it is still empty — an `rmdir` can never
 * erase a lock that was republished in the meantime, so takeover can never
 * delete another owner's live lock. Waiters on a live holder retry inside
 * `waitTimeoutMs` (default 10s), then this wrapper surfaces the exhaustion
 * as `ELOCKTIMEOUT`. Re-entrant for the same resolved path within one async
 * context.
 */
export async function withJsonStoreFileLock<T>(
	targetPath: string,
	task: () => Promise<T>,
	options?: JsonStoreFileLockOptions,
): Promise<T> {
	try {
		return await withFileTransactionLock(targetPath, task, {
			waitMs: options?.waitTimeoutMs ?? JSON_STORE_LOCK_WAIT_TIMEOUT_MS,
		});
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException | undefined)?.code === "ELOCKED"
		) {
			const timeoutError = new Error(
				`Timed out acquiring JSON store lock at ${targetPath}.`,
			) as NodeJS.ErrnoException;
			timeoutError.code = "ELOCKTIMEOUT";
			throw timeoutError;
		}
		throw error;
	}
}
