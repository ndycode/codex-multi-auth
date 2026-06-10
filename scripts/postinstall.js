#!/usr/bin/env node

// @ts-check

// Thin, CI-aware install notice (audit roadmap §4.5.4).
//
// All app detection, Codex app bind self-heal, and launcher routing that used
// to run here now run lazily on the first CLI invocation — see
// lib/runtime/first-run.ts (ensureFirstRunSetup). This script performs no
// detection and no filesystem mutation: it exits 0 silently in CI/non-TTY
// contexts and otherwise prints a short notice to stderr.

import process from "node:process";
import { resolve } from "node:path";
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

export const INSTALL_NOTICE = [
	"codex-multi-auth installed. Run `codex-multi-auth --help` to get started.",
	"App integration (Codex app bind + launcher shortcuts) completes automatically on first run.",
].join("\n");

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
 * @param {NodeJS.ProcessEnv} [env]
 * @param {boolean} [isTty]
 */
export function shouldPrintInstallNotice(
	env = process.env,
	isTty = process.stderr.isTTY === true,
) {
	if (isCiEnvironment(env)) return false;
	return isTty === true;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   isTty?: boolean,
 *   log?: (message: string) => void,
 * }} [options]
 * @returns {number} always 0 — an install notice must never fail an install
 */
export function runPostinstall(options = {}) {
	try {
		const env = options.env ?? process.env;
		const isTty = options.isTty ?? process.stderr.isTTY === true;
		if (shouldPrintInstallNotice(env, isTty)) {
			const log = options.log ?? ((message) => console.error(message));
			log(INSTALL_NOTICE);
		}
	} catch {
		// Best-effort notice only.
	}
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
	process.exitCode = runPostinstall();
}
