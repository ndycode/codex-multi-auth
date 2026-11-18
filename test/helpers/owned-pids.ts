import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

/**
 * PIDs the test owns, instead of sentinels the test hopes are unused.
 *
 * Helper-lifecycle fixtures used to stand in for "dead" with integers above the
 * platform PID ceiling (`99999999`, `2_147_483_646`) and for "a second live
 * process" with `process.ppid`. Neither is a fact the test controls:
 * `process.kill` may raise `EINVAL` rather than `ESRCH` for an out-of-range
 * PID — which happens to classify as dead only because every liveness check in
 * this tree treats every errno but `EPERM` as dead — and `process.ppid` inside
 * a vitest worker is the pool process, whose identity and lifetime differ
 * between the `threads` and `forks` pools and which can exit mid-run (#668).
 *
 * Spawning a process and killing it makes "dead" a fact; keeping one alive for
 * the duration of a test makes "live" a fact.
 */

function spawnIdleChild(): ChildProcess {
	// Reads stdin forever and does nothing else. stdin is a pipe the parent
	// holds open, so the child stays alive until it is signalled, without a
	// timer that could fire first.
	return spawn(process.execPath, ["-e", "process.stdin.resume()"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
}

export interface OwnedPidOptions {
	/**
	 * Test-only seam for how a probe child is created.
	 *
	 * The failure these helpers have to survive is a child that never spawns:
	 * it emits `error` and never `exit`, and because a batch is awaited
	 * concurrently, one of them stalls every sibling. That path cannot be
	 * reached by spawning a working binary, and asserting on a child the test
	 * spawned itself only proves what Node does — it would keep passing with
	 * the handling here deleted. Substituting the factory is what makes the
	 * helpers' own behaviour observable.
	 */
	spawnChild?: () => ChildProcess;
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) {
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			child.once("exit", finish);
			// A child that never spawned emits `error`, never `exit`. Waiting on
			// `exit` alone leaves this promise pending forever — and the batched
			// helpers below await a whole batch concurrently, so a single failed
			// spawn would stall every sibling and hang the run rather than failing
			// it. Either event means "this child is not running".
			child.once("error", finish);
		});
	}
	// `exit` fires before the stdio streams are torn down, so the parent's write
	// end of the stdin pipe is still open here and would linger until GC. Every
	// call site opens at least one, several open three at once, and on Windows
	// these are named-pipe handles — the scarcer resource. Close it explicitly
	// so the lifetime is the helper's, not the collector's.
	child.stdin?.destroy();
}

/**
 * Signal a probe child, tolerating one that has nothing to signal.
 *
 * A child that never spawned has no process behind it, and `kill` throws
 * rather than no-opping — `EINVAL` on Windows. Left unguarded that throw
 * escapes the cleanup loop *before* the batch helpers can report why the
 * batch was unusable, so the caller sees `kill EINVAL` instead of "failed to
 * spawn", and on a partial failure the real diagnosis is masked entirely.
 * `waitForExit` still settles such a child on its `error` event.
 */
function killChild(child: ChildProcess): void {
    // A failed spawn can retain a native handle with pid 0; never signal a process group.
    if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 0) return;
	try {
		child.kill("SIGKILL");
	} catch {
		// Nothing to signal; the `error` event is what settles this child.
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		return code === "EPERM";
	}
}

/**
 * A PID that is genuinely dead: a child this process started, signalled, and
 * reaped.
 *
 * Deadness is re-asserted immediately before the PID is handed over, because
 * "a just-exited PID is not reused" is only true where PIDs come from a
 * monotonic counter. Linux and macOS qualify; Windows does not — its PIDs come
 * from a pool and can be handed out again promptly. The callers that assert
 * unbind *removes* a dead PID's files run on every platform, so a recycled PID
 * would make unbind correctly preserve the file and the test fail — an
 * intermittent Windows-only failure in a cleanup test, which looks exactly
 * like the bug the test guards. The check turns that into an immediate,
 * legible fixture error instead.
 */
export async function withDeadPid<T>(
	run: (pid: number) => Promise<T> | T,
	options: OwnedPidOptions = {},
): Promise<T> {
	const child = (options.spawnChild ?? spawnIdleChild)();
	const pid = child.pid;
	if (pid === undefined) {
		killChild(child);
		await waitForExit(child);
		throw new Error(
			"owned-pids: failed to spawn a probe process while building a dead PID",
		);
	}
	killChild(child);
	await waitForExit(child);
	if (isPidAlive(pid)) {
		throw new Error(
			`owned-pids: pid ${pid} was recycled between reaping it and using it; ` +
				"this fixture needs a PID that stays dead for the length of the test",
		);
	}
	return await run(pid);
}

