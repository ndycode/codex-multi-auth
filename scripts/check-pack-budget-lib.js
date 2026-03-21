import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const MAX_PACKAGE_SIZE = 8 * 1024 * 1024;
export const REQUIRED_PREFIXES = [
	"dist/",
	"assets/",
	"config/",
	"scripts/",
	"vendor/codex-ai-plugin/",
	"vendor/codex-ai-sdk/",
	"README.md",
	"LICENSE",
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

export function normalizePackPath(filePath) {
	return filePath.replaceAll("\\", "/");
}

export function parsePackMetadata(stdout) {
	const packs = JSON.parse(stdout);
	if (!Array.isArray(packs) || packs.length === 0) {
		throw new Error("npm pack --dry-run --json returned no package metadata");
	}

	const pack = packs[0];
	if (!pack || !Array.isArray(pack.files)) {
		throw new Error("npm pack metadata did not include file list");
	}

	const packageSize = typeof pack.size === "number" ? pack.size : 0;
	if (packageSize <= 0) {
		throw new Error("npm pack metadata did not include a valid package size");
	}

	const paths = pack.files
		.map((file) => file?.path)
		.filter((value) => typeof value === "string")
		.map((value) => normalizePackPath(value));

	return { packageSize, paths };
}

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

export async function runPackBudgetCheck(deps = {}) {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const runExec = deps.execAsync ?? execAsync;
	const log = deps.log ?? console.log;
	const { stdout } = await runExec(`${npmCommand} pack --dry-run --json`, {
		windowsHide: true,
		maxBuffer: 10 * 1024 * 1024,
	});
	const summary = validatePackMetadata(parsePackMetadata(stdout));
	log(summary);
	return summary;
}
