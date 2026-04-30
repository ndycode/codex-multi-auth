#!/usr/bin/env node

// @ts-check

import { createRequire } from "node:module";
import { AUTH_SUBCOMMANDS } from "./codex-routing.js";

const versionFlags = new Set(["--version", "-v"]);

function resolveCliVersion() {
	const require = createRequire(import.meta.url);
	try {
		const pkg = require("../package.json");
		const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
		if (version.length > 0) {
			return version;
		}
	} catch {
		// Best effort only.
	}
	return "";
}

function normalizeStandaloneArgs(args) {
	if (args[0] === "auth") return args;
	const firstArg = args[0] ?? "";
	if (AUTH_SUBCOMMANDS.has(firstArg)) {
		// Keep this exhaustive: generic names here are reserved for auth routing.
		return ["auth", ...args];
	}
	return args;
}

const args = normalizeStandaloneArgs(process.argv.slice(2));
const version = resolveCliVersion();

if (version.length > 0) {
	process.env.CODEX_MULTI_AUTH_CLI_VERSION = version;
}

const firstArg = args[0] ?? "";

if (args.length === 1 && versionFlags.has(firstArg)) {
	if (version.length > 0) {
		process.stdout.write(`${version}\n`);
		process.exitCode = 0;
	} else {
		process.stderr.write("codex-multi-auth version is unavailable.\n");
		process.exitCode = 1;
	}
} else {
	const { runCodexMultiAuthCli } = await import("../dist/lib/codex-manager.js");
	const exitCode = await runCodexMultiAuthCli(args);
	process.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
}
