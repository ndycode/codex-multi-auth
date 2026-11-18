import type { UsageTokenCounts } from "./types.js";

export interface StreamUsageDeferral<TRow> {
	/** Latest counts reported by upstream, or null if none have arrived. */
	captured: () => UsageTokenCounts | null;
	/** Feed upstream-reported counts. Writes a deferred row immediately. */
	onUsage: (usage: UsageTokenCounts) => void;
	/**
	 * Hand over a row to be written once upstream reports its counts, or after
	 * `fallbackMs` without them. Only the first pending row is held.
	 */
	defer: (completion: TRow) => void;
}

/**
 * Holds a usage-ledger row open until a streaming response reports its tokens.
 *
 * A streaming request's row would otherwise be written when the request handler
 * returns its Response — before the client has read a byte, and therefore
 * before the upstream `usage` event exists. The ledger is append-only, so that
 * row could never be corrected: it would stand at zero tokens and zero cost
 * forever, which is what silently disables the `maxTokens` and `maxCostUsd`
 * budget caps (`evaluateBudgetGuard` compares `0 >= limit`).
 *
 * The fallback timer is not optional bookkeeping. A client that disconnects
 * mid-stream, or an upstream that never emits a terminal usage event, must
 * still cost one row, because `maxRequests` counts rows — losing it would
 * weaken a cap that currently works.
 *
 * Generic over the row type so this stays inside `lib/usage` rather than
 * importing the policy layer that imports it back.
 */
export function createStreamUsageDeferral<TRow extends object>(options: {
	record: (completion: TRow & Partial<UsageTokenCounts>) => void;
	fallbackMs: number;
	/** Injectable for tests; defaults to an unref'd setTimeout. */
	schedule?: (run: () => void, ms: number) => { cancel: () => void };
}): StreamUsageDeferral<TRow> {
	const schedule =
		options.schedule ??
		((run, ms) => {
			const timer = setTimeout(run, ms);
			// Never hold the process open for a row that is only a fallback.
			timer.unref?.();
			return { cancel: () => clearTimeout(timer) };
		});

	let captured: UsageTokenCounts | null = null;
	let pending: TRow | null = null;
	let timer: { cancel: () => void } | null = null;

	const flush = (usage: UsageTokenCounts | null): void => {
		const completion = pending;
		pending = null;
		timer?.cancel();
		timer = null;
		if (!completion) return;
		options.record(usage ? { ...completion, ...usage } : completion);
	};

	return {
		captured: () => captured,
		onUsage: (usage) => {
			captured = usage;
			flush(usage);
		},
		defer: (completion) => {
			// A second defer would orphan the first row's timer, so keep the row
			// already in flight and let it settle on its own terms.
			if (pending) return;
			pending = completion;
			timer = schedule(() => flush(null), options.fallbackMs);
		},
	};
}
