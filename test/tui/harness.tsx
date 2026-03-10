import { render } from "@opentui/solid";
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing";
import { createComponent } from "solid-js";
import type {
	OpenTuiBootstrapAppProps,
	OpenTuiShellExitReason,
	OpenTuiShellFocusTarget,
	OpenTuiShellReadyContext,
	OpenTuiShellSelection,
	OpenTuiWorkspaceAction,
	OpenTuiShellTimer,
} from "../../runtime/opentui/app.js";
import { OpenTuiBootstrapApp } from "../../runtime/opentui/app.js";

export type TrackedShellClock = {
	activeTimers: Set<number>;
	getActiveTimerCount: () => number;
	setInterval: (_callback: () => void, _intervalMs: number) => OpenTuiShellTimer;
	clearInterval: (timer: OpenTuiShellTimer) => void;
};

export function createTrackedShellClock(): TrackedShellClock {
	const activeTimers = new Set<number>();
	let nextTimerId = 0;

	return {
		activeTimers,
		getActiveTimerCount: () => activeTimers.size,
		setInterval: () => {
			nextTimerId += 1;
			activeTimers.add(nextTimerId);
			return nextTimerId;
		},
		clearInterval: (timer) => {
			if (typeof timer === "number") {
				activeTimers.delete(timer);
			}
		},
	};
}

export function getShellListenerCounts(renderer: {
	listenerCount: (eventName: string) => number;
	keyInput: {
		listenerCount: (eventName: string) => number;
	};
}) {
	return {
		selection: renderer.listenerCount("selection"),
		keypress: renderer.keyInput.listenerCount("keypress"),
	};
}

export async function mountOpenTuiShellHarness(options: {
	shell?: OpenTuiBootstrapAppProps;
	renderer?: Partial<TestRendererOptions>;
} = {}) {
	const readyContexts: OpenTuiShellReadyContext[] = [];
	const selectionChanges: OpenTuiShellSelection[] = [];
	const exitReasons: OpenTuiShellExitReason[] = [];
	const focusTargets: OpenTuiShellFocusTarget[] = [];
	const keyNames: string[] = [];
	const workspaceActions: OpenTuiWorkspaceAction[] = [];
	const trackedClock = options.shell?.clock ?? createTrackedShellClock();

	const setup = await createTestRenderer(
		{
			autoFocus: true,
			exitOnCtrlC: false,
			height: 20,
			kittyKeyboard: true,
			targetFps: 30,
			width: 72,
			...(options.renderer ?? {}),
		},
	);

	const baselineListenerCounts = getShellListenerCounts(setup.renderer);

	await render(
		() => createComponent(OpenTuiBootstrapApp, {
			...(options.shell ?? {}),
			clock: trackedClock,
			onExit: (reason, renderer) => {
				exitReasons.push(reason);
				options.shell?.onExit?.(reason, renderer);
			},
			onKeyPress: (keyEvent) => {
				keyNames.push(keyEvent.name);
				options.shell?.onKeyPress?.(keyEvent);
			},
			onReady: (context) => {
				readyContexts.push(context);
				options.shell?.onReady?.(context);
			},
			onSelectionChange: (selection) => {
				selectionChanges.push(selection);
				focusTargets.push(selection.focusTarget);
				options.shell?.onSelectionChange?.(selection);
			},
			onWorkspaceAction: (action) => {
				workspaceActions.push(action);
				options.shell?.onWorkspaceAction?.(action);
			},
		}),
		setup.renderer,
	);

	await setup.renderOnce();
	await Promise.resolve();

	return {
		...setup,
		baselineListenerCounts,
		clock: trackedClock,
		exitReasons,
		focusTargets,
		keyNames,
		readyContexts,
		selectionChanges,
		workspaceActions,
		destroy: async () => {
			if (!setup.renderer.isDestroyed) {
				setup.renderer.destroy();
				await Promise.resolve();
			}
		},
	};
}
