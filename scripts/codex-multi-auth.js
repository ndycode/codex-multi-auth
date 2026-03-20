#!/usr/bin/env node

import { createRequire } from "node:module";

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

const args = process.argv.slice(2);
const version = resolveCliVersion();

if (version.length > 0) {
	process.env.CODEX_MULTI_AUTH_CLI_VERSION = version;
}

if (args.length === 1 && versionFlags.has(args[0])) {
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
