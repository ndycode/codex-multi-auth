const MAX_TOTAL_OUTBOUND_REQUEST_ATTEMPTS = 6;
const MAX_STREAM_FAILOVERS = 1;
const MAX_STREAM_FAILOVER_CANDIDATES = 2;

export function capStreamFailoverMax(value: number): number {
	return Math.max(
		0,
		Math.min(MAX_STREAM_FAILOVERS, Math.floor(Number.isFinite(value) ? value : 0)),
	);
}

export function computeOutboundRequestAttemptBudget(params: {
	accountCount: number;
	maxSameAccountRetries: number;
	emptyResponseMaxRetries: number;
	streamFailoverMax: number;
}): number {
	const accountCount = Math.max(1, Math.floor(params.accountCount));
	const maxSameAccountRetries = Math.max(
		0,
		Math.floor(params.maxSameAccountRetries),
	);
	const emptyResponseMaxRetries = Math.max(
		0,
		Math.floor(params.emptyResponseMaxRetries),
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
