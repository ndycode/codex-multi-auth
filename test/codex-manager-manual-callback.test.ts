import { describe, expect, it } from "vitest";
import { classifyManualCallbackInput } from "../lib/codex-manager/manual-callback.js";

// Regression coverage for the issue #512 follow-up: `login --manual` used to
// print "Cancelled." for a malformed or wrong-attempt callback URL because the
// reader collapsed validation failures into the same null it used for a real
// user abort. classifyManualCallbackInput now distinguishes them so the CLI can
// surface the actual validation error.

const STATE = "expected-state-abc123";
const REDIRECT = "http://localhost:1455/auth/callback";

describe("classifyManualCallbackInput (issue #512 follow-up)", () => {
	it("returns the code for a valid callback URL with matching state", () => {
		const result = classifyManualCallbackInput(
			`${REDIRECT}?code=auth-code-xyz&state=${STATE}`,
			STATE,
		);
		expect(result).toEqual({ type: "code", code: "auth-code-xyz" });
	});

	it("accepts the bare code#state shorthand", () => {
		const result = classifyManualCallbackInput(
			`auth-code-xyz#${STATE}`,
			STATE,
		);
		expect(result).toEqual({ type: "code", code: "auth-code-xyz" });
	});

	it("treats a closed stream (null) as a cancellation", () => {
		expect(classifyManualCallbackInput(null, STATE)).toEqual({
			type: "cancelled",
		});
	});

	it("treats empty input and cancel keywords as a cancellation", () => {
		for (const input of ["", "   ", "q", "Q", "quit", "cancel", "back"]) {
			expect(classifyManualCallbackInput(input, STATE)).toEqual({
				type: "cancelled",
			});
		}
	});

	it("treats an Esc keypress as a cancellation", () => {
		expect(classifyManualCallbackInput("\u001b", STATE)).toEqual({
			type: "cancelled",
		});
	});

	it("reports a URL missing the state parameter as invalid, not cancelled", () => {
		expect(
			classifyManualCallbackInput(`${REDIRECT}?code=auth-code-only`, STATE),
		).toEqual({ type: "invalid" });
	});

	it("reports a URL missing the code parameter as invalid, not cancelled", () => {
		expect(
			classifyManualCallbackInput(`${REDIRECT}?state=${STATE}`, STATE),
		).toEqual({ type: "invalid" });
	});

	it("reports a state that belongs to a different login attempt as state-mismatch", () => {
		const result = classifyManualCallbackInput(
			`${REDIRECT}?code=auth-code-xyz&state=some-other-attempt`,
			STATE,
		);
		expect(result).toEqual({ type: "state-mismatch" });
	});

	it("does not confuse a non-cancel garbage string for a cancellation", () => {
		// The reporter pasted a localhost callback URL and still saw "Cancelled.";
		// a non-empty, non-keyword value must never classify as cancelled.
		const result = classifyManualCallbackInput("not-a-real-url", STATE);
		expect(result.type).not.toBe("cancelled");
		expect(result).toEqual({ type: "invalid" });
	});
});
