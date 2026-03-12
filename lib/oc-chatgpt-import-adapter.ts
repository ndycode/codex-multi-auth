import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import {
	type AccountMetadataV3,
	type AccountStorageV3,
	normalizeEmailKey,
} from "./storage.js";

type MatchStrategy = "accountId" | "email" | "refreshToken";

export type OcChatgptImportPayload = AccountStorageV3;

export type OcChatgptPreviewPayload = {
	version: 3;
	activeIndex: number;
	activeIndexByFamily?: AccountStorageV3["activeIndexByFamily"];
	accounts: OcChatgptAccountRef[];
};

export type OcChatgptAccountRef = {
	accountId?: string;
	email?: string;
	refreshTokenLast4: string;
};

export type OcChatgptMergePreview = {
	payload: OcChatgptPreviewPayload;
	merged: AccountStorageV3; // WARNING: contains raw refreshToken values - do not log directly
	toAdd: OcChatgptAccountRef[];
	toUpdate: Array<{
		previous: OcChatgptAccountRef;
		next: OcChatgptAccountRef;
		matchedBy: MatchStrategy;
	}>;
	toSkip: Array<{ source: OcChatgptAccountRef; reason: string }>;
	unchangedDestinationOnly: OcChatgptAccountRef[];
	activeSelectionBehavior: "preserve-destination";
};

type NormalizedForTarget = {
	storage: AccountStorageV3;
	skipped: Array<{ source: OcChatgptAccountRef; reason: string }>;
};

/**
 * Clamp a numeric index to the valid range for an array of the given length.
 *
 * @param index - Desired index; non-finite values are treated as 0
 * @param length - Array length; lengths less than or equal to 0 produce 0
 * @returns A safe index between 0 and `length - 1` (or 0 when `length <= 0` or `index` is not finite)
 */
function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	if (!Number.isFinite(index)) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

/**
 * Selects the newer of two timestamped records.
 *
 * Compares `lastUsed` first (larger wins); if equal, compares `addedAt` (larger wins); ties prefer `current`.
 *
 * @param current - The current record to compare.
 * @param candidate - The candidate record to compare against `current`.
 * @returns The record considered newer: `candidate` if it is newer by `lastUsed` or `addedAt`, otherwise `current`.
 */
function pickNewest<T extends { addedAt?: number; lastUsed?: number }>(
	current: T,
	candidate: T,
): T {
	const currentLastUsed = Number.isFinite(current.lastUsed)
		? (current.lastUsed as number)
		: 0;
	const candidateLastUsed = Number.isFinite(candidate.lastUsed)
		? (candidate.lastUsed as number)
		: 0;
	if (candidateLastUsed > currentLastUsed) return candidate;
	if (candidateLastUsed < currentLastUsed) return current;

	const currentAdded = Number.isFinite(current.addedAt)
		? (current.addedAt as number)
		: 0;
	const candidateAdded = Number.isFinite(candidate.addedAt)
		? (candidate.addedAt as number)
		: 0;
	return candidateAdded > currentAdded ? candidate : current;
}

/**
 * Sanitize and normalize an AccountMetadataV3, returning null when the refresh token is missing or empty.
 *
 * Trims string fields (`refreshToken`, `accountId`, `email`, `accountLabel`), coercing empty trimmed values to `undefined` for optional fields.
 * Ensures `addedAt` and `lastUsed` are finite numbers, defaulting to `0` when not.
 * The refresh token is preserved (trimmed) for downstream use; callers are responsible for any redaction or secure handling.
 * This function has no filesystem or concurrency side effects.
 *
 * @param account - The account metadata to sanitize
 * @returns A normalized AccountMetadataV3 with trimmed fields and numeric timestamps, or `null` if the refresh token is empty after trimming
 */
