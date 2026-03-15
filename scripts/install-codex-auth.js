#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	installPluginIntoCache,
	withInstallerLock,
	PLUGIN_MARKETPLACE,
	PLUGIN_NAME,
	PLUGIN_VERSION,
	mergePluginConfigToml,
	resolveInstallPaths,
	renameWithRetry,
	withFileOperationRetry,
} from "./install-codex-auth-utils.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("-")));
const dryRun = flags.has("--dry-run");
const compatibilityFlags = ["--modern", "--legacy", "--no-cache-clear"].filter((flag) =>
	flags.has(flag)
);

if (flags.has("--help") || flags.has("-h")) {
	console.log(
		`${PLUGIN_NAME} plugin installer\n\n` +
		"Usage: node scripts/install-codex-auth.js [--dry-run] [--modern] [--legacy] [--no-cache-clear]\n\n" +
		"Default behavior:\n" +
		"  - Installs the official Codex plugin shell into CODEX_HOME/plugins/cache\n" +
		"  - Ensures ~/.codex/config.toml (or CODEX_CLI_CONFIG_PATH) has [features] plugins = true\n" +
		"  - Enables [plugins.\"codex-multi-auth@ndycode\"]\n" +
		"  - Creates a backup of config.toml before changing it\n\n" +
		"Compatibility flags accepted for older docs/scripts:\n" +
		"  --modern, --legacy, --no-cache-clear\n" +
		"    These are now no-ops because official Codex uses config.toml + plugin cache, not Codex.json.\n"
	);
	process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const pluginSourcePath = join(repoRoot, "codex-plugin");
const installPaths = resolveInstallPaths();
const {
	configDir,
	configPath,
	pluginBaseDir,
	pluginInstallDir,
	pluginKey,
} = installPaths;
const installerLockDir = join(dirname(pluginBaseDir), `${PLUGIN_NAME}.install.lock`);

function log(message) {
	console.log(message);
}

function hasErrorCode(error, code) {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code;
}

async function writeTextAtomic(filePath, content) {
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	try {
		await withFileOperationRetry(() => writeFile(tempPath, content, "utf-8"));
		await renameWithRetry(tempPath, filePath, { log });
	} finally {
		try {
			await withFileOperationRetry(() => rm(tempPath, { force: true }));
		} catch (error) {
			log(`Warning: Could not remove temporary file ${tempPath} (${error}).`);
		}
	}
}

async function backupFile(sourcePath) {
	const timestamp = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.replace("Z", "");
	const nonce = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const backupPath = `${sourcePath}.bak-${timestamp}-${nonce}`;
	if (!dryRun) {
		await withFileOperationRetry(() => copyFile(sourcePath, backupPath));
	}
	return backupPath;
}

async function readConfigTomlIfExists() {
	try {
		return await withFileOperationRetry(() => readFile(configPath, "utf-8"));
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return null;
		}
		throw error;
	}
}

async function removeBackupFileIfPresent(backupPath) {
	try {
		await withFileOperationRetry(() => rm(backupPath, { force: true }));
	} catch (error) {
		log(`Warning: Could not remove transient backup ${backupPath} (${error}).`);
	}
}

async function updateConfigToml() {
	const originalConfig = await readConfigTomlIfExists();
	if (originalConfig === null) {
		log("No existing config.toml found. Creating new user config.");
	}

	const normalizedOriginalConfig = originalConfig ?? "";
	const nextConfig = mergePluginConfigToml(normalizedOriginalConfig, pluginKey);
	if (nextConfig === normalizedOriginalConfig) {
		log(`${configPath} is already up to date.`);
		return;
	}

	let backupPath = null;
	if (originalConfig !== null) {
		try {
			backupPath = await backupFile(configPath);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				throw new Error(`${configPath} was removed while preparing the install. Rerun the installer.`);
			}
			throw error;
		}
	}

	if (dryRun) {
		if (backupPath !== null) {
			log(`[dry-run] Would create backup: ${backupPath}`);
		}
		log(`[dry-run] Would write ${configPath}`);
		return;
	}

	const latestConfig = await readConfigTomlIfExists();
	if (latestConfig !== originalConfig) {
		if (backupPath !== null) {
			await removeBackupFileIfPresent(backupPath);
		}
		throw new Error(
			latestConfig === null
				? `${configPath} was removed while preparing the install. Rerun the installer.`
				: `${configPath} changed while preparing the install. Rerun the installer to merge the latest changes.`,
		);
	}

	if (backupPath !== null) {
		log(`Backup created: ${backupPath}`);
	}

	await withFileOperationRetry(() => mkdir(configDir, { recursive: true }));
	await writeTextAtomic(configPath, nextConfig);
	log(`Wrote ${configPath}`);
}

async function main() {
	if (compatibilityFlags.length > 0) {
		log(
			`Compatibility note: ${compatibilityFlags.join(", ")} ${compatibilityFlags.length === 1 ? "is" : "are"} ignored. Official Codex plugin install now targets config.toml + plugin cache.`,
		);
	}

	if (!existsSync(pluginSourcePath)) {
		throw new Error(`Official plugin source not found at ${pluginSourcePath}`);
	}

	await withInstallerLock(installerLockDir, async () => {
		await installPluginIntoCache(pluginSourcePath, pluginBaseDir, pluginInstallDir, { dryRun, log });
		await updateConfigToml();
	}, { dryRun, log });

	log("");
	log(`Done. ${PLUGIN_NAME}@${PLUGIN_MARKETPLACE} is enabled for official Codex plugin loading.`);
	log("Example next steps:");
	log("  codex auth status");
	log("  codex auth login");
	log("  codex auth forecast --live");
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
		console.error(`Installer failed: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	});
}
