const MAX_TOTAL_OUTBOUND_REQUEST_ATTEMPTS = 6;
const MAX_STREAM_FAILOVERS = 1;
const MAX_STREAM_FAILOVER_CANDIDATES = 2;

/**
 * Clamp configured stream failover retries to the conservative runtime cap.
 */
export function capStreamFailoverMax(value: number): number {
	return Math.max(
		0,
		Math.min(MAX_STREAM_FAILOVERS, Math.floor(Number.isFinite(value) ? value : 0)),
	);
}

/**
 * Compute a finite per-request budget that bounds all outbound Responses API
 * fetches across account rotation, same-account retries, empty-response
 * retries, and stream failover.
 */
export function computeOutboundRequestAttemptBudget(params: {
	accountCount: number;
	maxSameAccountRetries: number;
	emptyResponseMaxRetries: number;
	streamFailoverMax: number;
}): number {
	const accountCount = Math.max(
		1,
		Math.floor(Number.isFinite(params.accountCount) ? params.accountCount : 1),
	);
	const maxSameAccountRetries = Math.max(
		0,
		Math.floor(
			Number.isFinite(params.maxSameAccountRetries)
				? params.maxSameAccountRetries
				: 0,
		),
	);
	const emptyResponseMaxRetries = Math.max(
		0,
		Math.floor(
			Number.isFinite(params.emptyResponseMaxRetries)
				? params.emptyResponseMaxRetries
				: 0,
		),
	);
	const streamFailoverMax = capStreamFailoverMax(params.streamFailoverMax);

	return Math.max(
		1,
		Math.min(
			accountCount +
				maxSameAccountRetries +
				emptyResponseMaxRetries +
				streamFailoverMax,
			MAX_TOTAL_OUTBOUND_REQUEST_ATTEMPTS,
		),
	);
}

/**
 * Build the ordered stream-failover candidate list for a request.
 *
 * The caller is expected to pass a valid primary account index from the
 * current account snapshot. This helper keeps the primary first and adds at
 * most one alternate account to avoid broad replay fan-out.
 */
export function buildStreamFailoverCandidateOrder(
	primaryIndex: number,
	accountIndices: number[],
): number[] {
	const order: number[] = [primaryIndex];

	for (const index of accountIndices) {
		if (!Number.isFinite(index) || index === primaryIndex || order.includes(index)) {
			continue;
		}
		order.push(index);
		if (order.length >= MAX_STREAM_FAILOVER_CANDIDATES) {
			break;
		}
	}

	return order;
}
