import { describe, expect, test } from "bun:test";
import { mountOpenTuiShellHarness } from "./harness.js";

describe("OpenTUI shell navigation", () => {
	test("renders a two-pane shell with a compact status line", async () => {
		const harness = await mountOpenTuiShellHarness();

		try {
			const frame = harness.captureCharFrame();
			const frameLines = frame.split("\n");

			expect(frame).toContain("codex auth");
			expect(frame).toContain("Account workspace");
			expect(frame).toContain("1. * beta@example");
			expect(frame).toContain("2. gamma@example");
			expect(frame).toContain("Focused account");
			expect(frame).toContain("focus workspace");
			expect(frame).not.toContain("Accountcworkspacents");
			expect(frame).not.toContain("QcBacks");
			expect(frame).not.toContain("OpenTUI shell harness");
			expect(frame).not.toContain("Focused: account list");
			expect(frame).not.toContain("Renderer heartbeat");
			expect(frame).toContain("rows 3/3");
			expect(frameLines.some((line) => line.includes("│") || line.includes("|"))).toBe(true);
			expect(harness.readyContexts[0]?.modalHostRef.visible).toBe(false);
		} finally {
			await harness.destroy();
		}
	});

	test("switches focus between the nav rail and workspace without losing selection state", async () => {
		const harness = await mountOpenTuiShellHarness();

		try {
			expect(harness.selectionChanges.at(-1)?.focusTarget).toBe("workspace");
			expect(harness.renderer.currentFocusedRenderable).toBe(harness.readyContexts[0]?.accountListRef ?? null);

			harness.mockInput.pressArrow("left");
			await harness.renderOnce();

			expect(harness.selectionChanges.at(-1)?.focusTarget).toBe("nav");
			expect(harness.renderer.currentFocusedRenderable).toBe(harness.readyContexts[0]?.navRef ?? null);

			harness.mockInput.pressArrow("down");
			await harness.renderOnce();

			expect(harness.selectionChanges.at(-1)?.navLabel).toBe("Add");
			expect(harness.selectionChanges.at(-1)?.accountLabel).toBe("Open the browser-first login flow");
			expect(harness.captureCharFrame()).toContain("Add account");

			harness.mockInput.pressTab();
			await harness.renderOnce();

			expect(harness.selectionChanges.at(-1)?.focusTarget).toBe("workspace");
			expect(harness.renderer.currentFocusedRenderable).toBe(harness.readyContexts[0]?.accountListRef ?? null);

			harness.mockInput.pressArrow("down");
			await harness.renderOnce();

			expect(harness.selectionChanges.at(-1)?.accountLabel).toBe("Open the browser-first login flow");

			harness.mockInput.pressTab({ shift: true });
			await harness.renderOnce();

			expect(harness.selectionChanges.at(-1)?.focusTarget).toBe("nav");
		} finally {
			await harness.destroy();
		}
	});
});
