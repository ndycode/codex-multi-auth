#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeAuthAlias, shouldHandleMultiAuthAuth } from "./codex-routing.js";

const PLATFORM_PACKAGE_BY_TARGET = {
	"x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
	"aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
	"x86_64-apple-darwin": "@openai/codex-darwin-x64",
	"aarch64-apple-darwin": "@openai/codex-darwin-arm64",
	"x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
	"aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function getTargetTriple() {
	switch (process.platform) {
		case "linux":
		case "android":
			switch (process.arch) {
				case "x64":
					return "x86_64-unknown-linux-musl";
				case "arm64":
					return "aarch64-unknown-linux-musl";
				default:
					return null;
			}
		case "darwin":
			switch (process.arch) {
				case "x64":
					return "x86_64-apple-darwin";
				case "arm64":
					return "aarch64-apple-darwin";
				default:
					return null;
			}
		case "win32":
			switch (process.arch) {
				case "x64":
					return "x86_64-pc-windows-msvc";
				case "arm64":
					return "aarch64-pc-windows-msvc";
				default:
					return null;
			}
		default:
			return null;
	}
}

function getUpdatedPath(newDirs, existingPathValue = process.env.PATH ?? "") {
	const existingEntries = existingPathValue
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const uniqueEntries = [];
	const seen = new Set();
	for (const entry of [...newDirs, ...existingEntries]) {
		const key = process.platform === "win32" ? entry.toLowerCase() : entry;
		if (seen.has(key)) continue;
		seen.add(key);
		uniqueEntries.push(entry);
	}
	return uniqueEntries.join(delimiter);
}

function isNodeScriptPath(candidate) {
	return /\.m?js$/i.test(candidate);
}

function buildLaunchTarget(binPath, options = {}) {
	const {
		pathDirs = [],
		source = "stock",
	} = options;
	const env = { ...process.env };
	if (pathDirs.length > 0) {
		env.PATH = getUpdatedPath(pathDirs, env.PATH ?? process.env.PATH ?? "");
	}
	env.CODEX_MULTI_AUTH_RUNTIME_SOURCE = source;

	if (isNodeScriptPath(binPath)) {
		return {
			command: process.execPath,
			argsPrefix: [binPath],
			env,
			source,
		};
	}

	return {
		command: binPath,
		argsPrefix: [],
		env,
		source,
	};
}

function resolveBundledRuntimeTarget() {
	const preferBundledRuntime =
		(process.env.CODEX_MULTI_AUTH_PREFER_BUNDLED_RUNTIME ?? "1").trim() !== "0";
	if (!preferBundledRuntime) return null;

	const targetTriple = getTargetTriple();
	if (!targetTriple) return null;

	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const packageRoot = join(scriptDir, "..");
	const runtimeRoots = [];
	const runtimeRootOverride = (process.env.CODEX_MULTI_AUTH_RUNTIME_ROOT ?? "").trim();
	if (runtimeRootOverride.length > 0) {
		runtimeRoots.push(resolvePath(runtimeRootOverride));
	}

	runtimeRoots.push(join(homedir(), ".codex", "multi-auth", "runtime"));
	runtimeRoots.push(join(packageRoot, "vendor", "codex-runtime"));

	for (const runtimeRoot of runtimeRoots) {
		const archRoot = join(runtimeRoot, targetTriple);
		const codexDir = join(archRoot, "codex");
		const binaryCandidates = [
			join(codexDir, process.platform === "win32" ? "codex.exe" : "codex"),
			join(codexDir, "codex.js"),
		];
		const binPath = binaryCandidates.find((candidate) => existsSync(candidate));
		if (!binPath) {
			continue;
		}

		const pathDir = join(archRoot, "path");
		const pathDirs = existsSync(pathDir) ? [pathDir] : [];
		const target = buildLaunchTarget(binPath, {
			pathDirs,
			source: "bundled",
		});
		target.env.CODEX_MULTI_AUTH_RUNTIME_ROOT = runtimeRoot;
		return target;
	}

	return null;
}

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

