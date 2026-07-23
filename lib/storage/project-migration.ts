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
): AccountStorageV3 {
	if (!current) {
		return incoming;
	}

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
	return merged;
}
