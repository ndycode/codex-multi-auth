import { CODEX_BASE_URL } from "../constants.js";
import type { CodexCliMirror, Workspace } from "../storage/public-types.js";
import type { AccountIdSource } from "../types.js";
import { combineSignals } from "../utils.js";

/**
 * Which accounts the backend will actually let the current credentials act as.
 *
 * Codex CLI >= 0.156.0 resolves this itself through
 * `GET /backend-api/wham/accounts/check` before every request and refuses to run
 * when the account it was told to use is absent from the answer
 * ("selected workspace missing from routing discovery"). The id/organization
 * lists carried inside the token claims are NOT the same thing: a token can list
 * an organization it has no live authorization for, so selecting a workspace from
 * the claims alone can persist an account id that every later request rejects.
 */
export interface AuthorizedAccounts {
	/** Every account id the response listed, in the order it listed them. */
	accountIds: string[];
	/** The id the backend itself considers the default, when it named one. */
	defaultAccountId?: string;
}

export interface FetchAuthorizedAccountsOptions {
	/** Injection seam for tests; defaults to the global fetch. */
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}

const ACCOUNTS_CHECK_PATH = "/wham/accounts/check";
const ACCOUNTS_CHECK_TIMEOUT_MS = 10_000;

function readString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the account ids out of a `wham/accounts/check` payload.
 *
 * Returns null when the payload carries no usable list, which the caller must
 * treat as "unknown" rather than "nothing is authorized" — refusing every
 * account on a shape we failed to parse would break logins for a response format
 * change alone.
 */
export function parseAuthorizedAccounts(
	payload: unknown,
): AuthorizedAccounts | null {
	if (!isRecord(payload)) return null;

	const accounts = payload.accounts;
	if (!Array.isArray(accounts)) return null;

	const accountIds: string[] = [];
	for (const entry of accounts) {
		if (!isRecord(entry)) continue;
		const id = readString(entry.id) ?? readString(entry.account_id);
		if (id && !accountIds.includes(id)) accountIds.push(id);
	}
	if (accountIds.length === 0) return null;

	const defaultAccountId = readString(payload.default_account_id);
	return defaultAccountId ? { accountIds, defaultAccountId } : { accountIds };
}

/**
 * Asks the backend which accounts these credentials may act as.
 *
 * Fails open (resolves null) for every error: this check exists to catch a
 * selection that would not work, so an unreachable or unparseable answer must
 * leave the caller's existing behavior untouched rather than block a login.
 */
export async function fetchAuthorizedAccounts(
	accessToken: string,
	options: FetchAuthorizedAccountsOptions = {},
): Promise<AuthorizedAccounts | null> {
	const token = readString(accessToken);
	if (!token) return null;

	const doFetch = options.fetch ?? globalThis.fetch;
	const timeout = AbortSignal.timeout(ACCOUNTS_CHECK_TIMEOUT_MS);
	// combineSignals wraps AbortSignal.any (available on every Node the
	// engines floor, `>=22.19`, permits) with null-tolerance; the native composite also detaches
	// from a long-lived caller signal once this request completes.
	const signal = options.signal
		? combineSignals(options.signal, timeout)
		: timeout;

	try {
		const response = await doFetch(`${CODEX_BASE_URL}${ACCOUNTS_CHECK_PATH}`, {
			method: "GET",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json",
			},
			signal,
		});
		if (!response.ok) return null;
		return parseAuthorizedAccounts(await response.json());
	} catch {
		// Deliberately silent about the cause: the token is in scope here and the
		// failure is advisory, so there is nothing safe or useful to log.
		return null;
	}
}

export interface ConstrainedSelection {
	/** The account id to actually persist. */
	accountId: string;
	/** True when the backend's answer forced a different id than requested. */
	changed: boolean;
	/** The id that was rejected, present only when `changed` is true. */
	rejected?: string;
}

/**
 * Narrows a chosen account id to one the backend authorizes.
 *
 * Only ever narrows: with no authorization data, no default to fall back to, or
 * an id that is already authorized, the caller's own choice is returned
 * unchanged. That keeps this a guard against a known-bad write rather than a new
 * way for a login to end up somewhere the user did not ask for.
 */
export function constrainSelectionToAuthorized(
	accountId: string,
	authorized: AuthorizedAccounts | null,
): ConstrainedSelection {
	if (!authorized) return { accountId, changed: false };
	if (authorized.accountIds.includes(accountId)) {
		return { accountId, changed: false };
	}
	const fallback = authorized.defaultAccountId;
	if (!fallback || fallback === accountId) {
		return { accountId, changed: false };
	}
	return { accountId: fallback, changed: true, rejected: accountId };
}

/** The slice of a resolved login selection this guard reads and rewrites. */
export interface AccountSelectionLike {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	workspaces?: Workspace[];
}

/**
 * Applies {@link constrainSelectionToAuthorized} to a resolved login selection.
 *
 * On a rewrite the source becomes `token`: the backend's default account IS the
 * account these credentials are, so it must auto-follow later token refreshes
 * (see `shouldUpdateAccountIdFromToken`) instead of being pinned the way an
 * explicit org/manual choice is. The label follows the new id too; an empty
 * label (not undefined) is deliberate, because the account-pool merge keeps
 * the saved label on undefined and would go on naming the rejected workspace.
 *
 * The workspace list is narrowed with {@link toAuthorizedWorkspaces}.
 */
