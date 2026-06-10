/**
 * Retry wrapper for account-storage writes. Lives in the storage layer so
 * lower-level callers (lib/accounts.ts) can use it without importing the
 * codex-manager layer; lib/codex-manager/forecast-report-shared.ts re-exports
 * it for its historical consumers.
 */

import { sleep } from "../utils.js";
import type { AccountStorageV3 } from "./public-types.js";

const RETRYABLE_STORAGE_WRITE_CODES = new Set(["EBUSY", "EPERM"]);

export function isRetryableStorageWriteError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_STORAGE_WRITE_CODES.has(code);
}

export async function saveAccountsWithRetry(
	storage: AccountStorageV3,
	saveAccounts: (storage: AccountStorageV3) => Promise<void>,
): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await saveAccounts(storage);
			return;
		} catch (error) {
			if (!isRetryableStorageWriteError(error) || attempt >= 3) {
				throw error;
			}
			await sleep(10 * 2 ** attempt);
		}
	}
}
