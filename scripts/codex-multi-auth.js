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

const exitCode = await runCodexMultiAuthCli(process.argv.slice(2));
const parsedExitCode =
	typeof exitCode === "number" && Number.isInteger(exitCode)
		? exitCode
		: typeof exitCode === "string" && exitCode.trim().length > 0
			? Number(exitCode)
			: Number.NaN;
process.exitCode = Number.isInteger(parsedExitCode) ? parsedExitCode : 1;
