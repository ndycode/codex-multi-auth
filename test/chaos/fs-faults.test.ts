import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inspectStorageHealth,
	loadAccounts,
	saveAccounts,
	setStoragePathDirect,
	StorageError,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../../lib/storage.js";
import { withRetry } from "../../lib/fs-retry.js";

/**
 * REAL filesystem fault injection against the storage save seam.
 *
 * test/chaos/fault-injection.test.ts only exercises circuit-breaker state
 * machines; this file injects errno faults into the actual fs.promises calls
 * lib/storage.ts makes while persisting account storage, then asserts the
 * retry policy from lib/fs-retry.ts, typed StorageError propagation, and the
 * absence of corruption or *.tmp/.write-lock litter afterwards.
 *
 * Retry contract under test (lib/fs-retry.ts FILE_RETRY_CODES):
 *   retryable: EBUSY, EPERM, EAGAIN, ENOTEMPTY, EACCES  (6 attempts, shared wrapper)
 *   NOT retryable: ENOSPC, EMFILE                      (typed failure, first attempt)
 * Rename temp->primary uses a dedicated policy: EPERM/EBUSY, 5 attempts.
 */

const dirs: string[] = [];

afterEach(async () => {
	// Restore fs.promises spies BEFORE any cleanup work — a leftover fault with
	// failCount: Infinity would otherwise poison the next test's fixture save
	// (the global-sandbox afterEach does this too, but file-local hooks run
	// first, so restoring here also keeps the rm() below unmocked).
	vi.restoreAllMocks();
	setStoragePathDirect(null);
	for (const dir of dirs.splice(0)) {
		await withRetry(() => rm(dir, { recursive: true, force: true }), {
			maxAttempts: 6,
			backoffMs: 25,
		});
	}
});

function account(index: number, overrides: Partial<AccountMetadataV3> = {}): AccountMetadataV3 {
	return {
		recordId: `rec-live-${index}`,
		accountId: `acct-live-${index}`,
		email: `user${index}@corp.example`,
		refreshToken: `rt-live-${index}-${createHash("sha256").update(String(index)).digest("hex").slice(0, 12)}`,
		accessToken: `at-live-${index}`,
		expiresAt: Date.now() + 3_600_000,
		addedAt: 1_700_000_000_000 + index,
		lastUsed: 1_700_000_100_000 + index,
		...overrides,
	};
}

function store(accounts: AccountMetadataV3[]): AccountStorageV3 {
	return { version: 3, activeIndex: 0, activeIndexByFamily: { codex: 0 }, accounts };
}

function recordIds(storage: AccountStorageV3 | null): string[] {
	return (storage?.accounts ?? [])
		.map((row) => row.recordId ?? "")
		.sort();
}

/** Filenames that must never be left behind by a save, success or failure. */
async function storageLitter(dir: string): Promise<string[]> {
	return (await readdir(dir)).filter(
		(name) =>
			name.endsWith(".tmp") ||
			name.includes("write-lock") ||
			name.includes(".rotate."),
	);
}

interface InjectedFault {
	/** errno code thrown when the operation is intercepted. */
	code: string;
	/** How many matching calls to fail; Infinity fails every call. */
	failCount: number;
	/** Write this many bytes of real payload before failing (partial-write fault). */
	partialBytes?: number;
}

/**
 * Intercept fs.promises.writeFile for paths matched by `match`. Returns a call
 * counter so tests can assert the exact number of attempts the retry policy
 * made. Unmatched calls and calls past failCount pass straight through to the
 * real implementation.
 */
function injectWriteFileFault(
	match: (path: string) => boolean,
	fault: InjectedFault,
): () => number {
	const original = fs.writeFile.bind(fs);
	let calls = 0;
	vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		const [file, data, options] = args;
		const target = String(file);
		if (!match(target)) {
			return original(file, data, options);
		}
		calls += 1;
		if (calls > fault.failCount) {
			return original(file, data, options);
		}
		if (fault.partialBytes !== undefined && fault.partialBytes > 0) {
			const partial =
				typeof data === "string"
					? data.slice(0, fault.partialBytes)
					: Buffer.from(data as Uint8Array).subarray(0, fault.partialBytes);
			await original(file, partial, options);
		}
		throw Object.assign(new Error(`injected ${fault.code}`), {
			code: fault.code,
		});
	});
	return () => calls;
}

/**
 * Intercept fs.promises.rename for (source, destination) pairs matched by
 * `match`. Same counting contract as injectWriteFileFault.
 */
