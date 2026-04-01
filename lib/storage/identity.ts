import { createHash } from "node:crypto";

type AccountLike = {
	accountId?: string;
	email?: string;
	refreshToken?: string;
};

type RuntimeAccountLike = {
	accountId?: string;
	email?: string;
	index?: number;
};

export type AccountIdentityRef = {
	accountId?: string;
	emailKey?: string;
	refreshToken?: string;
};

function normalizeAccountIdKey(accountId: string | undefined): string | undefined {
	if (!accountId) return undefined;
	const trimmed = accountId.trim();
	return trimmed || undefined;
}

export function normalizeEmailKey(
	email: string | undefined,
): string | undefined {
	if (!email) return undefined;
	const trimmed = email.trim();
	if (!trimmed) return undefined;
	return trimmed.toLowerCase();
}

function normalizeRefreshTokenKey(
	refreshToken: string | undefined,
): string | undefined {
	if (!refreshToken) return undefined;
	const trimmed = refreshToken.trim();
	return trimmed || undefined;
}

function hashRefreshTokenKey(refreshToken: string): string {
	return createHash("sha256").update(refreshToken).digest("hex");
}

export function toAccountIdentityRef(
	account:
		| Pick<AccountLike, "accountId" | "email" | "refreshToken">
		| null
		| undefined,
): AccountIdentityRef {
	return {
		accountId: normalizeAccountIdKey(account?.accountId),
		emailKey: normalizeEmailKey(account?.email),
		refreshToken: normalizeRefreshTokenKey(account?.refreshToken),
	};
}

function getIdentityKeyFromRef(
	ref: AccountIdentityRef,
	options: { allowRefreshFallback: boolean },
): string | undefined {
	if (ref.accountId && ref.emailKey) {
		return `account:${ref.accountId}::email:${ref.emailKey}`;
	}
	if (ref.accountId) return `account:${ref.accountId}`;
	if (ref.emailKey) return `email:${ref.emailKey}`;
	if (options.allowRefreshFallback && ref.refreshToken) {
		// Legacy refresh-only identity keys embedded raw tokens. Hashing preserves
		// deterministic fallback matching without exposing token material in logs.
		return `refresh:${hashRefreshTokenKey(ref.refreshToken)}`;
	}
	return undefined;
}

export function getAccountIdentityKey(
	account: Pick<AccountLike, "accountId" | "email" | "refreshToken">,
): string | undefined {
	const ref = toAccountIdentityRef(account);
	return getIdentityKeyFromRef(ref, { allowRefreshFallback: true });
}

export function getRuntimeAccountIdentityKey(
	account: Pick<RuntimeAccountLike, "accountId" | "email" | "index">,
): string | number | undefined {
	const ref = toAccountIdentityRef({
		accountId: account.accountId,
		email: account.email,
	});
	return (
		getIdentityKeyFromRef(ref, { allowRefreshFallback: false }) ??
		(typeof account.index === "number" ? account.index : undefined)
	);
}
