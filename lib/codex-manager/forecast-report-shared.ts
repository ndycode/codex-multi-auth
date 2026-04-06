import type { ForecastAccountResult } from "../forecast.js";
import type { CodexQuotaSnapshot } from "../quota-probe.js";
import {
	findMatchingAccountIndex,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../storage.js";
import type { TokenFailure } from "../types.js";
import { sleep } from "../utils.js";

const RETRYABLE_STORAGE_WRITE_CODES = new Set(["EBUSY", "EPERM"]);

export type AccountIdentityMatch = Pick<
	AccountMetadataV3,
	"accountId" | "email" | "refreshToken"
>;

export type RefreshedAccountPatch = Pick<
	AccountMetadataV3,
	"refreshToken" | "accessToken" | "expiresAt"
> & {
	email?: AccountMetadataV3["email"];
	accountId?: AccountMetadataV3["accountId"];
	accountIdSource?: AccountMetadataV3["accountIdSource"];
};

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

export function applyRefreshedAccountPatch(
	account: AccountMetadataV3,
	patch: RefreshedAccountPatch,
): void {
	account.refreshToken = patch.refreshToken;
	account.accessToken = patch.accessToken;
	account.expiresAt = patch.expiresAt;
	if (patch.email) account.email = patch.email;
	if (patch.accountId) {
		account.accountId = patch.accountId;
		account.accountIdSource = patch.accountIdSource;
	}
}

export async function persistRefreshedAccountPatch(
	storage: AccountStorageV3,
	accountMatch: AccountIdentityMatch,
	patch: RefreshedAccountPatch,
	loadAccounts: () => Promise<AccountStorageV3 | null>,
	saveAccounts: (storage: AccountStorageV3) => Promise<void>,
): Promise<void> {
	const latestStorage = (await loadAccounts()) ?? storage;
	const nextStorage = structuredClone(latestStorage);
	const targetIndex =
		findMatchingAccountIndex(nextStorage.accounts, accountMatch, {
			allowUniqueAccountIdFallbackWithoutEmail: true,
		}) ??
		findMatchingAccountIndex(nextStorage.accounts, patch, {
			allowUniqueAccountIdFallbackWithoutEmail: true,
		});
	if (targetIndex === undefined) {
		throw new Error("Unable to resolve refreshed account for persistence");
	}
	const targetAccount = nextStorage.accounts[targetIndex];
	if (!targetAccount) {
		throw new Error("Unable to resolve refreshed account for persistence");
	}
	applyRefreshedAccountPatch(targetAccount, patch);
	await saveAccountsWithRetry(nextStorage, saveAccounts);
}

export function serializeForecastResults(
	results: ForecastAccountResult[],
	liveQuotaByIndex: Map<number, CodexQuotaSnapshot>,
	refreshFailures: Map<number, TokenFailure>,
	formatQuotaSnapshotLine: (snapshot: CodexQuotaSnapshot) => string,
): Array<{
	index: number;
	label: string;
	isCurrent: boolean;
	selected: boolean;
	primaryReason?: string;
	availability: ForecastAccountResult["availability"];
	riskScore: number;
	riskLevel: ForecastAccountResult["riskLevel"];
	waitMs: number;
	reasons: string[];
	liveQuota?: {
		status: number;
		planType?: string;
		activeLimit?: number;
		model: string;
		summary: string;
	};
	refreshFailure?: TokenFailure;
}> {
	return results.map((result) => {
		const liveQuota = liveQuotaByIndex.get(result.index);
		return {
			index: result.index,
			label: result.label,
			isCurrent: result.isCurrent,
			selected: false,
			primaryReason: result.reasons[0],
			availability: result.availability,
			riskScore: result.riskScore,
			riskLevel: result.riskLevel,
			waitMs: result.waitMs,
			reasons: result.reasons,
			liveQuota: liveQuota
				? {
						status: liveQuota.status,
						planType: liveQuota.planType,
						activeLimit: liveQuota.activeLimit,
						model: liveQuota.model,
						summary: formatQuotaSnapshotLine(liveQuota),
				  }
				: undefined,
			refreshFailure: refreshFailures.get(result.index),
		};
	});
}