function shouldRunStartupAccountPreflight(args) {
	const first = (args[0] ?? "").trim().toLowerCase();
	if (args.length === 0) return true;
	return !["--help", "-h", "help", "--version", "-v", "version"].includes(
		first,
	);
}

function resolveStartupProbeModel(args) {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-m" || arg === "--model") {
			const next = args[i + 1];
			if (typeof next === "string" && next.trim().length > 0) {
				return next.trim();
			}
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (value.length > 0) return value;
		}
	}
	return undefined;
}

async function autoSyncManagerActiveSelectionIfEnabled(rawArgs = []) {
	const enabled = (process.env.CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP ?? "1").trim() !== "0";
	if (!enabled) return;

	let mod;
	try {
		mod = await import("../dist/lib/codex-manager.js");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			// Non-auth command path should keep forwarding even if dist is missing.
			return;
		}
		// Best effort only: never block official Codex startup on sync failure.
		return;
	}

	if (
		shouldRunStartupAccountPreflight(rawArgs) &&
		typeof mod.autoRotateManagerActiveSelectionIfNeeded === "function"
	) {
		try {
			await mod.autoRotateManagerActiveSelectionIfNeeded({
				model: resolveStartupProbeModel(rawArgs),
			});
		} catch {
			// Best effort only: never block official Codex startup on preflight failure.
		}
	}

	try {
		if (typeof mod.autoSyncActiveAccountToCodex !== "function") {
			return;
		}
		await mod.autoSyncActiveAccountToCodex();
	} catch {
		// Best effort only: never block official Codex startup on sync failure.
	}
}

function resolveRealCodexBin() {
	const override = (process.env.CODEX_MULTI_AUTH_REAL_CODEX_BIN ?? "").trim();
	if (override.length > 0) {
		if (existsSync(override)) {
			return buildLaunchTarget(override, { source: "override" });
		}
		console.error(
			`CODEX_MULTI_AUTH_REAL_CODEX_BIN is set but missing: ${override}`,
		);
		return null;
	}

	const bundledTarget = resolveBundledRuntimeTarget();
	if (bundledTarget) {
		return bundledTarget;
	}

	try {
		const require = createRequire(import.meta.url);
		const resolved = require.resolve("@openai/codex/bin/codex.js");
		if (existsSync(resolved)) {
			return buildLaunchTarget(resolved, { source: "stock" });
		}
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
		if (existsSync(candidate)) {
			return buildLaunchTarget(candidate, { source: "stock" });
		}
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
				if (existsSync(globalBin)) {
					return buildLaunchTarget(globalBin, { source: "stock" });
				}
			}
		}
	} catch {
		// Ignore and fall through to null.
	}

	return null;
}

const BENIGN_SUCCESS_STDERR_PATTERNS = [
	/rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth\(TokenRefreshFailed\("Failed to parse server response"\)\)$/,
];

function createSuccessStderrFilter(output) {
	let pending = "";
	const suppressedLines = [];

	const shouldSuppressLine = (line) => {
		const normalizedLine = line.replace(/\r?\n$/, "");
		return BENIGN_SUCCESS_STDERR_PATTERNS.some((pattern) =>
			pattern.test(normalizedLine),
		);
	};

	const handleLine = (line) => {
		if (shouldSuppressLine(line)) {
			suppressedLines.push(line);
			return;
		}
		output.write(line);
	};

	return {
		push(chunk) {
			pending += chunk;
			while (true) {
				const newlineIndex = pending.indexOf("\n");
				if (newlineIndex === -1) break;
				const line = pending.slice(0, newlineIndex + 1);
				pending = pending.slice(newlineIndex + 1);
				handleLine(line);
			}
		},
		flush(exitCode, signal) {
			if (pending.length > 0) {
				handleLine(pending);
				pending = "";
			}
			if (exitCode === 0 && !signal) {
				suppressedLines.length = 0;
				return;
			}
			for (const line of suppressedLines) {
				output.write(line);
			}
			suppressedLines.length = 0;
		},
	};
}

