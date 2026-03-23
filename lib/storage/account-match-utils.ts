type AccountLike = {
	addedAt?: number;
	lastUsed?: number;
};

export function selectNewestAccount<T extends AccountLike>(
	current: T | undefined,
	candidate: T,
): T {
	if (!current) return candidate;
	const currentLastUsed = current.lastUsed || 0;
	const candidateLastUsed = candidate.lastUsed || 0;
	if (candidateLastUsed > currentLastUsed) return candidate;
	if (candidateLastUsed < currentLastUsed) return current;
	const currentAddedAt = current.addedAt || 0;
	const candidateAddedAt = candidate.addedAt || 0;
	return candidateAddedAt >= currentAddedAt ? candidate : current;
}

export function collectDistinctIdentityValues(
	values: Array<string | undefined>,
): Set<string> {
	const distinct = new Set<string>();
	for (const value of values) {
		if (value) distinct.add(value);
	}
	return distinct;
}

export function findNewestMatchingIndex<T, TRef>(
	accounts: readonly T[],
	toRef: (account: T) => TRef,
	predicate: (ref: TRef) => boolean,
	selectNewest: (current: T | undefined, candidate: T) => T,
): number | undefined {
	let matchIndex: number | undefined;
	let match: T | undefined;
	for (let i = 0; i < accounts.length; i += 1) {
		const account = accounts[i];
		if (!account) continue;
		const ref = toRef(account);
		if (!predicate(ref)) continue;
		if (matchIndex === undefined) {
			matchIndex = i;
			match = account;
			continue;
		}
		const newest = selectNewest(match, account);
		if (newest === account) {
			matchIndex = i;
			match = account;
		}
	}
	return matchIndex;
}
