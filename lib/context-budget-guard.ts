import { getEffectiveContextWindow } from "./context-budget/model-context-windows.js";

export interface ContextBudgetSnapshot {
	model: string;
	/**
	 * Tokens the NEXT turn on this session is expected to resend as context:
	 * this turn's `input_tokens` plus the part of its output that becomes
	 * conversation history. Deliberately NOT `total_tokens`, which also counts
	 * `reasoning_tokens` that the Responses API drops rather than resends —
	 * charging those against the window inflates every measurement by this
	 * turn's thinking budget and fires the guard early on long-reasoning turns.
	 */
	contextTokens: number;
	updatedAt: number;
}

export interface ContextBudgetOptions {
	enabled?: boolean;
	softPercent?: number;
	hardPercent?: number;
	modelWindowOverrides?: Record<string, number>;
}

interface ContextBudgetPressure {
	percent: number;
	contextTokens: number;
	windowTokens: number;
	windowSource: "override" | "estimate";
	model: string;
}

export type ContextBudgetAdvisory =
	| { level: "ok" }
	| ({ level: "soft" } & ContextBudgetPressure)
	| ({ level: "hard" } & ContextBudgetPressure);

const DEFAULT_SOFT_PERCENT = 65;
const DEFAULT_HARD_PERCENT = 69;
/**
 * Lowest hard threshold that can describe a real budget.
 *
 * `getContextBudgetGuardHardPercent` clamps rather than rejects (that is what
 * every other numeric setting does), so without a floor a configured `0` is a
 * legal value that makes `percent >= hardPercent` true for every snapshot —
 * every session pauses from its first recorded turn onward. Anything under
 * 10% of a window is that same failure in slower motion, so clamp up to a
 * value that at least can't fire on turn one of a normal session.
 */
const MIN_HARD_PERCENT = 10;
/** Sessions idle longer than this are dropped on the next prune sweep. */
const SESSION_TTL_MS = 6 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;

