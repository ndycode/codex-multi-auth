import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildSync } from "esbuild";
import {
	inspectStorageHealth,
	loadAccounts,
	setStoragePathDirect,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../lib/storage.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";
import { withRetry } from "../lib/fs-retry.js";

/**
 * Crash injection: a real child process runs the REAL saveAccounts() pipeline
 * (bundled from lib/storage.ts — never a hand-rolled fake) while the parent
 * SIGKILLs it at an exact write-pipeline boundary reported over IPC:
 *
 *   lock-acquired -> wal-done -> temp-done -> rename-start -> committed -> saved
 *
 * The child gates on an IPC "proceed" at every boundary, so the kill always
 * lands inside the same window — no timing races. The parent then asserts the
 * recovery contract from lib/storage.ts:
 *   - a valid primary wins over a stranded WAL (uncommitted intent is ignored)
 *   - a torn primary + valid WAL restores the journaled store ("recoverable"/wal)
 *   - a torn primary + no WAL restores through .bak ("corrupt" -> recovered)
 *   - the killed writer's .write-lock is reclaimed by dead-owner recovery
 */

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	setStoragePathDirect(null);
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	}
	for (const dir of dirs.splice(0)) {
		await withRetry(() => rm(dir, { recursive: true, force: true }), {
			maxAttempts: 6,
			backoffMs: 25,
		});
	}
});

function account(index: number, tag = "live"): AccountMetadataV3 {
	return {
		recordId: `rec-${tag}-${index}`,
		accountId: `acct-${tag}-${index}`,
		email: `writer${index}@corp.example`,
		refreshToken: `rt-${tag}-${index}-${index.toString(16).padStart(8, "0")}`,
		accessToken: `at-${tag}-${index}`,
		expiresAt: Date.now() + 3_600_000,
		addedAt: 1_700_000_000_000 + index,
		lastUsed: 1_700_000_100_000 + index,
	};
}

function storeOf(accounts: AccountMetadataV3[]): AccountStorageV3 {
	return { version: 3, activeIndex: 0, accounts };
}

function recordIds(storage: AccountStorageV3 | null): string[] {
	return (storage?.accounts ?? [])
		.map((row) => row.recordId ?? "")
		.sort();
}

const WORKER_SOURCE = `
import { promises as fs } from "node:fs";
import { setStoragePathDirect, saveAccounts } from "./storage.mjs";

const [storagePath, storeFile] = process.argv.slice(2);
setStoragePathDirect(storagePath);

const send = (message) => new Promise((resolve) => process.send(message, resolve));
const gate = () => new Promise((resolve) => process.once("message", resolve));
const phase = async (name) => { await send("phase:" + name); await gate(); };

const realWrite = fs.writeFile.bind(fs);
fs.writeFile = async (file, data, options) => {
	const target = String(file);
	const isWal = target === storagePath + ".wal";
	const isTemp = target.startsWith(storagePath + ".")
		&& target.endsWith(".tmp")
		&& !target.includes(".rotate.");
	const result = await realWrite(file, data, options);
	if (isWal) await phase("wal-done");
	else if (isTemp) await phase("temp-done");
	return result;
};
const realRename = fs.rename.bind(fs);
fs.rename = async (source, destination) => {
	const src = String(source), dest = String(destination);
	if (dest.endsWith(".write-lock")) {
		const result = await realRename(source, destination);
		await phase("lock-acquired");
		return result;
	}
	if (src.endsWith(".tmp") && !src.includes(".rotate.") && dest === storagePath) {
		await phase("rename-start");
		const result = await realRename(source, destination);
		await phase("committed");
		return result;
	}
	return realRename(source, destination);
};

await send("ready");
await gate();
await saveAccounts(JSON.parse(await fs.readFile(storeFile, "utf8")));
await send("saved");
process.disconnect();
`;

interface Fixture {
	dir: string;
	storagePath: string;
	workerPath: string;
	seed: AccountStorageV3;
	next: AccountStorageV3;
	nextStoreFile: string;
}

async function fixture(): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "cma-crash-write-"));
	dirs.push(dir);
	await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	// Bundle the REAL storage module for the child process; the test never
	// touches dist/ and never fakes the write pipeline.
	buildSync({
		entryPoints: ["lib/storage.ts"],
		bundle: true,
		format: "esm",
		platform: "node",
		outfile: join(dir, "storage.mjs"),
		logLevel: "silent",
	});
	const workerPath = join(dir, "worker.mjs");
	await writeFile(workerPath, WORKER_SOURCE);
	const storagePath = join(dir, "openai-codex-accounts.json");
	const seed = storeOf([account(0, "seed")]);
	await writeFile(storagePath, JSON.stringify(seed, null, 2));
	const next = storeOf([account(0, "seed"), account(1, "new")]);
	const nextStoreFile = join(dir, "next-store.json");
	await writeFile(nextStoreFile, JSON.stringify(next, null, 2));
	return { dir, storagePath, workerPath, seed, next, nextStoreFile };
}

