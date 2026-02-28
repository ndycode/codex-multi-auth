#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeAuthAlias, shouldHandleMultiAuthAuth } from "./codex-routing.js";

async function loadRunCodexMultiAuthCli() {
	try {
		const mod = await import("../dist/lib/codex-manager.js");
		if (typeof mod.runCodexMultiAuthCli !== "function") {
			console.error(
				"dist/lib/codex-manager.js is missing required export: runCodexMultiAuthCli",
			);
			return null;
		}
		return mod.runCodexMultiAuthCli;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			console.error(
				[
					"codex-multi-auth auth commands require built runtime files, but dist output is missing.",
					"Run: npm run build",
				].join("\n"),
			);
			return null;
		}
		throw error;
	}
}

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

function normalizeExitCode(value) {
	if (typeof value === "number" && Number.isInteger(value)) {
		return value;
	}
	const parsed = Number(value);
	if (Number.isInteger(parsed)) {
		return parsed;
	}
	return 1;
}

const rawArgs = process.argv.slice(2);
const normalizedArgs = normalizeAuthAlias(rawArgs);
const bypass = (process.env.CODEX_MULTI_AUTH_BYPASS ?? "").trim() === "1";

if (!bypass && shouldHandleMultiAuthAuth(normalizedArgs)) {
	try {
		const runCodexMultiAuthCli = await loadRunCodexMultiAuthCli();
		if (!runCodexMultiAuthCli) {
			process.exit(1);
		}
		const exitCode = await runCodexMultiAuthCli(normalizedArgs);
		process.exit(normalizeExitCode(exitCode));
	} catch (error) {
		console.error(
			`codex-multi-auth runner failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
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
