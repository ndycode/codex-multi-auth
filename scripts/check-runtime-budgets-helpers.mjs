export function evaluateRuntimeBudgetGate(benchmarkPayload, budgetPayload) {
	const benchmarkResults = new Map(
		Array.isArray(benchmarkPayload.results)
			? benchmarkPayload.results
					.filter((entry) => entry && typeof entry.name === "string")
					.map((entry) => [entry.name, entry])
			: [],
	);
	const budgetEntries = Object.entries(budgetPayload.cases ?? {});
	if (budgetEntries.length === 0) {
		throw new Error("No budget cases defined");
	}

	const failures = [];
	const reportLines = [];
	for (const caseName of benchmarkResults.keys()) {
		if (!Object.prototype.hasOwnProperty.call(budgetPayload.cases ?? {}, caseName)) {
			failures.push(`unbudgeted benchmark case: ${caseName}`);
		}
	}
	for (const [caseName, caseBudget] of budgetEntries) {
		const result = benchmarkResults.get(caseName);
		if (!result) {
			failures.push(`missing benchmark case: ${caseName}`);
			continue;
		}

		const maxAvgMs =
			typeof caseBudget?.maxAvgMs === "number" && Number.isFinite(caseBudget.maxAvgMs)
				? caseBudget.maxAvgMs
				: null;
		if (maxAvgMs === null || maxAvgMs <= 0) {
			failures.push(`invalid budget maxAvgMs for case: ${caseName}`);
			continue;
		}

		const avgMs = typeof result.avgMs === "number" ? result.avgMs : NaN;
		if (!Number.isFinite(avgMs)) {
			failures.push(`invalid avgMs for case: ${caseName}`);
			continue;
		}

		const ratio = avgMs / maxAvgMs;
		const ratioLabel = `${(ratio * 100).toFixed(1)}%`;
		reportLines.push(
			`${caseName}: avg=${avgMs.toFixed(6)}ms budget=${maxAvgMs.toFixed(6)}ms (${ratioLabel})`,
		);
		if (avgMs > maxAvgMs) {
			failures.push(
				`${caseName}: avg ${avgMs.toFixed(6)}ms exceeds budget ${maxAvgMs.toFixed(6)}ms`,
			);
		}
	}

	return {
		budgetEntriesCount: budgetEntries.length,
		failures,
		reportLines,
	};
}
