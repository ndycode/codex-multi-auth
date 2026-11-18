import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
	fork,
	spawnSync,
	type ChildProcess,
} from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { withRetry } from "../lib/fs-retry.js";
import { withJsonStoreFileLock } from "../lib/storage/json-store-lock.js";

// Cross-process proof for lib/storage/json-store-lock.ts: two real Node
// processes each run budget-guard's read→upsert→save. The second process's
// in-memory store was loaded BEFORE the first committed, so without the
// lockfile + mtime CAS + reload-merge its blind overwrite would silently drop
// the first write (the lost-update window this fix closes).

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	}
	for (const path of dirs.splice(0)) {
		await withRetry(() => rm(path, { recursive: true, force: true }), {
			maxAttempts: 6,
			backoffMs: 25,
		});
	}
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "json-store-lock-test-"));
	dirs.push(dir);
	// Compile only the modules under test into the fixture dir so each child is
	// a real, independent process; never import build output.
	await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	const sources: Array<[string, string, Array<[string, string]>]> = [
		["lib/budget-guard.ts", "budget-guard.js", [['"./storage/json-store-lock.js"', '"./json-store-lock.js"']]],
		["lib/account-policy.ts", "account-policy.js", [['"./storage/json-store-lock.js"', '"./json-store-lock.js"']]],
		["lib/storage/json-store-lock.ts", "json-store-lock.js", [['"../fs-retry.js"', '"./fs-retry.js"'], ['"../temp-path.js"', '"./temp-path.js"']]],
		["lib/storage/file-lock.ts", "file-lock.js", [['"../fs-retry.js"', '"./fs-retry.js"'], ['"../logger.js"', '"./logger.js"']]],
		["lib/runtime-paths.ts", "runtime-paths.js", []],
		["lib/utils.ts", "utils.js", []],
		["lib/fs-retry.ts", "fs-retry.js", []],
		["lib/temp-path.ts", "temp-path.js", []],
	];
	for (const [source, target, rewrites] of sources) {
		let text = await readFile(source, "utf8");
		for (const [from, to] of rewrites) {
			text = text.replace(from, to);
		}
		await writeFile(
			join(dir, target),
			ts.transpileModule(text, {
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.ES2022,
				},
			}).outputText,
		);
	}
	await writeFile(join(dir, "logger.js"), "export const logWarn = () => {};\n");
	const worker = join(dir, "worker.mjs");
	// load early, then hold the stale snapshot until the parent releases us:
	// child A ends up saving a store it read before child B committed.
	await writeFile(
		worker,
		`import {loadBudgetGuardStore,saveBudgetGuardStore,upsertBudgetLimit} from ${JSON.stringify(
			pathToFileURL(join(dir, "budget-guard.js")).href,
		)};
const key=process.argv[2];
const store=await loadBudgetGuardStore();
process.send('loaded');
await new Promise(r=>process.once('message',r));
upsertBudgetLimit(store,{key,window:'day',maxRequests:1},Date.now());
await saveBudgetGuardStore(store);
process.send('saved');
process.disconnect();`,
	);
	// Second worker: a bare lock contender. Each 'go' is one acquisition of
	// `<target>.lock`; inside the critical section it writes its pid to a
	// shared marker, holds briefly, then re-reads — a different pid on readback
	// means another process was inside at the same time (mutual exclusion
	// violated). Reports `done:<violations>` after each round.
	const lockWorker = join(dir, "lock-worker.mjs");
	await writeFile(
		lockWorker,
		`import {withJsonStoreFileLock} from ${JSON.stringify(
			pathToFileURL(join(dir, "json-store-lock.js")).href,
		)};
import {readFile,writeFile} from 'node:fs/promises';
const target=process.argv[2];
const inside=target+'.inside';
let violations=0;
process.on('message',async(m)=>{
if(m!=='go')return;
try{
await withJsonStoreFileLock(target,async()=>{
await writeFile(inside,String(process.pid));
await new Promise(r=>setTimeout(r,30));
if((await readFile(inside,'utf8'))!==String(process.pid))violations++;
});
}catch(e){
process.send('fail:'+((e&&e.code)||e));
return;
}
process.send('done:'+violations);
});
process.send('ready');`,
	);
	// Third worker: one account-policy mutation per process, then exit — the
	// disjoint-field update under the lock must land on the freshest store.
	const policyWorker = join(dir, "policy-worker.mjs");
	await writeFile(
		policyWorker,
		`import {updateAccountPolicyStore,upsertAccountPolicy} from ${JSON.stringify(
			pathToFileURL(join(dir, "account-policy.js")).href,
		)};
const key=process.argv[2],field=process.argv[3],value=process.argv[4];
await updateAccountPolicyStore(store=>({result:upsertAccountPolicy(store,key,p=>{
if(field==='weight')p.weight=Number(value);
if(field==='tag')p.tags.push(value);
},Date.now()),dirty:true}));
process.send('done');
process.disconnect();`,
	);
	return {
		dir,
		worker,
		lockWorker,
		policyWorker,
		storePath: join(dir, "budget-guards.json"),
	};
}

