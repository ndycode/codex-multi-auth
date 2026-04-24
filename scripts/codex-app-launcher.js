#!/usr/bin/env node

// @ts-check

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { withFileOperationRetry } from "./install-codex-auth-utils.js";

const LAUNCHER_NAME = "Codex";
const WINDOWS_SHORTCUT_NAME = `${LAUNCHER_NAME}.lnk`;
const LINUX_DESKTOP_FILE_NAME = "codex.desktop";
const MACOS_APP_NAME = `${LAUNCHER_NAME}.app`;

/**
 * @param {string} value
 */
function quotePowerShellSingle(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * @param {string} value
 */
function quoteDesktopExec(value) {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function resolveWindowsStartMenuDir(env, home) {
	const appData = (env.APPDATA ?? "").trim() || join(home, "AppData", "Roaming");
	return join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function resolveLinuxApplicationsDir(env, home) {
	const dataHome = (env.XDG_DATA_HOME ?? "").trim() || join(home, ".local", "share");
	return join(dataHome, "applications");
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function resolveMacApplicationsDir(env, home) {
	return (env.CODEX_MULTI_AUTH_APP_LAUNCHER_MACOS_DIR ?? "").trim() || join(home, "Applications");
}

/**
 * @param {string} moduleUrl
 */
function resolveCurrentScriptPath(moduleUrl) {
	return fileURLToPath(moduleUrl);
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   home?: string,
 *   moduleUrl?: string,
 * }} [options]
 */
export function resolveAppLauncherPlan(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const moduleUrl = options.moduleUrl ?? import.meta.url;
	const scriptPath = resolveCurrentScriptPath(moduleUrl);
	const codexScriptPath = join(dirname(scriptPath), "codex.js");
	const nodePath = process.execPath;

	if (platform === "win32") {
		const shortcutPath = join(resolveWindowsStartMenuDir(env, home), WINDOWS_SHORTCUT_NAME);
		return {
			platform,
			launcherPath: shortcutPath,
			commandPath: nodePath,
			commandArgs: `"${codexScriptPath}" app`,
			workingDirectory: home,
			iconPath: nodePath,
		};
	}

	if (platform === "darwin") {
		const appPath = join(resolveMacApplicationsDir(env, home), MACOS_APP_NAME);
		return {
			platform,
			launcherPath: appPath,
			commandPath: nodePath,
			commandArgs: `"${codexScriptPath}" app`,
			workingDirectory: home,
			iconPath: nodePath,
		};
	}

	const desktopPath = join(resolveLinuxApplicationsDir(env, home), LINUX_DESKTOP_FILE_NAME);
	return {
		platform,
		launcherPath: desktopPath,
		commandPath: nodePath,
		commandArgs: `"${codexScriptPath}" app %F`,
		workingDirectory: home,
		iconPath: "utilities-terminal",
	};
}

/**
 * @param {ReturnType<typeof resolveAppLauncherPlan>} plan
 */
export function createWindowsShortcutPowerShellScript(plan) {
	return [
		"$ErrorActionPreference = 'Stop'",
		`$ShortcutPath = ${quotePowerShellSingle(plan.launcherPath)}`,
		`$TargetPath = ${quotePowerShellSingle(plan.commandPath)}`,
		`$Arguments = ${quotePowerShellSingle(plan.commandArgs)}`,
		`$WorkingDirectory = ${quotePowerShellSingle(plan.workingDirectory)}`,
		`$IconLocation = ${quotePowerShellSingle(plan.iconPath)}`,
		"New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ShortcutPath) | Out-Null",
		"$Shell = New-Object -ComObject WScript.Shell",
		"$Shortcut = $Shell.CreateShortcut($ShortcutPath)",
		"$Shortcut.TargetPath = $TargetPath",
		"$Shortcut.Arguments = $Arguments",
		"$Shortcut.WorkingDirectory = $WorkingDirectory",
		"$Shortcut.IconLocation = $IconLocation",
		"$Shortcut.Description = 'Launch Codex through codex-multi-auth runtime rotation'",
		"$Shortcut.Save()",
	].join("\r\n");
}

/**
 * @param {ReturnType<typeof resolveAppLauncherPlan>} plan
 */
function createLinuxDesktopFile(plan) {
	return [
		"[Desktop Entry]",
		"Type=Application",
		`Name=${LAUNCHER_NAME}`,
		"Comment=Launch Codex through codex-multi-auth runtime rotation",
		`Exec=${quoteDesktopExec(plan.commandPath)} ${plan.commandArgs}`,
		`Path=${plan.workingDirectory}`,
		`Icon=${plan.iconPath}`,
		"Terminal=false",
		"Categories=Development;",
		"StartupNotify=true",
		"",
	].join("\n");
}

/**
 * @param {ReturnType<typeof resolveAppLauncherPlan>} plan
 */
function createMacInfoPlist(plan) {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"  <key>CFBundleExecutable</key>",
		"  <string>Codex</string>",
		"  <key>CFBundleIdentifier</key>",
		"  <string>com.ndycode.codex-multi-auth.launcher</string>",
		"  <key>CFBundleName</key>",
		`  <string>${LAUNCHER_NAME}</string>`,
		"  <key>CFBundlePackageType</key>",
		"  <string>APPL</string>",
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

/**
 * @param {ReturnType<typeof resolveAppLauncherPlan>} plan
 */
function createMacLauncherScript(plan) {
	return [
		"#!/bin/sh",
		`cd ${JSON.stringify(plan.workingDirectory)}`,
		`exec ${JSON.stringify(plan.commandPath)} ${plan.commandArgs}`,
		"",
	].join("\n");
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function runCommand(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${command} exited with ${code ?? "unknown"}: ${stderr.trim()}`));
		});
	});
}

/**
 * @param {ReturnType<typeof resolveAppLauncherPlan>} plan
 * @param {{ env: NodeJS.ProcessEnv }} options
 */
async function installWindowsShortcut(plan, options) {
	const script = createWindowsShortcutPowerShellScript(plan);
	const powershell =
		(options.env.SystemRoot ?? options.env.SYSTEMROOT ?? "C:\\Windows") +
		"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
	await runCommand(
		powershell,
		[
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
		],
		options.env,
	);
}

/**
 * @param {ReturnType<typeof resolveAppLauncherPlan>} plan
 */
async function installLinuxDesktopFile(plan) {
	await withFileOperationRetry(() => mkdir(dirname(plan.launcherPath), { recursive: true }));
	await withFileOperationRetry(() =>
		writeFile(plan.launcherPath, createLinuxDesktopFile(plan), "utf8"),
	);
	await chmod(plan.launcherPath, 0o755);
}

/**
 * @param {ReturnType<typeof resolveAppLauncherPlan>} plan
 */
async function installMacAppBundle(plan) {
	const contentsDir = join(plan.launcherPath, "Contents");
	const macosDir = join(contentsDir, "MacOS");
	await withFileOperationRetry(() => mkdir(macosDir, { recursive: true }));
	await withFileOperationRetry(() =>
		writeFile(join(contentsDir, "Info.plist"), createMacInfoPlist(plan), "utf8"),
	);
	const launcherScriptPath = join(macosDir, "Codex");
	await withFileOperationRetry(() =>
		writeFile(launcherScriptPath, createMacLauncherScript(plan), "utf8"),
	);
	await chmod(launcherScriptPath, 0o755);
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   home?: string,
 *   moduleUrl?: string,
 *   dryRun?: boolean,
 *   remove?: boolean,
 *   log?: (message: string) => void,
 * }} [options]
 */
export async function installCodexAppLauncher(options = {}) {
	const env = options.env ?? process.env;
	const plan = resolveAppLauncherPlan({
		env,
		platform: options.platform,
		home: options.home,
		moduleUrl: options.moduleUrl,
	});
	const log = options.log ?? console.log;

	if (options.remove) {
		if (options.dryRun) {
			log(`[dry-run] Would remove ${plan.launcherPath}`);
			return plan;
		}
		await withFileOperationRetry(() => rm(plan.launcherPath, { recursive: true, force: true }));
		log(`Removed Codex app launcher: ${plan.launcherPath}`);
		return plan;
	}

	if (options.dryRun) {
		log(`[dry-run] Would install Codex app launcher: ${plan.launcherPath}`);
		log(`[dry-run] Target: ${plan.commandPath} ${plan.commandArgs}`);
		return plan;
	}

	if (plan.platform === "win32") {
		await installWindowsShortcut(plan, { env });
	} else if (plan.platform === "darwin") {
		await installMacAppBundle(plan);
	} else {
		await installLinuxDesktopFile(plan);
	}
	log(`Installed Codex app launcher: ${plan.launcherPath}`);
	return plan;
}

function printHelp() {
	console.log(
		[
			"Usage: codex-multi-auth-app-launcher [--remove] [--dry-run]",
			"",
			"Installs a user-level Codex app launcher that runs `codex app` through codex-multi-auth.",
			"",
			"Options:",
			"  --remove   Remove the managed launcher",
			"  --dry-run  Print planned changes without writing",
			"  --help     Show this help",
			"",
		].join("\n"),
	);
}

async function main() {
	const args = new Set(process.argv.slice(2));
	if (args.has("--help") || args.has("-h")) {
		printHelp();
		return 0;
	}
	await installCodexAppLauncher({
		dryRun: args.has("--dry-run"),
		remove: args.has("--remove"),
	});
	return 0;
}

const isDirectRun = (() => {
	try {
		return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (isDirectRun) {
	main().catch((error) => {
		console.error(
			`Codex app launcher install failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
}
