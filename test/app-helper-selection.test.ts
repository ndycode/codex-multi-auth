import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	RUNTIME_HELPER_CLOCK_TOLERANCE_MS,
	RUNTIME_HELPER_STATUS_STALE_MS,
	isLiveRuntimeHelper,
	isRuntimeHelperProcessAlive,
	liveRuntimeHelpers,
	readRuntimeHelperPid,
	selectRuntimeHelperStatus,
	type RuntimeHelperSelectable,
} from "../lib/runtime/app-helper-selection.js";
import { withDeadPid, withLivePid } from "./helpers/owned-pids.js";

// These four predicates decide whether a helper is reported as live, which
// helper `rotation status` names, and which account is marked `current`. They
// are exercised indirectly through two readers, where an inverted comparison or
// a reordered guard can hide behind a fixture that happens to agree. Pin them
// directly.

const NOW = 1_700_000_000_000;

function helper(
	overrides: Partial<RuntimeHelperSelectable> = {},
): RuntimeHelperSelectable {
	return {
		state: "running",
		pid: process.pid,
		startedAt: NOW - 60_000,
		updatedAt: NOW - 1_000,
		...overrides,
	};
}

describe("readRuntimeHelperPid", () => {
	it("accepts only positive integers", () => {
		expect(readRuntimeHelperPid(1)).toBe(1);
		expect(readRuntimeHelperPid(4242)).toBe(4242);
	});

	it.each([
		["zero", 0],
		["negative", -1234],
		["fractional", 4242.5],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["null", null],
		["undefined", undefined],
		["a numeric string", "4242"],
		["an object", { pid: 4242 }],
	])("rejects %s", (_label, value) => {
		expect(readRuntimeHelperPid(value)).toBeNull();
	});
});

describe("isRuntimeHelperProcessAlive", () => {
	it("reports a live PID as alive and a reaped one as dead", async () => {
		await withLivePid((livePid) => {
			expect(isRuntimeHelperProcessAlive(livePid)).toBe(true);
		});
		await withDeadPid((deadPid) => {
			expect(isRuntimeHelperProcessAlive(deadPid)).toBe(false);
		});
	});

	it("never probes a negative PID", () => {
		// `process.kill(-1234, 0)` is a POSIX process-*group* probe and succeeds on
		// any busy machine, so a record carrying a negative PID would otherwise
		// report a helper that does not exist as live. The guard has to reject it
		// before the syscall, not interpret the syscall's answer.
		expect(isRuntimeHelperProcessAlive(-1234)).toBe(false);
		expect(isRuntimeHelperProcessAlive(-1)).toBe(false);
		expect(isRuntimeHelperProcessAlive(0)).toBe(false);
	});
});

describe("isLiveRuntimeHelper", () => {
	it("accepts a running, live, freshly-published helper", () => {
		expect(isLiveRuntimeHelper(helper(), NOW)).toBe(true);
	});

	it.each([
		["stopped", "stopped"],
		["idle-timeout", "idle-timeout"],
		["max-lifetime", "max-lifetime"],
		["owner-gone", "owner-gone"],
		["error", "error"],
		["an unknown future state", "something-new"],
		["no state at all", null],
	])("rejects state %s even with a live PID", (_label, state) => {
		expect(isLiveRuntimeHelper(helper({ state }), NOW)).toBe(false);
	});

	it("rejects a dead PID", async () => {
		await withDeadPid((deadPid) => {
			expect(isLiveRuntimeHelper(helper({ pid: deadPid }), NOW)).toBe(false);
		});
	});

	it("rejects a record older than the staleness window", () => {
		const justInside = helper({
			updatedAt: NOW - RUNTIME_HELPER_STATUS_STALE_MS,
		});
		const justOutside = helper({
			updatedAt: NOW - RUNTIME_HELPER_STATUS_STALE_MS - 1,
		});
		expect(isLiveRuntimeHelper(justInside, NOW)).toBe(true);
		expect(isLiveRuntimeHelper(justOutside, NOW)).toBe(false);
	});

	it("falls back to bare liveness when the record has no updatedAt", () => {
		// Predates the heartbeat contract, so freshness is unknowable rather than
		// bad. Discarding it would be stricter than the behaviour it replaced.
		expect(isLiveRuntimeHelper(helper({ updatedAt: null }), NOW)).toBe(true);
	});

	it("tolerates a startedAt slightly in the future but not a bogus one", () => {
		const withinSkew = helper({
			startedAt: NOW + RUNTIME_HELPER_CLOCK_TOLERANCE_MS,
		});
		const beyondSkew = helper({
			startedAt: NOW + RUNTIME_HELPER_CLOCK_TOLERANCE_MS + 1,
		});
		expect(isLiveRuntimeHelper(withinSkew, NOW)).toBe(true);
		expect(isLiveRuntimeHelper(beyondSkew, NOW)).toBe(false);
	});

	it("ignores a missing startedAt", () => {
		expect(isLiveRuntimeHelper(helper({ startedAt: null }), NOW)).toBe(true);
	});
});

