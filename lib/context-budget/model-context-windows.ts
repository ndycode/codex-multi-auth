/**
 * Context-window size estimates for the Context Budget Guard.
 *
 * Unlike `lib/usage/pricing.ts`, the numbers below are NOT published,
 * contractual facts. Per `docs/releases/v2.5.0.md` ("Where the model facts
 * came from"), the context window OpenAI's published API docs advertise is
 * for the API surface, not the ChatGPT Codex backend this wrapper actually
 * talks to — and the docs pages don't even agree with each other. Treating a
 * hardcoded number here as ground truth would repeat that exact mistake for
 * a safety feature, which is worse than not shipping the feature at all.
 *
 * So this table is a fallback starting point ONLY. `getEffectiveContextWindow`
 * always prefers a caller-supplied override (from
 * `contextBudgetGuardModelWindowOverrides`, the setting a user fills in once
 * they know their real ceiling) over anything listed here.
 */

/**
 * Best-effort estimates, in tokens. Deliberately conservative: an estimate
 * that is too LOW makes the guard fire early (annoying, safe); an estimate
 * that is too HIGH makes the guard fire late or never (silent, unsafe). When
 * in doubt about a model's real ceiling, leave it out of this table and add
 * it to UNESTIMATED_ROUTABLE_MODELS instead.
 */
const ESTIMATED_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-5.1": 260_000,
	"gpt-5.2": 260_000,
	"gpt-5.2-pro": 260_000,
	"gpt-5.3-codex": 260_000,
	"gpt-5.4": 260_000,
	"gpt-5.4-mini": 260_000,
	"gpt-5.4-nano": 260_000,
	"gpt-5.4-pro": 260_000,
	"gpt-5.5": 260_000,
	"gpt-5.5-pro": 260_000,
	"gpt-5-mini": 260_000,
	"gpt-5-nano": 260_000,
};

/**
 * Routable models this guard consciously does not estimate a window for.
 * `getEffectiveContextWindow` returns `null` for these absent an override,
 * and the guard treats `null` as "cannot evaluate; skip" — never a guessed
 * percentage. The 5.6 family ships with materially different per-tier
 * behavior (see the v2.5.0 release notes) closely enough to launch that no
 * estimate here has been reviewed for it yet.
 */
export const UNESTIMATED_ROUTABLE_MODELS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
] as const;

function normalizeModelName(model: string | null | undefined): string | null {
	const trimmed = model?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

export interface EffectiveContextWindow {
	tokens: number;
	source: "override" | "estimate";
}

/**
 * Resolve the context-window size to evaluate a session's budget against.
 *
 * Precedence: an explicit override always wins, even for a model this file
 * has never heard of — the whole point of the override setting is to let a
 * user correct or extend past this file's guesses. Failing that, fall back
 * to the estimate table. Returns `null` when neither source has a value, so
 * the guard can no-op rather than evaluate against a fabricated number.
 */
export function getEffectiveContextWindow(
	model: string | null | undefined,
	overrides: Record<string, number> | undefined,
): EffectiveContextWindow | null {
	const normalized = normalizeModelName(model);
	if (!normalized) return null;

	const override = overrides?.[normalized];
	if (typeof override === "number" && Number.isFinite(override) && override > 0) {
		return { tokens: Math.floor(override), source: "override" };
	}

	const estimate = ESTIMATED_MODEL_CONTEXT_WINDOWS[normalized];
	if (typeof estimate === "number") {
		return { tokens: estimate, source: "estimate" };
	}

	return null;
}

export function listEstimatedModelContextWindows(): Record<string, number> {
	return { ...ESTIMATED_MODEL_CONTEXT_WINDOWS };
}