type KillPhase =
	| "lock-acquired"
	| "wal-done"
	| "temp-done"
	| "rename-start"
	| "committed";

function launch(
	fix: Fixture,
	killPhase: KillPhase | null,
): {
	child: ChildProcess;
	messages: string[];
	done: Promise<unknown[]>;
	stderr: () => string;
} {
	const child = fork(fix.workerPath, [fix.storagePath, fix.nextStoreFile], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	children.push(child);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const messages: string[] = [];
	// Await "close", not "exit": Node can fire "exit" while the final IPC
	// messages ("saved"/"phase:*") are still buffered in the channel, and this
	// file asserts on run.messages after done resolves. "close" fires only
	// after exit AND after the IPC channel/stdio have fully drained.
	const done = once(child, "close");
	child.on("message", (message) => {
		const text = String(message);
		messages.push(text);
		if (text === "saved") return;
		if (killPhase !== null && text === `phase:${killPhase}`) {
			child.kill("SIGKILL");
		} else {
			// If the child died between emitting this message and our reply,
			// send() throws ERR_IPC_CHANNEL_CLOSED — an uncaught exception inside
			// this listener would crash the whole vitest fork instead of just
			// failing the test. Swallow it; run.done/"close" still resolves.
			try {
				child.send("proceed");
			} catch {
				/* child exited before the gate could be released */
			}
		}
	});
	return { child, messages, done, stderr: () => stderr };
}

async function readWal(storagePath: string) {
	const raw = await readFile(`${storagePath}.wal`, "utf8");
	return JSON.parse(raw) as {
		version: number;
		createdAt: number;
		path: string;
		checksum: string;
		content: string;
	};
}

async function walHolds(
	storagePath: string,
	expected: AccountStorageV3,
): Promise<void> {
	const wal = await readWal(storagePath);
	expect(wal.version).toBe(1);
	expect(createHash("sha256").update(wal.content).digest("hex")).toBe(
		wal.checksum,
	);
	expect(recordIds(JSON.parse(wal.content) as AccountStorageV3)).toEqual(
		recordIds(expected),
	);
}

async function expectDeadLockReclaimed(storagePath: string): Promise<void> {
	// The killed child still owns <path>.write-lock; dead-owner recovery must
	// let a fresh acquisition in THIS process proceed without any lease wait.
	await expect(
		withFileTransactionLock(storagePath, async () => 42, { waitMs: 1500 }),
	).resolves.toBe(42);
}

async function tornWalRecovery(fix: Fixture): Promise<void> {
	// Tear the primary into truncated JSON — a torn write — then let the
	// journal restore the store the killed writer meant to commit.
	await writeFile(fix.storagePath, '{"version":3,"accounts":[{"recordId":');
	const health = await inspectStorageHealth();
	expect(health.state).toBe("recoverable");
	expect(health.recoverySource).toBe("wal");
	const recovered = await loadAccounts();
	expect(recordIds(recovered)).toEqual(recordIds(fix.next));
	// Recovery re-persists, leaving a healthy primary afterwards.
	expect((await inspectStorageHealth()).state).toBe("healthy");
	const repersisted = JSON.parse(
		await readFile(fix.storagePath, "utf8"),
	) as AccountStorageV3;
	expect(recordIds(repersisted)).toEqual(recordIds(fix.next));
}

describe("SIGKILL mid-write recovery", () => {
	it("a clean save drives every pipeline phase and leaves no litter", async () => {
		const fix = await fixture();
		const run = launch(fix, null);
		await run.done;
		expect(run.messages).toEqual([
			"ready",
			"phase:lock-acquired",
			"phase:wal-done",
			"phase:temp-done",
			"phase:rename-start",
			"phase:committed",
			"saved",
		]);
		expect(recordIds(JSON.parse(await readFile(fix.storagePath, "utf8")))).toEqual(
			recordIds(fix.next),
		);
		expect(
			(await readdir(fix.dir)).filter(
				(name) =>
					name.endsWith(".tmp") ||
					name.endsWith(".wal") ||
					name.includes("write-lock"),
			),
		).toEqual([]);
	});

	it("kill while holding the write lock: dead owner is reclaimed, store untouched", async () => {
		const fix = await fixture();
		const run = launch(fix, "lock-acquired");
		await run.done;
		expect(run.messages).not.toContain("saved");

		// The lock directory outlives its dead owner until recovery reclaims it.
		await expectDeadLockReclaimed(fix.storagePath);
		expect(
			(await readdir(fix.dir)).filter((name) => name.includes("write-lock")),
		).toEqual([]);

		setStoragePathDirect(fix.storagePath);
		expect(recordIds(await loadAccounts())).toEqual(recordIds(fix.seed));
	});

	it("kill after the WAL flush: journal holds the intent, primary stays committed, torn primary recovers via WAL", async () => {
		const fix = await fixture();
		const run = launch(fix, "wal-done");
		await run.done;

		// Write-ahead contract: the journaled payload is complete and checksummed.
		await walHolds(fix.storagePath, fix.next);
		// No backup was needed for this store shape — .bak holds the seed.
		await expectDeadLockReclaimed(fix.storagePath);

		setStoragePathDirect(fix.storagePath);
		// A valid primary wins over a stranded journal.
		expect((await inspectStorageHealth()).state).toBe("healthy");
		expect(recordIds(await loadAccounts())).toEqual(recordIds(fix.seed));

		await tornWalRecovery(fix);
	});

	it("kill after the temp file is durable: orphaned temp holds the full payload, primary stays committed", async () => {
		const fix = await fixture();
		const run = launch(fix, "temp-done");
		await run.done;

		await walHolds(fix.storagePath, fix.next);
		// Honest report: the committed-intent temp file is left behind as a
		// complete (never torn) artifact — nothing sweeps plain *.tmp orphans.
		const orphans = (await readdir(fix.dir)).filter(
			(name) =>
				name.endsWith(".tmp") &&
				!name.includes(".rotate.") &&
				name.startsWith("openai-codex-accounts.json."),
		);
		expect(orphans.length).toBe(1);
		expect(
			recordIds(
				JSON.parse(
					await readFile(join(fix.dir, orphans[0]!), "utf8"),
				) as AccountStorageV3,
			),
		).toEqual(recordIds(fix.next));

		await expectDeadLockReclaimed(fix.storagePath);
		setStoragePathDirect(fix.storagePath);
		expect(recordIds(await loadAccounts())).toEqual(recordIds(fix.seed));
		await tornWalRecovery(fix);
	});

	it("kill at the rename boundary: primary is untouched, WAL + temp still recoverable", async () => {
		const fix = await fixture();
		const run = launch(fix, "rename-start");
		await run.done;

		await walHolds(fix.storagePath, fix.next);
		await expectDeadLockReclaimed(fix.storagePath);

		setStoragePathDirect(fix.storagePath);
		expect(recordIds(await loadAccounts())).toEqual(recordIds(fix.seed));
		await tornWalRecovery(fix);
	});

	it("kill immediately after the atomic rename commits: primary carries the new store", async () => {
		const fix = await fixture();
		const run = launch(fix, "committed");
		await run.done;

		await expectDeadLockReclaimed(fix.storagePath);
		setStoragePathDirect(fix.storagePath);
		expect(recordIds(await loadAccounts())).toEqual(recordIds(fix.next));
		expect((await inspectStorageHealth()).state).toBe("healthy");
		// The WAL cleanup never ran — the journal is stranded but benign: it is
		// ignored while the primary parses, and the next save overwrites it.
		await walHolds(fix.storagePath, fix.next);
	});

	it("torn primary with no WAL recovers through the rotated .bak", async () => {
		const fix = await fixture();
		const run = launch(fix, "wal-done");
		await run.done;

		await expectDeadLockReclaimed(fix.storagePath);
		// A completed backup rotation left .bak = seed before the crash.
		const backups = (await readdir(fix.dir)).filter((name) =>
			name.startsWith("openai-codex-accounts.json.bak"),
		);
		expect(backups.length).toBeGreaterThan(0);

		await rm(`${fix.storagePath}.wal`, { force: true });
		await writeFile(fix.storagePath, '{"version":3,"accounts":[{"recordId":');

		setStoragePathDirect(fix.storagePath);
		// With no journal, health is honestly "corrupt" until loadAccounts
		// restores through the backup chain and re-persists the seed store.
		expect((await inspectStorageHealth()).state).toBe("corrupt");
		expect(recordIds(await loadAccounts())).toEqual(recordIds(fix.seed));
		expect((await inspectStorageHealth()).state).toBe("healthy");
	});
});
