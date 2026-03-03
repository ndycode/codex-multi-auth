#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeAuthAlias, shouldHandleMultiAuthAuth } from "./codex-routing.js";

function hydrateCliVersionEnv() {
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
}

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

async function autoSyncManagerActiveSelectionIfEnabled() {
	const enabled = (process.env.CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP ?? "1").trim() !== "0";
	if (!enabled) return;

	try {
		const mod = await import("../dist/lib/codex-manager.js");
		if (typeof mod.autoSyncActiveAccountToCodex !== "function") {
			return;
		}
		await mod.autoSyncActiveAccountToCodex();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			// Non-auth command path should keep forwarding even if dist is missing.
			return;
		}
		// Best effort only: never block official Codex startup on sync failure.
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

function hasCliAuthCredentialsStoreOverride(args) {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-c" || arg === "--config") {
			const next = args[i + 1];
			if (!next || !next.includes("=")) continue;
			const [key] = next.split("=", 1);
			if ((key ?? "").trim() === "cli_auth_credentials_store") {
				return true;
			}
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--config=")) {
			const assignment = arg.slice("--config=".length);
			const [key] = assignment.split("=", 1);
			if ((key ?? "").trim() === "cli_auth_credentials_store") {
				return true;
			}
		}
	}
	return false;
}

