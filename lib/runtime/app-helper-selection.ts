import process from "node:process";

/**
 * The fields any helper status record has to expose for the shared selector to
 * reason about it. `rotation status` and runtime account resolution carry
 * different extra fields — request counters on one side, account identity on
 * the other — but they answer "which helper is current" the same way, and used
 * to answer it with two hand-rolled copies that could drift apart within a
 * single command (#667).
 */
export interface RuntimeHelperSelectable {
	state: string | null;
	pid: number | null;
	startedAt: number | null;
	updatedAt: number | null;
}

/**
 * How stale a `running` record may be before it stops counting as live.
 *
 * A running helper republishes its status on every tick, and the publish path
 * heartbeats at least once per `APP_RUNTIME_HELPER_STATUS_HEARTBEAT_MS` (60s)
 * even when nothing in the payload changed. Ten heartbeats of silence is not a
 * helper that is merely quiet — it is a record whose writer is gone.
 *
 * This is the identity check these readers were missing. `kill(pid, 0)` answers
 * "does *a* process hold this integer", so a stale record — classically the
 * legacy shared `runtime-rotation-app-helper.json` left behind by a SIGKILLed
 * pre-upgrade helper — passes liveness as soon as an unrelated process is
 * handed its PID, and can then win selection outright. Freshness is the half of
 * identity available to a synchronous reader: the wrapper verifies identity by
 * probing kernel start times, but that costs a `ps` per candidate, and these
 * two call sites are read-only status paths reached from the interactive menu
 * as well as the CLI. Whoever holds the PID now, they are not the process that
 * last wrote this file.
 */
export const RUNTIME_HELPER_STATUS_STALE_MS = 10 * 60 * 1000;

/** Tolerance for clock skew between the writing helper and the reader. */
export const RUNTIME_HELPER_CLOCK_TOLERANCE_MS = 60 * 1000;

/**
 * A PID is a positive integer or it is nothing. Both readers used to accept any
 * finite number, so a corrupt or hand-edited record carrying `-1234` reached
 * `process.kill(-1234, 0)` — which on POSIX probes process *group* 1234 and
 * succeeds on any busy machine, reporting a helper that does not exist as live.
 * Fractional values were accepted the same way.
 */
export function readRuntimeHelperPid(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: null;
}

/**
 * Best-effort liveness probe. `EPERM` means a process exists that this user may
 * not signal, so it counts as alive; every other errno — including the `EINVAL`
 * some platforms raise for a PID above their ceiling — counts as dead.
 */
export function isRuntimeHelperProcessAlive(pid: number | null): boolean {
	const probePid = readRuntimeHelperPid(pid);
	if (probePid === null) return false;
	try {
		process.kill(probePid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		return code === "EPERM";
	}
}

/**
 * The single definition of "this helper is currently serving": a running state,
 * a live PID, and a record recent enough to have been written by that PID's
 * current occupant.
 */
export function isLiveRuntimeHelper(
	status: RuntimeHelperSelectable,
	now: number = Date.now(),
): boolean {
	if (status.state !== "running") return false;
	if (!isRuntimeHelperProcessAlive(status.pid)) return false;
	// A record that claims to have started after the current instant was not
	// written by a process that is running now.
	if (
		status.startedAt !== null &&
		status.startedAt > now + RUNTIME_HELPER_CLOCK_TOLERANCE_MS
	) {
		return false;
	}
	// A record with no `updatedAt` at all predates the heartbeat contract and
	// cannot be judged on freshness; it falls back to bare liveness rather than
	// being discarded, which is no worse than the behaviour it replaces.
	if (status.updatedAt === null) return true;
	return now - status.updatedAt <= RUNTIME_HELPER_STATUS_STALE_MS;
}

/** Every helper that passes {@link isLiveRuntimeHelper}, input order preserved. */
export function liveRuntimeHelpers<T extends RuntimeHelperSelectable>(
	statuses: readonly T[],
	now: number = Date.now(),
): T[] {
	return statuses.filter((status) => isLiveRuntimeHelper(status, now));
}

function byRecency(
	left: RuntimeHelperSelectable,
	right: RuntimeHelperSelectable,
): number {
	return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
}

/**
 * Prefer a live helper, and among several the most recently updated. Absent any
 * live helper, fall back to the freshest record so the previous "reports the
 * last helper's final state" behaviour survives.
 *
 * Callers that also need the live count must pass the same `statuses` array and
 * the same `now` to {@link liveRuntimeHelpers}, so the selected helper and the
 * count describe one instant rather than two.
 */
export function selectRuntimeHelperStatus<T extends RuntimeHelperSelectable>(
	statuses: readonly T[],
	now: number = Date.now(),
): T | null {
	if (statuses.length === 0) return null;
	const live = liveRuntimeHelpers(statuses, now).sort(byRecency);
	if (live.length > 0) return live[0] ?? null;
	return [...statuses].sort(byRecency)[0] ?? null;
}
