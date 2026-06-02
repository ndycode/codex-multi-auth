#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { splitPathEntries } from "./codex-bin-resolver.js";

// Cross-platform replacement for the legacy `scripts/mcodex` bash launcher.
// The bash shim was shipped as a Windows `bin`; npm's generated mcodex.cmd/.ps1
// invoked bare `bash`, and when a WSL stub resolved before git-bash on PATH the
// launcher died with HCS_E_SERVICE_NOT_AVAILABLE. This node entry forwards to the
// sibling codex wrapper with zero bash dependency, and only reaches for the POSIX
// tools (`tmux`/`watch`) when they actually exist — otherwise it degrades with the
// same friendly messages the bash version printed.

const DEFAULT_MONITOR_INTERVAL = "5";
const DEFAULT_TMUX_HISTORY_LIMIT = "50000";
const DEFAULT_TMUX_SESSION = "mcodex";

// Security: monitor_interval is interpolated into the `watch -n <n> ...` argument
// and tmux_history_limit into a tmux option argument. Require a positive (optionally
// fractional) number / plain integer and fall back to the default otherwise, so no
// shell metacharacters can ever reach a command — preserving the bash hardening.
const MONITOR_INTERVAL_PATTERN = /^[0-9]+(\.[0-9]+)?$/;
const TMUX_HISTORY_LIMIT_PATTERN = /^[0-9]+$/;

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Spawn the sibling codex wrapper directly through `node` (process.execPath) rather
// than relying on the installed `codex-multi-auth-codex` shim being on PATH. This is
// the same idiom codex-app-launcher.js uses to launch codex.js and is what makes the
// default forward work on Windows without any bash/.cmd resolution.
const codexWrapperScript = join(scriptDir, "codex.js");

function defaultWarn(message) {
	console.error(message);
}

// When mcodex itself is asked to terminate, forward the signal to the spawned
// child so the forwarded codex.js / watch process doesn't outlive us as an
// orphan. Without this, a SIGTERM to the launcher exits the parent while the
// child keeps running detached. Listeners are registered with `once` and torn
// down when the child settles (returned cleanup), so they never leak across the
// launcher's lifetime. `proc` is injectable so the wiring is unit-testable
// without registering handlers on the real process.
export function relaySignalsToChild(
	child,
	{ proc = process, signals = ["SIGTERM", "SIGINT"] } = {},
) {
	const registered = signals.map((signal) => {
		const handler = () => {
			try {
				child.kill(signal);
			} catch {
				// Child may have already exited; nothing left to forward.
			}
		};
		proc.once(signal, handler);
		return { signal, handler };
	});
	return function removeSignalRelays() {
		for (const { signal, handler } of registered) {
			proc.removeListener(signal, handler);
		}
	};
}

function coerceValidatedSetting(rawValue, pattern, fallback, envName, warn) {
	// Mirror bash `${VAR:-default}`: unset OR empty falls back silently; any other
	// value is validated and, if it fails, replaced with the default plus a warning.
	const value = rawValue === undefined || rawValue === "" ? fallback : rawValue;
	if (!pattern.test(value)) {
		warn(`mcodex: invalid ${envName} '${value}'; using ${fallback}`);
		return fallback;
	}
	return value;
}

export function resolveMonitorInterval(env = process.env, warn = defaultWarn) {
	return coerceValidatedSetting(
		env.MCODEX_MONITOR_INTERVAL,
		MONITOR_INTERVAL_PATTERN,
		DEFAULT_MONITOR_INTERVAL,
		"MCODEX_MONITOR_INTERVAL",
		warn,
	);
}

export function resolveTmuxHistoryLimit(env = process.env, warn = defaultWarn) {
	return coerceValidatedSetting(
		env.MCODEX_TMUX_HISTORY_LIMIT,
		TMUX_HISTORY_LIMIT_PATTERN,
		DEFAULT_TMUX_HISTORY_LIMIT,
		"MCODEX_TMUX_HISTORY_LIMIT",
		warn,
	);
}

export function resolveTmuxSession(env = process.env) {
	const configured = (env.MCODEX_TMUX_SESSION ?? "").trim();
	return configured.length > 0 ? configured : DEFAULT_TMUX_SESSION;
}

/**
 * Parse the launcher flags the same way the bash script did: the FIRST argument
 * selects a mode (--monitor, or --tmux/-t), and only when --tmux/-t is present is
 * a following --live-accounts consumed. Every remaining token is passthrough for
 * the codex wrapper. Returns the mode plus the forwarded args.
 *
 * @param {string[]} argv
 */
