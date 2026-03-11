import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "./harness";
import {
	applyShellKey,
	createInitialShellState,
	OpenTuiShellProof,
} from "../../runtime/opentui/shell";
import { openAuthChoiceState, openHealthState, openSettingsState, openWorkspaceState } from "./scenario-helpers";

let activeRender: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
	activeRender?.renderer.destroy();
	activeRender = undefined;
});

describe("OpenTUI frame harness", () => {
	test("renders the dashboard slice at 100x30", async () => {
		activeRender = await testRender(OpenTuiShellProof, { width: 100, height: 30 });

		await activeRender.renderOnce();
		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("OpenTUI Dashboard Slice");
		expect(frame).toContain("Navigation");
		expect(frame).toContain("Content");
		expect(frame).toContain("Dashboard");
		expect(frame).toContain("Add New Account");
		expect(frame).toContain("Settings");
	});

	test("renders shell-native settings inside the same frame landmarks", async () => {
		const settingsState = openSettingsState();
		activeRender = await testRender(() => <OpenTuiShellProof initialState={settingsState} />, {
			width: 80,
			height: 24,
		});

		await activeRender.renderOnce();
		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("Settings");
		expect(frame).toContain("Navigation");
		expect(frame).toContain("Content");
		expect(frame).toContain("Status Badges: On");
		expect(frame).toContain("Save and Return to Dashboard");
	});

	test("renders account workspace with a visible current account inside the shared frame", async () => {
		const workspaceState = openWorkspaceState();
		activeRender = await testRender(() => <OpenTuiShellProof initialState={workspaceState} />, {
			width: 80,
			height: 24,
		});

		await activeRender.renderOnce();
		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("Account Workspace");
		expect(frame).toContain("Maya Rivera [current]");
		expect(frame).toContain("Run Health Check");
		expect(frame).toContain("Navigation");
		expect(frame).toContain("Content");
	});

	test("renders beginner-safe health check inside the same frame landmarks", async () => {
		const healthState = openHealthState();
		activeRender = await testRender(() => <OpenTuiShellProof initialState={healthState} />, {
			width: 80,
			height: 24,
		});

		await activeRender.renderOnce();
		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("Health Check");
		expect(frame).toContain("Cooling down: 1");
		expect(frame).toContain("Open Account Workspace");
		expect(frame).toContain("Navigation");
		expect(frame).toContain("Content");
	});

	test("renders auth choice after the dashboard flow at 80x24", async () => {
		const authChoiceState = openAuthChoiceState();
		activeRender = await testRender(() => <OpenTuiShellProof initialState={authChoiceState} />, {
			width: 80,
			height: 24,
		});

		await activeRender.renderOnce();
		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("80x24");
		expect(frame).toContain("wide split");
		expect(frame).toContain("Auth Choice");
		expect(frame).toContain("Open Browser (Easy)");
		expect(frame).toContain("Manual / Incognito");
	});

	test("switches to compact layout at threshold-adjacent narrow sizes", async () => {
		activeRender = await testRender(OpenTuiShellProof, { width: 59, height: 18 });

		await activeRender.renderOnce();
		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("59x18");
		expect(frame).toContain("compact stack");
	});

	test("switches to compact layout when height falls below threshold", async () => {
		activeRender = await testRender(OpenTuiShellProof, { width: 60, height: 17 });

		await activeRender.renderOnce();
		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("60x17");
		expect(frame).toContain("compact stack");
	});

	test("renders the dashboard reset after cancel without stale auth choice state", async () => {
		const authChoiceState = openAuthChoiceState();
		const cancelledState = applyShellKey(authChoiceState, "escape");
		activeRender = await testRender(() => <OpenTuiShellProof initialState={cancelledState} />, {
			width: 80,
			height: 24,
		});

		await activeRender.renderOnce();
		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("Dashboard");
		expect(frame).toContain("Add New Account");
		expect(frame).toContain("Sign-in cancelled. Back on the dashboard.");
		expect(frame).not.toContain("Open Browser (Easy)");
	});

	test("renders the compact shell slice at 48x16 without clipping the sidebar", async () => {
		activeRender = await testRender(OpenTuiShellProof, { width: 48, height: 16 });

		await activeRender.renderOnce();
		const frame = activeRender.captureCharFrame();
		expect(frame).toContain("48x16");
		expect(frame).toContain("compact stack");
		expect(frame).toContain("Navigation");
		expect(frame).toContain("Dash");
		expect(frame).toContain("Add");
		expect(frame).toContain("Auth");
		expect(frame).toContain("Work");
		expect(frame).toContain("Check");
		expect(frame).toContain("Set");
	});

	test("keeps content focus when toggling regions with Tab", async () => {
		const focusState = applyShellKey(createInitialShellState(), "tab");
		activeRender = await testRender(() => <OpenTuiShellProof initialState={focusState} />, {
			width: 80,
			height: 24,
		});

		await activeRender.renderOnce();
		expect(activeRender.captureCharFrame()).toContain("Focus navigation");
	});
});
