#!/usr/bin/env node

// @ts-check

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { withFileOperationRetry } from "./install-codex-auth-utils.js";

const OFFICIAL_LAUNCHER_NAME = "Codex";
const MANAGED_LAUNCHER_NAME = "Codex Multi Auth";
const WINDOWS_SHORTCUT_NAME = `${OFFICIAL_LAUNCHER_NAME}.lnk`;
const LINUX_DESKTOP_FILE_NAME = "codex-multi-auth.desktop";
const MACOS_APP_NAME = `${MANAGED_LAUNCHER_NAME}.app`;
const WINDOWS_BACKUP_FILE_NAME = "app-shortcuts.json";
const MANAGED_SHORTCUT_DESCRIPTION =
	"Launch Codex through codex-multi-auth runtime rotation";

/**
 * @param {string} value
 */
function quotePowerShellSingle(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * @param {string} value
 */
function encodePowerShellCommand(value) {
	return Buffer.from(value, "utf16le").toString("base64");
}

/**
 * @param {boolean} value
 */
function quotePowerShellBoolean(value) {
	return value ? "$true" : "$false";
}

/**
 * @param {string[]} values
 */
function quotePowerShellArray(values) {
	if (values.length === 0) {
		return "@()";
	}
	return `@(${values.map(quotePowerShellSingle).join(", ")})`;
}

/**
 * @param {string} value
 */
function quoteDesktopExec(value) {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * @param {string} value
 */
function quotePosixShell(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * @param {string[]} values
 */
function uniqueStrings(values) {
	return [...new Set(values.filter((value) => value.trim().length > 0))];
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
 */
function resolveWindowsPowerShellPath(env) {
	const systemRoot =
		(env.SystemRoot ?? env.SYSTEMROOT ?? "").trim() || "C:\\Windows";
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function resolveWindowsTaskbarPinnedDir(env, home) {
	const appData = (env.APPDATA ?? "").trim() || join(home, "AppData", "Roaming");
	return join(
		appData,
		"Microsoft",
		"Internet Explorer",
		"Quick Launch",
		"User Pinned",
		"TaskBar",
	);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function resolveWindowsDesktopDirs(env, home) {
	const configured = (env.CODEX_MULTI_AUTH_APP_LAUNCHER_WINDOWS_DESKTOP_DIR ?? "").trim();
	const onedriveRoots = [
		env.OneDrive,
		env.OneDriveConsumer,
		env.OneDriveCommercial,
	].filter((value) => typeof value === "string" && value.trim().length > 0);
	return uniqueStrings([
		configured,
		...onedriveRoots.map((root) => join(String(root), "Desktop")),
		join(home, "Desktop"),
	]);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function resolveCodexMultiAuthDir(env, home) {
	return (env.CODEX_MULTI_AUTH_DIR ?? "").trim() || join(home, ".codex", "multi-auth");
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
 *   nodePath: string,
 *   codexScriptPath: string,
 *   workingDirectory: string,
 * }} params
 */
function createWindowsLauncherCommandArgs(params) {
	const command = [
		"$ErrorActionPreference = 'Stop'",
		`Set-Location -LiteralPath ${quotePowerShellSingle(params.workingDirectory)}`,
		`& ${quotePowerShellSingle(params.nodePath)} ${quotePowerShellSingle(params.codexScriptPath)} app`,
	].join("; ");
	return `-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(command)}`;
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
	const commandArgv = [codexScriptPath, "app"];

	if (platform === "win32") {
		const startMenuDir = resolveWindowsStartMenuDir(env, home);
		return {
			platform,
			mode: "route-existing",
			launcherPath: join(startMenuDir, WINDOWS_SHORTCUT_NAME),
			shortcutRoots: [
				startMenuDir,
				resolveWindowsTaskbarPinnedDir(env, home),
				...resolveWindowsDesktopDirs(env, home),
			],
			backupPath: join(resolveCodexMultiAuthDir(env, home), WINDOWS_BACKUP_FILE_NAME),
			commandPath: resolveWindowsPowerShellPath(env),
			commandArgs: createWindowsLauncherCommandArgs({
				nodePath,
				codexScriptPath,
				workingDirectory: home,
			}),
			commandArgv,
			workingDirectory: home,
			iconPath: nodePath,
		};
	}

	if (platform === "darwin") {
		const appPath = join(resolveMacApplicationsDir(env, home), MACOS_APP_NAME);
		return {
			platform,
			mode: "create-managed",
			launcherPath: appPath,
			commandPath: nodePath,
			commandArgs: `"${codexScriptPath}" app`,
			commandArgv,
			workingDirectory: home,
			iconPath: nodePath,
		};
	}

	const desktopPath = join(resolveLinuxApplicationsDir(env, home), LINUX_DESKTOP_FILE_NAME);
	return {
		platform,
		mode: "create-managed",
		launcherPath: desktopPath,
		commandPath: nodePath,
		commandArgs: `"${codexScriptPath}" app %F`,
		commandArgv: [codexScriptPath, "app", "%F"],
		workingDirectory: home,
		iconPath: "utilities-terminal",
	};
}

/**
 * @param {ReturnType<typeof resolveAppLauncherPlan>} plan
 * @param {{ dryRun?: boolean, remove?: boolean }} [options]
 */
export function createWindowsShortcutPowerShellScript(plan, options = {}) {
	const shortcutRoots = Array.isArray(plan.shortcutRoots) ? plan.shortcutRoots : [];
	const backupPath = typeof plan.backupPath === "string" ? plan.backupPath : "";
	const dryRun = options.dryRun === true;
	const remove = options.remove === true;

	if (remove) {
		return [
			"$ErrorActionPreference = 'Stop'",
			`$DryRun = ${quotePowerShellBoolean(dryRun)}`,
			`$BackupPath = ${quotePowerShellSingle(backupPath)}`,
			"$Restored = @()",
			"$Skipped = @()",
			"if (Test-Path -LiteralPath $BackupPath) {",
			"  $Raw = Get-Content -LiteralPath $BackupPath -Raw -Encoding UTF8",
			"  $Backups = @($Raw | ConvertFrom-Json)",
			"  $Shell = New-Object -ComObject WScript.Shell",
			"  foreach ($Backup in $Backups) {",
			"    if ($null -eq $Backup.Path -or -not (Test-Path -LiteralPath $Backup.Path)) {",
			"      if ($null -ne $Backup.Path) { $Skipped += [string]$Backup.Path }",
			"      continue",
			"    }",
			"    if (-not $DryRun) {",
			"      $Shortcut = $Shell.CreateShortcut([string]$Backup.Path)",
			"      $Shortcut.TargetPath = [string]$Backup.TargetPath",
			"      $Shortcut.Arguments = [string]$Backup.Arguments",
			"      $Shortcut.WorkingDirectory = [string]$Backup.WorkingDirectory",
			"      $Shortcut.IconLocation = [string]$Backup.IconLocation",
			"      $Shortcut.Description = [string]$Backup.Description",
			"      $Shortcut.Save()",
			"    }",
			"    $Restored += [string]$Backup.Path",
			"  }",
			"  if (-not $DryRun) { Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue }",
			"}",
			"$Result = [ordered]@{ action = 'restore'; dryRun = $DryRun; backupPath = $BackupPath; restored = @($Restored); skipped = @($Skipped) }",
			"$Result | ConvertTo-Json -Depth 6 -Compress",
		].join("\r\n");
	}

	return [
		"$ErrorActionPreference = 'Stop'",
		`$DryRun = ${quotePowerShellBoolean(dryRun)}`,
		`$ShortcutRoots = ${quotePowerShellArray(shortcutRoots)}`,
		"$ShellDesktop = [Environment]::GetFolderPath('Desktop')",
		"if (-not [string]::IsNullOrWhiteSpace($ShellDesktop)) { $ShortcutRoots = @($ShortcutRoots + $ShellDesktop) | Sort-Object -Unique }",
		`$BackupPath = ${quotePowerShellSingle(backupPath)}`,
		`$ShortcutName = ${quotePowerShellSingle(OFFICIAL_LAUNCHER_NAME)}`,
		`$TargetPath = ${quotePowerShellSingle(plan.commandPath)}`,
		`$Arguments = ${quotePowerShellSingle(plan.commandArgs)}`,
		`$WorkingDirectory = ${quotePowerShellSingle(plan.workingDirectory)}`,
		`$ManagedDescription = ${quotePowerShellSingle(MANAGED_SHORTCUT_DESCRIPTION)}`,
		"$Candidates = @()",
		"$PackagedApps = @()",
		"foreach ($Root in $ShortcutRoots) {",
		"  if (-not (Test-Path -LiteralPath $Root)) { continue }",
		"  $Candidates += Get-ChildItem -LiteralPath $Root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -ieq $ShortcutName } | ForEach-Object { $_.FullName }",
		"}",
		"$Candidates = @($Candidates | Sort-Object -Unique)",
		"try {",
		"  $AppsFolder = (New-Object -ComObject Shell.Application).Namespace('shell:AppsFolder')",
		"  if ($null -ne $AppsFolder) {",
		"    $PackagedApps = @($AppsFolder.Items() | Where-Object { $_.Name -ieq $ShortcutName } | ForEach-Object { [ordered]@{ Name = [string]$_.Name; Path = [string]$_.Path } })",
		"  }",
		"} catch { $PackagedApps = @() }",
		"$Shell = New-Object -ComObject WScript.Shell",
		"$ExistingBackups = @()",
		"if (Test-Path -LiteralPath $BackupPath) {",
		"  try {",
		"    $Raw = Get-Content -LiteralPath $BackupPath -Raw -Encoding UTF8",
		"    if ($Raw.Trim().Length -gt 0) { $ExistingBackups = @($Raw | ConvertFrom-Json) }",
		"  } catch { $ExistingBackups = @() }",
		"}",
		"$BackupByPath = @{}",
		"$BackupsToWrite = New-Object System.Collections.ArrayList",
		"foreach ($Backup in $ExistingBackups) {",
		"  if ($null -eq $Backup.Path) { continue }",
		"  $BackupByPath[[string]$Backup.Path] = $Backup",
		"  [void]$BackupsToWrite.Add($Backup)",
		"}",
		"$Routed = @()",
		"$Skipped = @()",
		"foreach ($Path in $Candidates) {",
		"  $Shortcut = $Shell.CreateShortcut($Path)",
		"  $ShortcutText = (($Shortcut.TargetPath, $Shortcut.Arguments, $Shortcut.Description) -join ' ')",
		"  if ($ShortcutText -notmatch '(?i)codex') {",
		"    $Skipped += $Path",
		"    continue",
		"  }",
		"  $AlreadyManaged = (([string]$Shortcut.Description) -eq $ManagedDescription) -or ((([string]$Shortcut.TargetPath) -ieq $TargetPath) -and (([string]$Shortcut.Arguments) -ieq $Arguments))",
		"  if (-not $BackupByPath.ContainsKey($Path) -and -not $AlreadyManaged) {",
		"    $IconLocation = [string]$Shortcut.IconLocation",
		"    if ([string]::IsNullOrWhiteSpace($IconLocation)) { $IconLocation = [string]$Shortcut.TargetPath }",
		"    $Backup = [ordered]@{",
		"      Path = [string]$Path",
		"      TargetPath = [string]$Shortcut.TargetPath",
		"      Arguments = [string]$Shortcut.Arguments",
		"      WorkingDirectory = [string]$Shortcut.WorkingDirectory",
		"      IconLocation = $IconLocation",
		"      Description = [string]$Shortcut.Description",
		"    }",
		"    [void]$BackupsToWrite.Add($Backup)",
		"    $BackupByPath[$Path] = $Backup",
		"  }",
		"  if (-not $DryRun) {",
		"    $Backup = $BackupByPath[$Path]",
		"    $Shortcut.TargetPath = $TargetPath",
		"    $Shortcut.Arguments = $Arguments",
		"    $Shortcut.WorkingDirectory = $WorkingDirectory",
		"    if ($null -ne $Backup -and $null -ne $Backup.IconLocation) { $Shortcut.IconLocation = [string]$Backup.IconLocation }",
		"    $Shortcut.Description = $ManagedDescription",
		"    $Shortcut.Save()",
		"  }",
		"  $Routed += $Path",
		"}",
		"if (-not $DryRun -and $Routed.Count -gt 0) {",
		"  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BackupPath) | Out-Null",
		"  @($BackupsToWrite) | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $BackupPath -Encoding UTF8",
		"}",
		"$Result = [ordered]@{ action = 'route'; dryRun = $DryRun; backupPath = $BackupPath; candidates = @($Candidates); packagedApps = @($PackagedApps); routed = @($Routed); skipped = @($Skipped); targetPath = $TargetPath; arguments = $Arguments }",
		"$Result | ConvertTo-Json -Depth 6 -Compress",
	].join("\r\n");
}

/**
 * @param {ReturnType<typeof resolveAppLauncherPlan>} plan
 */
function createLinuxDesktopFile(plan) {
	return [
		"[Desktop Entry]",
		"Type=Application",
		`Name=${MANAGED_LAUNCHER_NAME}`,
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
		`  <string>${MANAGED_LAUNCHER_NAME}</string>`,
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
	const args = Array.isArray(plan.commandArgv)
		? plan.commandArgv.map(quotePosixShell).join(" ")
		: plan.commandArgs;
	return [
		"#!/bin/sh",
		`cd ${quotePosixShell(plan.workingDirectory)}`,
		`exec ${quotePosixShell(plan.commandPath)} ${args}`,
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
 * @param {{ env: NodeJS.ProcessEnv, dryRun?: boolean, remove?: boolean }} options
 */
async function installWindowsShortcut(plan, options) {
	const script = createWindowsShortcutPowerShellScript(plan, {
		dryRun: options.dryRun,
		remove: options.remove,
	});
	const powershell =
		(options.env.SystemRoot ?? options.env.SYSTEMROOT ?? "C:\\Windows") +
		"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
	const result = await runCommand(
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
	const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
	if (!output) {
		return { action: options.remove ? "restore" : "route", routed: [], restored: [], skipped: [] };
	}
	try {
		return JSON.parse(output);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`codex-multi-auth-app-launcher: unexpected powershell output (${detail}): ${result.stdout.trim().slice(-512)}`,
		);
	}
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

	if (plan.platform === "win32") {
		const result = await installWindowsShortcut(plan, {
			env,
			dryRun: options.dryRun,
			remove: options.remove,
		});
		const routedCount = Array.isArray(result.routed) ? result.routed.length : 0;
		const restoredCount = Array.isArray(result.restored) ? result.restored.length : 0;
		const packagedAppCount = Array.isArray(result.packagedApps)
			? result.packagedApps.length
			: 0;
		if (options.remove) {
			const prefix = options.dryRun ? "[dry-run] Would restore" : "Restored";
			log(`${prefix} ${restoredCount} Codex app shortcut(s) from ${plan.backupPath}`);
			return plan;
		}
		if (routedCount === 0) {
			const prefix = options.dryRun ? "[dry-run] No" : "No";
			log(
				`${prefix} existing Codex app shortcuts or taskbar pins found to route through codex-multi-auth.`,
			);
			if (packagedAppCount > 0) {
				log(
					`Detected ${packagedAppCount} packaged Codex app entry; packaged app entries cannot be retargeted without a persistent background router.`,
				);
			}
			return plan;
		}
		const prefix = options.dryRun ? "[dry-run] Would route" : "Routed";
		log(`${prefix} ${routedCount} existing Codex app shortcut(s) through codex-multi-auth`);
		if (options.dryRun) {
			log(`[dry-run] Target: ${plan.commandPath} ${plan.commandArgs}`);
		}
		return plan;
	}

	if (options.remove) {
		if (options.dryRun) {
			log(`[dry-run] Would remove ${plan.launcherPath}`);
			return plan;
		}
		await withFileOperationRetry(() => rm(plan.launcherPath, { recursive: true, force: true }));
		log(`Removed ${MANAGED_LAUNCHER_NAME} app launcher: ${plan.launcherPath}`);
		return plan;
	}

	if (options.dryRun) {
		log(`[dry-run] Would install ${MANAGED_LAUNCHER_NAME} app launcher: ${plan.launcherPath}`);
		log(`[dry-run] Target: ${plan.commandPath} ${plan.commandArgs}`);
		return plan;
	}

	if (plan.platform === "darwin") {
		await installMacAppBundle(plan);
	} else {
		await installLinuxDesktopFile(plan);
	}
	log(`Installed ${MANAGED_LAUNCHER_NAME} app launcher: ${plan.launcherPath}`);
	return plan;
}

function printHelp() {
	console.log(
		[
			"Usage: codex-multi-auth-app-launcher [--remove] [--dry-run]",
			"",
			"Routes existing user-level Codex app shortcuts through codex-multi-auth on Windows.",
			`On other platforms, installs a user-level ${MANAGED_LAUNCHER_NAME} app launcher that runs \`codex app\` through codex-multi-auth.`,
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
			`Codex app launcher routing failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
}
