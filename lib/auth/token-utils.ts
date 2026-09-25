/**
 * Token utility functions for JWT parsing and account ID extraction.
 * Extracted from accounts.ts to reduce module size and improve cohesion.
 */

import { decodeJWT } from "./auth.js";
import { JWT_CLAIM_PATH } from "../constants.js";
import { isRecord } from "../utils.js";
import type { CodexCliMirror } from "../storage/public-types.js";
import type { AccountIdSource, JWTPayload } from "../types.js";

/**
 * Account ID candidate from token or organization data.
 */
export interface AccountIdCandidate {
	accountId: string;
	label: string;
	source: AccountIdSource;
	isDefault?: boolean;
	isPersonal?: boolean;
}

/**
 * Converts a value to a trimmed string if it's a non-empty string.
 * Local helper - returns undefined for non-strings (different from lib/utils.toStringValue).
 */
function toStringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Converts a value to boolean if possible.
 */
function toBoolean(value: unknown): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return undefined;
}

/**
 * Formats account ID to last 6 characters for display.
 */
function formatAccountIdSuffix(accountId: string): string {
	return accountId.length > 6 ? accountId.slice(-6) : accountId;
}

/**
 * Formats a label for token-derived account candidates.
 */
function formatTokenCandidateLabel(prefix: string, accountId: string): string {
	const suffix = formatAccountIdSuffix(accountId);
	return `${prefix} [id:${suffix}]`;
}

/**
 * Extracts account ID from a JWT payload.
 */
function extractAccountIdFromPayload(payload: JWTPayload | Record<string, unknown> | null): string | undefined {
	if (!payload) return undefined;
	const auth = payload[JWT_CLAIM_PATH];
	if (isRecord(auth)) {
		const id = toStringValue(auth.chatgpt_account_id);
		if (id) return id;
	}

	const direct =
		toStringValue((payload as Record<string, unknown>).chatgpt_account_id) ??
		toStringValue((payload as Record<string, unknown>).account_id) ??
		toStringValue((payload as Record<string, unknown>).accountId);
	return direct;
}

/**
 * Normalizes candidate arrays from various response formats.
 */
function normalizeCandidateArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (isRecord(value)) {
		const nested =
			value.data ??
			value.items ??
			value.accounts ??
			value.organizations ??
			value.workspaces ??
			value.teams;
		if (Array.isArray(nested)) return nested;
	}
	return [];
}

/**
 * Extracts a single account candidate from a record.
 */
function extractCandidateFromRecord(
	record: Record<string, unknown>,
	source: AccountIdSource,
): AccountIdCandidate | null {
	const accountId =
		toStringValue(record.account_id) ??
		toStringValue(record.accountId) ??
		toStringValue(record.chatgpt_account_id) ??
		toStringValue(record.organization_id) ??
		toStringValue(record.org_id) ??
		toStringValue(record.workspace_id) ??
		toStringValue(record.team_id) ??
		toStringValue(record.id);

	if (!accountId) return null;

	const name =
		toStringValue(record.name) ??
		toStringValue(record.display_name) ??
		toStringValue(record.title) ??
		toStringValue(record.organization_name) ??
		toStringValue(record.workspace_name) ??
		toStringValue(record.team_name) ??
		toStringValue(record.slug);
	const type =
		toStringValue(record.type) ??
		toStringValue(record.plan_type) ??
		toStringValue(record.kind) ??
		toStringValue(record.account_type);
	const role =
		toStringValue(record.role) ??
		toStringValue(record.membership_role) ??
		toStringValue(record.user_role);
	const isDefault = toBoolean(
		record.is_default ?? record.isDefault ?? record.default ?? record.primary ?? record.is_active ?? record.isActive ?? record.current,
	);
	const isPersonal = toBoolean(record.is_personal ?? record.isPersonal ?? record.personal);

	const suffix = formatAccountIdSuffix(accountId);
	const labelParts: string[] = [];
	let labelBase = name ?? "Workspace";

	if (!name && type) {
		labelBase = type;
	}

	if (type && (!name || name.toLowerCase() !== type.toLowerCase())) {
		labelParts.push(type);
	}
	if (role) {
		labelParts.push(`role:${role}`);
	}
	if (isPersonal) {
		labelParts.push("personal");
	}

	const meta = labelParts.length > 0 ? ` (${labelParts.join(", ")})` : "";
	const label = `${labelBase}${meta} [id:${suffix}]`;

	return {
		accountId,
		label,
		source,
		isDefault,
		isPersonal,
	};
}

