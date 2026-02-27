#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCodexMultiAuthCli } from "../dist/lib/codex-manager.js";

const AUTH_SUBCOMMANDS = new Set([
	"login",
	"list",
	"status",
	"switch",
	"check",
	"features",
	"verify-flagged",
	"forecast",
	"report",
	"fix",
	"doctor",
]);

/**
 * Normalize alternate "multi-auth" CLI invocation forms to the canonical "auth" form.
 *
 * Converts argument lists that begin with ["multi", "auth"] or with a single token
 * "multi-auth" / "multiauth" into ["auth", ...rest]; returns the original args otherwise.
 * @param {string[]} args - Command-line arguments to normalize.
 * @returns {string[]} The normalized argument array.
 */
function normalizeAuthAlias(args) {
	if (args.length >= 2 && args[0] === "multi" && args[1] === "auth") {
		return ["auth", ...args.slice(2)];
	}
	if (args.length >= 1 && (args[0] === "multi-auth" || args[0] === "multiauth")) {
		return ["auth", ...args.slice(1)];
	}
	return args;
}

/**
 * Determine whether the provided CLI arguments should be handled by the wrapper's multi-auth `auth` flow.
 *
 * @param {string[]} args - The command-line arguments (tokens after the script name).
 * @returns {boolean} `true` if the arguments indicate the wrapper should handle a multi-auth `auth` action, `false` otherwise.
 */
function shouldHandleMultiAuthAuth(args) {
	if (args[0] !== "auth") return false;
	if (args.length === 1) return true;
	const subcommand = args[1];
	if (typeof subcommand !== "string") return false;
	if (subcommand.startsWith("-")) return true;
	return AUTH_SUBCOMMANDS.has(subcommand);
}

/**
 * Locate the real @openai/codex CLI binary on disk.
 *
 * Checks, in order: the CODEX_MULTI_AUTH_REAL_CODEX_BIN environment override, local package resolution for
 * @openai/codex, sibling/common installation locations based on the script and npm prefix, and the global
 * npm root. Returns the resolved filesystem path when found.
 *
 * @returns {string|null} The path to the codex binary if found, `null` otherwise.
 */
function resolveRealCodexBin() {
	const override = (process.env.CODEX_MULTI_AUTH_REAL_CODEX_BIN ?? "").trim();
	if (override.length > 0) {
		if (existsSync(override)) return override;
		console.error(
			`CODEX_MULTI_AUTH_REAL_CODEX_BIN is set but missing: ${override}`,
		);
		return null;
	}

	try {
		const require = createRequire(import.meta.url);
		const resolved = require.resolve("@openai/codex/bin/codex.js");
		if (existsSync(resolved)) return resolved;
	} catch {
		// Fall through to sibling lookup.
	}

	const searchRoots = [];
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	searchRoots.push(join(scriptDir, "..", ".."));

	const invokedScript = process.argv[1];
	if (typeof invokedScript === "string" && invokedScript.length > 0) {
		searchRoots.push(join(dirname(invokedScript), "..", ".."));
	}

	const npmPrefix = (process.env.npm_config_prefix ?? process.env.PREFIX ?? "").trim();
	if (npmPrefix.length > 0) {
		searchRoots.push(join(npmPrefix, "node_modules"));
		searchRoots.push(join(npmPrefix, "lib", "node_modules"));
	}

	for (const root of searchRoots) {
		const candidate = join(root, "@openai", "codex", "bin", "codex.js");
		if (existsSync(candidate)) return candidate;
	}

	const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
	try {
		const rootResult = spawnSync(npmCmd, ["root", "-g"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (rootResult.status === 0) {
			const globalRoot = rootResult.stdout.trim();
			if (globalRoot.length > 0) {
				const globalBin = join(globalRoot, "@openai", "codex", "bin", "codex.js");
				if (existsSync(globalBin)) return globalBin;
			}
		}
	} catch {
		// Ignore and fall through to null.
	}

	return null;
}

/**
 * Spawn the real Codex CLI with the provided arguments and proxy its exit status.
 *
 * @param {string} codexBin - Path to the real Codex CLI JavaScript file to execute.
 * @param {string[]} args - Arguments to forward to the real Codex CLI.
 * @returns {number} Exit code for the wrapper process: the child's numeric exit code if available; `130` if the child was terminated by `SIGINT`; `1` for other signals, errors, or unknown exit conditions.
 */
function forwardToRealCodex(codexBin, args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [codexBin, ...args], {
			stdio: "inherit",
			env: process.env,
		});

		child.once("error", (error) => {
			console.error(`Failed to launch real Codex CLI: ${String(error)}`);
			resolve(1);
		});

		child.once("exit", (code, signal) => {
			if (signal) {
				const signalNumber = signal === "SIGINT" ? 130 : 1;
				resolve(signalNumber);
				return;
			}
			resolve(typeof code === "number" ? code : 1);
		});
	});
}

const rawArgs = process.argv.slice(2);
const normalizedArgs = normalizeAuthAlias(rawArgs);
const bypass = (process.env.CODEX_MULTI_AUTH_BYPASS ?? "").trim() === "1";

if (!bypass && shouldHandleMultiAuthAuth(normalizedArgs)) {
	const exitCode = await runCodexMultiAuthCli(normalizedArgs);
	process.exit(exitCode);
}

const realCodexBin = resolveRealCodexBin();
if (!realCodexBin) {
	console.error(
		[
			"Could not locate the official Codex CLI binary (@openai/codex).",
			"Install it globally: npm install -g @openai/codex",
			"Or set CODEX_MULTI_AUTH_REAL_CODEX_BIN to a full bin/codex.js path.",
		].join("\n"),
	);
	process.exit(1);
}

const forwardExitCode = await forwardToRealCodex(realCodexBin, rawArgs);
process.exit(forwardExitCode);