function injectRenameFault(
	match: (source: string, destination: string) => boolean,
	fault: InjectedFault,
): () => number {
	const original = fs.rename.bind(fs);
	let calls = 0;
	vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
		const [source, destination] = args;
		if (!match(String(source), String(destination))) {
			return original(source, destination);
		}
		calls += 1;
		if (calls > fault.failCount) {
			return original(source, destination);
		}
		throw Object.assign(new Error(`injected ${fault.code}`), {
			code: fault.code,
		});
	});
	return () => calls;
}

async function fixture(): Promise<{ dir: string; storagePath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "cma-fs-faults-"));
	dirs.push(dir);
	const storagePath = join(dir, "openai-codex-accounts.json");
	setStoragePathDirect(storagePath);
	return { dir, storagePath };
}

async function readWal(storagePath: string): Promise<{
	version: number;
	checksum: string;
	content: string;
} | null> {
	try {
		return JSON.parse(await readFile(`${storagePath}.wal`, "utf8")) as {
			version: number;
			checksum: string;
			content: string;
		};
	} catch {
		return null;
	}
}

describe("storage fs fault injection", () => {
	it("ENOSPC mid temp-write fails typed, keeps the committed store, and removes the torn temp", async () => {
		const { dir, storagePath } = await fixture();
		const seed = store([account(0)]);
		await saveAccounts(seed);

		const next = store([account(0), account(1)]);
		// Partial write then ENOSPC: the torn temp file must be cleaned up, and
		// ENOSPC is outside FILE_RETRY_CODES so exactly one attempt is expected.
		const calls = injectWriteFileFault(
			(path) => path.endsWith(".tmp"),
			{ code: "ENOSPC", failCount: Number.POSITIVE_INFINITY, partialBytes: 96 },
		);

		const failure = await saveAccounts(next).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(StorageError);
		expect((failure as StorageError).code).toBe("ENOSPC");
		expect(calls()).toBe(1);

		// The committed primary still parses to the pre-fault store.
		const committed = JSON.parse(await readFile(storagePath, "utf8")) as AccountStorageV3;
		expect(recordIds(committed)).toEqual(recordIds(seed));
		expect((await inspectStorageHealth()).state).toBe("healthy");

		// No torn temp / staged backup / lock artifacts remain.
		expect(await storageLitter(dir)).toEqual([]);

		// The write-ahead journal survived: it records the attempted payload with
		// a valid checksum, which is exactly what makes the crash recoverable.
		const wal = await readWal(storagePath);
		expect(wal).not.toBeNull();
		expect(createHash("sha256").update(wal!.content).digest("hex")).toBe(
			wal!.checksum,
		);
		expect(recordIds(JSON.parse(wal!.content) as AccountStorageV3)).toEqual(
			recordIds(next),
		);

		// loadAccounts must return a valid store, not throw or corrupt.
		expect(recordIds(await loadAccounts())).toEqual(recordIds(seed));
	});

	it.each(["EBUSY", "EPERM"])(
		"transient %s on the temp write retries under the shared fs policy",
		async (code) => {
			const { dir, storagePath } = await fixture();
			await saveAccounts(store([account(0)]));

			const next = store([account(0), account(2)]);
			const calls = injectWriteFileFault(
				(path) => path.endsWith(".tmp"),
				{ code, failCount: 1 },
			);

			await expect(saveAccounts(next)).resolves.toBeUndefined();
			expect(calls()).toBe(2); // one faulted attempt + one successful retry
			expect(recordIds(await loadAccounts())).toEqual(recordIds(next));
			expect((await inspectStorageHealth()).state).toBe("healthy");
			expect(await storageLitter(dir)).toEqual([]);
		},
	);

	it("persistent EACCES on the temp write exhausts the shared retry budget, then fails typed", async () => {
		const { dir, storagePath } = await fixture();
		const seed = store([account(0)]);
		await saveAccounts(seed);

		// EACCES IS in FILE_RETRY_CODES: withFileOperationRetry must burn all
		// six attempts before surfacing the typed error.
		const calls = injectWriteFileFault(
			(path) => path.endsWith(".tmp"),
			{ code: "EACCES", failCount: Number.POSITIVE_INFINITY },
		);
		const failure = await saveAccounts(store([account(0), account(3)])).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(StorageError);
		expect((failure as StorageError).code).toBe("EACCES");
		expect(calls()).toBe(6);

		expect(recordIds(await loadAccounts())).toEqual(recordIds(seed));
		expect((await inspectStorageHealth()).state).toBe("healthy");
		expect(await storageLitter(dir)).toEqual([]);
	});

	it("EMFILE is not in the shared retry set and fails on the first attempt", async () => {
		const { dir, storagePath } = await fixture();
		const seed = store([account(0)]);
		await saveAccounts(seed);

		const calls = injectWriteFileFault(
			(path) => path.endsWith(".tmp"),
			{ code: "EMFILE", failCount: Number.POSITIVE_INFINITY },
		);
		const failure = await saveAccounts(store([account(0), account(4)])).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(StorageError);
		expect((failure as StorageError).code).toBe("EMFILE");
		expect(calls()).toBe(1);

		expect(recordIds(await loadAccounts())).toEqual(recordIds(seed));
		expect(await storageLitter(dir)).toEqual([]);
	});

	it.each(["EBUSY", "EPERM"])(
		"transient %s on the WAL journal write retries before the temp write",
		async (code) => {
			const { dir, storagePath } = await fixture();
			await saveAccounts(store([account(0)]));

			const next = store([account(0), account(5)]);
			const calls = injectWriteFileFault(
				(path) => path.endsWith(".wal"),
				{ code, failCount: 1 },
			);
			await expect(saveAccounts(next)).resolves.toBeUndefined();
			expect(calls()).toBe(2);
			expect(recordIds(await loadAccounts())).toEqual(recordIds(next));
			// Successful saves remove the journal.
			expect(await readWal(storagePath)).toBeNull();
			expect(await storageLitter(dir)).toEqual([]);
		},
	);

	it("transient EPERM on the atomic commit rename retries on the dedicated rename policy", async () => {
		const { dir, storagePath } = await fixture();
		await saveAccounts(store([account(0)]));

		const next = store([account(0), account(6)]);
		const calls = injectRenameFault(
			(source, destination) =>
				source.endsWith(".tmp") && destination === storagePath,
			{ code: "EPERM", failCount: 1 },
		);
		await expect(saveAccounts(next)).resolves.toBeUndefined();
		expect(calls()).toBe(2);
		expect(recordIds(await loadAccounts())).toEqual(recordIds(next));
		expect(await storageLitter(dir)).toEqual([]);
	});

	it("persistent EBUSY on the commit rename exhausts its 5-attempt budget and leaves the primary intact", async () => {
		const { dir, storagePath } = await fixture();
		const seed = store([account(0)]);
		await saveAccounts(seed);

		const calls = injectRenameFault(
			(source, destination) =>
				source.endsWith(".tmp") && destination === storagePath,
			{ code: "EBUSY", failCount: Number.POSITIVE_INFINITY },
		);
		const failure = await saveAccounts(store([account(0), account(7)])).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(StorageError);
		expect((failure as StorageError).code).toBe("EBUSY");
		expect(calls()).toBe(5);

		const committed = JSON.parse(await readFile(storagePath, "utf8")) as AccountStorageV3;
		expect(recordIds(committed)).toEqual(recordIds(seed));
		// The fully-written temp file (it was never renamed) must be cleaned up.
		expect(await storageLitter(dir)).toEqual([]);
	});

	it("a tracked save that fails mid-write still merges against disk once the fault clears", async () => {
		const { dir, storagePath } = await fixture();
		const seed = store([account(0)]);
		await saveAccounts(seed);

		// loadAccounts() registers the optimistic-concurrency baseline on the
		// returned object; mutating it and saving exercises the merge path.
		const working = await loadAccounts();
		expect(working).not.toBeNull();
		working!.accounts.push(account(8));

		const calls = injectWriteFileFault(
			(path) => path.endsWith(".tmp"),
			{ code: "ENOSPC", failCount: Number.POSITIVE_INFINITY },
		);
		const failure = await saveAccounts(working!).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(StorageError);
		expect((failure as StorageError).code).toBe("ENOSPC");
		expect(calls()).toBe(1);
		expect(recordIds(await loadAccounts())).toEqual(recordIds(seed));

		// After the fault clears, the same tracked object merges cleanly.
		vi.restoreAllMocks();
		await expect(saveAccounts(working!)).resolves.toBeUndefined();
		expect(recordIds(await loadAccounts())).toEqual([
			...recordIds(seed),
			"rec-live-8",
		].sort());
		expect(await storageLitter(dir)).toEqual([]);
	});
});
