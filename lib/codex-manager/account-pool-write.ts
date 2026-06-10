import type { Workspace } from "../accounts.js";
import type { AccountMetadataV3 } from "../storage/public-types.js";

/**
 * Outcome of folding a single login result into the saved account pool.
 *
 * The CLI login flow uses this to report what actually happened instead of
 * always claiming `Added account` (issue #512): a same-email login that maps
 * onto an existing saved entry updates or rebinds it rather than growing the
 * pool.
 *
 * - `inserted`: a brand new saved entry was appended.
 * - `updated`: an existing entry was refreshed (tokens/label/email) with no
 *   previously-unknown workspace introduced.
 * - `rebound`: an existing entry gained at least one workspace id it was not
 *   tracking before (e.g. a different workspace on the same email).
 */
export type AccountPoolWriteOutcome = "inserted" | "updated" | "rebound";

/**
 * Identity/token fields resolved from a login result, ready to fold into the
 * saved pool. Field resolution (account id precedence, email sanitisation)
 * happens in the caller; this helper only owns the workspace-tracking and
 * outcome-classification logic that issue #512 depends on.
 */
export interface ResolvedAccountWrite {
	accountId?: string;
	accountIdSource?: AccountMetadataV3["accountIdSource"];
	accountLabel?: string;
	email?: string;
	refreshToken: string;
	accessToken?: string;
	expiresAt?: number;
	workspaces?: Workspace[];
	now: number;
}

/**
 * Choose the workspace a freshly-saved account should start on: prefer the
 * workspace whose id matches the resolved accountId, otherwise the first
 * enabled workspace, otherwise index 0.
 */
export function pickInitialWorkspaceIndex(
	workspaces: Workspace[],
	accountId: string | undefined,
): number {
	if (accountId) {
		const matching = workspaces.findIndex(
			(workspace) => workspace.id === accountId,
		);
		if (matching >= 0) return matching;
	}
	const firstEnabled = workspaces.findIndex(
		(workspace) => workspace.enabled !== false,
	);
	return firstEnabled >= 0 ? firstEnabled : 0;
}

/**
 * Merge incoming workspaces with the saved set, preserving any per-workspace
 * enabled/disabled state the user already had. Workspaces the login did not
 * surface are dropped only when the login returned a workspace list at all;
 * otherwise the existing list is kept untouched.
 */
export function mergeAccountWorkspaces(
	existing: Pick<AccountMetadataV3, "workspaces">,
	incoming: Workspace[] | undefined,
): Workspace[] | undefined {
	if (!incoming) return existing.workspaces;
	return incoming.map((newWs) => {
		const existingWs = existing.workspaces?.find((w) => w.id === newWs.id);
		return existingWs
			? {
					...newWs,
					enabled: existingWs.enabled,
					disabledAt: existingWs.disabledAt,
				}
			: newWs;
	});
}

/**
 * Resolve the workspace index a refreshed account should point at after a
 * merge: keep the user on their current workspace if it survived, else the
 * default workspace, else the first enabled one, else index 0.
 */
export function resolveCurrentWorkspaceIndex(
	existing: Pick<AccountMetadataV3, "workspaces" | "currentWorkspaceIndex">,
	mergedWorkspaces: Workspace[] | undefined,
): number | undefined {
	if (!mergedWorkspaces || mergedWorkspaces.length === 0) {
		return existing.currentWorkspaceIndex;
	}
	const currentWorkspaceId =
		existing.workspaces?.[
			typeof existing.currentWorkspaceIndex === "number"
				? existing.currentWorkspaceIndex
				: 0
		]?.id;
	if (currentWorkspaceId) {
		const matching = mergedWorkspaces.findIndex(
			(workspace) => workspace.id === currentWorkspaceId,
		);
		if (matching >= 0) return matching;
	}
	const defaultIndex = mergedWorkspaces.findIndex(
		(workspace) => workspace.isDefault === true,
	);
	if (defaultIndex >= 0) return defaultIndex;
	const firstEnabled = mergedWorkspaces.findIndex(
		(workspace) => workspace.enabled !== false,
	);
	return firstEnabled >= 0 ? firstEnabled : 0;
}

/**
 * Build the saved record for a login result that did not match any existing
 * entry, seeding its workspace tracking from the token-derived workspaces.
 */
export function buildInsertedAccount(
	write: ResolvedAccountWrite,
): { account: AccountMetadataV3; outcome: "inserted" } {
	const initialWorkspaceIndex =
		write.workspaces && write.workspaces.length > 0
			? pickInitialWorkspaceIndex(write.workspaces, write.accountId)
			: undefined;
	return {
		outcome: "inserted",
		account: {
			accountId: write.accountId,
			accountIdSource: write.accountIdSource,
			accountLabel: write.accountLabel,
			email: write.email,
			refreshToken: write.refreshToken,
			accessToken: write.accessToken,
			expiresAt: write.expiresAt,
			enabled: true,
			addedAt: write.now,
			lastUsed: write.now,
			workspaces: write.workspaces,
			currentWorkspaceIndex: initialWorkspaceIndex,
		},
	};
}

