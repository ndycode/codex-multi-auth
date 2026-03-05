#!/usr/bin/env node

import { createRequire } from "node:module";
import { runCodexMultiAuthCli } from "../dist/lib/codex-manager.js";

try {
	const require = createRequire(import.meta.url);
	const pkg = require("../package.json");
	const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
	if (version.length > 0) {
		process.env.CODEX_MULTI_AUTH_CLI_VERSION = version;
	}
} catch {
	// Best effort only.
}

function parseCliExitCode(value) {
	if (typeof value === "number" && Number.isInteger(value)) {
		return value;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (/^[+-]?\d+$/.test(trimmed)) {
			const parsed = Number.parseInt(trimmed, 10);
			if (Number.isInteger(parsed)) {
				return parsed;
			}
		}
	}
	return 1;
}

const exitCode = await runCodexMultiAuthCli(process.argv.slice(2));
process.exitCode = parseCliExitCode(exitCode);
