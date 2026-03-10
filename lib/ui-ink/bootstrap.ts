import { createElement } from "react";
import { render, type Instance, type RenderOptions } from "ink";
import type { AuthDashboardViewModel } from "../codex-manager/auth-ui-controller.js";
import { AuthInkShell, type AuthInkShellProps } from "./auth-shell.js";

export type InkAuthShellBootstrapReason =
	| "stdin-not-tty"
	| "stdout-not-tty"
	| "host-managed-ui";

export interface InkAuthShellEnvironment {
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	env?: NodeJS.ProcessEnv;
}

export interface InkAuthShellBootstrapResult {
	supported: boolean;
	reason?: InkAuthShellBootstrapReason;
}

function isHostManagedUi(env: NodeJS.ProcessEnv): boolean {
	if (env.FORCE_INTERACTIVE_MODE === "1") return false;
	if (env.CODEX_TUI === "1") return true;
	if (env.CODEX_DESKTOP === "1") return true;
	if ((env.TERM_PROGRAM ?? "").trim().toLowerCase() === "codex") return true;
	if (env.ELECTRON_RUN_AS_NODE === "1") return true;
	return false;
}

export function resolveInkAuthShellBootstrap(
	environment: InkAuthShellEnvironment = {},
): InkAuthShellBootstrapResult {
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

export interface StartInkAuthShellOptions extends InkAuthShellEnvironment {
	dashboard: AuthDashboardViewModel;
	title?: string;
	subtitle?: string;
	statusText?: string;
	footerText?: string;
	stderr?: NodeJS.WriteStream;
	debug?: boolean;
	patchConsole?: boolean;
	exitOnCtrlC?: boolean;
}

export function startInkAuthShell(options: StartInkAuthShellOptions): Instance | null {
	const support = resolveInkAuthShellBootstrap(options);
	if (!support.supported) {
		return null;
	}

	const props: AuthInkShellProps = {
		dashboard: options.dashboard,
		title: options.title,
		subtitle: options.subtitle,
		statusText: options.statusText,
		footerText: options.footerText,
	};

	const renderOptions: RenderOptions = {
		stdin: options.stdin ?? process.stdin,
		stdout: options.stdout ?? process.stdout,
		stderr: options.stderr ?? process.stderr,
		debug: options.debug ?? false,
		patchConsole: options.patchConsole ?? false,
		exitOnCtrlC: options.exitOnCtrlC ?? false,
	};

	return render(createElement(AuthInkShell, props), renderOptions);
}