/**
 * Fold a login result onto an existing saved entry: refresh tokens/identity,
 * merge workspace tracking, and classify whether this was a plain `updated`
 * refresh or a `rebound` (a previously-unknown workspace appeared).
 */
export function buildUpdatedAccount(
	existing: AccountMetadataV3,
	write: ResolvedAccountWrite,
): { account: AccountMetadataV3; outcome: "updated" | "rebound" } {
	const nextEmail = write.email ?? existing.email;
	const nextAccountId = write.accountId ?? existing.accountId;
	const nextAccountIdSource = write.accountId
		? (write.accountIdSource ?? existing.accountIdSource)
		: existing.accountIdSource;

	const previousWorkspaceIds = new Set(
		(existing.workspaces ?? []).map((workspace) => workspace.id),
	);
	const mergedWorkspaces = mergeAccountWorkspaces(existing, write.workspaces);
	// Only a genuine *rebind* counts as "rebound": the account already tracked
	// workspaces and the login surfaced one it had never seen. First-time
	// enrichment of a pre-#491 row (no prior workspaces) is a plain `updated`,
	// so the user is not told "Rebound workspace" on their first workspace-aware
	// re-login (#512 follow-up).
	const introducedNewWorkspace =
		previousWorkspaceIds.size > 0 &&
		Boolean(
			write.workspaces?.some(
				(workspace) => !previousWorkspaceIds.has(workspace.id),
			),
		);
	const nextCurrentWorkspaceIndex = resolveCurrentWorkspaceIndex(
		existing,
		mergedWorkspaces,
	);

	return {
		outcome: introducedNewWorkspace ? "rebound" : "updated",
		account: {
			...existing,
			accountId: nextAccountId,
			accountIdSource: nextAccountIdSource,
			accountLabel: write.accountLabel ?? existing.accountLabel,
			email: nextEmail,
			refreshToken: write.refreshToken,
			accessToken: write.accessToken,
			expiresAt: write.expiresAt,
			enabled: true,
			lastUsed: write.now,
			workspaces: mergedWorkspaces,
			currentWorkspaceIndex: nextCurrentWorkspaceIndex,
		},
	};
}

/**
 * Fold a batch of resolved login writes into the saved account list, returning
 * the next account array, the selected index, and the outcome of the last
 * write. This is the pure core of `persistAccountPool`: it owns the dedup →
 * insert/update → workspace-tracking → active-index decisions that issue #512
 * depends on, with the matching strategy injected so the production path and
 * tests share the exact same behaviour.
 */
export function applyAccountPoolResults(params: {
	existing: AccountMetadataV3[];
	writes: ResolvedAccountWrite[];
	priorActiveIndex?: number;
	findMatchingAccountIndex: (
		accounts: AccountMetadataV3[],
		identity: {
			accountId?: string;
			email?: string;
			refreshToken?: string;
		},
		options: { allowUniqueAccountIdFallbackWithoutEmail: boolean },
	) => number | undefined;
}): {
	accounts: AccountMetadataV3[];
	activeIndex: number;
	outcome: AccountPoolWriteOutcome | null;
} {
	const accounts = [...params.existing];
	let selectedAccountIndex: number | null = null;
	let selectedOutcome: AccountPoolWriteOutcome | null = null;

	for (const write of params.writes) {
		const existingIndex = params.findMatchingAccountIndex(
			accounts,
			{
				accountId: write.accountId,
				email: write.email,
				refreshToken: write.refreshToken,
			},
			{ allowUniqueAccountIdFallbackWithoutEmail: true },
		);

		if (existingIndex === undefined) {
			const { account, outcome } = buildInsertedAccount(write);
			selectedAccountIndex = accounts.length;
			accounts.push(account);
			selectedOutcome = outcome;
			continue;
		}

		const existing = accounts[existingIndex];
		if (!existing) continue;

		const { account, outcome } = buildUpdatedAccount(existing, write);
		accounts[existingIndex] = account;
		selectedAccountIndex = existingIndex;
		selectedOutcome = outcome;
	}

	const fallbackActiveIndex =
		accounts.length === 0
			? 0
			: Math.max(0, Math.min(params.priorActiveIndex ?? 0, accounts.length - 1));
	const activeIndex =
		accounts.length === 0
			? 0
			: selectedAccountIndex === null
				? fallbackActiveIndex
				: Math.max(0, Math.min(selectedAccountIndex, accounts.length - 1));

	return { accounts, activeIndex, outcome: selectedOutcome };
}
