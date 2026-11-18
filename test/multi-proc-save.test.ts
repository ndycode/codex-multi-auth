import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import {
	loadAccounts,
	setStoragePathDirect,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../lib/storage.js";
import { withRetry } from "../lib/fs-retry.js";

/**
 * Multiprocess save race: two REAL forked processes run the REAL saveAccounts()
 * (bundled from lib/storage.ts) against the same storage file. IPC barriers —
 * never sleeps — force both writers to load their merge baseline BEFORE either
 * is allowed to save, so the second writer provably merges against the first
 * writer's committed state under the cross-process file lock.
 *
 * Contracts asserted (lib/storage.ts + lib/storage/snapshot-merge.ts):
 *  - baseline save (object returned by loadAccounts): merge-on-write. Two
 *    disjoint appends both survive; a same-field two-sided edit fails LOUDLY
 *    with ESTALE instead of a silent last-writer-wins overwrite.
 *  - untracked save (fresh object, no baseline): documented LWW overwrite —
 *    the loser's update is gone with no signal. Asserted exactly so the
 *    primitive can never quietly change.
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

function account(tag: string): AccountMetadataV3 {
	return {
		recordId: `rec-${tag}`,
		accountId: `acct-${tag}`,
		email: `writer-${tag}@corp.example`,
		refreshToken: `rt-${tag}-${tag.length.toString(16).padStart(8, "0")}`,
		accessToken: `at-${tag}`,
		expiresAt: Date.now() + 3_600_000,
		addedAt: 1_700_000_000_000,
		lastUsed: 1_700_000_100_000,
	};
}

function recordIds(storage: AccountStorageV3 | null): string[] {
	return (storage?.accounts ?? [])
		.map((row) => row.recordId ?? "")
		.sort();
}

const WORKER_SOURCE = `
import { promises as fs } from "node:fs";
import { setStoragePathDirect, loadAccounts, saveAccounts } from "./storage.mjs";

const [storagePath, planFile] = process.argv.slice(2);
setStoragePathDirect(storagePath);
const plan = JSON.parse(await fs.readFile(planFile, "utf8"));

const send = (message) => new Promise((resolve) => process.send(message, resolve));
const gate = () => new Promise((resolve) => process.once("message", resolve));

// For baseline modes the merge snapshot is registered the moment loadAccounts
// resolves — load BEFORE signaling so the parent's barrier proves both writers
// saw the same pre-race store.
let store = null;
if (plan.mode !== "foreign") {
	store = await loadAccounts();
}
await send("loaded");
await gate();
try {
	if (plan.mode === "baseline-append") {
		store.accounts.push(plan.account);
	} else if (plan.mode === "baseline-edit") {
		store.accounts[0].email = plan.email;
	}
	await saveAccounts(store ?? plan.storage);
	await send("saved");
} catch (error) {
	await send("failed:" + ((error && error.code) || "UNKNOWN"));
}
process.disconnect();
`;

type Plan =
	| { mode: "baseline-append"; account: AccountMetadataV3 }
	| { mode: "baseline-edit"; email: string }
	| { mode: "foreign"; storage: AccountStorageV3 };

interface Fixture {
	dir: string;
	storagePath: string;
	workerPath: string;
	seed: AccountStorageV3;
}

async function fixture(): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "cma-multi-proc-"));
	dirs.push(dir);
	await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
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
	const seed: AccountStorageV3 = {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [account("base")],
	};
	await writeFile(storagePath, JSON.stringify(seed, null, 2));
	return { dir, storagePath, workerPath, seed };
}

interface Run {
	child: ChildProcess;
	messages: string[];
	done: Promise<unknown[]>;
	stderr: () => string;
}

async function launch(fix: Fixture, plan: Plan): Promise<Run> {
	const planFile = join(fix.dir, `plan-${children.length}.json`);
	await writeFile(planFile, JSON.stringify(plan));
	const child = fork(fix.workerPath, [fix.storagePath, planFile], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	children.push(child);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const messages: string[] = [];
	// Await "close", not "exit": "exit" can fire while the worker's last IPC
	// message ("saved"/"failed:*") is still buffered, and outcomes() reads
	// run.messages after done resolves. "close" waits for exit + IPC drain.
	const done = once(child, "close");
	child.on("message", (message) => messages.push(String(message)));
	return { child, messages, done, stderr: () => stderr };
}

async function waitFor(run: Run, message: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!run.messages.includes(message)) {
		if (run.child.exitCode !== null || run.child.signalCode !== null) {
			throw new Error(
				`Worker exited before "${message}"; stderr: ${run.stderr()}`,
			);
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for "${message}"; stderr: ${run.stderr()}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function outcomes(run: Run): Promise<string[]> {
	await run.done;
	return run.messages.filter(
		(message) => message === "saved" || message.startsWith("failed:"),
	);
}

async function readStore(storagePath: string): Promise<AccountStorageV3> {
	return JSON.parse(await readFile(storagePath, "utf8")) as AccountStorageV3;
}

describe("multiprocess saveAccounts races", () => {
	it("two baseline writers append disjoint accounts and the merge keeps both", async () => {
		const fix = await fixture();
		const a = await launch(fix, {
			mode: "baseline-append",
			account: account("a-writer"),
		});
		const b = await launch(fix, {
			mode: "baseline-append",
			account: account("b-writer"),
		});
		// Deterministic barrier: both baselines captured before ANY save.
		await waitFor(a, "loaded");
		await waitFor(b, "loaded");
		// send() throws ERR_IPC_CHANNEL_CLOSED if a worker died after "loaded" —
		// keep it a test failure (empty outcomes) instead of an uncaught throw.
		try { a.child.send("go"); } catch { /* worker exited */ }
		try { b.child.send("go"); } catch { /* worker exited */ }

		const [outA, outB] = await Promise.all([outcomes(a), outcomes(b)]);
		expect(outA).toEqual(["saved"]);
		expect(outB).toEqual(["saved"]);

		// Merge-on-write: the second writer's merge folded the first writer's
		// committed row into its own update — neither append was lost.
		const final = await readStore(fix.storagePath);
		expect(recordIds(final)).toEqual(
			["rec-base", "rec-a-writer", "rec-b-writer"].sort(),
		);
		// The parent's real loader must see the same merged store.
		setStoragePathDirect(fix.storagePath);
		expect(recordIds(await loadAccounts())).toEqual(recordIds(final));
	});

	it("two baseline writers editing the same field: loser fails loudly with ESTALE", async () => {
		const fix = await fixture();
		const a = await launch(fix, {
			mode: "baseline-edit",
			email: "alice@corp.example",
		});
		const b = await launch(fix, {
			mode: "baseline-edit",
			email: "bob@corp.example",
		});
		await waitFor(a, "loaded");
		await waitFor(b, "loaded");
		try { a.child.send("go"); } catch { /* worker exited */ }
		try { b.child.send("go"); } catch { /* worker exited */ }

		const all = [...(await outcomes(a)), ...(await outcomes(b))];
		// One winner, one loud loser — the contract forbids a silent overwrite.
		expect(all.filter((m) => m === "saved")).toHaveLength(1);
		expect(all.filter((m) => m === "failed:ESTALE")).toHaveLength(1);

		const final = await readStore(fix.storagePath);
		expect(recordIds(final)).toEqual(["rec-base"]);
		// The committed store holds exactly one writer's edit — whichever won
		// the lock — and nothing merged or duplicated.
		expect(["alice@corp.example", "bob@corp.example"]).toContain(
			final.accounts[0]!.email,
		);
		setStoragePathDirect(fix.storagePath);
		expect((await loadAccounts())?.accounts[0]?.email).toBe(
			final.accounts[0]!.email,
		);
	});

	it("two untracked writers: last-writer-wins overwrite — the contract of the no-baseline primitive", async () => {
		const fix = await fixture();
		const storageA: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [account("base"), account("a-writer")],
		};
		const storageB: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [account("base"), account("b-writer")],
		};
		const a = await launch(fix, { mode: "foreign", storage: storageA });
		const b = await launch(fix, { mode: "foreign", storage: storageB });
		await waitFor(a, "loaded");
		await waitFor(b, "loaded");
		try { a.child.send("go"); } catch { /* worker exited */ }
		try { b.child.send("go"); } catch { /* worker exited */ }

		const all = [...(await outcomes(a)), ...(await outcomes(b))];
		// Both writers "succeed" — no ESTALE — because neither save carries a
		// merge baseline. The loser's row is gone with NO error: this is the
		// documented overwrite primitive, not merge-on-write. Callers that need
		// merge semantics must keep the loadAccounts() object as the baseline.
		expect(all).toEqual(["saved", "saved"]);

		const final = await readStore(fix.storagePath);
		expect(final.version).toBe(3);
		expect([
			["rec-base", "rec-a-writer"].sort().join(","),
			["rec-base", "rec-b-writer"].sort().join(","),
		]).toContain(recordIds(final).join(","));
		expect(recordIds(final)).toHaveLength(2);
		setStoragePathDirect(fix.storagePath);
		expect(recordIds(await loadAccounts())).toEqual(recordIds(final));
	});
});