function maybeLogRuntimeDebug(target) {
	if ((process.env.CODEX_MULTI_AUTH_DEBUG_RUNTIME ?? "").trim() !== "1") {
		return;
	}

	const command = target?.command ?? "<missing>";
	const argsPrefix = Array.isArray(target?.argsPrefix)
		? target.argsPrefix.join(" ")
		: "";
	console.error(
		[
			`codex-multi-auth runtime source: ${target?.source ?? "<none>"}`,
			`codex-multi-auth runtime command: ${command}`,
			target?.env?.CODEX_MULTI_AUTH_RUNTIME_ROOT
				? `codex-multi-auth runtime root: ${target.env.CODEX_MULTI_AUTH_RUNTIME_ROOT}`
				: null,
			argsPrefix.length > 0
				? `codex-multi-auth runtime argsPrefix: ${argsPrefix}`
				: null,
		]
			.filter(Boolean)
			.join("\n"),
	);
}

function forwardToRealCodex(codexBin, args) {
	return new Promise((resolve) => {
		maybeLogRuntimeDebug(codexBin);
		const child = spawn(codexBin.command, [...codexBin.argsPrefix, ...args], {
			stdio: ["inherit", "inherit", "pipe"],
			env: codexBin.env,
		});
		const stderrFilter = createSuccessStderrFilter(process.stderr);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stderrFilter.push(chunk);
		});

		child.once("error", (error) => {
			console.error(`Failed to launch real Codex CLI: ${String(error)}`);
			resolve(1);
		});

		child.once("exit", (code, signal) => {
			stderrFilter.flush(code, signal);
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
	const override = (process.env.CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD ?? "0").trim();
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
	const override = (process.env.CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD ?? "0").trim();
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
	const shouldInstallBatchGuard = shouldInstallWindowsBatchShimGuard();
	const shouldInstallProfileGuard = shouldInstallPowerShellProfileGuard();
	if (!shouldInstallBatchGuard && !shouldInstallProfileGuard) return;
	const shimDirectory = resolveWindowsShimDirectoryFromPath();
	if (!shimDirectory) return;

	const codexMultiAuthShimPath = join(shimDirectory, "codex-multi-auth.cmd");
	if (!existsSync(codexMultiAuthShimPath)) return;

	const overwriteCustomShim =
		(process.env.CODEX_MULTI_AUTH_OVERWRITE_CUSTOM_BATCH_SHIM ?? "0").trim() === "1";
	const installedBatch = shouldInstallBatchGuard
		? ensureWindowsShellShim(
				join(shimDirectory, "codex.bat"),
				buildWindowsBatchShimContent(),
				{ overwriteCustomShim },
			)
		: false;
	const installedCmd = shouldInstallBatchGuard
		? ensureWindowsShellShim(
				join(shimDirectory, "codex.cmd"),
				buildWindowsCmdShimContent(),
				{ overwriteCustomShim },
			)
		: false;
	const installedPs1 = shouldInstallBatchGuard
		? ensureWindowsShellShim(
				join(shimDirectory, "codex.ps1"),
				buildWindowsPowerShellShimContent(),
				{ overwriteCustomShim },
			)
		: false;
	const installedAny = installedBatch || installedCmd || installedPs1;
	const installedProfileGuard = shouldInstallProfileGuard
		? ensurePowerShellProfileGuard(shimDirectory)
		: false;
	if (installedAny || installedProfileGuard) {
		console.error(
			"codex-multi-auth: installed Windows shell guards to keep multi-auth routing after codex npm updates.",
		);
	}
}

async function main() {
	hydrateCliVersionEnv();
	ensureWindowsShellShimGuards();
	process.env.CODEX_MULTI_AUTH_LAUNCHER_ACTIVE = "1";

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
				"Could not locate a Codex runtime to launch.",
				"Either bundle a patched runtime with: npm run runtime:bundle",
				"Install it globally: npm install -g @openai/codex",
				"Or set CODEX_MULTI_AUTH_REAL_CODEX_BIN to a full codex binary or bin/codex.js path.",
			].join("\n"),
		);
		return 1;
	}

	await autoSyncManagerActiveSelectionIfEnabled(rawArgs);
	const forwardArgs = buildForwardArgs(rawArgs);
	return forwardToRealCodex(realCodexBin, forwardArgs);
}

const exitCode = await main();
process.exitCode = normalizeExitCode(exitCode);
