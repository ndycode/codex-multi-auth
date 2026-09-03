import { getNormalizedModel } from "../request/helpers/model-map.js";

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
	// GPT-6 Astra published two different numbers on day one: 1.05M for the API
	// surface and 272K as the Codex context. This wrapper talks to the Codex
	// backend, and the same split is what the v2.5.0 notes warn about — so no
	// estimate is entered here. `gpt-daybreak-red-latest` is the one model whose
	// upstream catalog entry pins `context_window` and `max_context_window` to
	// the same 372000, but that is the Codex picker's number rather than a
	// measured ceiling for this transport, so it stays unestimated too. Set
	// `contextBudgetGuardModelWindowOverrides` once you know your real ceiling.
	"gpt-6-astra",
	"gpt-6-astra-aeon",
	"gpt-daybreak-blue-latest",
	"gpt-daybreak-red-latest",
] as const;

function normalizeModelName(model: string | null | undefined): string | null {
	const trimmed = model?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Model ids to try, in order, against the override map and the estimate table.
 *
 * The guard is fed the model string exactly as the client sent it: the
 * rotation proxy is a pass-through and `buildResponsesRequestContext` copies
 * `body.model` verbatim. That raw string is very often NOT a key of this
 * file's table — Codex CLI's own default is `gpt-5-codex`, and every
 * reasoning-suffixed alias (`gpt-5.3-codex-high`, …) is an alias-map entry
 * rather than a catalog model. Looking up only the raw string made the guard
 * silently return "no window, skip" for the most common model in the product.
 *
 * So: try the raw (lowercased) string first, so a user override keyed exactly
 * the way they type the model still wins, then the catalog's canonical id for
 * it. `getNormalizedModel` is deliberately the exact/alias-only resolver —
 * `resolveNormalizedModel` falls back to `DEFAULT_MODEL` for anything it does
 * not recognize, which would hand an unknown model gpt-5.5's window and
 * evaluate a real session against a fabricated number.
 */
function windowLookupCandidates(model: string | null | undefined): string[] {
	const raw = normalizeModelName(model);
	if (!raw) return [];
	const canonical = normalizeModelName(getNormalizedModel(raw));
	return canonical && canonical !== raw ? [raw, canonical] : [raw];
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
	const candidates = windowLookupCandidates(model);
	if (candidates.length === 0) return null;

	for (const candidate of candidates) {
		const override = overrides?.[candidate];
		if (typeof override !== "number" || !Number.isFinite(override)) continue;
		// Floor BEFORE the positivity check, not after. Checking `override > 0`
		// on the raw value admits anything in (0, 1), which then floors to 0 and
		// returns a zero-token window -- breaking this function's contract that a
		// window it cannot resolve comes back as null, and handing any caller
		// that trusts it a division by zero.
		const tokens = Math.floor(override);
		if (tokens > 0) {
			return { tokens, source: "override" };
		}
	}

	for (const candidate of candidates) {
		const estimate = ESTIMATED_MODEL_CONTEXT_WINDOWS[candidate];
		if (typeof estimate === "number") {
			return { tokens: estimate, source: "estimate" };
		}
	}

	return null;
}

export function listEstimatedModelContextWindows(): Record<string, number> {
	return { ...ESTIMATED_MODEL_CONTEXT_WINDOWS };
}