function sanitizeAccount(account: AccountMetadataV3): AccountMetadataV3 | null {
	const refreshToken =
		typeof account.refreshToken === "string" ? account.refreshToken.trim() : "";
	if (!refreshToken) return null;
	const accountId =
		typeof account.accountId === "string"
			? account.accountId.trim()
			: undefined;
	const email =
		typeof account.email === "string" ? account.email.trim() : undefined;
	const accountLabel =
		typeof account.accountLabel === "string"
			? account.accountLabel.trim()
			: undefined;
	return {
		...account,
		accountId: accountId || undefined,
		email: email || undefined,
		accountLabel: accountLabel || undefined,
		refreshToken,
		addedAt: Number.isFinite(account.addedAt) ? (account.addedAt as number) : 0,
		lastUsed: Number.isFinite(account.lastUsed)
			? (account.lastUsed as number)
			: 0,
	};
}

/**
 * Produce a redacted 4-character representation of a refresh token for display.
 *
 * @param token - The raw token string to redact
 * @returns The last four characters of the trimmed token, or a string of asterisks equal to the token length if the trimmed token has four or fewer characters
 */
function tokenLast4(token: string): string {
	const trimmed = token.trim();
	if (trimmed.length <= 4) return "*".repeat(trimmed.length);
	return trimmed.slice(-4);
}

/**
 * Create a preview-safe account reference with a masked refresh token.
 *
 * @param account - The account metadata to summarize; its `refreshToken` is read and masked.
 * @returns An `OcChatgptAccountRef` containing `accountId`, `email`, and `refreshTokenLast4` (the last four characters of the trimmed token; if the token length is 4 or fewer characters, a string of asterisks of equal length is returned).
 *
 * Note: This function is pure and has no concurrency or Windows filesystem side effects. Token redaction follows the rule above to avoid exposing full tokens.
 */
function summarizeAccount(account: AccountMetadataV3): OcChatgptAccountRef {
	return {
		accountId: account.accountId,
		email: account.email,
		refreshTokenLast4: tokenLast4(account.refreshToken),
	};
}

function getAccountIdentityKey(account: AccountMetadataV3): string {
	const accountId = account.accountId?.trim();
	const email = normalizeEmailKey(account.email);
	if (accountId && email) return `account:${accountId}::email:${email}`;
	if (accountId) return `account:${accountId}`;
	if (email) return `email:${email}`;
	return `refresh:${account.refreshToken}`;
}

/**
 * Build a preview payload summarizing storage for display in an import preview.
 *
 * Produces a versioned payload containing the active index(s) and a list of account references with refresh tokens redacted to their last four characters. No concurrency guarantees are provided by this pure data transformation. This function has no special filesystem behavior on Windows.
 *
 * @param storage - Account storage to summarize into a preview payload
 * @returns A preview payload (version 3) with `activeIndex`, optional `activeIndexByFamily`, and an array of account summaries where refresh tokens are masked to their last four characters
 */
function buildPreviewPayload(
	storage: AccountStorageV3,
): OcChatgptPreviewPayload {
	return {
		version: 3,
		activeIndex: storage.activeIndex,
		activeIndexByFamily: storage.activeIndexByFamily
			? { ...storage.activeIndexByFamily }
			: undefined,
		accounts: storage.accounts.map(summarizeAccount),
	};
}

/**
 * Finds the index of an account in `accounts` that corresponds to `target` using normalized matching rules.
 *
 * Matching precedence:
 * 1. Trimmed `accountId` (if present on `target`).
 * 2. Normalized email (only against destination entries that have no `accountId`).
 * 3. Exact `refreshToken` match (only against destination entries that have no `accountId` and no normalized email).
 *
 * @param accounts - The list of normalized destination accounts to search.
 * @param target - The account to match against `accounts`.
 * @returns The index of a matching account in `accounts`, or `null` if no match is found.
 */
function findNormalizedAccountIndex(
	accounts: AccountMetadataV3[],
	target: AccountMetadataV3 | null | undefined,
): number | null {
	if (!target) return null;
	const targetAccountId = target.accountId?.trim();
	const targetEmail = normalizeEmailKey(target.email);
	if (targetAccountId && targetEmail) {
		const idx = accounts.findIndex(
			(account) =>
				account.accountId?.trim() === targetAccountId &&
				normalizeEmailKey(account.email) === targetEmail,
		);
		if (idx >= 0) return idx;
	}
	if (targetAccountId) {
		const idx = accounts.findIndex(
			(account) => account.accountId?.trim() === targetAccountId,
		);
		if (idx >= 0) return idx;
	}
	if (targetEmail) {
		const idx = accounts.findIndex(
			(account) =>
				!account.accountId && normalizeEmailKey(account.email) === targetEmail,
		);
		if (idx >= 0) return idx;
	}
	const idx = accounts.findIndex(
		(account) =>
			!account.accountId &&
			!normalizeEmailKey(account.email) &&
			account.refreshToken === target.refreshToken,
	);
	return idx >= 0 ? idx : null;
}

