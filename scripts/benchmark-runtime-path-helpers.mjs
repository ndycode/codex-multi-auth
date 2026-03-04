export function assertSyncBenchmarkMergeResult(reconciled, options = {}) {
	const minimumAccounts =
		typeof options.minimumAccounts === "number" && Number.isFinite(options.minimumAccounts)
			? Math.max(1, Math.floor(options.minimumAccounts))
			: 1;
	const expectedRefreshToken =
		typeof options.expectedRefreshToken === "string" ? options.expectedRefreshToken : "";
	const caseName = typeof options.caseName === "string" ? options.caseName : "codexCliSync_merge_1000";

	if (!reconciled?.storage || !reconciled.changed || reconciled.storage.accounts.length < minimumAccounts) {
		throw new Error(`${caseName} failed`);
	}
	if (expectedRefreshToken && reconciled.storage.accounts[0]?.refreshToken !== expectedRefreshToken) {
		throw new Error(`${caseName} failed`);
	}
}
