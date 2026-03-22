import type { ModelFamily } from "../prompts/codex.js";
import type { AccountStorageV3 } from "../storage.js";
import type { TokenResult } from "../types.js";

export function clampRuntimeActiveIndices(
	storage: AccountStorageV3,
	modelFamilies: readonly ModelFamily[],
): void {
	const count = storage.accounts.length;
	if (count === 0) {
		storage.activeIndex = 0;
		storage.activeIndexByFamily = {};
		return;
	}

	storage.activeIndex = Math.max(0, Math.min(storage.activeIndex, count - 1));
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of modelFamilies) {
		const raw = storage.activeIndexByFamily[family];
		const candidate =
			typeof raw === "number" && Number.isFinite(raw)
				? raw
				: storage.activeIndex;
		storage.activeIndexByFamily[family] = Math.max(
			0,
			Math.min(candidate, count - 1),
		);
	}
}

export function isRuntimeFlaggableFailure(
	failure: Extract<TokenResult, { type: "failed" }>,
): boolean {
	if (failure.reason === "missing_refresh") return true;
	if (failure.statusCode === 401) return true;
	if (failure.statusCode !== 400) return false;
	const message = (failure.message ?? "").toLowerCase();
	return (
		message.includes("invalid_grant") ||
		message.includes("invalid refresh") ||
		message.includes("token has been revoked")
	);
}