/**
 * Map an active account index from an original accounts list to the corresponding index in a normalized accounts list.
 *
 * Remaps the provided originalIndex by locating the same account (by id/email/refresh token) in normalizedAccounts; if not found, clamps the original position into the valid range of normalizedAccounts. Concurrency: function is pure and has no side effects. Windows filesystem: not applicable. Token redaction: refresh tokens are not exposed by this function.
 *
 * @param originalAccounts - The source account array that contains the original active index; may be undefined.
 * @param originalIndex - The active index within originalAccounts; may be undefined.
 * @param normalizedAccounts - The target account array after normalization to map into.
 * @returns The index within normalizedAccounts that corresponds to the original active position, clamped to [0, normalizedAccounts.length - 1].
 */
function remapActiveIndex(
	originalAccounts: AccountMetadataV3[] | undefined,
	originalIndex: number | undefined,
	normalizedAccounts: AccountMetadataV3[],
): number {
	if (!originalAccounts || originalAccounts.length === 0)
		return clampIndex(0, normalizedAccounts.length);
	const safeOriginalIndex = clampIndex(
		originalIndex ?? 0,
		originalAccounts.length,
	);
	const originalActive = originalAccounts[safeOriginalIndex];
	const remapped = findNormalizedAccountIndex(
		normalizedAccounts,
		originalActive,
	);
	if (remapped !== null) return remapped;
	return clampIndex(safeOriginalIndex, normalizedAccounts.length);
}

/**
 * Map per-model-family active indices from the original account list to the normalized account list.
 *
 * @param activeIndexByFamily - Optional mapping of model family keys to active account indices from the original storage.
 * @param originalAccounts - The original array of accounts corresponding to `activeIndexByFamily`, used as the source index space.
 * @param normalizedAccounts - The normalized array of accounts to which indices should be remapped.
 * @returns A mapping of model family keys to remapped indices aligned with `normalizedAccounts`, or `undefined` if no valid mappings exist.
 */
