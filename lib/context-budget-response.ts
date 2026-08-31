import type { ContextBudgetAdvisory } from "./context-budget-guard.js";
import { createSyntheticSseResponse } from "./synthetic-response.js";

/** Response header carrying the soft-threshold advisory, non-blocking. */
export const CONTEXT_BUDGET_PERCENT_HEADER = "x-codex-context-budget-percent";

function formatPercent(percent: number): string {
	return percent.toFixed(1);
}

/**
 * The message shown to users when the context budget guard pauses a session
 * at the hard threshold, before the request that would have pushed it over
 * the model's window is even sent upstream.
 *
 * Deliberately echoes `lib/context-overflow.ts`'s CONTEXT_OVERFLOW_MESSAGE
 * copy so the two related notices read as one family in a transcript,
 * rather than as two unexplained different warnings.
 */
function buildPauseMessage(advisory: Extract<ContextBudgetAdvisory, { level: "hard" }>): string {
	const windowNote =
		advisory.windowSource === "override"
			? "your configured window size"
			: "an estimated window size (unverified — set `contextBudgetGuardModelWindowOverrides` if you know the real limit)";

	return `[Plugin Notice] Context budget guard paused this session at ${formatPercent(advisory.percent)}% of ${windowNote} for \`${advisory.model}\`, before hitting the model's actual limit.

Please use one of these commands to reduce context size:

• **/compact** - Compress conversation history (recommended)
• **/clear** - Start fresh with empty context
• **/undo** - Remove recent messages

Then retry your request. This pause clears itself automatically once your context usage drops back below the threshold.`;
}

/**
 * Build the synthetic response returned in place of forwarding to upstream
 * when the context budget guard's hard threshold has been reached.
 *
 * Same technique as `createContextOverflowResponse`: a 200 OK synthetic SSE
 * reply so the host session never locks on an error for a notice the plugin
 * itself generated — except this fires pre-flight, before the request that
 * would overflow is ever sent, instead of reacting to the 400 after the
 * fact.
 */
export function createContextBudgetPauseResponse(
	advisory: Extract<ContextBudgetAdvisory, { level: "hard" }>,
): Response {
	return createSyntheticSseResponse({
		model: advisory.model,
		message: buildPauseMessage(advisory),
		idPrefix: "context_budget_pause",
		errorType: "context_budget_pause",
	});
}

/**
 * Non-blocking header for the soft threshold, added to the real forwarded
 * response next to the existing `x-codex-*-used-percent` quota headers.
 * Consumed by `codex-multi-auth status` / the statusline, not by the model.
 */
export function buildContextBudgetHeaders(
	advisory: Extract<ContextBudgetAdvisory, { level: "soft" | "hard" }>,
): Record<string, string> {
	return {
		[CONTEXT_BUDGET_PERCENT_HEADER]: formatPercent(advisory.percent),
	};
}
