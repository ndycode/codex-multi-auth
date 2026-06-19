import { describe, expect, it } from "vitest";
import {
	buildAccountListPreview,
	buildSummaryPreviewText,
	DEFAULT_STATUSLINE_FIELDS,
	highlightPreviewToken,
	normalizeStatuslineFields,
} from "../lib/codex-manager/settings-preview.js";
import { resolveMenuLayoutMode } from "../lib/codex-manager/settings-hub/shared.js";
import { getUiRuntimeOptions } from "../lib/ui/runtime.js";
import type { DashboardDisplaySettings } from "../lib/dashboard-settings.js";

const UI = getUiRuntimeOptions();

function summary(
	settings: DashboardDisplaySettings,
	focus: Parameters<typeof buildSummaryPreviewText>[3] = null,
): string {
	return buildSummaryPreviewText(settings, UI, resolveMenuLayoutMode, focus);
}

// Mutates process-global state: the TTY-sensitive tests below rely on the
// suite running sequentially (vitest's default); do not mark them concurrent.
function setStdoutTty(value: boolean | undefined): () => void {
	const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", {
		value,
		writable: true,
		configurable: true,
	});
	return () => {
		if (original) {
			Object.defineProperty(process.stdout, "isTTY", original);
		} else {
			delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	};
}

describe("settings preview builders", () => {
	describe("normalizeStatuslineFields", () => {
		it("falls back to the documented defaults for undefined and empty input", () => {
			const fromUndefined = normalizeStatuslineFields(undefined);
			expect(fromUndefined).toStrictEqual(DEFAULT_STATUSLINE_FIELDS);
			expect(fromUndefined).not.toBe(DEFAULT_STATUSLINE_FIELDS);
			const fromEmpty = normalizeStatuslineFields([]);
			expect(fromEmpty).toStrictEqual(DEFAULT_STATUSLINE_FIELDS);
			// Defensive copy: mutating the result must not corrupt the defaults.
			expect(fromEmpty).not.toBe(DEFAULT_STATUSLINE_FIELDS);
		});

		it("deduplicates while preserving first-occurrence order", () => {
			expect(
				normalizeStatuslineFields([
					"status",
					"last-used",
					"status",
					"limits",
					"last-used",
				]),
			).toStrictEqual(["status", "last-used", "limits"]);
		});
	});

	describe("buildSummaryPreviewText", () => {
		it("shows last-used and limits (with cooldowns) by default, status only when badges are hidden", () => {
			const text = summary({});
			expect(text).toContain("last used: today");
			expect(text).toContain("limits: ");
			expect(text).toContain("reset");
			expect(text).not.toContain("status: active");

			const withHiddenBadge = summary({ menuShowStatusBadge: false });
			expect(withHiddenBadge).toContain("status: active");
		});

		it("drops the cooldown segment when menuShowQuotaCooldown is false", () => {
			const text = summary({ menuShowQuotaCooldown: false });
			expect(text).toContain("limits: ");
			expect(text).not.toContain("reset");
		});

		it("orders parts by the configured statusline fields", () => {
			const text = summary({
				menuShowStatusBadge: false,
				menuStatuslineFields: ["status", "last-used", "limits"],
			});
			expect(text.indexOf("status: active")).toBeLessThan(
				text.indexOf("last used: today"),
			);
			expect(text.indexOf("last used: today")).toBeLessThan(
				text.indexOf("limits: "),
			);
		});

		it("explains why nothing is visible when every part is disabled", () => {
			// Status field configured but the badge is shown, so the status text
			// is suppressed: the preview explains the dependency.
			expect(
				summary({
					menuShowLastUsed: false,
					menuShowQuotaSummary: false,
				}),
			).toBe("status text appears only when status badges are hidden");

			// No status field at all: generic nothing-visible message.
			expect(
				summary({
					menuShowLastUsed: false,
					menuShowQuotaSummary: false,
					menuStatuslineFields: ["last-used", "limits"],
				}),
			).toBe("no summary text is visible with current account-list settings");
		});
	});

	describe("buildAccountListPreview", () => {
		it("renders the demo row with both badges by default", () => {
			const preview = buildAccountListPreview(
				{},
				UI,
				resolveMenuLayoutMode,
			);
			expect(preview.label).toBe("1. demo@example.com [current] [active]");
			expect(preview.hint.endsWith("details shown on selected row only")).toBe(
				true,
			);
			expect(preview.hint).toContain("\n");
		});

		it("drops badges individually and reflects the expanded-rows layout", () => {
			const preview = buildAccountListPreview(
				{
					menuShowCurrentBadge: false,
					menuShowStatusBadge: false,
					menuLayoutMode: "expanded-rows",
				},
				UI,
				resolveMenuLayoutMode,
			);
			expect(preview.label).toBe("1. demo@example.com");
			expect(preview.hint.endsWith("details shown on all rows")).toBe(true);
		});

		it("derives the layout text from the legacy boolean when no explicit mode is set", () => {
			const preview = buildAccountListPreview(
				{ menuShowDetailsForUnselectedRows: true },
				UI,
				resolveMenuLayoutMode,
			);
			expect(preview.hint.endsWith("details shown on all rows")).toBe(true);
		});
	});

	describe("highlightPreviewToken", () => {
		it("returns plain text when stdout is not a TTY", () => {
			const restore = setStdoutTty(false);
			try {
				expect(highlightPreviewToken("token", UI)).toBe("token");
			} finally {
				restore();
			}
		});

		it("wraps the token in ANSI styling when stdout is a TTY", () => {
			const restore = setStdoutTty(true);
			try {
				const highlighted = highlightPreviewToken("token", UI);
				expect(highlighted).not.toBe("token");
				expect(highlighted).toContain("token");
				expect(highlighted).toMatch(/\x1b\[/);
				expect(
					highlighted.replace(/\x1b\[[0-9;]*m/g, ""),
				).toBe("token");
			} finally {
				restore();
			}
		});

		it("highlights only the focused part in the summary preview", () => {
			const restore = setStdoutTty(true);
			try {
				const text = summary({}, "last-used");
				const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
				expect(stripped).toBe(summaryPlain());
				expect(text).not.toBe(stripped);
				const limitsSegment = text.slice(text.indexOf("limits:"));
				expect(limitsSegment).not.toMatch(/\x1b\[/);
			} finally {
				restore();
			}
		});
	});
});

function summaryPlain(): string {
	const restore = setStdoutTty(false);
	try {
		return buildSummaryPreviewText({}, UI, resolveMenuLayoutMode, null);
	} finally {
		restore();
	}
}