/**
 * Collects candidates from a list of records.
 */
function collectCandidatesFromList(
	value: unknown,
	source: AccountIdSource,
): AccountIdCandidate[] {
	const result: AccountIdCandidate[] = [];
	const list = normalizeCandidateArray(value);
	if (list.length === 0) return result;

	for (const item of list) {
		if (!isRecord(item)) continue;
		const candidate = extractCandidateFromRecord(item, source);
		if (candidate) {
			result.push(candidate);
		}
	}
	return result;
}

/**
 * Collects candidates from a JWT payload.
 */
function collectCandidatesFromPayload(
	payload: JWTPayload | Record<string, unknown> | null,
	source: AccountIdSource,
): AccountIdCandidate[] {
	if (!payload || !isRecord(payload)) return [];

	const candidates: AccountIdCandidate[] = [];
	const keys = ["organizations", "orgs", "accounts", "workspaces", "teams"];
	for (const key of keys) {
		if (key in payload) {
			candidates.push(...collectCandidatesFromList(payload[key], source));
		}
	}

	const auth = payload[JWT_CLAIM_PATH];
	if (isRecord(auth)) {
		for (const key of keys) {
			if (key in auth) {
				candidates.push(...collectCandidatesFromList(auth[key], source));
			}
		}
	}

	return candidates;
}

/**
 * Removes duplicate candidates by accountId.
 */
function uniqueCandidates(candidates: AccountIdCandidate[]): AccountIdCandidate[] {
	const byId = new Map<string, AccountIdCandidate>();
	for (const candidate of candidates) {
		const kept = byId.get(candidate.accountId);
		if (!kept) {
			byId.set(candidate.accountId, { ...candidate });
			continue;
		}
		const wasPersonal = isPersonalAccountCandidate(kept);
		if (kept.isPersonal === undefined && candidate.isPersonal !== undefined) {
			kept.isPersonal = candidate.isPersonal;
		}
		if (!wasPersonal && isPersonalAccountCandidate(candidate) && kept.isPersonal !== false) {
			kept.label = candidate.label;
		}
	}
	return [...byId.values()];
}

