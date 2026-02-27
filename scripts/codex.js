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
 * Canonicalizes multi-auth CLI aliases into the canonical "auth" form.
 * @param {string[]} args - Command-line argument tokens (e.g., user-provided subcommands and flags).
 * @returns {string[]} The normalized argument array: if the invocation begins with ["multi","auth"] or with "multi-auth"/"multiauth" it returns ["auth", ...rest], otherwise it returns the original `args`.
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
 * Determine whether a Codex CLI invocation should be handled by the multi-auth handler.
 * @param {string[]} args - Command tokens (argv slice after the node executable and script).
 * @returns {boolean} `true` if the first token is "auth" and there is no subcommand, the subcommand starts with "-", or the subcommand is a recognized auth subcommand; `false` otherwise.
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
 * Locate the real Codex CLI binary on disk using multiple fallbacks.
 *
 * The resolution order is: an explicit `CODEX_MULTI_AUTH_REAL_CODEX_BIN` override,
 * Node package resolution for `@openai/codex/bin/codex.js`, sibling/conventional
 * locations relative to the current and invoked script, npm prefix locations,
 * and finally the global npm root.
 *
 * @returns {string|null} The filesystem path to the Codex CLI if found, or `null` if not found.
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
 * Run the real Codex CLI with the given arguments and propagate its exit status.
 *
 * @param {string} codexBin - Filesystem path to the real Codex CLI entry script.
 * @param {string[]} args - Command-line arguments to pass through to the real CLI.
 * @returns {Promise<number>} Exit code: `130` if terminated by `SIGINT`, otherwise the child process exit code if available, or `1` as a fallback.
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