export function applyAuthorizedAccountConstraint<T extends AccountSelectionLike>(
	selection: T,
	authorized: AuthorizedAccounts | null,
): { selection: T; result: ConstrainedSelection | null } {
	const current = readString(selection.accountIdOverride);
	if (!current || !authorized) return { selection, result: null };

	const result = constrainSelectionToAuthorized(current, authorized);
	if (!result.changed) return { selection, result };

	const workspaces = selection.workspaces
		? toAuthorizedWorkspaces(selection.workspaces, authorized, result.accountId)
		: undefined;
	return {
		selection: {
			...selection,
			accountIdOverride: result.accountId,
			accountIdSource: "token",
			accountLabel:
				workspaces?.find((workspace) => workspace.id === result.accountId)
					?.name ?? "",
			...(workspaces ? { workspaces } : {}),
		},
		result,
	};
}

/**
 * Keeps only workspaces the backend authorizes and makes `accountId` the one
 * default, adding it when the token claims never listed it.
 *
 * The plugin host sends workspaces[currentWorkspaceIndex].id ahead of
 * accountId, and the account-pool merge keeps a saved pointer while its id
 * survives, else falls back to the default. With every unauthorized
 * workspace gone and `accountId` the only default, neither path can land on
 * a workspace the backend refuses.
 */
function toAuthorizedWorkspaces(
	workspaces: Workspace[],
	authorized: AuthorizedAccounts,
	accountId: string,
): Workspace[] {
	const kept = workspaces
		.filter(
			(workspace) =>
				workspace.id === accountId || authorized.accountIds.includes(workspace.id),
		)
		.map((workspace) => ({ ...workspace, isDefault: workspace.id === accountId }));
	if (!kept.some((workspace) => workspace.id === accountId)) {
		kept.push({ id: accountId, enabled: true, isDefault: true });
	}
	return kept;
}

/** The outcome of {@link refreshCodexCliMirror}. */
export type CodexCliMirrorUpdate = "set" | "cleared";

/**
 * Re-checks an explicit (`manual`) binding and keeps its CodexCliMirror in
 * step, mutating the record in place: set to the backend default while the
 * explicit id is unauthorized, removed once it is authorized again. The
 * explicit id itself is never changed. Fails open: no answer, no change.
 */
export async function refreshCodexCliMirror(
	account: {
		accountId?: string;
		accountIdSource?: AccountIdSource;
		codexCliMirror?: CodexCliMirror;
	},
	accessToken: string,
	options: FetchAuthorizedAccountsOptions = {},
): Promise<CodexCliMirrorUpdate | null> {
	if (account.accountIdSource !== "manual") return null;
	const currentId = readString(account.accountId);
	if (!currentId) return null;

	const authorized = await fetchAuthorizedAccounts(accessToken, options);
	if (!authorized) return null;
	if (authorized.accountIds.includes(currentId)) {
		if (!account.codexCliMirror) return null;
		delete account.codexCliMirror;
		return "cleared";
	}
	const result = constrainSelectionToAuthorized(currentId, authorized);
	if (!result.changed) return null;
	const mirror = account.codexCliMirror;
	if (mirror?.forAccountId === currentId && mirror.accountId === result.accountId) {
		return null;
	}
	account.codexCliMirror = { forAccountId: currentId, accountId: result.accountId };
	return "set";
}

/** The slice of a saved account record this migration reads and rewrites. */
export interface StoredAccountIdentity {
	accountId?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	workspaces?: Workspace[];
	currentWorkspaceIndex?: number;
}

/**
 * Rebinds a saved account's id when it is not one the backend currently
 * authorizes, mutating the record in place. This is the migration path for
 * accounts saved before this guard existed (or by `codex-multi-auth workspace
 * <account> <workspace>`, which has no live check of its own).
 *
 * Scoped to `accountIdSource === "org"` — the one source that never
 * auto-follows the token (`shouldUpdateAccountIdFromToken`). "token" /
 * "id_token" already self-correct through `applyTokenAccountIdentity`, and
 * "manual" is an explicit `login --org` binding this must not override.
 */
export async function reboundUnauthorizedAccountIdentity(
	account: StoredAccountIdentity,
	accessToken: string,
	options: FetchAuthorizedAccountsOptions = {},
): Promise<ConstrainedSelection | null> {
	if (account.accountIdSource !== "org") return null;
	const currentId = readString(account.accountId);
	if (!currentId) return null;

	const authorized = await fetchAuthorizedAccounts(accessToken, options);
	const result = constrainSelectionToAuthorized(currentId, authorized);
	if (!authorized || !result.changed) return null;

	account.accountId = result.accountId;
	account.accountIdSource = "token";
	// The workspace pointer has to follow the rebind: the plugin host sends
	// the pointed-at workspace id ahead of accountId.
	if (account.workspaces) {
		account.workspaces = toAuthorizedWorkspaces(
			account.workspaces,
			authorized,
			result.accountId,
		);
		const workspaceIndex = account.workspaces.findIndex(
			(workspace) => workspace.id === result.accountId,
		);
		account.currentWorkspaceIndex = workspaceIndex;
		account.accountLabel = account.workspaces[workspaceIndex]?.name ?? "";
	} else if (account.accountLabel !== undefined) {
		account.accountLabel = "";
	}
	return result;
}