function normalizeActiveIndexByFamily(
	activeIndexByFamily: AccountStorageV3["activeIndexByFamily"],
	originalAccounts: AccountMetadataV3[] | undefined,
	normalizedAccounts: AccountMetadataV3[],
): AccountStorageV3["activeIndexByFamily"] {
	if (!activeIndexByFamily) return undefined;
	const normalized: Partial<Record<ModelFamily, number>> = {};
	for (const family of MODEL_FAMILIES) {
		const raw = (activeIndexByFamily as Partial<Record<ModelFamily, unknown>>)[
			family
		];
		if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
		normalized[family] = remapActiveIndex(
			originalAccounts,
			raw,
			normalizedAccounts,
		);
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Normalize and de-duplicate a list of account metadata for import into a target store.
 *
 * Processes input accounts by sanitizing entries, removing invalid refresh tokens, and
 * de-duplicating with the following precedence: accountId, normalized email, then refreshToken.
 * When duplicates are found the most recently used/added account is kept and the other is recorded
 * in `skipped` with a reason code.
 *
 * Concurrency: this function is synchronous and not safe for concurrent mutation of the same
 * input arrays; callers should handle synchronization. Token redaction: skipped entries include
 * masked token previews (`refreshTokenLast4`) rather than full refresh tokens. No filesystem or
 * Windows-specific behavior is performed here.
 *
 * @param accounts - Array of AccountMetadataV3 to normalize (may contain untrimmed or invalid fields)
 * @returns An object with:
 *   - `accounts`: sanitized, de-duplicated AccountMetadataV3 in order of precedence (by accountId, by email, by refreshToken)
 *   - `skipped`: array of sources summarized as OcChatgptAccountRef with a `reason` string; possible reasons include
 *       "invalid-refresh-token", "duplicate-account-id", "duplicate-email", and "duplicate-refresh-token"
 */
function normalizeAccountsForTarget(accounts: AccountMetadataV3[]): {
	accounts: AccountMetadataV3[];
	skipped: Array<{ source: OcChatgptAccountRef; reason: string }>;
} {
	const skipped: Array<{ source: OcChatgptAccountRef; reason: string }> = [];
	const valid: AccountMetadataV3[] = [];

	for (const candidate of accounts) {
		const sanitized = sanitizeAccount(candidate);
		if (!sanitized) {
			skipped.push({
				source: summarizeAccount({
					...candidate,
					refreshToken: candidate.refreshToken ?? "",
				} as AccountMetadataV3),
				reason: "invalid-refresh-token",
			});
			continue;
		}
		valid.push(sanitized);
	}

	const byAccountIdentity = new Map<string, AccountMetadataV3>();
	const withoutAccountId: AccountMetadataV3[] = [];

	for (const account of valid) {
		if (account.accountId) {
			const identityKey = getAccountIdentityKey(account);
			const existing = byAccountIdentity.get(identityKey);
			if (!existing) {
				byAccountIdentity.set(identityKey, account);
				continue;
			}
			const newest = pickNewest(existing, account);
			if (newest === account) {
				byAccountIdentity.set(identityKey, account);
				skipped.push({
					source: summarizeAccount(existing),
					reason: "duplicate-account-id",
				});
			} else {
				skipped.push({
					source: summarizeAccount(account),
					reason: "duplicate-account-id",
				});
			}
			continue;
		}
		withoutAccountId.push(account);
	}

	const byEmail = new Map<string, AccountMetadataV3>();
	const withoutIdentity: AccountMetadataV3[] = [];

	for (const account of withoutAccountId) {
		const normalizedEmail = normalizeEmailKey(account.email);
		if (normalizedEmail) {
			const existing = byEmail.get(normalizedEmail);
			if (!existing) {
				byEmail.set(normalizedEmail, account);
				continue;
			}
			const newest = pickNewest(existing, account);
			if (newest === account) {
				byEmail.set(normalizedEmail, account);
				skipped.push({
					source: summarizeAccount(existing),
					reason: "duplicate-email",
				});
			} else {
				skipped.push({
					source: summarizeAccount(account),
					reason: "duplicate-email",
				});
			}
			continue;
		}
		withoutIdentity.push(account);
	}

	const byRefreshToken = new Map<string, AccountMetadataV3>();
	for (const account of withoutIdentity) {
		const key = account.refreshToken;
		const existing = byRefreshToken.get(key);
		if (!existing) {
			byRefreshToken.set(key, account);
			continue;
		}
		const newest = pickNewest(existing, account);
		if (newest === account) {
			byRefreshToken.set(key, account);
			skipped.push({
				source: summarizeAccount(existing),
				reason: "duplicate-refresh-token",
			});
		} else {
			skipped.push({
				source: summarizeAccount(account),
				reason: "duplicate-refresh-token",
			});
		}
	}

	return {
		accounts: [
			...byAccountIdentity.values(),
			...byEmail.values(),
			...byRefreshToken.values(),
		],
		skipped,
	};
}

/**
 * Normalize an AccountStorageV3 (or null/undefined) for a target by sanitizing and deduplicating accounts, and remapping active indices.
 *
 * @param storage - Source storage to normalize; if null/undefined it is treated as empty storage
 * @returns An object containing `storage` (a normalized `AccountStorageV3` with sanitized accounts, remapped `activeIndex` and optional `activeIndexByFamily`) and `skipped` (array of account summaries with reasons for omission). Tokens in resulting summaries are redacted (last-4 visible); no filesystem or concurrency side effects occur.
 */
function normalizeStorageForTarget(
	storage: AccountStorageV3 | null | undefined,
): NormalizedForTarget {
	const { accounts, skipped } = normalizeAccountsForTarget(
		storage?.accounts ?? [],
	);
	const activeIndex = remapActiveIndex(
		storage?.accounts,
		storage?.activeIndex,
		accounts,
	);
	const activeIndexByFamily = normalizeActiveIndexByFamily(
		storage?.activeIndexByFamily,
		storage?.accounts,
		accounts,
	);
	return {
		storage: {
			version: 3,
			accounts: accounts.map((account) => ({ ...account })),
			activeIndex,
			activeIndexByFamily,
		},
		skipped,
	};
}

/**
 * Produce a shallow-cloned copy of an AccountStorageV3 suitable for independent mutation.
 *
 * The returned storage has a new array and new objects for each account (shallow copy of account fields),
 * preserves primitive fields verbatim, and shallow-copies `activeIndexByFamily` if present.
 *
 * @param storage - The source storage to clone; the source is not mutated.
 * @returns A cloned AccountStorageV3 whose accounts and top-level objects can be mutated without affecting the original.
 *
 * Concurrency: safe to use for concurrent reads; concurrent mutations to the original and the clone are not synchronized.
 * Filesystem: this function performs no filesystem I/O and is unaffected by OS-specific filesystem semantics (e.g., Windows).
 * Token handling: refresh tokens and other sensitive fields are copied as-is and are not redacted or transformed.
 */
function cloneStorage(storage: AccountStorageV3): AccountStorageV3 {
	return {
		version: 3,
		accounts: storage.accounts.map((account) => ({ ...account })),
		activeIndex: storage.activeIndex,
		activeIndexByFamily: storage.activeIndexByFamily
			? { ...storage.activeIndexByFamily }
			: undefined,
	};
}

/**
 * Finds a destination account that corresponds to the given source account by matching
 * in the order: trimmed `accountId`, normalized `email` (only against destination entries
 * without an `accountId`), then exact `refreshToken` equality across any remaining destination entry.
 *
 * Concurrency: caller must manage concurrent access to the destination array and `usedIndexes`.
 * Filesystem: no filesystem interactions or Windows-specific behavior.
 * Token handling: refresh tokens are compared as stored; any redaction for display occurs elsewhere.
 *
 * @param source - The source account to find a match for; `accountId` is trimmed and `email` is normalized.
 * @param destination - Array of destination accounts to search; entries in `usedIndexes` are ignored.
 * @param usedIndexes - Indexes in `destination` that have already been matched and should be skipped.
 * @returns An object with `index` of the matching destination entry and `matchedBy` indicating the match strategy,
 * or `null` if no match was found.
 */
function matchDestination(
	source: AccountMetadataV3,
	destination: AccountMetadataV3[],
	usedIndexes: Set<number>,
): { index: number; matchedBy: MatchStrategy } | null {
	const sourceAccountId = source.accountId?.trim();
	const sourceEmail = normalizeEmailKey(source.email);
	if (sourceAccountId && sourceEmail) {
		const idx = destination.findIndex(
			(account, i) =>
				!usedIndexes.has(i) &&
				typeof account.accountId === "string" &&
				account.accountId.trim() === sourceAccountId &&
				normalizeEmailKey(account.email) === sourceEmail,
		);
		if (idx >= 0) return { index: idx, matchedBy: "accountId" };
	}
	if (sourceAccountId) {
		const idx = destination.findIndex(
			(account, i) =>
				!usedIndexes.has(i) &&
				typeof account.accountId === "string" &&
				account.accountId.trim() === sourceAccountId,
		);
		if (idx >= 0) return { index: idx, matchedBy: "accountId" };
	}
	if (sourceEmail) {
		const idx = destination.findIndex((account, i) => {
			if (usedIndexes.has(i)) return false;
			if (account.accountId) return false;
			return normalizeEmailKey(account.email) === sourceEmail;
		});
		if (idx >= 0) return { index: idx, matchedBy: "email" };
	}

	const idx = destination.findIndex((account, i) => {
		if (usedIndexes.has(i)) return false;
		if (account.accountId) return false;
		if (normalizeEmailKey(account.email)) return false;
		return account.refreshToken === source.refreshToken;
	});
	if (idx >= 0) return { index: idx, matchedBy: "refreshToken" };

	return null;
}

/**
 * Produce a normalized AccountStorageV3 payload suitable for OC ChatGPT import.
 *
 * Normalizes and sanitizes the provided source storage for the target importer.
 *
 * @param source - The source AccountStorageV3 to normalize, or `null` to normalize an empty input.
 * @returns A normalized AccountStorageV3 ready for import. WARNING: this object may include raw `refreshToken` values; redact or mask tokens before logging, persisting to logs, or transmitting to external systems.
 *
 * Concurrency notes: the function does not perform synchronization; callers are responsible for coordinating concurrent access to the source data.
 *
 * Filesystem note: the function performs in-memory transformations only and has no special behavior for Windows filesystem semantics.
 */
export function buildOcChatgptImportPayload(
	source: AccountStorageV3 | null,
): OcChatgptImportPayload {
	const { storage } = normalizeStorageForTarget(source ?? null);
	return storage;
}

/**
 * Produces a detailed merge preview and merged storage that reconciles a source and destination AccountStorageV3.
 *
 * Normalizes source and destination inputs, identifies accounts to add, update, or skip (with reasons), preserves
 * destination-only unchanged accounts, and returns a merged AccountStorageV3 plus a preview payload. Refresh tokens
 * in preview entries are redacted (masked to last four characters). The function is synchronous, stateless, performs
 * no filesystem I/O (no Windows-specific behavior), and is safe to call concurrently from multiple callers.
 *
 * @param options.source - Source storage to import from; may be `null`.
 * @param options.destination - Destination storage to merge into; may be `null`.
 * @returns An OcChatgptMergePreview describing the normalized source preview (`payload`), the resulting merged storage
 *          (`merged`), lists of accounts to add (`toAdd`), accounts updated with previous/next summaries (`toUpdate`),
 *          skipped accounts with reasons (`toSkip`), destination-only unchanged accounts (`unchangedDestinationOnly`),
 *          and an `activeSelectionBehavior` hint.
 */
export function previewOcChatgptImportMerge(options: {
	source: AccountStorageV3 | null;
	destination: AccountStorageV3 | null;
}): OcChatgptMergePreview {
	const sourceNormalized = normalizeStorageForTarget(options.source);
	const destinationNormalized = normalizeStorageForTarget(options.destination);

	const merged = cloneStorage(destinationNormalized.storage);
	const destinationAccounts = merged.accounts.slice(
		0,
		destinationNormalized.storage.accounts.length,
	);
	const usedDestinationIndexes = new Set<number>();

	const toAdd: OcChatgptAccountRef[] = [];
	const toUpdate: OcChatgptMergePreview["toUpdate"] = [];
	const toSkip: OcChatgptMergePreview["toSkip"] = [
		...sourceNormalized.skipped,
		...destinationNormalized.skipped.map(({ source, reason }) => ({
			source,
			reason: `destination-${reason}`,
		})),
	];

	for (const account of sourceNormalized.storage.accounts) {
		const match = matchDestination(
			account,
			destinationAccounts,
			usedDestinationIndexes,
		);
		if (!match) {
			merged.accounts.push({ ...account });
			toAdd.push(summarizeAccount(account));
			continue;
		}

		const current = merged.accounts[match.index];
		if (!current) {
			merged.accounts[match.index] = { ...account };
			toAdd.push(summarizeAccount(account));
			continue;
		}
		const newest = pickNewest(current, account);
		usedDestinationIndexes.add(match.index);
		if (newest === current) {
			toSkip.push({
				source: summarizeAccount(account),
				reason: "unchanged-or-older-than-destination",
			});
			continue;
		}

		merged.accounts[match.index] = { ...newest };
		toUpdate.push({
			previous: summarizeAccount(current),
			next: summarizeAccount(newest),
			matchedBy: match.matchedBy,
		});
	}

	const destinationLength = destinationNormalized.storage.accounts.length;
	const unchangedDestinationOnly: OcChatgptAccountRef[] = [];
	for (let i = 0; i < destinationLength; i += 1) {
		if (usedDestinationIndexes.has(i)) continue;
		const account = destinationNormalized.storage.accounts[i];
		if (!account) continue;
		unchangedDestinationOnly.push(summarizeAccount(account));
	}

	return {
		payload: buildPreviewPayload(sourceNormalized.storage),
		merged,
		toAdd,
		toUpdate,
		toSkip,
		unchangedDestinationOnly,
		activeSelectionBehavior: "preserve-destination",
	};
}
