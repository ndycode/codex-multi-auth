import { vi } from "vitest";
import type { AccountInfo } from "../lib/ui/auth-menu.js";
import type { MenuItem } from "../lib/ui/select.js";
import type { AuthMenuAction } from "../lib/ui/auth-menu.js";

// ui-03: the glyph-mode quota-bar renderer (formatQuotaBar) is a private function,
// so we exercise it through the public showAuthMenu render path. select is mocked to
// capture the MenuItem list; the account row's `hint` carries the rendered quota bar.
// The Unicode block glyphs (U+2588 "█" / U+2592 "▒") render as mojibake on ascii
// terminals, so the renderer must emit ascii fill/empty ("#"/"-") for every glyph mode
// except an explicit "unicode". "auto" deliberately resolves to ascii here (the theme
// keeps the raw "auto" and formatQuotaBar only treats a literal "unicode" as unicode),
// which avoids guessing the terminal's capabilities. These tests pin each mode so a
// regression that leaks block glyphs into ascii output is caught.

const selectMock = vi.fn();
const confirmMock = vi.fn(async () => true);

vi.mock("../lib/ui/select.js", () => ({
	select: selectMock,
}));

vi.mock("../lib/ui/confirm.js", () => ({
	confirm: confirmMock,
}));

const UNICODE_FILL = "█"; // █
const UNICODE_EMPTY = "▒"; // ▒

function createAccount(): AccountInfo {
	// 50% left → width 10 → 5 filled + 5 empty glyphs, so both fill and empty chars
	// are present regardless of mode.
	return {
		index: 0,
		email: "owner@example.com",
		status: "ok",
		lastUsed: 1_700_000_000_000,
		quota5hLeftPercent: 50,
	};
}

/**
 * Render the auth menu once with the given glyph mode and return the account row's
 * rendered hint text (which contains the quota bar). select is stubbed to capture the
 * items and immediately cancel so the menu loop exits deterministically.
 */
async function renderQuotaHint(
	glyphMode: "unicode" | "ascii" | "auto",
): Promise<string> {
	let captured: MenuItem<AuthMenuAction>[] | null = null;
	selectMock.mockImplementation(
		async (items: MenuItem<AuthMenuAction>[]) => {
			captured = items;
			return { type: "cancel" as const };
		},
	);

	// Import runtime + auth-menu from the same post-reset module graph so the runtime
	// options we set are the ones showAuthMenu reads.
	const { setUiRuntimeOptions } = await import("../lib/ui/runtime.js");
	setUiRuntimeOptions({ glyphMode });
	const { showAuthMenu } = await import("../lib/ui/auth-menu.js");

	await showAuthMenu([createAccount()]);

	expect(captured).not.toBeNull();
	const items = captured as unknown as MenuItem<AuthMenuAction>[];
	const accountRow = items.find(
		(item) => item.value?.type === "select-account",
	);
	expect(accountRow).toBeDefined();
	const hint = accountRow?.hint ?? "";
	expect(hint.length).toBeGreaterThan(0);
	return hint;
}

describe("auth-menu quota bar glyph modes", () => {
	// beforeEach forces process.stdin/stdout isTTY to false (non-tty) to pin the
	// renderer's terminal-capability path. Capture the original property descriptors
	// up front so afterEach can restore them — otherwise the forced non-tty state
	// leaks into later suites that inspect isTTY.
	const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(
		process.stdin,
		"isTTY",
	);
	const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(
		process.stdout,
		"isTTY",
	);

	beforeEach(() => {
		vi.resetModules();
		selectMock.mockReset();
		confirmMock.mockReset();
		confirmMock.mockResolvedValue(true);
		Object.defineProperty(process.stdin, "isTTY", {
			value: false,
			configurable: true,
		});
		Object.defineProperty(process.stdout, "isTTY", {
			value: false,
			configurable: true,
		});
	});

	afterEach(async () => {
		// Restore default runtime options so other suites are unaffected.
		const { resetUiRuntimeOptions } = await import("../lib/ui/runtime.js");
		resetUiRuntimeOptions();
		// Restore the original isTTY descriptors so the forced non-tty state cannot
		// leak into later suites. Delete when there was no own descriptor originally.
		if (stdinIsTTYDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
		} else {
			delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
		}
		if (stdoutIsTTYDescriptor) {
			Object.defineProperty(process.stdout, "isTTY", stdoutIsTTYDescriptor);
		} else {
			delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
		}
		vi.restoreAllMocks();
	});

	it("renders Unicode block glyphs in unicode mode", async () => {
		const hint = await renderQuotaHint("unicode");
		expect(hint).toContain(UNICODE_FILL);
		expect(hint).toContain(UNICODE_EMPTY);
		expect(hint).not.toContain("#");
	});

	it("renders ASCII glyphs in ascii mode (no mojibake)", async () => {
		const hint = await renderQuotaHint("ascii");
		expect(hint).toContain("#");
		expect(hint).not.toContain(UNICODE_FILL);
		expect(hint).not.toContain(UNICODE_EMPTY);
	});

	it("falls back to ASCII glyphs in auto mode (auto -> ascii)", async () => {
		const hint = await renderQuotaHint("auto");
		expect(hint).toContain("#");
		expect(hint).not.toContain(UNICODE_FILL);
		expect(hint).not.toContain(UNICODE_EMPTY);
	});
});
