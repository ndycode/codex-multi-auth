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

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	if (!Number.isFinite(index)) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

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
		accountLabel: accountLabel || account.accountLabel,
		refreshToken,
		addedAt: Number.isFinite(account.addedAt) ? (account.addedAt as number) : 0,
		lastUsed: Number.isFinite(account.lastUsed)
			? (account.lastUsed as number)
			: 0,
	};
}

function tokenLast4(token: string): string {
	const trimmed = token.trim();
	if (trimmed.length <= 4) return "*".repeat(trimmed.length);
	return trimmed.slice(-4);
}

function summarizeAccount(account: AccountMetadataV3): OcChatgptAccountRef {
	return {
		accountId: account.accountId,
		email: account.email,
		refreshTokenLast4: tokenLast4(account.refreshToken),
	};
}

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

function findNormalizedAccountIndex(
	accounts: AccountMetadataV3[],
	target: AccountMetadataV3 | null | undefined,
): number | null {
	if (!target) return null;
	const targetAccountId = target.accountId?.trim();
	if (targetAccountId) {
		const idx = accounts.findIndex(
			(account) => account.accountId?.trim() === targetAccountId,
		);
		if (idx >= 0) return idx;
	}
	const targetEmail = normalizeEmailKey(target.email);
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

	const byAccountId = new Map<string, AccountMetadataV3>();
	const withoutAccountId: AccountMetadataV3[] = [];

	for (const account of valid) {
		if (account.accountId) {
			const existing = byAccountId.get(account.accountId);
			if (!existing) {
				byAccountId.set(account.accountId, account);
				continue;
			}
			const newest = pickNewest(existing, account);
			if (newest === account) {
				byAccountId.set(account.accountId, account);
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
			...byAccountId.values(),
			...byEmail.values(),
			...byRefreshToken.values(),
		],
		skipped,
	};
}

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

function matchDestination(
	source: AccountMetadataV3,
	destination: AccountMetadataV3[],
	usedIndexes: Set<number>,
): { index: number; matchedBy: MatchStrategy } | null {
	const sourceAccountId = source.accountId?.trim();
	if (sourceAccountId) {
		const idx = destination.findIndex(
			(account, i) =>
				!usedIndexes.has(i) &&
				typeof account.accountId === "string" &&
				account.accountId.trim() === sourceAccountId,
		);
		if (idx >= 0) return { index: idx, matchedBy: "accountId" };
	}

	const sourceEmail = normalizeEmailKey(source.email);
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

export function buildOcChatgptImportPayload(
	source: AccountStorageV3 | null,
): OcChatgptImportPayload {
	const { storage } = normalizeStorageForTarget(source ?? null);
	return storage;
}

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
	const toSkip: OcChatgptMergePreview["toSkip"] = [...sourceNormalized.skipped];

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
