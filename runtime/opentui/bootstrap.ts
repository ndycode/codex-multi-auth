import type { CliRenderer, CliRendererConfig } from "@opentui/core";
import { render } from "@opentui/solid";
import { createComponent } from "solid-js";
import { OpenTuiBootstrapApp, type OpenTuiBootstrapAppProps } from "./app.js";

export type OpenTuiAuthShellBootstrapReason =
	| "stdin-not-tty"
	| "stdout-not-tty"
	| "host-managed-ui";

export interface OpenTuiAuthShellEnvironment {
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	env?: NodeJS.ProcessEnv;
}

export interface OpenTuiAuthShellBootstrapResult {
	supported: boolean;
	reason?: OpenTuiAuthShellBootstrapReason;
}

function isHostManagedUi(env: NodeJS.ProcessEnv): boolean {
	if (env.FORCE_INTERACTIVE_MODE === "1") return false;
	if (env.CODEX_TUI === "1") return true;
	if (env.CODEX_DESKTOP === "1") return true;
	if ((env.TERM_PROGRAM ?? "").trim().toLowerCase() === "codex") return true;
	if (env.ELECTRON_RUN_AS_NODE === "1") return true;
	return false;
}

export function resolveOpenTuiAuthShellBootstrap(
	environment: OpenTuiAuthShellEnvironment = {},
): OpenTuiAuthShellBootstrapResult {
	const stdin = environment.stdin ?? process.stdin;
	const stdout = environment.stdout ?? process.stdout;
	const env = environment.env ?? process.env;
	if (!stdin.isTTY) {
		return { supported: false, reason: "stdin-not-tty" };
	}
	if (!stdout.isTTY) {
		return { supported: false, reason: "stdout-not-tty" };
	}
	if (isHostManagedUi(env)) {
		return { supported: false, reason: "host-managed-ui" };
	}
	return { supported: true };
}

export type OpenTuiBootstrapOptions = OpenTuiAuthShellEnvironment & OpenTuiBootstrapAppProps & {
	renderer?: CliRenderer | CliRendererConfig;
};

export async function startOpenTuiAuthShell(options: OpenTuiBootstrapOptions = {}) {
	const support = resolveOpenTuiAuthShellBootstrap(options);
	if (!support.supported) {
		return null;
	}

	const renderResult = await render(() => createComponent(OpenTuiBootstrapApp, {
		dashboard: options.dashboard,
		navOptions: options.navOptions,
		onExit: options.onExit,
		onKeyPress: options.onKeyPress,
		onReady: options.onReady,
		onRendererSelection: options.onRendererSelection,
		onSelectionChange: options.onSelectionChange,
		onSettingsSave: options.onSettingsSave,
		onWorkspaceAction: options.onWorkspaceAction,
	}), options.renderer ?? {
		exitOnCtrlC: false,
		targetFps: 30,
	});

	return renderResult;
}

export async function startOpenTuiBootstrap(options: OpenTuiBootstrapOptions = {}) {
	return startOpenTuiAuthShell(options);
}
