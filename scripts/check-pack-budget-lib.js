import { exec } from "node:child_process";
import { promisify } from "node:util";

/**
 * @typedef {{ packageSize: number, paths: string[] }} ParsedPackMetadata
 * @typedef {{ windowsHide: boolean, maxBuffer: number }} ExecOptions
 * @typedef {{ stdout: string | Buffer, stderr?: string | Buffer }} ExecResult
 * @typedef {(command: string, options: ExecOptions) => Promise<ExecResult>} ExecAsync
 * @typedef {{ execAsync?: ExecAsync, log?: (message: string) => void }} RunPackBudgetDeps
 */

/** @type {ExecAsync} */
const execAsync = promisify(exec);

export const MAX_PACKAGE_SIZE = 8 * 1024 * 1024;
// Exact files that must be present (matched by full path equality, so a sibling
// like ".codex-plugin/plugin.json.bak" or "README.md.bak" cannot satisfy them).
export const REQUIRED_FILES = [
	".codex-plugin/plugin.json",
	"README.md",
	"LICENSE",
];
// Directory prefixes that must contribute at least one packed file.
export const REQUIRED_PREFIXES = [
	"dist/",
	"assets/",
	"config/",
	"scripts/",
	"vendor/codex-ai-plugin/",
	"vendor/codex-ai-sdk/",
];

export const FORBIDDEN_PREFIXES = [
	".github/",
	"test/",
	"src/",
	"lib/",
	"tmp/",
	".tmp/",
	".codex/",
];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function normalizePackPath(filePath) {
	return filePath.replaceAll("\\", "/");
}

/**
 * @param {string} stdout
 * @returns {ParsedPackMetadata}
 */
export function parsePackMetadata(stdout) {
	/** @type {unknown} */
	const packs = JSON.parse(stdout);
	if (!Array.isArray(packs) || packs.length === 0) {
		throw new Error("npm pack --dry-run --json returned no package metadata");
	}

	const pack = packs[0];
	if (!isRecord(pack) || !Array.isArray(pack.files)) {
		throw new Error("npm pack metadata did not include file list");
	}

	const packageSize = typeof pack.size === "number" ? pack.size : 0;
	if (packageSize <= 0) {
		throw new Error("npm pack metadata did not include a valid package size");
	}

	const paths = pack.files
		.map((file) => (isRecord(file) ? file.path : undefined))
		.filter((value) => typeof value === "string")
		.map((value) => normalizePackPath(value));

	return { packageSize, paths };
}

/**
 * @param {ParsedPackMetadata} metadata
 * @returns {string}
 */
export function validatePackMetadata({ packageSize, paths }) {
	if (packageSize > MAX_PACKAGE_SIZE) {
		throw new Error(
			`Packed tarball is too large: ${packageSize} bytes (max ${MAX_PACKAGE_SIZE})`,
		);
	}

	for (const forbidden of FORBIDDEN_PREFIXES) {
		const leaked = paths.find(
			(path) => path === forbidden || path.startsWith(forbidden),
		);
		if (leaked) {
			throw new Error(`Forbidden file leaked into package: ${leaked}`);
		}
	}

	for (const requiredFile of REQUIRED_FILES) {
		if (!paths.includes(requiredFile)) {
			throw new Error(
				`Required package file missing from npm pack output: ${requiredFile}`,
			);
		}
	}

	for (const required of REQUIRED_PREFIXES) {
		const present = paths.some(
			(path) => path === required || path.startsWith(required),
		);
		if (!present) {
			throw new Error(
				`Required package content missing from npm pack output: ${required}`,
			);
		}
	}

	return `Pack budget ok: ${packageSize} bytes across ${paths.length} files`;
}

/**
 * @param {RunPackBudgetDeps} [deps]
 * @returns {Promise<string>}
 */
export async function runPackBudgetCheck(deps = {}) {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const runExec = deps.execAsync ?? execAsync;
	const log = deps.log ?? console.log;
	let stdout = "";
	try {
		const result = await runExec(`${npmCommand} pack --dry-run --json`, {
			windowsHide: true,
			maxBuffer: 10 * 1024 * 1024,
		});
		if (result.stdout === null || result.stdout === undefined) {
			throw new Error("npm pack --dry-run --json returned no stdout");
		}
		stdout =
			typeof result.stdout === "string"
				? result.stdout
				: result.stdout.toString("utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const stdoutText =
			isRecord(error) && "stdout" in error ? String(error.stdout ?? "") : "";
		const stderrText =
			isRecord(error) && "stderr" in error ? String(error.stderr ?? "") : "";
		throw new Error(`npm pack --dry-run --json failed via ${npmCommand}: ${message}${stdoutText ? `
stdout: ${stdoutText.slice(0, 500)}` : ""}${stderrText ? `
stderr: ${stderrText.slice(0, 500)}` : ""}`);
	}
	let summary;
	try {
		summary = validatePackMetadata(parsePackMetadata(stdout));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to validate npm pack output: ${message}
stdout: ${stdout.slice(0, 500)}`);
	}
	log(summary);
	return summary;
}