// withJsonStoreFileLock delegates to lib/storage/file-lock.ts: the lock is a
// `<target>.write-lock` DIRECTORY holding exactly one owner file named
// `<host16>.<pid>.<uuid>`. Recovery only ever unlinks a dead owner's unique
// filename — so a seeded foreign lock is simulated by writing that owner
// entry directly. `realpath` mirrors the lock's canonicalized parent so /tmp
// symlink aliases resolve to the same directory the implementation uses.
const testHost = createHash("sha256")
	.update(hostname())
	.digest("hex")
	.slice(0, 16);

async function lockDirFor(target: string): Promise<string> {
	return join(await realpath(dirname(target)), `${basename(target)}.write-lock`);
}

async function seedForeignLock(target: string, pid: number): Promise<string> {
	const lockDir = await lockDirFor(target);
	await mkdir(lockDir, { recursive: true });
	const ownerName = `${testHost}.${pid}.${randomUUID()}`;
	await writeFile(join(lockDir, ownerName), "", { flag: "wx" });
	return lockDir;
}

// A pid that is guaranteed dead at seed time: a spawned-and-reaped child's
// pid stays dead for the test's duration (reuse within milliseconds is
// negligible, and each attempt re-verifies via kill(pid, 0) → ESRCH).
// Hardcoded "dead-looking" pids are NOT reliable — e.g. 999999 was a live
// pid on the CI host.
function deadPid(): number {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const pid = spawnSync(process.execPath, ["-e", ""]).pid;
		if (pid === undefined) continue;
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException | undefined)?.code === "ESRCH"
			) {
				return pid;
			}
		}
	}
	throw Error("could not obtain a dead pid for the seeded lock");
}

