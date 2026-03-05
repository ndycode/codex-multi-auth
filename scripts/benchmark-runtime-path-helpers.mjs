import { rm } from "node:fs/promises";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function removeWithRetry(
	path,
	options,
	dependencies = {},
) {
	const remove = dependencies.remove ?? rm;
	const delay = dependencies.sleep ?? sleep;
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await remove(path, options);
			return;
		} catch (error) {
			const code = error?.code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await delay(25 * 2 ** attempt);
		}
	}
}

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
