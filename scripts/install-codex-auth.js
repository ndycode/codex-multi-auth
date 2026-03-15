#!/usr/bin/env node

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
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
const INSTALL_LOCK_RETRY_CODES = new Set(["EEXIST", "EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"]);
const INSTALL_LOCK_MAX_ATTEMPTS = 40;
const INSTALL_LOCK_BASE_DELAY_MS = 25;

function log(message) {
	console.log(message);
}

function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function withInstallerLock(operation) {
	if (dryRun) {
		return operation();
	}

	await withFileOperationRetry(() => mkdir(dirname(installerLockDir), { recursive: true }));

	for (let attempt = 0; ; attempt += 1) {
		try {
			await mkdir(installerLockDir, { recursive: false });
			break;
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
			const isRetryable = typeof code === "string" && INSTALL_LOCK_RETRY_CODES.has(code);
			if (!isRetryable || attempt >= INSTALL_LOCK_MAX_ATTEMPTS - 1) {
				throw error;
			}
			const delayMs = INSTALL_LOCK_BASE_DELAY_MS * (attempt + 1);
			await sleep(delayMs);
		}
	}

	try {
		return await operation();
	} finally {
		try {
			await withFileOperationRetry(() => rm(installerLockDir, { recursive: true, force: true }));
		} catch (error) {
			log(`Warning: Could not remove installer lock ${installerLockDir} (${error}).`);
		}
	}
}

async function writeTextAtomic(filePath, content) {
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	try {
		await withFileOperationRetry(() => writeFile(tempPath, content, "utf-8"));
		await renameWithRetry(tempPath, filePath, { log });
	} finally {
		if (existsSync(tempPath)) {
			try {
				await withFileOperationRetry(() => rm(tempPath, { force: true }));
			} catch (error) {
				log(`Warning: Could not remove temporary file ${tempPath} (${error}).`);
			}
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

async function installPluginIntoCache(sourcePath, targetBaseDir, targetInstallDir) {
	const parentDir = dirname(targetBaseDir);
	const stagedRoot = join(
		parentDir,
		`.plugin-install-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	const stagedBaseDir = join(stagedRoot, basename(targetBaseDir));
	const stagedInstallDir = join(stagedBaseDir, relative(targetBaseDir, targetInstallDir));

	if (dryRun) {
		log(`[dry-run] Would install plugin files from ${sourcePath}`);
		log(`[dry-run] Would replace ${targetBaseDir}`);
		return;
	}

	try {
		await withFileOperationRetry(() => mkdir(parentDir, { recursive: true }));
		await withFileOperationRetry(() => mkdir(stagedInstallDir, { recursive: true }));
		await withFileOperationRetry(() => cp(sourcePath, stagedInstallDir, { recursive: true }));
		await withFileOperationRetry(() => rm(targetBaseDir, { recursive: true, force: true }));
		await renameWithRetry(stagedBaseDir, targetBaseDir, { log });
	} finally {
		if (existsSync(stagedRoot)) {
			try {
				await withFileOperationRetry(() => rm(stagedRoot, { recursive: true, force: true }));
			} catch (cleanupError) {
				log(`Warning: Could not remove staged temp dir ${stagedRoot} (${cleanupError}).`);
			}
		}
	}
	log(`Installed plugin cache at ${targetInstallDir}`);
}

async function updateConfigToml() {
	let nextConfig = "";
	if (existsSync(configPath)) {
		const backupPath = await backupFile(configPath);
		log(`${dryRun ? "[dry-run] Would create backup" : "Backup created"}: ${backupPath}`);
		nextConfig = await withFileOperationRetry(() => readFile(configPath, "utf-8"));
	} else {
		log("No existing config.toml found. Creating new user config.");
	}

	nextConfig = mergePluginConfigToml(nextConfig, pluginKey);
	if (dryRun) {
		log(`[dry-run] Would write ${configPath}`);
		return;
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

	await withInstallerLock(async () => {
		await installPluginIntoCache(pluginSourcePath, pluginBaseDir, pluginInstallDir);
		await updateConfigToml();
	});

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
