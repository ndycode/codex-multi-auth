import { describe, expect, test } from "bun:test";
import { mountOpenTuiShellHarness } from "./harness.js";

describe("OpenTUI shell harness", () => {
	test("mounts, focuses the account list, and exits through keyboard plumbing", async () => {
		const destroyCalls: string[] = [];
		const harness = await mountOpenTuiShellHarness({
			renderer: {
				onDestroy: () => {
					destroyCalls.push("destroy");
				},
			},
		});

		try {
			const frame = harness.captureCharFrame();
			expect(frame).toContain("Account workspace");
			expect(frame).toContain("Focused account");
			expect(frame).not.toContain("Accountcworkspacents");
			expect(frame).not.toContain("QcBacks");
			expect(harness.readyContexts).toHaveLength(1);
			expect(harness.readyContexts[0]?.accountListRef).toBeDefined();
			expect(harness.readyContexts[0]?.focusTarget).toBe("workspace");
			expect(harness.readyContexts[0]?.statusLineRef.plainText).toContain("rows 3/3");
			expect(harness.readyContexts[0]?.focusedRenderable).toBe(harness.readyContexts[0]?.accountListRef ?? null);
			expect(harness.selectionChanges[0]).toEqual({
				accountIndex: 0,
				accountLabel: "1. * beta@example.com [act] today 5h100 7d100",
				focusTarget: "workspace",
				navIndex: 0,
				navLabel: "Accounts",
			});

			harness.mockInput.pressArrow("down");
			await harness.renderOnce();

			expect(harness.keyNames).toContain("down");
			expect(harness.selectionChanges.at(-1)?.accountLabel).toContain("gamma@example.com");

			harness.mockInput.pressKey("q");
			await Promise.resolve();

			expect(harness.keyNames).toContain("q");
			expect(harness.exitReasons).toEqual(["quit"]);
			expect(destroyCalls).toEqual(["destroy"]);
			expect(harness.renderer.isDestroyed).toBe(true);
		} finally {
			await harness.destroy();
		}
	});
});
