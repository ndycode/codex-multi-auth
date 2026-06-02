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
});
