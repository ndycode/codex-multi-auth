import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { styleAccountDetailText } from "../lib/codex-manager.js";
import { ANSI } from "../lib/ui/ansi.js";
import { resetUiRuntimeOptions, setUiRuntimeOptions } from "../lib/ui/runtime.js";

// styleAccountDetailText colors a one-line account detail by tone. The
// security/UX-relevant invariant is precedence: a real failure whose text also
// contains "unavailable"/"not available" (e.g. a 5xx "service not available")
// MUST render danger (red), never be downgraded to a warning (yellow). These
// tests pin that the /failed|error/i check wins over the unavailable regex on
// both the compact path and the quota-suffix path.
//
// To make tone assertions deterministic we force the legacy ANSI renderer
// (v2 off) and an interactive stdout, so danger => ANSI.red and
// warning => ANSI.yellow exactly.

describe("styleAccountDetailText tone precedence", () => {
	const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(
		process.stdout,
		"isTTY",
	);

	beforeEach(() => {
		Object.defineProperty(process.stdout, "isTTY", {
			value: true,
			configurable: true,
		});
		setUiRuntimeOptions({ v2Enabled: false });
	});

	afterEach(() => {
		resetUiRuntimeOptions();
		if (stdoutIsTTYDescriptor) {
			Object.defineProperty(process.stdout, "isTTY", stdoutIsTTYDescriptor);
		} else {
			delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
		}
	});

	it("renders danger (red), not warning (yellow), when a failure detail also says 'unavailable'", () => {
		const styled = styleAccountDetailText("refresh failed: service unavailable");
		expect(styled).toContain(ANSI.red);
		expect(styled).not.toContain(ANSI.yellow);
	});

	it("treats 'not available' the same — danger wins over the warning keyword", () => {
		const styled = styleAccountDetailText("token error (not available)");
		// "(not available)" has no percent sign, so this stays on the compact path.
		expect(styled).toContain(ANSI.red);
		expect(styled).not.toContain(ANSI.yellow);
	});

	it("normalizes whitespace/newlines before matching tone keywords", () => {
		const styled = styleAccountDetailText("  probe   failed\n  — endpoint unavailable  ");
		expect(styled).toContain(ANSI.red);
		expect(styled).not.toContain(ANSI.yellow);
	});

	it("still renders warning (yellow) when only an unavailable keyword is present", () => {
		const styled = styleAccountDetailText("Codex not available for this account");
		expect(styled).toContain(ANSI.yellow);
		expect(styled).not.toContain(ANSI.red);
	});

	it("applies danger precedence to the quota suffix when it contains both keywords", () => {
		// Quota-bearing prefix routes through the (NN%) branch; the suffix carries
		// the failure text and must render red despite containing "unavailable".
		const styled = styleAccountDetailText("acct (12%) — refresh failed, now unavailable");
		expect(styled).toContain(ANSI.red);
		expect(styled).not.toContain(ANSI.yellow);
	});

	it("does not render a 'working' prefix green when the failure is inside the quota segment", () => {
		// Reachable from runHealthCheck: a failed live probe still emits a quota
		// percent, so "failed" is trapped inside the (…%) parens while the prefix
		// reads "working". The prefix must NOT render green over a real failure.
		const styled = styleAccountDetailText(
			"signed in and working (live check failed: timeout 0%)",
		);
		expect(styled).toContain(ANSI.red);
		expect(styled).not.toContain(ANSI.green);
	});

	it("clamps an out-of-range quota percent to 100% in the styled quota segment", () => {
		// A malformed quota summary like "5h 999%" must be clamped to [0,100] before
		// tone selection and rendering, so it renders identically to "5h 100%"
		// (success/green) and never surfaces the bogus 999% value to the user.
		const clamped = styleAccountDetailText("acct (5h 999%)");
		const hundred = styleAccountDetailText("acct (5h 100%)");
		expect(clamped).toContain("100%");
		expect(clamped).not.toContain("999%");
		expect(clamped).toContain(ANSI.green);
		expect(clamped).toBe(hundred);
	});

	it("renders the 0% lower bound as danger (red) without crashing", () => {
		// 0% is the clamp lower bound; quotaToneFromLeftPercent(0) => "danger"
		// (0 <= 15). It must render the literal "0%" in red, never drop the value
		// or throw on the boundary.
		const styled = styleAccountDetailText("acct (5h 0%)");
		expect(styled).toContain("0%");
		expect(styled).toContain(ANSI.red);
		expect(styled).not.toContain(ANSI.green);
	});

	it("does not render a soft-failure detail green via an unanchored success keyword", () => {
		// The success regex is /\b(ok|working|succeeded|valid)\b/ — without word
		// boundaries, "invalid"/"revoked"/"token" would match (valid in invalid,
		// ok in revoked/token) and color a failure detail green. These details have
		// no "failed"/"error" keyword, so the danger pre-check does not catch them.
		for (const detail of [
			"token is invalid or expired",
			"refresh token revoked",
		]) {
			const styled = styleAccountDetailText(detail);
			expect(styled).not.toContain(ANSI.green);
		}
		// A genuine success keyword on a word boundary still renders green.
		expect(styleAccountDetailText("signed in and working")).toContain(
			ANSI.green,
		);
	});
});
