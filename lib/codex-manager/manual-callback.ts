import { parseAuthorizationInput } from "../auth/auth.js";

/**
 * Classification of a manual OAuth callback entry.
 *
 * Splitting `invalid` and `state-mismatch` out from `cancelled` is the fix for
 * the issue #512 follow-up: `login --manual` previously collapsed a malformed
 * or wrong-attempt callback URL into the same `null` it used for a genuine user
 * abort, so the CLI printed `Cancelled.` and hid the real validation error.
 *
 * - `code`: a valid authorization code + matching state were extracted.
 * - `cancelled`: the user aborted (empty input, an Esc character, or one of the
 *   cancel keywords `q`/`quit`/`cancel`/`back`).
 * - `invalid`: the pasted value was missing the code and/or state parameter.
 * - `state-mismatch`: the state did not match the one minted for this attempt.
 */
export type ManualCallbackClassification =
	| { type: "code"; code: string }
	| { type: "cancelled" }
	| { type: "invalid" }
	| { type: "state-mismatch" };

const CANCEL_KEYWORDS = new Set(["", "q", "quit", "cancel", "back"]);
const ESC_CHARACTER = "\u001b";

/**
 * Classify raw manual-callback input against the expected OAuth state. Pure and
 * I/O-free so the CLI prompt and unit tests share identical behaviour.
 *
 * `answer` is `null` when the input stream closed before any line was read,
 * which is treated as a cancellation.
 */
export function classifyManualCallbackInput(
	answer: string | null,
	expectedState: string,
): ManualCallbackClassification {
	if (answer === null) {
		return { type: "cancelled" };
	}
	if (answer.includes(ESC_CHARACTER)) {
		return { type: "cancelled" };
	}
	const normalized = answer.trim().toLowerCase();
	if (CANCEL_KEYWORDS.has(normalized)) {
		return { type: "cancelled" };
	}
	const parsed = parseAuthorizationInput(answer);
	if (!parsed.code || !parsed.state) {
		return { type: "invalid" };
	}
	if (parsed.state !== expectedState) {
		return { type: "state-mismatch" };
	}
	return { type: "code", code: parsed.code };
}
