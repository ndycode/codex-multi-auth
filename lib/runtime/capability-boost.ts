import { resolveEntitlementAccountKey } from "../entitlement-cache.js";

export type AccountSnapshotCandidate = {
	index: number;
	email?: string;
	accountId?: string;
	accountLabel?: string;
	currentWorkspaceIndex?: number;
	workspaces?: Array<{
		id: string;
		name?: string;
		enabled?: boolean;
		isDefault?: boolean;
		disabledAt?: number;
	}>;
};

export function buildCapabilityBoostByAccount(input: {
	accountCount: number;
	model?: string;
	modelFamily: string;
	accountSnapshotSource: {
		getAccountsSnapshot?: () => AccountSnapshotCandidate[];
		getAccountByIndex?: (index: number) => AccountSnapshotCandidate | null;
	};
	getBoost: (accountKey: string, capabilityKey: string) => number;
}): number[] {
	const boosts = new Array<number>(Math.max(0, input.accountCount)).fill(0);
	const accountSnapshotList =
		typeof input.accountSnapshotSource.getAccountsSnapshot === "function"
			? (input.accountSnapshotSource.getAccountsSnapshot() ?? [])
			: [];

	if (
		accountSnapshotList.length === 0 &&
		typeof input.accountSnapshotSource.getAccountByIndex === "function"
	) {
		for (
			let accountSnapshotIndex = 0;
			accountSnapshotIndex < input.accountCount;
			accountSnapshotIndex += 1
		) {
			const candidate =
				input.accountSnapshotSource.getAccountByIndex(accountSnapshotIndex);
			if (candidate) accountSnapshotList.push(candidate);
		}
	}

	for (const candidate of accountSnapshotList) {
		const accountKey = resolveEntitlementAccountKey(candidate);
		boosts[candidate.index] = input.getBoost(
			accountKey,
			input.model ?? input.modelFamily,
		);
	}

	return boosts;
}
