import type { AccountStorageV3 } from "./public-types.js";

export async function loadNormalizedStorageFromPath(
	path: string,
	label: string,
	deps: {
		loadAccountsFromPath: (path: string) => Promise<{
			normalized: AccountStorageV3 | null;
			schemaErrors: string[];
		}>;
		logWarn: (message: string, details: Record<string, unknown>) => void;
	},
): Promise<AccountStorageV3 | null> {
	try {
		const { normalized, schemaErrors } = await deps.loadAccountsFromPath(path);
		if (schemaErrors.length > 0) {
			deps.logWarn(`${label} schema validation warnings`, {
				path,
				errors: schemaErrors.slice(0, 5),
			});
		}
		return normalized;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			deps.logWarn(`Failed to load ${label}`, {
				path,
				error: String(error),
			});
		}
		return null;
	}
}

export function mergeStorageForMigration(
	current: AccountStorageV3 | null,
	incoming: AccountStorageV3,
	normalizeAccountStorage: (value: unknown) => AccountStorageV3 | null,
	// Injected like `normalizeAccountStorage` rather than imported from
	// ../storage.js, which would put this leaf module in a dependency cycle with
	// the storage barrel.
	findMatchingAccountIndex: (
		accounts: AccountStorageV3["accounts"],
		candidate: AccountStorageV3["accounts"][number],
	) => number | undefined,
): AccountStorageV3 {
	if (!current) {
		return incoming;
	}

	// Resolve the pinned account by IDENTITY before merging. normalizeAccountStorage
	// deduplicates the merged list but only RANGE-validates the pin, so a raw
	// positional pin that survives the range check can still end up pointing at a
	// different account once dedupe shifts positions.
	const pinnedAccount =
		typeof current.pinnedAccountIndex === "number"
			? current.accounts[current.pinnedAccountIndex]
			: undefined;

	const merged = normalizeAccountStorage({
		version: 3,
		activeIndex: current.activeIndex,
		activeIndexByFamily: current.activeIndexByFamily,
		accounts: [...current.accounts, ...incoming.accounts],
		// Carry the manual pin (#474) and affinity generation from the current
		// storage through legacy-project migration; normalizeAccountStorage
		// validates/clamps them against the merged account list. Omitting them
		// dropped the pin and reset affinityGeneration to 0, which let a running
		// proxy clobber a newer CLI pin.
		pinnedAccountIndex: current.pinnedAccountIndex,
		affinityGeneration: current.affinityGeneration,
	});
	if (!merged) {
		return current;
	}
	if (!pinnedAccount) {
		return merged;
	}
	// Re-point the pin at the account the user actually pinned; clear it when that
	// account no longer resolves in the normalized list.
	return {
		...merged,
		pinnedAccountIndex: findMatchingAccountIndex(merged.accounts, pinnedAccount),
	};
}
