import { createLogger } from "../logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import { type AccountStorageV3 } from "../storage.js";
import { incrementCodexCliMetric } from "./observability.js";

const log = createLogger("codex-cli-sync");

function cloneStorage(storage: AccountStorageV3): AccountStorageV3 {
	return {
		version: 3,
		accounts: storage.accounts.map((account) => ({ ...account })),
		activeIndex: storage.activeIndex,
		activeIndexByFamily: storage.activeIndexByFamily
			? { ...storage.activeIndexByFamily }
			: {},
	};
}

function normalizeIndexCandidate(value: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.trunc(value);
}

function normalizeStoredFamilyIndexes(storage: AccountStorageV3): void {
	const count = storage.accounts.length;
	const normalizedActiveIndex = normalizeIndexCandidate(storage.activeIndex, 0);
	const clamped =
		count === 0 ? 0 : Math.max(0, Math.min(normalizedActiveIndex, count - 1));
	if (storage.activeIndex !== clamped) {
		storage.activeIndex = clamped;
	}
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		const raw = storage.activeIndexByFamily[family];
		const resolved =
			typeof raw === "number"
				? normalizeIndexCandidate(raw, storage.activeIndex)
				: storage.activeIndex;
		storage.activeIndexByFamily[family] =
			count === 0 ? 0 : Math.max(0, Math.min(resolved, count - 1));
	}
}

/**
 * Preserves one-way mirror semantics for Codex CLI compatibility state.
 *
 * Multi-auth storage is the canonical source of truth. Codex CLI account files are mirrors only
 * and must never seed, merge into, or restore the canonical account pool. This helper is kept for
 * older call sites that still use the historical reconcile entry point, but it now only normalizes
 * the existing local indexes and never reads or applies Codex CLI account data.
 *
 * @param current - The current canonical AccountStorageV3, or null when no canonical storage exists.
 * @returns The original storage when no local normalization is needed, a normalized clone when index
 * values need clamping, or null when canonical storage is missing.
 */
export function syncAccountStorageFromCodexCli(
	current: AccountStorageV3 | null,
): Promise<{ storage: AccountStorageV3 | null; changed: boolean }> {
	incrementCodexCliMetric("reconcileAttempts");

	if (!current) {
		incrementCodexCliMetric("reconcileNoops");
		log.debug("Skipped Codex CLI reconcile because canonical storage is missing", {
			operation: "reconcile-storage",
			outcome: "canonical-missing",
		});
		return Promise.resolve({ storage: null, changed: false });
	}

	const next = cloneStorage(current);
	const previousActive = next.activeIndex;
	const previousFamilies = JSON.stringify(next.activeIndexByFamily ?? {});
	normalizeStoredFamilyIndexes(next);

	const changed =
		previousActive !== next.activeIndex ||
		previousFamilies !== JSON.stringify(next.activeIndexByFamily ?? {});

	incrementCodexCliMetric(changed ? "reconcileChanges" : "reconcileNoops");
	log.debug("Skipped Codex CLI authority import; canonical storage remains authoritative", {
		operation: "reconcile-storage",
		outcome: changed ? "normalized-local-indexes" : "canonical-authoritative",
		accountCount: next.accounts.length,
	});

	return Promise.resolve({
		storage: changed ? next : current,
		changed,
	});
}

export function getActiveSelectionForFamily(
	storage: AccountStorageV3,
	family: ModelFamily,
): number {
	const count = storage.accounts.length;
	if (count === 0) return 0;
	const raw = storage.activeIndexByFamily?.[family];
	const candidate =
		typeof raw === "number"
			? normalizeIndexCandidate(raw, storage.activeIndex)
			: normalizeIndexCandidate(storage.activeIndex, 0);
	return Math.max(0, Math.min(candidate, count - 1));
}
