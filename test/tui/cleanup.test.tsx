import { describe, expect, test } from "bun:test";
import { getShellListenerCounts, mountOpenTuiShellHarness } from "./harness.js";

describe("OpenTUI shell cleanup", () => {
	test("cleans timers and listeners on repeated mount and destroy", async () => {
		for (let cycle = 0; cycle < 2; cycle += 1) {
			const destroyCalls: string[] = [];
			const harness = await mountOpenTuiShellHarness({
				renderer: {
					onDestroy: () => {
						destroyCalls.push(`destroy-${cycle}`);
					},
				},
			});

			try {
				const mountedListeners = getShellListenerCounts(harness.renderer);

				expect(harness.clock.getActiveTimerCount()).toBe(1);
				expect(mountedListeners.selection).toBe(harness.baselineListenerCounts.selection + 1);
				expect(mountedListeners.keypress).toBeGreaterThan(harness.baselineListenerCounts.keypress);

				await harness.destroy();

				const cleanedListeners = getShellListenerCounts(harness.renderer);

				expect(harness.clock.getActiveTimerCount()).toBe(0);
				expect(cleanedListeners.selection).toBe(harness.baselineListenerCounts.selection);
				expect(cleanedListeners.keypress).toBe(harness.baselineListenerCounts.keypress);
				expect(destroyCalls).toEqual([`destroy-${cycle}`]);
				expect(harness.renderer.isDestroyed).toBe(true);
			} finally {
				await harness.destroy();
			}
		}
	});

	test("cleans shell resources on escape exit", async () => {
		const destroyCalls: string[] = [];
		const harness = await mountOpenTuiShellHarness({
			renderer: {
				onDestroy: () => {
					destroyCalls.push("destroy");
				},
			},
		});

		try {
			expect(harness.clock.getActiveTimerCount()).toBe(1);
			expect(getShellListenerCounts(harness.renderer).selection).toBe(harness.baselineListenerCounts.selection + 1);

			harness.mockInput.pressEscape();
			await Promise.resolve();

			const cleanedListeners = getShellListenerCounts(harness.renderer);

			expect(harness.exitReasons).toEqual(["escape"]);
			expect(harness.clock.getActiveTimerCount()).toBe(0);
			expect(cleanedListeners.selection).toBe(harness.baselineListenerCounts.selection);
			expect(cleanedListeners.keypress).toBe(harness.baselineListenerCounts.keypress);
			expect(destroyCalls).toEqual(["destroy"]);
			expect(harness.renderer.isDestroyed).toBe(true);
		} finally {
			await harness.destroy();
		}
	});
});
