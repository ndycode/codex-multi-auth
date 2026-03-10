import { describe, expect, test } from "bun:test";
import { getDefaultPluginConfig } from "../../lib/config.js";
import { mountOpenTuiShellHarness } from "./harness.js";

async function moveToSettingsNav(
	harness: Awaited<ReturnType<typeof mountOpenTuiShellHarness>>,
): Promise<void> {
	harness.mockInput.pressArrow("left");
	await harness.renderOnce();
	for (let step = 0; step < 3; step += 1) {
		harness.mockInput.pressArrow("down");
		await harness.renderOnce();
	}
	expect(harness.selectionChanges.at(-1)?.navLabel).toBe("Settings");
}

async function openSettingsDrawer(
	harness: Awaited<ReturnType<typeof mountOpenTuiShellHarness>>,
): Promise<void> {
	await moveToSettingsNav(harness);
	harness.mockInput.pressArrow("right");
	await harness.renderOnce();
	expect(harness.readyContexts[0]?.modalHostRef.visible).toBe(true);
}

describe("OpenTUI settings drawer", () => {
	test("opens the settings hub as a drawer without replacing the shell", async () => {
		const harness = await mountOpenTuiShellHarness();

		try {
			await openSettingsDrawer(harness);

			const frame = harness.captureCharFrame();
			expect(frame).toContain("Settings host");
			expect(frame).toContain("Account List View");
			expect(frame).toContain("Customize menu, behavior, and");
			expect(frame).toContain("backend");
			expect(harness.readyContexts[0]?.statusLineRef.plainText).toContain("tab switch pane");
		} finally {
			await harness.destroy();
		}
	});

	test("preserves cancel without save for drawer edits", async () => {
		const saveEvents: unknown[] = [];
		const harness = await mountOpenTuiShellHarness({
			shell: {
				onSettingsSave: (event) => {
					saveEvents.push(event);
				},
			},
		});

		try {
			await openSettingsDrawer(harness);
			harness.mockInput.pressKey("1");
			await harness.renderOnce();
			harness.mockInput.pressKey("1");
			await harness.renderOnce();
			harness.mockInput.pressKey("q");
			await harness.renderOnce();
			harness.mockInput.pressKey("q");
			await harness.renderOnce();

			expect(saveEvents).toHaveLength(0);
			expect(harness.readyContexts[0]?.modalHostRef.visible).toBe(false);
		} finally {
			await harness.destroy();
		}
	});

	test("resets account-list edits before saving", async () => {
		const saveEvents: unknown[] = [];
		const harness = await mountOpenTuiShellHarness({
			shell: {
				onSettingsSave: (event) => {
					saveEvents.push(event);
				},
			},
		});

		try {
			await openSettingsDrawer(harness);
			harness.mockInput.pressKey("1");
			await harness.renderOnce();
			harness.mockInput.pressKey("1");
			await harness.renderOnce();
			harness.mockInput.pressKey("r");
			await harness.renderOnce();
			harness.mockInput.pressKey("s");
			await harness.renderOnce();

			expect(saveEvents).toEqual([
				expect.objectContaining({
					kind: "dashboard",
					panel: "account-list",
					selected: expect.objectContaining({
						menuShowStatusBadge: true,
					}),
				}),
			]);
		} finally {
			await harness.destroy();
		}
	});

	test("reorders summary fields with bracket hotkeys inside the drawer", async () => {
		const saveEvents: Array<Record<string, unknown>> = [];
		const harness = await mountOpenTuiShellHarness({
			shell: {
				onSettingsSave: (event) => {
					saveEvents.push(event as Record<string, unknown>);
				},
			},
		});

		try {
			await openSettingsDrawer(harness);
			harness.mockInput.pressKey("2");
			await harness.renderOnce();
			harness.mockInput.pressKey("]");
			await harness.renderOnce();
			harness.mockInput.pressKey("[");
			await harness.renderOnce();
			harness.mockInput.pressKey("]");
			await harness.renderOnce();
			harness.mockInput.pressKey("s");
			await harness.renderOnce();

			expect(saveEvents).toHaveLength(1);
			expect(saveEvents[0]).toEqual(
				expect.objectContaining({
					kind: "dashboard",
					panel: "summary-fields",
					selected: expect.objectContaining({
						menuStatuslineFields: ["limits", "last-used", "status"],
					}),
				}),
			);
		} finally {
			await harness.destroy();
		}
	});

	test("saves backend category drafts with numeric and +/- hotkeys", async () => {
		const saveEvents: Array<Record<string, unknown>> = [];
		const baseline = getDefaultPluginConfig();
		const harness = await mountOpenTuiShellHarness({
			shell: {
				onSettingsSave: (event) => {
					saveEvents.push(event as Record<string, unknown>);
				},
			},
		});

		try {
			await openSettingsDrawer(harness);
			harness.mockInput.pressKey("5");
			await harness.renderOnce();
			harness.mockInput.pressKey("1");
			await harness.renderOnce();
			harness.mockInput.pressKey("1");
			await harness.renderOnce();
			for (let step = 0; step < 5; step += 1) {
				harness.mockInput.pressArrow("down");
				await harness.renderOnce();
			}
			harness.mockInput.pressKey("+");
			await harness.renderOnce();
			harness.mockInput.pressKey("-");
			await harness.renderOnce();
			harness.mockInput.pressKey("]");
			await harness.renderOnce();
			harness.mockInput.pressKey("q");
			await harness.renderOnce();
			harness.mockInput.pressKey("s");
			await harness.renderOnce();

			expect(saveEvents).toHaveLength(1);
			expect(saveEvents[0]).toEqual(
				expect.objectContaining({
					kind: "backend",
					selected: expect.objectContaining({
						liveAccountSync: !(baseline.liveAccountSync ?? true),
						liveAccountSyncDebounceMs: (baseline.liveAccountSyncDebounceMs ?? 250) + 50,
					}),
				}),
			);
		} finally {
			await harness.destroy();
		}
	});
});