function clampInt(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Tracks how full each session's context window is and decides, before the
 * NEXT request on that session goes out, whether to nudge (soft) or pause
 * (hard) the caller.
 *
 * Deliberately shaped like `PreemptiveQuotaScheduler`
 * (`lib/preemptive-quota-scheduler.ts`): a per-key `Map` snapshot, a
 * `configure()`/decision-getter split, and a lazy `prune()` on the same
 * cadence. Same reason in both places — the decision needs to survive
 * across the request that observed the usage and the next request that
 * asks "are we still OK," and a scheduled sweep keeps memory bounded
 * without a dedicated timer.
 */
export class ContextBudgetGuard {
	private readonly snapshots = new Map<string, ContextBudgetSnapshot>();
	private enabled = false;
	private softPercent = DEFAULT_SOFT_PERCENT;
	private hardPercent = DEFAULT_HARD_PERCENT;
	private modelWindowOverrides: Record<string, number> | undefined;
	private lastPruneAt = 0;

	constructor(options: ContextBudgetOptions = {}) {
		this.configure(options);
	}

	configure(options: ContextBudgetOptions = {}): void {
		if (typeof options.enabled === "boolean") {
			// Turning the guard off must also drop what it already tracked, or a
			// disable/re-enable cycle re-evaluates against usage measured under
			// the old settings and can pause a session on its first request back.
			if (!options.enabled && this.enabled) {
				this.snapshots.clear();
			}
			this.enabled = options.enabled;
		}

		if (typeof options.softPercent === "number" && Number.isFinite(options.softPercent)) {
			this.softPercent = clampInt(options.softPercent, 0, 100);
		}

		if (typeof options.hardPercent === "number" && Number.isFinite(options.hardPercent)) {
			this.hardPercent = clampInt(options.hardPercent, MIN_HARD_PERCENT, 100);
		}

		// A misconfigured soft >= hard must degrade safely (guard fires later
		// than intended) rather than throw or produce a nonsensical "hard but
		// not soft" state. Never silently widen hard to fix it — narrowing soft
		// is the change least likely to surprise whoever set hard deliberately.
		if (this.softPercent >= this.hardPercent) {
			this.softPercent = Math.max(0, this.hardPercent - 1);
		}

		if (options.modelWindowOverrides) {
			this.modelWindowOverrides = options.modelWindowOverrides;
		}
	}

	private maybePrune(now: number): void {
		if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
		this.prune(now);
		this.lastPruneAt = now;
	}

	/**
	 * Record the latest known context size for a session, from that turn's usage.
	 *
	 * No-ops while disabled. The call sites sit on the hot path of every
	 * forwarded Responses turn, so a default-off install must not pay for a
	 * per-session map it will never read.
	 */
	update(key: string, snapshot: ContextBudgetSnapshot): void {
		if (!this.enabled || !key) return;
		this.maybePrune(snapshot.updatedAt || Date.now());
		this.snapshots.set(key, snapshot);
	}

	/**
	 * Evaluate before forwarding the NEXT request on this session key.
	 *
	 * `requestModel` is the model that request will use, and it is what the
	 * window is resolved from -- NOT the model of the last recorded turn. The
	 * two differ whenever a session switches models, and then the snapshot's
	 * model is the wrong denominator: a session carrying 205k tokens is 79% of
	 * a 260k window and a fifth of a 1M one. Using the stale model also let
	 * the guard pause a request for a model it deliberately refuses to
	 * estimate, and print that stale model's name in the notice. Falls back to
	 * the snapshot's model only when the request declares none.
	 */
	getAdvisory(
		key: string,
		now = Date.now(),
		requestModel?: string | null,
	): ContextBudgetAdvisory {
		this.maybePrune(now);
		if (!this.enabled || !key) return { level: "ok" };

		const snapshot = this.snapshots.get(key);
		if (!snapshot) return { level: "ok" };

		const trimmedRequestModel = requestModel?.trim();
		const evaluatedModel =
			trimmedRequestModel && trimmedRequestModel.length > 0
				? trimmedRequestModel
				: snapshot.model;
		const window = getEffectiveContextWindow(evaluatedModel, this.modelWindowOverrides);
		if (!window || window.tokens <= 0) return { level: "ok" };

		const percent = (snapshot.contextTokens / window.tokens) * 100;
		if (percent >= this.hardPercent) {
			return {
				level: "hard",
				percent,
				contextTokens: snapshot.contextTokens,
				windowTokens: window.tokens,
				windowSource: window.source,
				model: evaluatedModel,
			};
		}
		if (percent >= this.softPercent) {
			return {
				level: "soft",
				percent,
				contextTokens: snapshot.contextTokens,
				windowTokens: window.tokens,
				windowSource: window.source,
				model: evaluatedModel,
			};
		}
		return { level: "ok" };
	}

	/** Drop sessions untouched for a while so the map does not grow unbounded. */
	prune(now = Date.now()): number {
		let removed = 0;
		for (const [key, snapshot] of this.snapshots.entries()) {
			if (now - snapshot.updatedAt > SESSION_TTL_MS) {
				this.snapshots.delete(key);
				removed += 1;
			}
		}
		return removed;
	}

	/** Forget a single session's tracked usage, e.g. once it has visibly compacted. */
	forget(key: string): void {
		this.snapshots.delete(key);
	}

	/**
	 * Call immediately after emitting a hard pause for `key`.
	 *
	 * The pause is synthetic: it short-circuits before the request is forwarded,
	 * so `update()` never runs for it and the recorded usage can never fall on
	 * its own. Left in place, the first crossing of the hard threshold would
	 * block that session forever — including the `/compact` turn the pause
	 * message tells the user to run, which travels on the same session key.
	 *
	 * Dropping the snapshot makes the pause one-shot per measurement: the next
	 * request is forwarded and re-measures. A session that really did compact
	 * comes back under the threshold and stays quiet; one that did not gets
	 * paused again on the turn after, so the warning still repeats while the
	 * session is over budget, without ever becoming a dead end.
	 */
	noteHardPauseEmitted(key: string): void {
		this.snapshots.delete(key);
	}
}