export function parseMcodexArgs(argv) {
	const first = argv[0] ?? "";
	if (first === "--monitor") {
		// --monitor takes no extra args; the live account list is fixed.
		return { mode: "monitor", liveAccounts: false, forwardArgs: argv.slice(1) };
	}
	if (first === "--tmux" || first === "-t") {
		let rest = argv.slice(1);
		let liveAccounts = false;
		if (rest[0] === "--live-accounts") {
			liveAccounts = true;
			rest = rest.slice(1);
		}
		return { mode: "tmux", liveAccounts, forwardArgs: rest };
	}
	return { mode: "forward", liveAccounts: false, forwardArgs: argv };
}

// Resolve a POSIX helper (tmux/watch) on PATH ourselves rather than shelling out,
// so we never depend on bash. Mirrors codex-bin-resolver's PATH handling.
function resolvePosixToolOnPath(tool, env = process.env, platform = process.platform) {
	const names = platform === "win32" ? [`${tool}.exe`, `${tool}.cmd`, tool] : [tool];
	for (const entry of splitPathEntries(env.PATH ?? env.Path ?? "")) {
		for (const name of names) {
			const candidate = join(entry, name);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

function hasPosixTool(tool, env = process.env, platform = process.platform) {
	return resolvePosixToolOnPath(tool, env, platform) !== null;
}

// Build the watch argv as an array (NOT a shell string): `watch -n <interval>
// codex-multi-auth list`. Because the interval is validated to digits/dot and the
// command is passed as discrete argv tokens, no shell interpolation occurs — this
// is strictly safer than the bash `printf %q` approach.
function buildWatchArgs(interval) {
	return ["-n", interval, "codex-multi-auth", "list"];
}

function forwardToCodexWrapper(forwardArgs, env = process.env) {
	const child = spawn(process.execPath, [codexWrapperScript, ...forwardArgs], {
		stdio: "inherit",
		env,
	});
	const removeSignalRelays = relaySignalsToChild(child);
	child.once("error", (error) => {
		removeSignalRelays();
		console.error(
			`mcodex: failed to launch codex wrapper: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
	child.once("close", (code, signal) => {
		removeSignalRelays();
		if (signal === "SIGINT") {
			process.exit(130);
			return;
		}
		process.exit(typeof code === "number" ? code : 1);
	});
}

function runMonitor(interval, env = process.env, platform = process.platform) {
	const watchPath = resolvePosixToolOnPath("watch", env, platform);
	if (!watchPath) {
		console.error(
			"mcodex: 'watch' is not installed; the live account monitor requires it (install procps / procps-ng).",
		);
		process.exit(1);
		return;
	}
	const child = spawn(watchPath, buildWatchArgs(interval), { stdio: "inherit", env });
	const removeSignalRelays = relaySignalsToChild(child);
	child.once("error", (error) => {
		removeSignalRelays();
		console.error(
			`mcodex: failed to launch watch: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
	child.once("close", (code, signal) => {
		removeSignalRelays();
		if (signal === "SIGINT") {
			process.exit(130);
			return;
		}
		process.exit(typeof code === "number" ? code : 1);
	});
}

// Run a tmux subcommand synchronously, swallowing output exactly like the bash
// `>/dev/null 2>&1`. argv-only, so the validated history-limit/session never reach
// a shell.
function runTmux(tmuxPath, args, env = process.env) {
	return spawnSync(tmuxPath, args, {
		stdio: ["ignore", "ignore", "ignore"],
		env,
	});
}

function configureTmuxScrollback(tmuxPath, historyLimit, target, env = process.env) {
	const targetArgs = target ? ["-t", target] : [];
	runTmux(tmuxPath, ["set-option", ...targetArgs, "mouse", "on"], env);
	runTmux(tmuxPath, ["set-option", ...targetArgs, "history-limit", historyLimit], env);
	runTmux(tmuxPath, ["bind-key", "-T", "root", "WheelUpPane", "copy-mode", "-e"], env);
	runTmux(tmuxPath, ["bind-key", "-T", "copy-mode", "WheelUpPane", "send-keys", "-X", "scroll-up"], env);
	runTmux(tmuxPath, ["bind-key", "-T", "copy-mode", "WheelDownPane", "send-keys", "-X", "scroll-down"], env);
	runTmux(tmuxPath, ["bind-key", "-T", "copy-mode-vi", "WheelUpPane", "send-keys", "-X", "scroll-up"], env);
	runTmux(tmuxPath, ["bind-key", "-T", "copy-mode-vi", "WheelDownPane", "send-keys", "-X", "scroll-down"], env);
}

function warnWatchMissing() {
	console.error(
		"mcodex: 'watch' is not installed; the live account monitor requires it (install procps / procps-ng).",
	);
}

function formatTmuxSessionSuffix(date = new Date()) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// The codex command tmux should run inside a pane. Use node + the sibling wrapper
// (same as the default forward) so the pane never depends on the installed
// `codex-multi-auth-codex` shim being resolvable.
function buildCodexPaneCommand(forwardArgs) {
	return [process.execPath, codexWrapperScript, ...forwardArgs];
}

function runTmuxMode(options) {
	const { liveAccounts, forwardArgs, interval, historyLimit, session, env, platform } =
		options;

	const tmuxPath = resolvePosixToolOnPath("tmux", env, platform);
	if (!tmuxPath) {
		// Degrade exactly like the bash version: warn, then forward without tmux.
		console.error("mcodex: tmux is not installed; launching without tmux");
		forwardToCodexWrapper(forwardArgs, env);
		return;
	}

	const watchAvailable = liveAccounts ? hasPosixTool("watch", env, platform) : false;
	if (liveAccounts && !watchAvailable) {
		warnWatchMissing();
	}

	// Already inside a tmux client: configure the current session, optionally add a
	// live-accounts pane, then run codex in the current pane (forward + exit code).
	if ((env.TMUX ?? "").length > 0) {
		configureTmuxScrollback(tmuxPath, historyLimit, undefined, env);
		if (liveAccounts && watchAvailable) {
			runTmux(tmuxPath, ["split-window", "-h", "watch", ...buildWatchArgs(interval)], env);
		}
		forwardToCodexWrapper(forwardArgs, env);
		return;
	}

	// Not inside tmux: create a fresh detached session, configure it, optionally add
	// the live pane, then attach (inheriting the terminal) and propagate the code.
	let targetSession = session;
	if (runTmux(tmuxPath, ["has-session", "-t", targetSession], env).status === 0) {
		targetSession = `${targetSession}-${formatTmuxSessionSuffix()}`;
	}
	runTmux(
		tmuxPath,
		["new-session", "-d", "-s", targetSession, "-n", "codex", ...buildCodexPaneCommand(forwardArgs)],
		env,
	);
	configureTmuxScrollback(tmuxPath, historyLimit, targetSession, env);
	if (liveAccounts && watchAvailable) {
		runTmux(
			tmuxPath,
			["split-window", "-h", "-t", `${targetSession}:0`, "watch", ...buildWatchArgs(interval)],
			env,
		);
	}
	runTmux(tmuxPath, ["select-pane", "-t", `${targetSession}:0.0`], env);
	const attach = spawn(tmuxPath, ["attach-session", "-t", targetSession], {
		stdio: "inherit",
		env,
	});
	attach.once("error", (error) => {
		console.error(
			`mcodex: failed to attach tmux session: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
	attach.once("close", (code, signal) => {
		if (signal === "SIGINT") {
			process.exit(130);
			return;
		}
		process.exit(typeof code === "number" ? code : 0);
	});
}

export function runMcodex(argv = process.argv.slice(2), env = process.env, platform = process.platform) {
	const { mode, liveAccounts, forwardArgs } = parseMcodexArgs(argv);
	const interval = resolveMonitorInterval(env);
	const historyLimit = resolveTmuxHistoryLimit(env);

	if (mode === "monitor") {
		runMonitor(interval, env, platform);
		return;
	}
	if (mode === "tmux") {
		runTmuxMode({
			liveAccounts,
			forwardArgs,
			interval,
			historyLimit,
			session: resolveTmuxSession(env),
			env,
			platform,
		});
		return;
	}
	forwardToCodexWrapper(forwardArgs, env);
}

export function isDirectRunInvocation(invoked, selfUrl) {
	if (!invoked) return false;
	const selfPath = fileURLToPath(selfUrl);
	// Canonicalize both sides: npm installs bins as symlinks (and on Windows the
	// .cmd/.ps1 shim invokes this file via its real path), so a raw string compare
	// of process.argv[1] against import.meta.url misses the symlinked-bin case and
	// the launcher silently becomes a no-op. realpathSync resolves both to the same
	// target; fall back to a resolved-path compare if realpath fails (e.g. the file
	// was unlinked between launch and this check).
	const canonical = (p) => {
		try {
			return realpathSync(p);
		} catch {
			return resolvePath(p);
		}
	};
	try {
		return canonical(invoked) === canonical(selfPath);
	} catch {
		return false;
	}
}

const isDirectRun = isDirectRunInvocation(process.argv[1], import.meta.url);

if (isDirectRun) {
	runMcodex();
}

