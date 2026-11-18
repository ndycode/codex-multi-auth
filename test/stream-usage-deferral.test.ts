import { describe, expect, it, vi } from "vitest";
import { createStreamUsageDeferral } from "../lib/usage/stream-usage-deferral.js";
import type { UsageTokenCounts } from "../lib/usage/types.js";

interface Row {
	outcome: "success";
	statusCode: number;
}

const ROW: Row = { outcome: "success", statusCode: 200 };

const USAGE: UsageTokenCounts = {
	inputTokens: 1_000,
	outputTokens: 300,
	cachedInputTokens: 400,
	reasoningTokens: 200,
	totalTokens: 1_500,
};

function harness() {
	const record = vi.fn();
	let fire: (() => void) | null = null;
	const cancel = vi.fn(() => {
		fire = null;
	});
	const schedule = vi.fn((run: () => void) => {
		fire = run;
		return { cancel };
	});
	const deferral = createStreamUsageDeferral<Row>({
		record,
		fallbackMs: 900_000,
		schedule,
	});
	return {
		deferral,
		record,
		cancel,
		schedule,
		fireFallback: () => {
			const run = fire;
			if (!run) throw new Error("no fallback armed");
			run();
		},
	};
}

describe("createStreamUsageDeferral", () => {
	it("writes the deferred row with token counts once usage arrives", () => {
		const { deferral, record, cancel } = harness();

		deferral.defer(ROW);
		expect(record).not.toHaveBeenCalled();

		deferral.onUsage(USAGE);

		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith({ ...ROW, ...USAGE });
		// The armed fallback must be cancelled, or it would try to write a
		// second row for the same request.
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("writes the row without counts when the fallback fires first", () => {
		const { deferral, record, fireFallback } = harness();

		// A client that disconnects mid-stream never pulls the terminal usage
		// event. The row must still be written, because maxRequests counts rows.
		deferral.defer(ROW);
		fireFallback();

		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith(ROW);
	});

	it("writes exactly one row when usage arrives after the fallback", () => {
		const { deferral, record, fireFallback } = harness();

		deferral.defer(ROW);
		fireFallback();
		deferral.onUsage(USAGE);

		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith(ROW);
	});

	it("does nothing when usage arrives with no row deferred", () => {
		const { deferral, record, schedule } = harness();

		// The non-streaming path folds captured() into its row itself and never
		// defers, so the callback must stay inert there.
		deferral.onUsage(USAGE);

		expect(record).not.toHaveBeenCalled();
		expect(schedule).not.toHaveBeenCalled();
		expect(deferral.captured()).toEqual(USAGE);
	});

	it("exposes the counts for a caller that folds them in itself", () => {
		const { deferral } = harness();

		expect(deferral.captured()).toBeNull();
		deferral.onUsage(USAGE);
		expect(deferral.captured()).toEqual(USAGE);
	});

	it("keeps the first deferred row rather than orphaning its timer", () => {
		const { deferral, record, schedule } = harness();
		const second: Row = { outcome: "success", statusCode: 201 };

		deferral.defer(ROW);
		deferral.defer(second);
		deferral.onUsage(USAGE);

		expect(schedule).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith({ ...ROW, ...USAGE });
	});
});