/** Explicit metadata wins over the conventional Personal display name. */
export function isPersonalAccountCandidate(candidate: AccountIdCandidate): boolean {
	return candidate.isPersonal === true ||
		(candidate.isPersonal !== false && /^Personal(?:\s*\(|\s*\[|$)/i.test(candidate.label.trim()));
}

/**
 * Select the best workspace candidate for OAuth account binding.
 * Prefer a uniquely identifiable Personal workspace. Ambiguous CLI logins
 * require an explicit choice before reaching this fallback selector.
 * Fallback order when no unique Personal candidate exists:
 * 1) org default that is not personal
 * 2) org default (any)
 * 3) id_token candidate
 * 4) non-personal org candidate
 * 5) token candidate
 * 6) first candidate
 */
export function selectBestAccountCandidate(
	candidates: AccountIdCandidate[],
): AccountIdCandidate | undefined {
	if (candidates.length === 0) return undefined;
	const personal = candidates.filter(isPersonalAccountCandidate);
	if (personal.length === 1) return personal[0];

	const orgDefaultNonPersonal = candidates.find(
		(candidate) =>
			candidate.source === "org" && candidate.isDefault === true && candidate.isPersonal !== true,
	);
	if (orgDefaultNonPersonal) return orgDefaultNonPersonal;

	const orgDefault = candidates.find(
		(candidate) => candidate.source === "org" && candidate.isDefault === true,
	);
	if (orgDefault) return orgDefault;

	const idTokenCandidate = candidates.find(
		(candidate) => candidate.source === "id_token",
	);
	if (idTokenCandidate) return idTokenCandidate;

	const nonPersonalOrg = candidates.find(
		(candidate) => candidate.source === "org" && candidate.isPersonal !== true,
	);
	if (nonPersonalOrg) return nonPersonalOrg;

	const tokenCandidate = candidates.find(
		(candidate) => candidate.source === "token",
	);
	if (tokenCandidate) return tokenCandidate;

	return candidates[0];
}

/**
 * Extracts the ChatGPT account ID from a JWT access token.
 * @param accessToken - JWT access token from OAuth flow
 * @returns Account ID string or undefined if not found
 */
export function extractAccountId(accessToken?: string): string | undefined {
	if (!accessToken) return undefined;
	const decoded = decodeJWT(accessToken);
	const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
}

/**
 * Maps a stored account id to the value Codex CLI accepts as tokens.account_id.
 * Codex CLI >= 0.156 checks that field against the token's ChatGPT workspaces;
 * an OpenAI platform org id ("org-...") is never one of them, so it resolves to
 * the token's chatgpt_account_id claim instead, or undefined without a claim.
 * The auth.json writer and every stored-vs-auth.json comparison must share
 * this mapping, or org-sourced accounts read as permanently drifted.
 */
/** Whether an id is an OpenAI platform org id ("org-..."), never a ChatGPT workspace. */
export function isOpenAiOrgId(accountId: string | undefined): boolean {
	return /^org-/i.test(accountId?.trim() ?? "");
}

export function resolveCodexAuthAccountId(
	accountId: string | undefined,
	accessToken?: string,
	idToken?: string,
): string | undefined {
	const trimmed = accountId?.trim();
	if (!trimmed) return undefined;
	if (!isOpenAiOrgId(trimmed)) return trimmed;
	return extractAccountId(accessToken) ?? extractAccountId(idToken);
}

/**
 * The account id to hand the ~/.codex/auth.json writer for a saved account,
 * and to compare against that file. Applies the account's live
 * {@link CodexCliMirror} first, then resolveCodexAuthAccountId's org-id
 * substitution. An org id without a token claim is returned unchanged so the
 * writer can still drop it. Every auth.json writer and drift check goes
 * through this; a raw `account.accountId` there writes back an id Codex CLI
 * refuses.
 */
export function codexCliAccountIdFor(
	account: { accountId?: string; codexCliMirror?: CodexCliMirror },
	accessToken?: string,
	idToken?: string,
): string | undefined {
	const accountId = account.accountId?.trim();
	const mirror = account.codexCliMirror;
	const selected =
		accountId && mirror && mirror.forAccountId === accountId
			? mirror.accountId
			: account.accountId;
	return resolveCodexAuthAccountId(selected, accessToken, idToken) ?? selected;
}

interface CodexAccountIdentity {
	accountId?: string;
	accessToken?: string;
}

/**
 * The Codex CLI state's active account id with the access token of the
 * snapshot it came from, so an "org-..." id (the legacy accounts.json keeps
 * the raw id) can be resolved against that account's own token.
 */
export function codexCliActiveIdentity(state: {
	activeAccountId?: string;
	accounts?: ReadonlyArray<CodexAccountIdentity & { isActive?: boolean }>;
}): CodexAccountIdentity {
	const accountId = state.activeAccountId?.trim();
	const accounts = state.accounts ?? [];
	const snapshot =
		accounts.find((entry) => !!accountId && entry.accountId?.trim() === accountId) ??
		accounts.find((entry) => entry.isActive);
	return { accountId, accessToken: snapshot?.accessToken };
}

/**
 * Whether two account ids name the same Codex account. Equal raw ids match;
 * otherwise each side goes through resolveCodexAuthAccountId with its own
 * token, so a stored "org-..." id matches the workspace id the writer put in
 * auth.json. Unresolvable ids (org id, no claim) never match a different id.
 * Equal org ids still differ when both tokens name different workspaces.
 */
export function codexAuthAccountIdsMatch(
	left: CodexAccountIdentity,
	right: CodexAccountIdentity,
): boolean {
	const leftId = left.accountId?.trim();
	const rightId = right.accountId?.trim();
	if (!leftId || !rightId) return false;
	const leftResolved = resolveCodexAuthAccountId(leftId, left.accessToken);
	const rightResolved = resolveCodexAuthAccountId(rightId, right.accessToken);
	if (leftId === rightId) {
		return !leftResolved || !rightResolved || leftResolved === rightResolved;
	}
	return !!leftResolved && leftResolved === rightResolved;
}

/**
 * Extracts the email address from OAuth tokens.
 * Checks id_token first (where OpenAI puts email), then falls back to access_token.
 */
export function extractAccountEmail(accessToken?: string, idToken?: string): string | undefined {
	// Try id_token first - OpenAI puts email here
	if (idToken) {
		const idDecoded = decodeJWT(idToken);
		const idEmail = idDecoded?.email as string | undefined;
		if (typeof idEmail === "string" && idEmail.includes("@") && idEmail.trim()) {
			return idEmail;
		}
	}

	// Fall back to access_token
	if (!accessToken) return undefined;
	const decoded = decodeJWT(accessToken);
	const nested = decoded?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
	const candidate =
		(nested?.email as string | undefined) ??
		(nested?.chatgpt_user_email as string | undefined) ??
		(decoded?.email as string | undefined) ??
		(decoded?.preferred_username as string | undefined);
	if (typeof candidate === "string" && candidate.includes("@") && candidate.trim()) {
		return candidate;
	}
	return undefined;
}

/**
 * Extracts all accountId candidates from access/id tokens.
 * Used to support business workspaces/organizations that are not the token default.
 */
export function getAccountIdCandidates(
	accessToken?: string,
	idToken?: string,
): AccountIdCandidate[] {
	const candidates: AccountIdCandidate[] = [];
	const accessId = extractAccountId(accessToken);
	if (accessId) {
		candidates.push({
			accountId: accessId,
			label: formatTokenCandidateLabel("Token account", accessId),
			source: "token",
			isDefault: true,
		});
	}

	if (accessToken) {
		const accessDecoded = decodeJWT(accessToken);
		candidates.push(...collectCandidatesFromPayload(accessDecoded, "org"));
	}

	if (idToken) {
		const decoded = decodeJWT(idToken);
		const idAccountId = extractAccountIdFromPayload(decoded);
		if (idAccountId && idAccountId !== accessId) {
			candidates.push({
				accountId: idAccountId,
				label: formatTokenCandidateLabel("ID token account", idAccountId),
				source: "id_token",
			});
		}
		candidates.push(...collectCandidatesFromPayload(decoded, "org"));
	}

	return uniqueCandidates(candidates);
}

/**
 * Determines if accountId should be updated from a token-derived value.
 * We keep org/manual selections stable across refreshes.
 */
export function shouldUpdateAccountIdFromToken(
	source: AccountIdSource | undefined,
	currentAccountId?: string,
): boolean {
	if (!currentAccountId) return true;
	if (!source) return true;
	return source === "token" || source === "id_token";
}

/**
 * Resolve which accountId to use for runtime API calls.
 * Preserves explicit org/manual selections; only token/id_token sources auto-follow token changes.
 */
export function resolveRequestAccountId(
	storedAccountId: string | undefined,
	source: AccountIdSource | undefined,
	tokenAccountId: string | undefined,
): string | undefined {
	if (!storedAccountId) return tokenAccountId;
	if (!shouldUpdateAccountIdFromToken(source, storedAccountId)) {
		return storedAccountId;
	}
	return tokenAccountId ?? storedAccountId;
}

export interface RuntimeRequestIdentity {
	accountId?: string;
	email?: string;
	tokenAccountId?: string;
}

/**
 * Resolve the live request identity for an account using the stored workspace binding
 * plus the freshest token-derived hints available for this request.
 */
export function resolveRuntimeRequestIdentity(input: {
	storedAccountId?: string;
	source?: AccountIdSource;
	storedEmail?: string;
	accessToken?: string;
	idToken?: string;
}): RuntimeRequestIdentity {
	const tokenAccountId = extractAccountId(input.accessToken);
	return {
		accountId: resolveRequestAccountId(
			input.storedAccountId,
			input.source,
			tokenAccountId,
		),
		email:
			sanitizeEmail(extractAccountEmail(input.accessToken, input.idToken)) ??
			sanitizeEmail(input.storedEmail),
		tokenAccountId,
	};
}

/**
 * Sanitizes an email address by trimming whitespace and lowercasing.
 * @param email - Email string to sanitize
 * @returns Sanitized email or undefined if invalid
 */
export function sanitizeEmail(email: string | undefined): string | undefined {
	if (!email) return undefined;
	const trimmed = email.trim();
	if (!trimmed || !trimmed.includes("@")) return undefined;
	return trimmed.toLowerCase();
}
