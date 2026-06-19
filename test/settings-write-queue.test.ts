import { describe, expect, it, vi } from "vitest";
// Everything is driven through withQueuedRetry on purpose: it is the one
// entry point external callers use, and the module's helper exports are
// internal surface that may be pruned.
import { withQueuedRetry } from "../lib/codex-manager/settings-write-queue.js";

function errnoError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

// Records requested delays and resolves immediately: the retry schedule is
// asserted, not waited for.
function recordingSleep(): {
	sleep: (ms: number) => Promise<void>;
	delays: number[];
} {
	const delays: number[] = [];
	return {
		delays,
		sleep: async (ms: number) => {
			delays.push(ms);
		},
	};
}

// Unique key per test so the module-level queue map never couples tests.
let keyCounter = 0;
function uniqueKey(): string {
	keyCounter += 1;
	return `/settings/test-${keyCounter}.json`;
}

describe("withQueuedRetry retries", () => {
	it("returns the task result without sleeping on first-try success", async () => {
		const { sleep, delays } = recordingSleep();
		const task = vi.fn().mockResolvedValue("written");

		await expect(withQueuedRetry(uniqueKey(), task, { sleep })).resolves.toBe(
			"written",
		);
		expect(task).toHaveBeenCalledTimes(1);
		expect(delays).toEqual([]);
	});

	it("retries Windows sharing violations with exponential backoff", async () => {
		const { sleep, delays } = recordingSleep();
		const task = vi
			.fn()
			.mockRejectedValueOnce(errnoError("EBUSY"))
			.mockRejectedValueOnce(errnoError("EACCES"))
			.mockResolvedValueOnce("written");

		await expect(withQueuedRetry(uniqueKey(), task, { sleep })).resolves.toBe(
			"written",
		);
		expect(task).toHaveBeenCalledTimes(3);
		expect(delays).toEqual([50, 100]);
	});

	it.each(["EPERM", "EAGAIN", "ENOTEMPTY"])(
		"treats %s as a retryable Windows lock code",
		async (code) => {
			// Windows file locks most often surface as EPERM, so the whole
			// retryable set is pinned, not just EBUSY/EACCES.
			const { sleep, delays } = recordingSleep();
			const task = vi
				.fn()
				.mockRejectedValueOnce(errnoError(code))
				.mockResolvedValueOnce("written");

			await expect(
				withQueuedRetry(uniqueKey(), task, { sleep }),
			).resolves.toBe("written");
			expect(task).toHaveBeenCalledTimes(2);
			expect(delays).toEqual([50]);
		},
	);

	it("honors a 429 retry-after hint, clamped into the sane range", async () => {
		const { sleep, delays } = recordingSleep();
		const task = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("throttled"), {
					status: 429,
					retryAfterMs: 12_345,
				}),
			)
			.mockRejectedValueOnce(
				Object.assign(new Error("throttled"), {
					statusCode: 429,
					retryAfterMs: 2, // below the 10ms floor
				}),
			)
			.mockRejectedValueOnce(
				Object.assign(new Error("throttled"), {
					status: 429,
					retryAfterMs: 999_999_999, // above the 30s ceiling
				}),
			)
			.mockResolvedValueOnce("written");

		await expect(withQueuedRetry(uniqueKey(), task, { sleep })).resolves.toBe(
			"written",
		);
		expect(delays).toEqual([12_345, 10, 30_000]);
	});

	it("rethrows non-retryable errors immediately", async () => {
		const { sleep, delays } = recordingSleep();
		const task = vi.fn().mockRejectedValue(errnoError("ENOSPC"));

		await expect(
			withQueuedRetry(uniqueKey(), task, { sleep }),
		).rejects.toThrow("ENOSPC");
		expect(task).toHaveBeenCalledTimes(1);
		expect(delays).toEqual([]);
	});

	it("gives up with the last error after four retryable attempts", async () => {
		const { sleep, delays } = recordingSleep();
		const task = vi.fn().mockRejectedValue(errnoError("EBUSY"));

		await expect(
			withQueuedRetry(uniqueKey(), task, { sleep }),
		).rejects.toThrow("EBUSY");
		expect(task).toHaveBeenCalledTimes(4);
		// No sleep after the final attempt.
		expect(delays).toEqual([50, 100, 200]);
	});
});

describe("withQueuedRetry serialization", () => {
	it("runs tasks for the same path strictly in submission order", async () => {
		const { sleep } = recordingSleep();
		const key = uniqueKey();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = withQueuedRetry(
			key,
			async () => {
				order.push("first:start");
				await firstGate;
				order.push("first:end");
				return 1;
			},
			{ sleep },
		);
		const second = withQueuedRetry(
			key,
			async () => {
				order.push("second:start");
				return 2;
			},
			{ sleep },
		);

		// Give the second task every chance to start early if the queue leaked.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(order).toEqual(["first:start"]);

		releaseFirst();
		await expect(first).resolves.toBe(1);
		await expect(second).resolves.toBe(2);
		expect(order).toEqual([
			"first:start",
			"first:end",
			"second:start",
		]);
	});

	it("does not let a failed predecessor block the next write", async () => {
		const { sleep } = recordingSleep();
		const key = uniqueKey();

		const failed = withQueuedRetry(
			key,
			async () => {
				throw errnoError("ENOSPC");
			},
			{ sleep },
		);
		const next = withQueuedRetry(key, async () => "recovered", { sleep });

		await expect(failed).rejects.toThrow("ENOSPC");
		await expect(next).resolves.toBe("recovered");
	});

	it("lets different paths proceed independently", async () => {
		const { sleep } = recordingSleep();
		const order: string[] = [];
		let releaseBlocked!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseBlocked = resolve;
		});

		const blocked = withQueuedRetry(
			uniqueKey(),
			async () => {
				await gate;
				order.push("blocked");
			},
			{ sleep },
		);
		const independent = withQueuedRetry(
			uniqueKey(),
			async () => {
				order.push("independent");
			},
			{ sleep },
		);

		await independent;
		expect(order).toEqual(["independent"]);
		releaseBlocked();
		await blocked;
		expect(order).toEqual(["independent", "blocked"]);
	});

	it("keeps every retry of a task ahead of the next queued task", async () => {
		const { sleep } = recordingSleep();
		const key = uniqueKey();
		const order: string[] = [];
		const flaky = vi
			.fn()
			.mockImplementationOnce(async () => {
				order.push("flaky:1");
				throw errnoError("EBUSY");
			})
			.mockImplementationOnce(async () => {
				order.push("flaky:2");
				return "ok";
			});

		const first = withQueuedRetry(key, flaky, { sleep });
		const second = withQueuedRetry(
			key,
			async () => {
				order.push("second");
				return "done";
			},
			{ sleep },
		);

		await expect(first).resolves.toBe("ok");
		await expect(second).resolves.toBe("done");
		// The retry happened inside the queue slot, before the second task.
		expect(order).toEqual(["flaky:1", "flaky:2", "second"]);
	});
});