/**
 * `count` distinct dead PIDs at once, so a fixture needing several does not
 * nest `withDeadPid` callbacks one inside the next.
 */
export async function withDeadPids<T>(
	count: number,
	run: (pids: number[]) => Promise<T> | T,
	options: OwnedPidOptions = {},
): Promise<T> {
	const spawnChild = options.spawnChild ?? spawnIdleChild;
	// Spawned and reaped in batches rather than all at once. The stress fixtures
	// ask for hundreds, and launching that many processes simultaneously can hit
	// a process-table or fd limit and fail the spawn — which would surface as a
	// fixture error indistinguishable from the bug under test. Batching keeps the
	// instantaneous footprint small while still yielding `count` distinct PIDs.
	//
	// Windows draws PIDs from a shared pool and hands a just-reaped one straight
	// back out — to the next batch here, or to any other process on the machine.
	// So PIDs are collected as a set, and any that come back to life before the
	// hand-over are dropped and replaced with fresh ones rather than failing
	// the fixture; only a machine that keeps recycling them round after round
	// still throws.
	const batchSize = 32;
	const maxBatches = 10 * Math.ceil(count / batchSize);
	const deadPids = new Set<number>();
	let recycled: number[] = [];
	let batches = 0;
	for (;;) {
		while (deadPids.size < count) {
			batches += 1;
			if (batches > maxBatches) {
				throw new Error(
					`owned-pids: pid(s) ${recycled.join(", ")} were recycled between ` +
						"reaping them and using them; this fixture needs PIDs that stay dead",
				);
			}
			await spawnAndReapBatch(spawnChild, Math.min(batchSize, count - deadPids.size), deadPids);
		}
		recycled = [...deadPids].filter((pid) => isPidAlive(pid));
		if (recycled.length === 0) break;
		for (const pid of recycled) deadPids.delete(pid);
	}
	return await run([...deadPids]);
}

async function spawnAndReapBatch(
	spawnChild: () => ChildProcess,
	size: number,
	into: Set<number>,
): Promise<void> {
	const children = Array.from({ length: size }, () => spawnChild());
	const pids = children.map((child) => child.pid);
	// Reap the whole batch first — including any child that failed to spawn,
	// which `waitForExit` now settles on `error` — and only then decide whether
	// the batch was usable. Throwing before the cleanup would leak the
	// siblings that did start.
	await Promise.all(
		children.map(async (child) => {
			killChild(child);
			await waitForExit(child);
		}),
	);
	if (pids.some((pid) => pid === undefined)) {
		throw new Error(
			"owned-pids: failed to spawn a probe process while building a dead-PID batch",
		);
	}
	for (const pid of pids as number[]) into.add(pid);
}

/**
 * A PID that is genuinely alive for the duration of `run`, and killed
 * afterwards whether `run` throws or not.
 */
export async function withLivePid<T>(
	run: (pid: number) => Promise<T> | T,
	options: OwnedPidOptions = {},
): Promise<T> {
	const child = (options.spawnChild ?? spawnIdleChild)();
	const pid = child.pid;
	if (pid === undefined) {
		killChild(child);
		await waitForExit(child);
		throw new Error(
			"owned-pids: failed to spawn a probe process while building a live PID",
		);
	}
	try {
		return await run(pid);
	} finally {
		killChild(child);
		await waitForExit(child);
	}
}

/**
 * `count` distinct live PIDs at once, all killed afterwards whether `run`
 * throws or not. Used where a fixture needs more concurrent live helpers than
 * the code under test's parallelism bound.
 */
export async function withLivePids<T>(
	count: number,
	run: (pids: number[]) => Promise<T> | T,
	options: OwnedPidOptions = {},
): Promise<T> {
	const spawnChild = options.spawnChild ?? spawnIdleChild;
	const children = Array.from({ length: count }, () => spawnChild());
	try {
		const pids = children.map((child) => child.pid);
		if (pids.some((pid) => pid === undefined)) {
			throw new Error(
				"owned-pids: failed to spawn a probe process while building a live-PID set",
			);
		}
		return await run(pids as number[]);
	} finally {
		// Same contract as the dead-PID batch: a child that failed to spawn settles
		// on `error` and is not signalled, so this cleanup can neither hang on it
		// nor throw out of the `finally`.
		await Promise.all(
			children.map(async (child) => {
				killChild(child);
				await waitForExit(child);
			}),
		);
	}
}
