import { createHash } from "node:crypto";

/** Derive a legacy record identity before its first persisted token rotation. */
export function deriveAccountRecordId(
	account: {
		accountId?: string;
		email?: string;
		refreshToken: string;
		addedAt: number;
	},
): string {
	const seed = [
		account.addedAt,
		account.accountId?.trim() ?? "",
		account.email?.trim().toLowerCase() ?? "",
		account.refreshToken.trim(),
	].join("\u0000");
	return `record:${createHash("sha256").update(seed).digest("hex")}`;
}

/** Resolve the persisted identity, or derive it for a legacy row. */
export function resolveAccountRecordId(
	account: {
		recordId?: string;
		accountId?: string;
		email?: string;
		refreshToken: string;
		addedAt: number;
	},
): string {
	const stored = account.recordId?.trim();
	return stored || deriveAccountRecordId(account);
}

