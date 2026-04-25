#!/usr/bin/env node

// @ts-check

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TRUE_VALUES = new Set(["1", "true", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "no"]);
const CI_ENV_KEYS = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"BUILDKITE",
	"TF_BUILD",
	"TEAMCITY_VERSION",
	"JENKINS_URL",
	"TRAVIS",
	"APPVEYOR",
	"BITBUCKET_BUILD_NUMBER",
];

/**
 * @param {string | undefined} value
 */
export function readOptionalBoolean(value) {
	if (value === undefined || value.trim().length === 0) return null;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function isGlobalNpmInstall(env = process.env) {
	const globalFlag = readOptionalBoolean(env.npm_config_global);
	if (globalFlag === true) return true;
	return (env.npm_config_location ?? "").trim().toLowerCase() === "global";
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 */
function isEnabledEnvFlag(env, key) {
	const value = env[key];
	if (value === undefined || value.trim().length === 0) return false;
	const parsed = readOptionalBoolean(value);
	return parsed !== false;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isCiEnvironment(env = process.env) {
	if (readOptionalBoolean(env.npm_config_ignore_scripts) === true) return true;
	return CI_ENV_KEYS.some((key) => isEnabledEnvFlag(env, key));
}

/**
 * @param {string} directory
 * @param {string} prefix
 */
function directoryContainsEntryWithPrefix(directory, prefix) {
	try {
		return readdirSync(directory, { withFileTypes: true }).some((entry) =>
			entry.name.startsWith(prefix),
		);
	} catch {
		return false;
	}
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string }} [options]
 */
export function hasCodexDesktopApp(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();

	if (platform === "win32") {
		const localAppData =
			(env.LOCALAPPDATA ?? "").trim() || join(home, "AppData", "Local");
		const programFiles =
			(env.ProgramFiles ?? env.ProgramW6432 ?? "").trim() || "C:\\Program Files";
		return (
			directoryContainsEntryWithPrefix(
				join(localAppData, "Packages"),
				"OpenAI.Codex_",
			) ||
			directoryContainsEntryWithPrefix(
				join(programFiles, "WindowsApps"),
				"OpenAI.Codex_",
			)
		);
	}

	if (platform === "darwin") {
		return (
			existsSync("/Applications/Codex.app") ||
			existsSync(join(home, "Applications", "Codex.app"))
		);
	}

	return false;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   home?: string,
 *   rotationEnabled: boolean,
 *   appDetected?: boolean,
 * }} options
 */
export function shouldAutoBindCodexAppOnInstall(options) {
	const env = options.env ?? process.env;
	if (isCiEnvironment(env)) return false;

	const bindOverride = readOptionalBoolean(env.CODEX_MULTI_AUTH_APP_BIND);
	if (bindOverride !== null) return bindOverride;

	const installOverride = readOptionalBoolean(
		env.CODEX_MULTI_AUTH_APP_BIND_INSTALL,
	);
	if (installOverride !== null) return installOverride;

	if (!isGlobalNpmInstall(env)) return false;
	if (!options.rotationEnabled) return false;
	return (
		options.appDetected ??
		hasCodexDesktopApp({
			env,
			platform: options.platform,
			home: options.home,
		})
	);
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   rotationEnabled: boolean,
 * }} options
 */
export function shouldAutoInstallCodexAppLauncherOnInstall(options) {
	const env = options.env ?? process.env;
	if (isCiEnvironment(env)) return false;

	const installOverride = readOptionalBoolean(
		env.CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL,
	);
	if (installOverride !== null) return installOverride;

	if (!isGlobalNpmInstall(env)) return false;
	return options.rotationEnabled;
}

async function loadConfigModule() {
	try {
		return await import("../dist/lib/config.js");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ERR_MODULE_NOT_FOUND"
		) {
			return null;
		}
		throw error;
	}
}

