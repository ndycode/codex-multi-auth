import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	accountRowColor,
	accountSearchText,
	accountTitle,
	authMenuFocusKey,
	currentMarkerLabel,
	formatAccountHint,
	formatDate,
	formatRelativeTime,
	mainMenuTitleWithVersion,
	statusBadge,
	type AccountInfo,
	type AuthMenuAction,
} from "../lib/ui/auth-menu-builder.js";
import {
	getUiRuntimeOptions,
	resetUiRuntimeOptions,
	setUiRuntimeOptions,
} from "../lib/ui/runtime.js";
import { UI_COPY } from "../lib/ui/ui-copy.js";

const NOW = Date.now();
const DAY_MS = 86_400_000;

// All formatting helpers may paint with ANSI in either UI mode; the contract
// under test is the text content, not the palette.
function stripAnsi(value: string): string {
	 
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function account(overrides: Partial<AccountInfo> = {}): AccountInfo {
	return { index: 0, ...overrides };
}

const originalVersionEnv = process.env.CODEX_MULTI_AUTH_CLI_VERSION;

beforeEach(() => {
	delete process.env.CODEX_MULTI_AUTH_CLI_VERSION;
});

afterEach(() => {
	if (originalVersionEnv === undefined) {
		delete process.env.CODEX_MULTI_AUTH_CLI_VERSION;
	} else {
		process.env.CODEX_MULTI_AUTH_CLI_VERSION = originalVersionEnv;
	}
});

describe("mainMenuTitleWithVersion", () => {
	it("returns the bare title when no CLI version is exported", () => {
		expect(mainMenuTitleWithVersion()).toBe(UI_COPY.mainMenu.title);
	});

	it("appends the version, prefixing a v only when missing", () => {
		process.env.CODEX_MULTI_AUTH_CLI_VERSION = "1.2.3";
		expect(mainMenuTitleWithVersion()).toBe(
			`${UI_COPY.mainMenu.title} (v1.2.3)`,
		);

		process.env.CODEX_MULTI_AUTH_CLI_VERSION = "v2.0.0";
		expect(mainMenuTitleWithVersion()).toBe(
			`${UI_COPY.mainMenu.title} (v2.0.0)`,
		);
	});
});

describe("formatRelativeTime", () => {
	it.each([
		["never", undefined],
		["today", NOW - 1_000],
		["yesterday", NOW - DAY_MS - 1_000],
		["3d ago", NOW - 3 * DAY_MS - 1_000],
		["2w ago", NOW - 15 * DAY_MS],
	] as const)("renders %s", (expected, timestamp) => {
		expect(formatRelativeTime(timestamp)).toBe(expected);
	});

	it("falls back to a locale date beyond a month", () => {
		const old = NOW - 60 * DAY_MS;
		expect(formatRelativeTime(old)).toBe(new Date(old).toLocaleDateString());
	});
});

describe("accountTitle", () => {
	it("prefers email, then label, then id, then a generic name", () => {
		expect(accountTitle(account({ email: "a@example.com" }))).toBe(
			"1. a@example.com",
		);
		expect(accountTitle(account({ accountLabel: "Team A" }))).toBe(
			"1. Team A",
		);
		expect(accountTitle(account({ accountId: "acc_1" }))).toBe("1. acc_1");
		expect(accountTitle(account())).toBe("1. Account 1");
	});

	it("numbers rows by quickSwitchNumber when present", () => {
		expect(
			accountTitle(account({ index: 4, quickSwitchNumber: 2, email: "a@b.c" })),
		).toBe("2. a@b.c");
	});

	it("strips ANSI escapes and control characters from every identity field", () => {
		// Hostile identity values must not be able to repaint the menu row,
		// regardless of which field carries them.
		expect(
			accountTitle(account({ accountLabel: "\x1b[31mEvil\x1b[0m Label" })),
		).toBe("1. Evil Label");
		expect(
			accountTitle(account({ email: "\x1b[2Jevil@example.com" })),
		).toBe("1. evil@example.com");
		expect(accountTitle(account({ accountId: "acc\x1b[31m_red" }))).toBe(
			"1. acc_red",
		);
	});
});

describe("accountSearchText", () => {
	it("joins the lowercased identity fields and the row number", () => {
		expect(
			accountSearchText(
				account({
					index: 1,
					email: "User@Example.com",
					accountLabel: "Team A",
					accountId: "ACC_9",
				}),
			),
		).toBe("user@example.com team a acc_9 2");
	});
});

describe("accountRowColor", () => {
	it("highlights the current row green unless highlighting is disabled", () => {
		expect(
			accountRowColor(account({ isCurrentAccount: true, status: "disabled" })),
		).toBe("green");
		expect(
			accountRowColor(
				account({
					isCurrentAccount: true,
					highlightCurrentRow: false,
					status: "disabled",
				}),
			),
		).toBe("red");
	});

	it.each([
		["green", "ok"],
		["yellow", "rate-limited"],
		["yellow", "cooldown"],
		["red", "flagged"],
		["yellow", undefined],
	] as const)("maps to %s for status %s", (expected, status) => {
		expect(accountRowColor(account({ status }))).toBe(expected);
	});
});

describe("statusBadge", () => {
	it.each([
		"active",
		"ok",
		"quota-exhausted",
		"rate-limited",
		"cooldown",
		"flagged",
		"disabled",
		"error",
	] as const)("labels the %s badge with its status", (status) => {
		expect(stripAnsi(statusBadge(status))).toContain(status);
	});

	it("labels missing statuses unknown", () => {
		expect(stripAnsi(statusBadge(undefined))).toContain("unknown");
	});
});

describe("formatDate", () => {
	it("renders unknown for missing timestamps and a locale date otherwise", () => {
		expect(formatDate(undefined)).toBe("unknown");
		const ts = NOW - 10 * DAY_MS;
		expect(formatDate(ts)).toBe(new Date(ts).toLocaleDateString());
	});
});

describe("currentMarkerLabel", () => {
	it("humanizes in-use and passes other markers through", () => {
		expect(currentMarkerLabel("in-use")).toBe("in use");
		expect(currentMarkerLabel("current")).toBe("current");
		expect(currentMarkerLabel("selected")).toBe("selected");
	});
});

describe("formatAccountHint", () => {
	const ui = getUiRuntimeOptions();

	it("renders last-used and quota limits in the default field order", () => {
		const hint = stripAnsi(
			formatAccountHint(
				account({
					lastUsed: NOW - 1_000,
					quota5hLeftPercent: 50,
					quota5hResetAtMs: NOW + 30_000,
				}),
				ui,
			),
		);

		expect(hint).toMatch(/^Last used: today \| Limits: 5h /);
		expect(hint).toContain("50%");
		expect(hint).toContain("reset ");
	});

	it("includes the status text only when the badge column is hidden", () => {
		const visibleBadge = stripAnsi(
			formatAccountHint(account({ status: "ok", lastUsed: NOW }), ui),
		);
		expect(visibleBadge).not.toContain("Status:");

		const hiddenBadge = stripAnsi(
			formatAccountHint(
				account({ status: "ok", lastUsed: NOW, showStatusBadge: false }),
				ui,
			),
		);
		expect(hiddenBadge).toContain("Status: ok");
	});

	it("orders the parts by the configured statusline fields", () => {
		const hint = stripAnsi(
			formatAccountHint(
				account({
					status: "ok",
					lastUsed: NOW,
					showStatusBadge: false,
					statuslineFields: ["status", "last-used"],
				}),
				ui,
			),
		);

		expect(hint.indexOf("Status:")).toBeLessThan(hint.indexOf("Last used:"));
	});

	it("flags rate-limited and exhausted accounts in the limits segment", () => {
		const hint = stripAnsi(
			formatAccountHint(
				account({
					lastUsed: NOW,
					quotaRateLimited: true,
					quotaExhausted: true,
				}),
				ui,
			),
		);

		expect(hint).toContain("rate-limited");
		expect(hint).toContain("quota-exhausted");
	});

	it("returns an empty string when every field is hidden", () => {
		expect(
			formatAccountHint(account({ showLastUsed: false }), ui),
		).toBe("");
	});

	// Regression for issue #635: Codex Business accounts carry a 30d monthly
	// primary window, but the account row hardcoded the positional "5h"/"7d"
	// labels, so the monthly window rendered as "5h ... reset 28d 11h". The label
	// must be derived from the window's real duration.
	it("labels the primary window from its duration instead of the positional 5h default", () => {
		const hint = stripAnsi(
			formatAccountHint(
				account({
					lastUsed: NOW - 2 * DAY_MS,
					// primary window is a 30d monthly quota (Codex Business), not 5h
					quota5hLeftPercent: 18,
					quota5hResetAtMs: NOW + 28 * DAY_MS,
					quotaPrimaryWindowMinutes: 30 * 24 * 60,
					// secondary window is the 7d weekly quota, fully available
					quota7dLeftPercent: 100,
					quotaSecondaryWindowMinutes: 7 * 24 * 60,
				}),
				ui,
			),
		);

		expect(hint).toContain("30d ");
		expect(hint).toContain("7d ");
		expect(hint).not.toMatch(/\b5h\b/);
	});

	it("falls back to the positional 5h/7d labels when window durations are unknown", () => {
		const hint = stripAnsi(
			formatAccountHint(
				account({
					lastUsed: NOW,
					quota5hLeftPercent: 50,
					quota7dLeftPercent: 80,
				}),
				ui,
			),
		);

		expect(hint).toContain("5h ");
		expect(hint).toContain("7d ");
	});

	// Render a row carrying only the given quota window and read back the label the
	// menu printed for it, so every branch of the duration->label rule is observed
	// through the public formatter rather than the private helper.
	function windowLabelFor(
		windowMinutes: number | undefined,
		position: "primary" | "secondary",
	): string {
		const hint = stripAnsi(
			formatAccountHint(
				account(
					position === "primary"
						? {
							showLastUsed: false,
							quota5hLeftPercent: 50,
							quotaPrimaryWindowMinutes: windowMinutes,
						}
						: {
							showLastUsed: false,
							quota7dLeftPercent: 50,
							quotaSecondaryWindowMinutes: windowMinutes,
						},
				),
				ui,
			),
		);
		return hint.replace(/^Limits: /, "").split(" ")[0] ?? "";
	}

	it.each([
		[1_440, "1d"],
		[43_200, "30d"],
		[300, "5h"],
		[720, "12h"],
		[100, "100m"],
		[90, "90m"],
	] as const)("labels a %i-minute window as %s", (windowMinutes, expected) => {
		expect(windowLabelFor(windowMinutes, "primary")).toBe(expected);
	});

	// An undefined duration is covered above; these are the durations a corrupt or
	// hostile cache entry could carry, which must not produce labels like "0m" or
	// "Infinityd".
	it.each([
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
		["infinite", Number.POSITIVE_INFINITY],
	] as const)(
		"keeps the positional labels for a %s duration",
		(_name, windowMinutes) => {
			expect(windowLabelFor(windowMinutes, "primary")).toBe("5h");
			expect(windowLabelFor(windowMinutes, "secondary")).toBe("7d");
		},
	);

	// The percentage can also be recovered from the summary string when the typed
	// field is absent. That string is labelled by duration too, so the lookup has to
	// use the resolved label -- searching for a literal "5h" drops the whole segment.
	it("recovers a percent from the summary using the resolved window label", () => {
		const hint = stripAnsi(
			formatAccountHint(
				account({
					showLastUsed: false,
					quotaSummary: "30d 42%, resets in 12d | 7d 80%",
					quotaPrimaryWindowMinutes: 30 * 24 * 60,
					quotaSecondaryWindowMinutes: 7 * 24 * 60,
				}),
				ui,
			),
		);

		expect(hint).toContain("30d ");
		expect(hint).toContain("42%");
		expect(hint).toContain("80%");
	});
});

describe("legacy (v1) palette rendering", () => {
	it("renders badges and hints with the same text content when v2 is off", () => {
		setUiRuntimeOptions({ v2Enabled: false });
		try {
			expect(stripAnsi(statusBadge("rate-limited"))).toContain(
				"rate-limited",
			);
			expect(stripAnsi(statusBadge(undefined))).toContain("unknown");

			const hint = stripAnsi(
				formatAccountHint(
					account({
						lastUsed: NOW - 1_000,
						quota5hLeftPercent: 50,
						quota5hResetAtMs: NOW + 30_000,
					}),
					getUiRuntimeOptions(),
				),
			);
			expect(hint).toMatch(/^Last used: today \| Limits: 5h /);
			expect(hint).toContain("50%");
		} finally {
			resetUiRuntimeOptions();
		}
	});
});

describe("authMenuFocusKey", () => {
	it("keys account actions by their storage position", () => {
		const row = account({ index: 2, sourceIndex: 5 });
		const action: AuthMenuAction = { type: "select-account", account: row };
		expect(authMenuFocusKey(action)).toBe("account:5");
		// Without a sourceIndex the display index is the identity.
		expect(
			authMenuFocusKey({
				type: "delete-account",
				account: account({ index: 2 }),
			}),
		).toBe("account:2");
	});

	it("keys static actions by their type", () => {
		expect(authMenuFocusKey({ type: "add" })).toBe("action:add");
		expect(authMenuFocusKey({ type: "cancel" })).toBe("action:cancel");
	});
});