function buildForwardArgs(rawArgs) {
	const forceFileAuthStore = (process.env.CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE ?? "1").trim() !== "0";
	if (!forceFileAuthStore) return [...rawArgs];
	if (hasCliAuthCredentialsStoreOverride(rawArgs)) return [...rawArgs];

	return [
		...rawArgs,
		"-c",
		'cli_auth_credentials_store="file"',
	];
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

const WINDOWS_SHIM_MARKER = "codex-multi-auth windows shim guardian v1";
const POWERSHELL_PROFILE_MARKER_START = "# >>> codex-multi-auth shell guard >>>";
const POWERSHELL_PROFILE_MARKER_END = "# <<< codex-multi-auth shell guard <<<";

function shouldInstallWindowsBatchShimGuard() {
	if (process.platform !== "win32") return false;
	const override = (process.env.CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD ?? "1").trim();
	return override !== "0";
}

function splitPathEntries(pathValue) {
	if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
		return [];
	}
	return pathValue
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function resolveWindowsShimDirectoryFromInvocation() {
	const invokedScript = (process.argv[1] ?? "").trim();
	if (invokedScript.length === 0) return null;
	const resolvedScript = resolvePath(invokedScript);
	const scriptDir = dirname(resolvedScript);
	const packageRoot = dirname(scriptDir);
	const nodeModulesDir = dirname(packageRoot);
	if (basename(nodeModulesDir).toLowerCase() !== "node_modules") {
		return null;
	}
	const shimDir = dirname(nodeModulesDir);
	if (existsSync(join(shimDir, "codex-multi-auth.cmd"))) {
		return shimDir;
	}
	return null;
}

function resolveWindowsShimDirectoryFromPath() {
	const fromInvocation = resolveWindowsShimDirectoryFromInvocation();
	if (fromInvocation) {
		return fromInvocation;
	}
	const pathEntries = splitPathEntries(process.env.PATH ?? process.env.Path ?? "");
	for (const entry of pathEntries) {
		if (existsSync(join(entry, "codex-multi-auth.cmd"))) {
			return entry;
		}
	}
	return null;
}

function buildWindowsBatchShimContent() {
	return [
		"@ECHO off",
		`:: ${WINDOWS_SHIM_MARKER}`,
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		'  SET PATHEXT=%PATHEXT:;.JS;=%',
		")",
		"",
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\codex-multi-auth\\scripts\\codex.js" %*',
	].join("\r\n");
}

function buildWindowsCmdShimContent() {
	return [
		"@ECHO off",
		`:: ${WINDOWS_SHIM_MARKER}`,
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		'  SET PATHEXT=%PATHEXT:;.JS;=%',
		")",
		"",
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\codex-multi-auth\\scripts\\codex.js" %*',
	].join("\r\n");
}

function buildWindowsPowerShellShimContent() {
	return [
		`# ${WINDOWS_SHIM_MARKER}`,
		"$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
		"",
		'$exe=""',
		'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
		'  $exe=".exe"',
		"}",
		"$ret=0",
		'if (Test-Path "$basedir/node$exe") {',
		"  if ($MyInvocation.ExpectingInput) {",
		'    $input | & "$basedir/node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  } else {",
		'    & "$basedir/node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  }",
		"  $ret=$LASTEXITCODE",
		"} else {",
		"  if ($MyInvocation.ExpectingInput) {",
		'    $input | & "node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  } else {",
		'    & "node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  }",
		"  $ret=$LASTEXITCODE",
		"}",
		"if ($null -eq $ret) {",
		"  exit 0",
		"}",
		"exit $ret",
	].join("\r\n");
}

function ensureWindowsShellShim(filePath, desiredContent, options = {}) {
	const {
		overwriteCustomShim = false,
		shimMarker = WINDOWS_SHIM_MARKER,
	} = options;

	let currentContent = "";
	if (existsSync(filePath)) {
		try {
			currentContent = readFileSync(filePath, "utf8");
		} catch {
			return false;
		}
		if (currentContent === desiredContent || currentContent.includes(shimMarker)) {
			if (currentContent !== desiredContent) {
				try {
					writeFileSync(filePath, desiredContent, { encoding: "utf8", mode: 0o755 });
					return true;
				} catch {
					return false;
				}
			}
			return false;
		}
		const looksLikeStockOpenAiShim =
			currentContent.includes("node_modules\\@openai\\codex\\bin\\codex.js") ||
			currentContent.includes("node_modules/@openai/codex/bin/codex.js");
		if (looksLikeStockOpenAiShim) {
			try {
				writeFileSync(filePath, desiredContent, { encoding: "utf8", mode: 0o755 });
				return true;
			} catch {
				return false;
			}
		}
		if (!overwriteCustomShim) {
			return false;
		}
	}

	try {
		writeFileSync(filePath, desiredContent, { encoding: "utf8", mode: 0o755 });
		return true;
	} catch {
		return false;
	}
}

function shouldInstallPowerShellProfileGuard() {
	if (process.platform !== "win32") return false;
	const override = (process.env.CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD ?? "1").trim();
	return override !== "0";
}

function resolveWindowsUserHomeDir() {
	const userProfile = (process.env.USERPROFILE ?? "").trim();
	if (userProfile.length > 0) return userProfile;
	const homeDrive = (process.env.HOMEDRIVE ?? "").trim();
	const homePath = (process.env.HOMEPATH ?? "").trim();
	if (homeDrive.length > 0 && homePath.length > 0) {
		return `${homeDrive}${homePath}`;
	}
	const home = (process.env.HOME ?? "").trim();
	return home;
}

function buildPowerShellProfileGuardBlock(shimDirectory) {
	const codexBatchPath = join(shimDirectory, "codex.bat").replace(/\\/g, "\\\\");
	return [
		POWERSHELL_PROFILE_MARKER_START,
		`$CodexMultiAuthShim = "${codexBatchPath}"`,
		"if (Test-Path $CodexMultiAuthShim) {",
		"  function global:codex {",
		"    & $CodexMultiAuthShim @args",
		"  }",
		"}",
		POWERSHELL_PROFILE_MARKER_END,
	].join("\r\n");
}

function upsertPowerShellProfileGuard(profilePath, guardBlock) {
	let content = "";
	if (existsSync(profilePath)) {
		try {
			content = readFileSync(profilePath, "utf8");
		} catch {
			return false;
		}
	}
	const normalizedCurrentContent = content.replace(/\r?\n$/, "");

	const startIndex = content.indexOf(POWERSHELL_PROFILE_MARKER_START);
	const endIndex = content.indexOf(POWERSHELL_PROFILE_MARKER_END);
	let nextContent;
	if (startIndex >= 0 && endIndex >= startIndex) {
		const endWithMarker = endIndex + POWERSHELL_PROFILE_MARKER_END.length;
		const prefix = content.slice(0, startIndex).replace(/\s*$/, "");
		const suffix = content.slice(endWithMarker).replace(/^\s*/, "");
		nextContent = `${prefix}\r\n\r\n${guardBlock}\r\n\r\n${suffix}`.trimEnd();
	} else if (normalizedCurrentContent.trim().length === 0) {
		nextContent = guardBlock;
	} else {
		nextContent = `${normalizedCurrentContent.replace(/\s*$/, "")}\r\n\r\n${guardBlock}`;
	}

	if (nextContent === normalizedCurrentContent) {
		return false;
	}

	try {
		mkdirSync(dirname(profilePath), { recursive: true });
		writeFileSync(profilePath, `${nextContent}\r\n`, { encoding: "utf8", mode: 0o644 });
		return true;
	} catch {
		return false;
	}
}

function ensurePowerShellProfileGuard(shimDirectory) {
	if (!shouldInstallPowerShellProfileGuard()) return false;
	const homeDir = resolveWindowsUserHomeDir();
	if (!homeDir) return false;
	const guardBlock = buildPowerShellProfileGuardBlock(shimDirectory);
	const profilePaths = [
		join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
		join(homeDir, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
	];
	let changed = false;
	for (const profilePath of profilePaths) {
		changed = upsertPowerShellProfileGuard(profilePath, guardBlock) || changed;
	}
	return changed;
}

function ensureWindowsShellShimGuards() {
	if (!shouldInstallWindowsBatchShimGuard()) return;
	const shimDirectory = resolveWindowsShimDirectoryFromPath();
	if (!shimDirectory) return;

	const codexMultiAuthShimPath = join(shimDirectory, "codex-multi-auth.cmd");
	if (!existsSync(codexMultiAuthShimPath)) return;

	const overwriteCustomShim =
		(process.env.CODEX_MULTI_AUTH_OVERWRITE_CUSTOM_BATCH_SHIM ?? "0").trim() === "1";
	const installedBatch = ensureWindowsShellShim(
		join(shimDirectory, "codex.bat"),
		buildWindowsBatchShimContent(),
		{ overwriteCustomShim },
	);
	const installedCmd = ensureWindowsShellShim(
		join(shimDirectory, "codex.cmd"),
		buildWindowsCmdShimContent(),
		{ overwriteCustomShim },
	);
	const installedPs1 = ensureWindowsShellShim(
		join(shimDirectory, "codex.ps1"),
		buildWindowsPowerShellShimContent(),
		{ overwriteCustomShim },
	);
	const installedAny = installedBatch || installedCmd || installedPs1;
	const installedProfileGuard = ensurePowerShellProfileGuard(shimDirectory);
	if (installedAny || installedProfileGuard) {
		console.error(
			"codex-multi-auth: installed Windows shell guards to keep multi-auth routing after codex npm updates.",
		);
	}
}

async function main() {
	hydrateCliVersionEnv();
	ensureWindowsShellShimGuards();

	const rawArgs = process.argv.slice(2);
	const normalizedArgs = normalizeAuthAlias(rawArgs);
	const bypass = (process.env.CODEX_MULTI_AUTH_BYPASS ?? "").trim() === "1";

	if (!bypass && shouldHandleMultiAuthAuth(normalizedArgs)) {
		try {
			const runCodexMultiAuthCli = await loadRunCodexMultiAuthCli();
			if (!runCodexMultiAuthCli) {
				return 1;
			}
			const exitCode = await runCodexMultiAuthCli(normalizedArgs);
			return normalizeExitCode(exitCode);
		} catch (error) {
			console.error(
				`codex-multi-auth runner failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
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
		return 1;
	}

	await autoSyncManagerActiveSelectionIfEnabled();
	const forwardArgs = buildForwardArgs(rawArgs);
	return forwardToRealCodex(realCodexBin, forwardArgs);
}

const exitCode = await main();
process.exitCode = normalizeExitCode(exitCode);
