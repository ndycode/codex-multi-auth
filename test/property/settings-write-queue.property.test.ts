import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { withQueuedRetry } from "../../lib/codex-manager/settings-write-queue.js";

type TaskBehavior = "ok" | "flaky" | "fatal" | "exhausted";

const RETRYABLE_CODES = [
	"EBUSY",
	"EPERM",
	"EACCES",
	"EAGAIN",
	"ENOTEMPTY",
] as const;

const arbSchedule = fc.array(
	fc.record({
		key: fc.integer({ min: 0, max: 2 }),
		behavior: fc.constantFrom<TaskBehavior>("ok", "flaky", "fatal", "exhausted"),
		// The transient code a flaky/exhausted task throws: the whole
		// retryable set matters on Windows, not just EBUSY.
		retryableCode: fc.constantFrom(...RETRYABLE_CODES),
	}),
	{ minLength: 1, maxLength: 12 },
);

function errnoError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

const immediateSleep = { sleep: async () => {} };

// Unique key namespace per run so the module-level queue map never couples
// property iterations.
let runCounter = 0;

describe("withQueuedRetry serialization properties", () => {
	it("keeps every key's tasks contiguous and in submission order, for any schedule", async () => {
		await fc.assert(
			fc.asyncProperty(arbSchedule, async (schedule) => {
				const run = runCounter++;
				// Invocation log per key: the task index for every task() call,
				// including retries.
				const invocationsByKey = new Map<number, number[]>();
				const flakyFailed = new Set<number>();

				const pending = schedule.map((spec, taskIndex) =>
					withQueuedRetry(
						`/settings/prop-${run}-key-${spec.key}.json`,
						async () => {
							const log = invocationsByKey.get(spec.key) ?? [];
							log.push(taskIndex);
							invocationsByKey.set(spec.key, log);
							if (spec.behavior === "fatal") {
								throw errnoError("ENOSPC");
							}
							if (spec.behavior === "exhausted") {
								// Retryable on every attempt: burns the whole budget.
								throw errnoError(spec.retryableCode);
							}
							if (spec.behavior === "flaky" && !flakyFailed.has(taskIndex)) {
								flakyFailed.add(taskIndex);
								throw errnoError(spec.retryableCode);
							}
							return `result-${taskIndex}`;
						},
						immediateSleep,
					).then(
						(value) => ({ taskIndex, outcome: "ok" as const, value }),
						() => ({ taskIndex, outcome: "error" as const }),
					),
				);
				const settled = await Promise.all(pending);

				// Outcomes match behaviors: fatal rejects, ok/flaky resolve with
				// their own result; a failed predecessor never blocks successors.
				for (const result of settled) {
					const spec = schedule[result.taskIndex];
					if (spec.behavior === "fatal" || spec.behavior === "exhausted") {
						expect(result.outcome).toBe("error");
					} else {
						expect(result).toMatchObject({
							outcome: "ok",
							value: `result-${result.taskIndex}`,
						});
					}
				}

				// An exhausted task burns exactly the full retry budget.
				const allInvocations = [...invocationsByKey.values()].flat();
				for (let taskIndex = 0; taskIndex < schedule.length; taskIndex += 1) {
					if (schedule[taskIndex].behavior === "exhausted") {
						expect(
							allInvocations.filter((id) => id === taskIndex),
						).toHaveLength(4);
					}
				}

				// Per key: invocations form contiguous groups (retries never
				// interleave with another task) and groups run in submission order.
				for (const [, invocations] of invocationsByKey) {
					const groups: number[] = [];
					for (const taskIndex of invocations) {
						if (groups[groups.length - 1] !== taskIndex) {
							groups.push(taskIndex);
						}
					}
					expect(new Set(groups).size).toBe(groups.length);
					expect([...groups].sort((a, b) => a - b)).toEqual(groups);
				}

				// Every task ran at least once, on its own key.
				const totalInvocations = [...invocationsByKey.values()].flat();
				for (let taskIndex = 0; taskIndex < schedule.length; taskIndex += 1) {
					expect(totalInvocations).toContain(taskIndex);
					expect(
						invocationsByKey.get(schedule[taskIndex].key) ?? [],
					).toContain(taskIndex);
				}
			}),
		);
	});

	it("clamps any 429 retry-after hint into the 10ms..30s range", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 2_000_000_000 }),
				async (retryAfterMs) => {
					const run = runCounter++;
					const delays: number[] = [];
					let failed = false;

					await withQueuedRetry(
						`/settings/prop-${run}-clamp.json`,
						async () => {
							if (!failed) {
								failed = true;
								throw Object.assign(new Error("throttled"), {
									status: 429,
									retryAfterMs,
								});
							}
							return "written";
						},
						{
							sleep: async (ms: number) => {
								delays.push(ms);
							},
						},
					);

					expect(delays).toEqual([
						Math.max(10, Math.min(30_000, Math.round(retryAfterMs))),
					]);
				},
			),
		);
	});
});