describe("selectRuntimeHelperStatus", () => {
	it("returns null for an empty set", () => {
		expect(selectRuntimeHelperStatus([], NOW)).toBeNull();
	});

	it("prefers the most recently updated live helper", () => {
		const older = helper({ updatedAt: NOW - 30_000 });
		const newer = helper({ updatedAt: NOW - 1_000 });
		// Both orderings, so the result cannot come from input order.
		expect(selectRuntimeHelperStatus([older, newer], NOW)).toBe(newer);
		expect(selectRuntimeHelperStatus([newer, older], NOW)).toBe(newer);
	});

	it("prefers any live helper over a fresher dead one", async () => {
		await withDeadPid((deadPid) => {
			const live = helper({ updatedAt: NOW - 30_000 });
			const deadButFresher = helper({ pid: deadPid, updatedAt: NOW });
			expect(selectRuntimeHelperStatus([deadButFresher, live], NOW)).toBe(live);
		});
	});

	it("falls back to the freshest record when nothing is live", async () => {
		await withDeadPid((deadPid) => {
			const older = helper({
				pid: deadPid,
				state: "idle-timeout",
				updatedAt: NOW - 60_000,
			});
			const newer = helper({
				pid: deadPid,
				state: "stopped",
				updatedAt: NOW - 10_000,
			});
			expect(selectRuntimeHelperStatus([older, newer], NOW)).toBe(newer);
		});
	});

	it("does not mutate the caller's array", () => {
		const older = helper({ updatedAt: NOW - 30_000 });
		const newer = helper({ updatedAt: NOW - 1_000 });
		const statuses = [older, newer];
		selectRuntimeHelperStatus(statuses, NOW);
		expect(statuses[0]).toBe(older);
		expect(statuses[1]).toBe(newer);
	});
});

describe("liveRuntimeHelpers", () => {
	it("counts only the live ones and preserves input order", async () => {
		await withDeadPid((deadPid) => {
			const first = helper({ updatedAt: NOW - 5_000 });
			const dead = helper({ pid: deadPid });
			const stale = helper({
				updatedAt: NOW - RUNTIME_HELPER_STATUS_STALE_MS - 1,
			});
			const second = helper({ updatedAt: NOW - 1_000 });
			expect(liveRuntimeHelpers([first, dead, stale, second], NOW)).toEqual([
				first,
				second,
			]);
		});
	});
});

describe("staleness window versus the wrapper's heartbeat", () => {
	it("stays well above the wrapper's publish cadence", () => {
		// The staleness window only works because a live helper republishes far
		// more often than it. That cadence is `APP_RUNTIME_HELPER_STATUS_HEARTBEAT_MS`
		// in `scripts/codex.js`, which this module cannot import — the wrapper has
		// to run before `dist/` exists, so the constant cannot be shared. Nothing
		// else links the two numbers, so raising the heartbeat past a tenth of the
		// staleness window would silently start declaring live helpers dead. Read
		// it out of the wrapper and fail loudly here instead.
		const wrapperPath = fileURLToPath(
			new URL("../scripts/codex.js", import.meta.url),
		);
		const wrapper = readFileSync(wrapperPath, "utf8");
		const match = /APP_RUNTIME_HELPER_STATUS_HEARTBEAT_MS\s*=\s*([0-9_]+)/.exec(
			wrapper,
		);
		expect(match?.[1]).toBeDefined();
		const heartbeatMs = Number.parseInt(
			(match?.[1] ?? "").replace(/_/g, ""),
			10,
		);
		expect(Number.isSafeInteger(heartbeatMs)).toBe(true);
		expect(heartbeatMs).toBeGreaterThan(0);
		// The wrapper only ever shortens this cadence (it publishes at
		// `min(heartbeat, idleTimeout, detachedIdle)`), so the constant is the
		// worst case and ten of them must still fit inside the staleness window.
		expect(RUNTIME_HELPER_STATUS_STALE_MS).toBeGreaterThanOrEqual(
			heartbeatMs * 10,
		);
	});
});
