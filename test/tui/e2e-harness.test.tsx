import { existsSync, promises as fs } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "./harness";
import {
	applyShellEvent,
	applyShellKey,
	createInitialShellState,
	loadInitialShellState,
	OpenTuiShellProof,
	persistShellSettings,
} from "../../runtime/opentui/shell";
import { getDashboardSettingsPath, loadDashboardDisplaySettings } from "../../lib/dashboard-settings";
import { openAuthChoiceState, openSettingsContentState, openWorkspaceState } from "./scenario-helpers";

let activeRender: Awaited<ReturnType<typeof testRender>> | undefined;

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

afterEach(() => {
	activeRender?.renderer.destroy();
	activeRender = undefined;
});

afterEach(async () => {
	await removeWithRetry(getDashboardSettingsPath(), { force: true });
});

describe("OpenTUI interaction harness", () => {
	test("cold-start reload restores persisted settings into initial shell state", async () => {
		await removeWithRetry(getDashboardSettingsPath(), { force: true });
		let settingsState = createInitialShellState(await loadDashboardDisplaySettings());
		settingsState = applyShellKey(settingsState, "down");
		settingsState = applyShellKey(settingsState, "down");
		settingsState = applyShellKey(settingsState, "down");
		settingsState = applyShellKey(settingsState, "return");
		settingsState = applyShellKey(settingsState, "return");
		settingsState = applyShellKey(settingsState, "down");

		await persistShellSettings(settingsState);
		const coldStartState = await loadInitialShellState();

		expect(coldStartState.persistedSettings.menuShowStatusBadge).toBe(false);
		expect(coldStartState.settingsDraft.menuShowStatusBadge).toBe(false);
		expect(coldStartState.sectionIndex).toBe(0);
		expect(coldStartState.statusNote).toBe(
			"Dashboard ready. Choose Add New Account, Account Workspace, Run Health Check, or Settings to start.",
		);
	});

	test("walks from dashboard to auth choice with visible beginner actions", async () => {
		const authChoiceState = openAuthChoiceState();
		expect(authChoiceState.sectionIndex).toBe(2);
		expect(authChoiceState.unlockedSectionIndex).toBe(2);

		activeRender = await testRender(() => <OpenTuiShellProof initialState={authChoiceState} />, {
			width: 80,
			height: 24,
		});
		await activeRender.renderOnce();

		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("Auth Choice");
		expect(frame).toContain("Open Browser (Easy)");
		expect(frame).toContain("Manual / Incognito");
	});

	test("routes key events through the shell event bridge", async () => {
		const prevented: string[] = [];
		const event = (name: string, shift = false) => ({
			name,
			shift,
			preventDefault: () => prevented.push(name),
		});

		let state = createInitialShellState();
		state = await applyShellEvent(state, event("tab"));
		expect(state.activeRegion).toBe("nav");

		state = await applyShellEvent(state, event("down"));
		expect(state.sectionIndex).toBe(0);

		state = await applyShellEvent(state, event("right"));
		expect(state.activeRegion).toBe("content");

		state = await applyShellEvent(state, event("return"));
		expect(state.sectionIndex).toBe(1);
		expect(state.statusNote).toBe("Add account opened. Choose a sign-in method next.");

		state = await applyShellEvent(state, event("escape"));
		expect(state.sectionIndex).toBe(0);
		expect(state.statusNote).toBe(
			"Sign-in cancelled. Back on the dashboard.",
		);
		expect(prevented).toEqual(["tab", "down", "right", "return", "escape"]);
	});

	test("cancels back to dashboard and reopens add account from a clean shell state", async () => {
		const authChoiceState = openAuthChoiceState();
		const cancelledState = applyShellKey(authChoiceState, "escape");

		expect(cancelledState.activeRegion).toBe("content");
		expect(cancelledState.sectionIndex).toBe(0);
		expect(cancelledState.actionIndex).toBe(0);
		expect(cancelledState.unlockedSectionIndex).toBe(0);
		expect(cancelledState.statusNote).toBe("Sign-in cancelled. Back on the dashboard.");

		const reopenedState = applyShellKey(cancelledState, "return");
		expect(reopenedState.sectionIndex).toBe(1);
		expect(reopenedState.unlockedSectionIndex).toBe(1);

		activeRender = await testRender(() => <OpenTuiShellProof initialState={reopenedState} />, {
			width: 80,
			height: 24,
		});
		await activeRender.renderOnce();

		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("Add Account");
		expect(frame).toContain("Choose Sign-In Method");
		expect(frame).not.toContain("Open Browser (Easy)");
	});

	test("cancels settings without persisting the draft change", async () => {
		await removeWithRetry(getDashboardSettingsPath(), { force: true });
		let settingsState = openSettingsContentState(createInitialShellState(await loadDashboardDisplaySettings()));
		settingsState = applyShellKey(settingsState, "down");
		settingsState = applyShellKey(settingsState, "down");
		const cancelledState = applyShellKey(settingsState, "return");

		expect(cancelledState.sectionIndex).toBe(0);
		expect(cancelledState.statusNote).toBe("Settings cancelled. Saved value kept.");
		expect(cancelledState.persistedSettings.menuShowStatusBadge).toBe(true);
		expect(cancelledState.settingsDraft.menuShowStatusBadge).toBe(true);
		expect(existsSync(getDashboardSettingsPath())).toBe(false);

		activeRender = await testRender(() => <OpenTuiShellProof initialState={cancelledState} />, {
			width: 80,
			height: 24,
		});
		await activeRender.renderOnce();

		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("Settings cancelled. Saved value kept.");
		expect(frame).toContain("Dashboard");
	});

	test("saves a simple settings change under the isolated env root", async () => {
		await removeWithRetry(getDashboardSettingsPath(), { force: true });
		let settingsState = openSettingsContentState(createInitialShellState(await loadDashboardDisplaySettings()));
		settingsState = applyShellKey(settingsState, "down");

		const savedState = await persistShellSettings(settingsState);
		const reloadedSettings = await loadDashboardDisplaySettings();
		const savedContent = await fs.readFile(getDashboardSettingsPath(), "utf8");

		expect(savedState.sectionIndex).toBe(0);
		expect(savedState.statusNote).toBe("Settings saved. Status badges are off.");
		expect(reloadedSettings.menuShowStatusBadge).toBe(false);
		expect(savedContent).toContain('"dashboardDisplaySettings"');
		expect(savedContent).toContain('"menuShowStatusBadge": false');

		activeRender = await testRender(() => <OpenTuiShellProof initialState={savedState} />, {
			width: 80,
			height: 24,
		});
		await activeRender.renderOnce();

		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("Dashboard");
		expect(frame).toContain("Settings saved. Status badges are off.");
	});

	test("switches the current account in workspace and carries it into health before resetting cleanly", async () => {
		let workspaceState = openWorkspaceState();

		expect(workspaceState.sectionIndex).toBe(3);
		expect(workspaceState.currentAccountIndex).toBe(0);

		workspaceState = applyShellKey(workspaceState, "down");
		workspaceState = applyShellKey(workspaceState, "return");

		expect(workspaceState.currentAccountIndex).toBe(1);
		expect(workspaceState.statusNote).toBe(
			"Current account set to Build Canary for this shell workspace.",
		);

		workspaceState = applyShellKey(workspaceState, "down");
		workspaceState = applyShellKey(workspaceState, "down");
		const healthState = applyShellKey(workspaceState, "return");

		expect(healthState.sectionIndex).toBe(4);
		expect(healthState.currentAccountIndex).toBe(1);
		expect(healthState.statusNote).toBe("Health check opened for Build Canary.");

		activeRender = await testRender(() => <OpenTuiShellProof initialState={healthState} />, {
			width: 80,
			height: 24,
		});
		await activeRender.renderOnce();

		const healthFrame = activeRender.captureCharFrame();
		expect(healthFrame).toContain("Health Check");
		expect(healthFrame).toContain("Build Canary [current]");
		expect(healthFrame).toContain("Shell status: DEGRADED");

		const cancelledState = applyShellKey(healthState, "escape");
		expect(cancelledState.sectionIndex).toBe(0);
		expect(cancelledState.unlockedSectionIndex).toBe(0);
		expect(cancelledState.currentAccountIndex).toBe(1);
		expect(cancelledState.statusNote).toBe("Health check closed. Back on the dashboard.");

		activeRender.renderer.destroy();
		activeRender = await testRender(() => <OpenTuiShellProof initialState={cancelledState} />, {
			width: 80,
			height: 24,
		});
		await activeRender.renderOnce();

		const dashboardFrame = activeRender.captureCharFrame();
		expect(dashboardFrame).toContain("Account Workspace (Build Canary)");
		expect(dashboardFrame).toContain("Health check closed. Back on the dashboard.");
	});
});