async function loadAppBindModule() {
	try {
		return await import("../dist/lib/runtime/app-bind.js");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ERR_MODULE_NOT_FOUND"
		) {
			return null;
		}
		throw error;
	}
}

/**
 * @param {unknown} configModule
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveRotationEnabled(configModule, env = process.env) {
	const envOverride = readOptionalBoolean(
		env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY,
	);
	if (envOverride !== null) return envOverride;
	if (
		!configModule ||
		typeof configModule.loadPluginConfig !== "function" ||
		typeof configModule.getCodexRuntimeRotationProxy !== "function"
	) {
		return true;
	}
	return (
		configModule.getCodexRuntimeRotationProxy(configModule.loadPluginConfig()) ===
		true
	);
}

function defaultPostinstallLog(message) {
	console.error(`codex-multi-auth: ${message}`);
}

/**
 * @param {boolean} rotationEnabled
 */
async function maybeBindCodexAppOnInstall(rotationEnabled) {
	const appBindModule = await loadAppBindModule();
	if (!appBindModule || typeof appBindModule.bindCodexAppRuntimeRotation !== "function") {
		return;
	}

	const currentStatus =
		typeof appBindModule.getAppBindStatus === "function"
			? await appBindModule.getAppBindStatus().catch(() => null)
			: null;
	const appDetected = hasCodexDesktopApp() || currentStatus?.bound === true;
	if (!shouldAutoBindCodexAppOnInstall({ rotationEnabled, appDetected })) {
		return;
	}

	const result = await appBindModule.bindCodexAppRuntimeRotation();
	if (result?.message) {
		console.error(`codex-multi-auth: ${result.message}`);
	}
}

/**
 * @param {boolean} rotationEnabled
 * @param {(message: string) => void} [log]
 */
export async function maybeInstallCodexAppLauncherOnInstall(
	rotationEnabled,
	log = defaultPostinstallLog,
) {
	if (!shouldAutoInstallCodexAppLauncherOnInstall({ rotationEnabled })) {
		return;
	}

	try {
		const launcherModule = await import("./codex-app-launcher.js");
		if (typeof launcherModule.installCodexAppLauncher !== "function") {
			return;
		}
		await launcherModule.installCodexAppLauncher({
			log,
		});
	} catch (error) {
		log(
			`app launcher postinstall skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * @param {{
 *   loadConfigModule?: () => Promise<unknown>,
 *   bindCodexApp?: (rotationEnabled: boolean) => Promise<void>,
 *   installLauncher?: (rotationEnabled: boolean) => Promise<void>,
 *   log?: (message: string) => void,
 *   env?: NodeJS.ProcessEnv,
 * }} [deps]
 */
export async function runPostinstallSelfHeal(deps = {}) {
	const loadConfig = deps.loadConfigModule ?? loadConfigModule;
	const bindCodexApp = deps.bindCodexApp ?? maybeBindCodexAppOnInstall;
	const log = deps.log ?? defaultPostinstallLog;
	const installLauncher =
		deps.installLauncher ??
		((rotationEnabled) =>
			maybeInstallCodexAppLauncherOnInstall(rotationEnabled, log));
	const configModule = await loadConfig();
	const rotationEnabled = resolveRotationEnabled(configModule, deps.env);

	try {
		await bindCodexApp(rotationEnabled);
	} catch (error) {
		log(
			`app bind postinstall skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	try {
		await installLauncher(rotationEnabled);
	} catch (error) {
		log(
			`app launcher postinstall skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return 0;
}

async function main() {
	return runPostinstallSelfHeal();
}

function normalizePostinstallExitCode(exitCode) {
	return Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255
		? exitCode
		: 0;
}

const isDirectRun = (() => {
	try {
		return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (isDirectRun) {
	main()
		.then((exitCode) => {
			process.exitCode = normalizePostinstallExitCode(exitCode);
		})
		.catch((error) => {
			defaultPostinstallLog(
				`postinstall self-heal skipped: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exitCode = 0;
		});
}
