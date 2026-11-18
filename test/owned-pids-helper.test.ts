import { spawn } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { withDeadPid, withDeadPids, withLivePid, withLivePids } from "./helpers/owned-pids.js";

// The lifecycle fixtures depend on these helpers being facts rather than
// approximations, so the helpers themselves need coverage. The hang is the
// dangerous one: a helper that never resolves turns a test failure into a
// suite that sits there until the runner's timeout, with no useful output.

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		return code === "EPERM";
	}
}

describe("owned-pids", () => {
	it("hands out a PID that is genuinely dead", async () => {
		await withDeadPid((pid) => {
			expect(Number.isInteger(pid)).toBe(true);
			expect(pid).toBeGreaterThan(0);
			expect(isAlive(pid)).toBe(false);
		});
	});

	it("hands out a PID that is genuinely alive, and reaps it afterwards", async () => {
		let captured = 0;
		await withLivePid((pid) => {
			captured = pid;
			expect(isAlive(pid)).toBe(true);
		});
		// Killed on the way out rather than left for the OS.
		expect(isAlive(captured)).toBe(false);
	});

	it("kills the live PID even when the body throws", async () => {
		let captured = 0;
		await expect(
			withLivePid((pid) => {
				captured = pid;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(isAlive(captured)).toBe(false);
	});

	it("produces distinct PIDs in batches larger than one spawn round", async () => {
		// The batch size is an implementation detail; asking for more than one
		// batch is what proves the loop stitches them together rather than
		// returning only the last batch.
		const count = 40;
		await withDeadPids(count, (pids) => {
			expect(pids).toHaveLength(count);
			expect(new Set(pids).size).toBe(count);
			for (const pid of pids) {
				expect(isAlive(pid)).toBe(false);
			}
		});
	}, 60_000);

	it("keeps every PID in a live batch alive for the body and reaps them after", async () => {
		let captured: number[] = [];
		await withLivePids(5, (pids) => {
			captured = [...pids];
			expect(new Set(pids).size).toBe(pids.length);
			for (const pid of pids) {
				expect(isAlive(pid)).toBe(true);
			}
		});
		for (const pid of captured) {
			expect(isAlive(pid)).toBe(false);
		}
	}, 60_000);

	// A child that fails to spawn emits `error` and never `exit`, so waiting on
	// `exit` alone left the promise pending forever — and because a batch is
	// awaited concurrently, one failed spawn stalled every sibling and hung the
	// run rather than failing it.
	//
	// These drive the helpers themselves through a substituted spawn factory.
	// Asserting on a child the test spawns directly would only demonstrate what
	// Node does, and would keep passing with the handling in `waitForExit`
	// deleted — the failure it is supposed to catch.
	describe("a child that never spawns", () => {
		const spawnFailingChild = () =>
			spawn("definitely-not-a-real-binary-2f8c1d", ["--nope"], {
				stdio: ["pipe", "ignore", "ignore"],
			});

		// Bounded well inside vitest's own timeout, so a regression reads as this
		// assertion failing rather than as a suite that sits there until the
		// runner gives up.
		async function settlesWithin<T>(
			work: Promise<T>,
			budgetMs: number,
		): Promise<string> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					work.then(
						() => "resolved",
						(error: unknown) =>
							`rejected: ${error instanceof Error ? error.message : String(error)}`,
					),
					new Promise<string>((resolve) => {
						timer = setTimeout(() => resolve("HUNG"), budgetMs);
					}),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}

		it("makes withDeadPids reject instead of hanging", async () => {
			const outcome = await settlesWithin(
				withDeadPids(4, () => "unreachable", {
					spawnChild: spawnFailingChild,
				}),
				5_000,
			);
			expect(outcome).not.toBe("HUNG");
			expect(outcome).toContain("failed to spawn");
		}, 30_000);

		it("makes withLivePids reject instead of hanging", async () => {
			const outcome = await settlesWithin(
				withLivePids(4, () => "unreachable", {
					spawnChild: spawnFailingChild,
				}),
				5_000,
			);
			expect(outcome).not.toBe("HUNG");
			expect(outcome).toContain("failed to spawn");
		}, 30_000);

		it("makes withDeadPid reject instead of hanging", async () => {
			const outcome = await settlesWithin(
				withDeadPid(() => "unreachable", { spawnChild: spawnFailingChild }),
				5_000,
			);
			expect(outcome).not.toBe("HUNG");
			expect(outcome).toContain("failed to spawn");
		}, 30_000);

		it("makes withLivePid reject instead of hanging", async () => {
			// The fourth entry point, and the last unexercised failed-spawn branch:
			// its cleanup runs from a `finally`, where an unguarded `kill` throw
			// would replace the reported reason with its own.
			const outcome = await settlesWithin(
				withLivePid(() => "unreachable", { spawnChild: spawnFailingChild }),
				5_000,
			);
			expect(outcome).not.toBe("HUNG");
			expect(outcome).toContain("failed to spawn");
		}, 30_000);
	});
});