function launch(worker: string, key: string, dir: string) {
	const child = fork(worker, [key], {
		env: { ...process.env, CODEX_MULTI_AUTH_DIR: dir },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	children.push(child);
	const messages: string[] = [];
	child.on("message", (m) => messages.push(String(m)));
	const wait = async (message: string) => {
		const deadline = Date.now() + 10_000;
		while (!messages.includes(message)) {
			if (Date.now() > deadline) {
				throw Error(`Worker did not report ${message}`);
			}
			await new Promise((r) => setTimeout(r, 10));
		}
	};
	return { child, messages, wait };
}

it("does not lose a concurrent upsert committed by another process", async () => {
	const { dir, worker, storePath } = await fixture();

	// A loads first and parks on a stale snapshot that predates B's commit.
	const a = launch(worker, "alpha", dir);
	await a.wait("loaded");

	// B loads the same base, then commits its own limit while A is parked.
	const b = launch(worker, "beta", dir);
	await b.wait("loaded");
	b.child.send("go");
	await b.wait("saved");

	// A now saves its stale snapshot. With the cross-process lock + reload-
	// merge CAS this MUST merge over B's committed store rather than
	// overwrite it — before the fix, `beta` silently vanished here.
	a.child.send("go");
	await a.wait("saved");

	const parsed = JSON.parse(await readFile(storePath, "utf8")) as {
		limits?: Record<string, { key?: string }>;
	};
	expect(Object.keys(parsed.limits ?? {}).sort()).toEqual(["alpha", "beta"]);

	// The lock directory is released by both writers; nothing stale is left.
	const leftovers = (await readdir(dir)).filter(
		(entry) =>
			entry.includes(".write-lock") ||
			entry.includes(".candidate-") ||
			entry.endsWith(".tmp"),
	);
	expect(leftovers).toEqual([]);
}, 30_000);

it("never lets a stale takeover unlink a live lock owned by another process", async () => {
	// Regression for the stale-takeover race: N real processes all observe the
	// SAME dead-owner lock each round. Previously each loser's unconditional
	// unlink could land AFTER the winner published its fresh lock, deleting a
	// live lock and letting two processes into the critical section at once.
	// The lock is now a directory published by atomic rename and recovered by
	// unlinking the dead owner's unique filename — an entry no live holder can
	// share — so a takeover can never remove a newly acquired lock. Each
	// contender asserts sole occupancy via a shared pid marker.
	const { dir, lockWorker } = await fixture();
	const target = join(dir, "store.json");
	const workers = [
		launch(lockWorker, target, dir),
		launch(lockWorker, target, dir),
		launch(lockWorker, target, dir),
		launch(lockWorker, target, dir),
	];
	for (const worker of workers) await worker.wait("ready");

	// Each round's message is `done:<cumulativeViolations>`; wait for the
	// round-th occurrence per worker.
	const waitRoundDone = async (
		worker: (typeof workers)[number],
		count: number,
	) => {
		const deadline = Date.now() + 15_000;
		while (
			worker.messages.filter((m) => m.startsWith("done:")).length < count
		) {
			const failure = worker.messages.find((m) => m.startsWith("fail:"));
			if (failure) {
				throw Error(`Lock worker failed in round ${count}: ${failure}`);
			}
			if (Date.now() > deadline) {
				throw Error(`Lock worker did not finish round ${count}`);
			}
			await new Promise((r) => setTimeout(r, 10));
		}
	};

	const ROUNDS = 10;
	for (let round = 1; round <= ROUNDS; round += 1) {
		// Re-seed the same dead-owner lock; all four contenders race to recover
		// it and publish their own lock in the same instant.
		await seedForeignLock(target, deadPid());
		for (const worker of workers) worker.child.send("go");
		for (const worker of workers) await waitRoundDone(worker, round);
	}
	const totalViolations = workers.reduce((sum, worker) => {
		const last = worker.messages.findLast((m) => m.startsWith("done:"));
		return sum + Number(last?.slice("done:".length) ?? 0);
	}, 0);
	expect(totalViolations).toBe(0);

	const leftovers = (await readdir(dir)).filter(
		(entry) =>
			entry.includes(".write-lock") || entry.includes(".candidate-"),
	);
	expect(leftovers).toEqual([]);
}, 60_000);

it("applies disjoint field mutations on the same policy record across processes", async () => {
	// Regression for the whole-record timestamp merge: one process sets
	// `weight`, another sets `tags` on the SAME policy key. The old
	// load→upsert→save path merged entire records by `updatedAt`, so the
	// later saver's stale record clobbered (or was discarded under) the
	// first's change. The update path re-applies each mutation under the
	// lockfile against the freshest store, so both fields must land.
	const { dir, policyWorker } = await fixture();
	const key = "sha256:shared";
	// The worker takes [key, field, value] on argv; both run concurrently so
	// their updates genuinely overlap on the lockfile.
	const spawnPolicy = (field: string, value: string) => {
		const child = fork(policyWorker, [key, field, value], {
			env: { ...process.env, CODEX_MULTI_AUTH_DIR: dir },
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		children.push(child);
		const messages: string[] = [];
		child.on("message", (m) => messages.push(String(m)));
		return { child, messages };
	};
	const w1 = spawnPolicy("weight", "7");
	const w2 = spawnPolicy("tag", "ops");
	const deadline = Date.now() + 10_000;
	while (
		!w1.messages.includes("done") ||
		!w2.messages.includes("done")
	) {
		if (Date.now() > deadline) throw Error("policy workers did not finish");
		await new Promise((r) => setTimeout(r, 10));
	}

	const parsed = JSON.parse(
		await readFile(join(dir, "account-policies.json"), "utf8"),
	) as {
		accounts?: Record<string, { weight?: number; tags?: string[] }>;
	};
	expect(parsed.accounts?.[key]?.weight).toBe(7);
	expect(parsed.accounts?.[key]?.tags).toEqual(["ops"]);
}, 30_000);

it("times out on a live foreign lock without deleting it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "json-store-lock-live-"));
	dirs.push(dir);
	const target = join(dir, "store.json");
	// An owner whose PID is alive (this process — a foreign owner name with a
	// live pid is indistinguishable from a REUSED pid): a waiter must fail
	// closed, and the foreign lock entry must still be there afterwards —
	// liveness is the only takeover signal, never timestamps.
	const lockDir = await seedForeignLock(target, process.pid);
	const ownerEntries = await readdir(lockDir);
	await expect(
		withJsonStoreFileLock(target, async () => "unreachable", {
			waitTimeoutMs: 400,
		}),
	).rejects.toMatchObject({ code: "ELOCKTIMEOUT" });
	expect(await readdir(lockDir)).toEqual(ownerEntries);
});

it("takes over a dead owner's lock and releases cleanly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "json-store-lock-stale-"));
	dirs.push(dir);
	const target = join(dir, "store.json");
	const lockDir = await seedForeignLock(target, deadPid());
	// Clock-skew guard: a FUTURE mtime on the stale owner entry must not
	// protect it — takeover keys on the dead PID, never on timestamps.
	const [ownerEntry] = await readdir(lockDir);
	const future = new Date(Date.now() + 60_000);
	await utimes(join(lockDir, ownerEntry), future, future);
	const statInside = await withJsonStoreFileLock(target, async () => {
		// While held, the lock directory exists carrying OUR owner entry.
		const entries = await readdir(lockDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatch(
			new RegExp(`^${testHost}\\.${process.pid}\\.[a-f0-9-]{36}$`),
		);
		return lstat(lockDir);
	});
	if (process.platform !== "win32") {
		expect(statInside.mode & 0o777).toBe(0o700);
	}
	expect(existsSync(lockDir)).toBe(false);
	const leftovers = (await readdir(dir)).filter(
		(entry) =>
			entry.includes(".write-lock") || entry.includes(".candidate-"),
	);
	expect(leftovers).toEqual([]);
});
