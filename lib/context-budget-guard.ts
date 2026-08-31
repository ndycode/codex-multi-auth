import { getEffectiveContextWindow } from "./context-budget/model-context-windows.js";

export interface ContextBudgetSnapshot {
	model: string;
	totalTokens: number;
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
	totalTokens: number;
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
			this.enabled = options.enabled;
		}

		if (typeof options.softPercent === "number" && Number.isFinite(options.softPercent)) {
			this.softPercent = clampInt(options.softPercent, 0, 100);
		}

		if (typeof options.hardPercent === "number" && Number.isFinite(options.hardPercent)) {
			this.hardPercent = clampInt(options.hardPercent, 0, 100);
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

	/** Record the latest known context size for a session, from that turn's usage. */
	update(key: string, snapshot: ContextBudgetSnapshot): void {
		if (!key) return;
		this.maybePrune(snapshot.updatedAt || Date.now());
		this.snapshots.set(key, snapshot);
	}

	/** Evaluate before forwarding the NEXT request on this session key. */
	getAdvisory(key: string, now = Date.now()): ContextBudgetAdvisory {
		this.maybePrune(now);
		if (!this.enabled || !key) return { level: "ok" };

		const snapshot = this.snapshots.get(key);
		if (!snapshot) return { level: "ok" };

		const window = getEffectiveContextWindow(snapshot.model, this.modelWindowOverrides);
		if (!window || window.tokens <= 0) return { level: "ok" };

		const percent = (snapshot.totalTokens / window.tokens) * 100;
		if (percent >= this.hardPercent) {
			return {
				level: "hard",
				percent,
				totalTokens: snapshot.totalTokens,
				windowTokens: window.tokens,
				windowSource: window.source,
				model: snapshot.model,
			};
		}
		if (percent >= this.softPercent) {
			return {
				level: "soft",
				percent,
				totalTokens: snapshot.totalTokens,
				windowTokens: window.tokens,
				windowSource: window.source,
				model: snapshot.model,
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
}
