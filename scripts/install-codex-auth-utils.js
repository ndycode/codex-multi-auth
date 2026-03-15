import { existsSync } from "node:fs";
import { cp, mkdir, rename as fsRename, rm, stat, utimes } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";

const requireFromUtils = createRequire(import.meta.url);
const { version: packageVersion } = requireFromUtils("../package.json");

export const PLUGIN_NAME = "codex-multi-auth";
export const PLUGIN_MARKETPLACE = "ndycode";
export const PLUGIN_VERSION = packageVersion;
export const FILE_RETRY_CODES = new Set(["EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"]);
export const FILE_RETRY_MAX_ATTEMPTS = 6;
export const FILE_RETRY_BASE_DELAY_MS = 25;
export const FILE_RETRY_JITTER_MS = 20;
export const INSTALL_LOCK_RETRY_CODES = new Set(["EEXIST", "EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"]);
export const INSTALL_LOCK_MAX_ATTEMPTS = 40;
export const INSTALL_LOCK_BASE_DELAY_MS = 25;
export const INSTALL_LOCK_MAX_DELAY_MS = 500;
export const INSTALL_LOCK_STALE_MS = 60_000;
export const INSTALL_LOCK_HEARTBEAT_INTERVAL_MS = 15_000;

function firstNonEmpty(values) {
	for (const value of values) {
		const trimmed = (value ?? "").trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return null;
}

export function resolveCodexHomeDir(
	platform = process.platform,
	env = process.env,
	home = homedir(),
) {
	const override = (env.CODEX_HOME ?? "").trim();
	if (override.length > 0) {
		return override;
	}
	if (platform === "win32") {
		const homeDrive = (env.HOMEDRIVE ?? "").trim();
		const homePath = (env.HOMEPATH ?? "").trim();
		const drivePathHome =
			homeDrive.length > 0 && homePath.length > 0
				? `${homeDrive}${homePath}`
				: undefined;
		return join(
			firstNonEmpty([env.USERPROFILE, env.HOME, drivePathHome, home]) ?? home,
			".codex",
		);
	}
	return join(firstNonEmpty([env.HOME, home]) ?? home, ".codex");
}

export function makePluginKey(
	pluginName = PLUGIN_NAME,
	marketplaceName = PLUGIN_MARKETPLACE,
) {
	return `${pluginName}@${marketplaceName}`;
}

export function resolveInstallPaths(
	platform = process.platform,
	env = process.env,
	home = homedir(),
	pluginName = PLUGIN_NAME,
	marketplaceName = PLUGIN_MARKETPLACE,
	pluginVersion = PLUGIN_VERSION,
) {
	const codexHomeDir = resolveCodexHomeDir(platform, env, home);
	const configPathOverride = (env.CODEX_CLI_CONFIG_PATH ?? "").trim();
	const configPath = configPathOverride.length > 0
		? configPathOverride
		: join(codexHomeDir, "config.toml");
	const configDir = dirname(configPath);
	const pluginsCacheDir = join(codexHomeDir, "plugins", "cache");
	const pluginBaseDir = join(pluginsCacheDir, marketplaceName, pluginName);
	const pluginInstallDir = join(pluginBaseDir, pluginVersion);
	return {
		codexHomeDir,
		configDir,
		configPath,
		pluginsCacheDir,
		pluginBaseDir,
		pluginInstallDir,
		pluginKey: makePluginKey(pluginName, marketplaceName),
		pluginName,
		marketplaceName,
		pluginVersion,
	};
}

function splitLines(content) {
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	return {
		lines: content.replace(/\r\n/g, "\n").split("\n"),
		newline,
	};
}

function formatTomlOutput(lines, newline) {
	const normalized = [...lines];
	while (normalized.length > 0 && normalized[normalized.length - 1] === "") {
		normalized.pop();
	}
	return normalized.length === 0 ? "" : `${normalized.join(newline)}${newline}`;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSectionRange(lines, sectionHeader) {
	const headerPattern = new RegExp(`^\\s*${escapeRegExp(sectionHeader)}\\s*(?:#.*)?$`);
	const headerIndex = lines.findIndex((line) => headerPattern.test(line));
	if (headerIndex === -1) {
		return null;
	}
	let endIndex = lines.length;
	for (let index = headerIndex + 1; index < lines.length; index += 1) {
		if (/^\s*\[\[?[^\]]+\]?\]\s*(?:#.*)?$/.test(lines[index])) {
			endIndex = index;
			break;
		}
	}
	return { headerIndex, endIndex };
}

function upsertTomlBoolean(content, sectionHeader, key, enabled) {
	const { lines, newline } = splitLines(content);
	const normalized = content.trim().length === 0 ? [] : lines;
	const keyLine = `${key} = ${enabled ? "true" : "false"}`;
	const range = findSectionRange(normalized, sectionHeader);
	const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);

	if (!range) {
		if (normalized.length > 0 && normalized[normalized.length - 1] !== "") {
			normalized.push("");
		}
		normalized.push(sectionHeader, keyLine);
		return formatTomlOutput(normalized, newline);
	}

	for (let index = range.headerIndex + 1; index < range.endIndex; index += 1) {
		if (keyPattern.test(normalized[index])) {
			if (normalized[index] === keyLine) {
				return content;
			}
			normalized[index] = keyLine;
			return formatTomlOutput(normalized, newline);
		}
	}

	normalized.splice(range.endIndex, 0, keyLine);
	return formatTomlOutput(normalized, newline);
}

export function mergePluginConfigToml(content, pluginKey) {
	const withFeatures = upsertTomlBoolean(content, "[features]", "plugins", true);
	return upsertTomlBoolean(withFeatures, `[plugins."${pluginKey}"]`, "enabled", true);
}

function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function shouldRetryFileOperation(error) {
	return error instanceof Error &&
		typeof error.code === "string" &&
		FILE_RETRY_CODES.has(error.code);
}

function hasErrorCode(error, code) {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code;
}

export async function withFileOperationRetry(operation) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (!shouldRetryFileOperation(error) || attempt >= FILE_RETRY_MAX_ATTEMPTS) {
				throw error;
			}

			const jitter = Math.floor(Math.random() * FILE_RETRY_JITTER_MS);
			const delayMs = (FILE_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1))) + jitter;
			await sleep(delayMs);
		}
	}
}

export async function renameWithRetry(sourcePath, targetPath, options = {}) {
	const {
		rename = fsRename,
		log = () => {},
		maxRetries = FILE_RETRY_MAX_ATTEMPTS,
		baseDelayMs = FILE_RETRY_BASE_DELAY_MS,
		jitterMs = FILE_RETRY_JITTER_MS,
		random = Math.random,
		sleep: sleepImpl = sleep,
	} = options;

	if (!Number.isInteger(maxRetries) || maxRetries < 1) {
		throw new RangeError("maxRetries must be an integer >= 1");
	}

	for (let attempt = 0; attempt < maxRetries; attempt += 1) {
		try {
			await rename(sourcePath, targetPath);
			return;
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
			const isRetryable = typeof code === "string" && FILE_RETRY_CODES.has(code);
			if (!isRetryable || attempt === maxRetries - 1) {
				throw error;
			}
			const delayMs = baseDelayMs * 2 ** attempt + Math.floor(random() * jitterMs);
			log(
				`Retrying atomic rename (${attempt + 1}/${maxRetries}) code=${code ?? "unknown"} source=${sourcePath} target=${targetPath} delayMs=${delayMs}`,
			);
			await sleepImpl(delayMs);
		}
	}
}

export async function installPluginIntoCache(sourcePath, targetBaseDir, targetInstallDir, options = {}) {
	const {
		mkdirImpl = mkdir,
		cpImpl = cp,
		rmImpl = rm,
		renameImpl = renameWithRetry,
		log = () => {},
		dryRun = false,
	} = options;
	const parentDir = dirname(targetBaseDir);
	const stagedRoot = join(
		parentDir,
		`.plugin-install-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	const stagedBaseDir = join(stagedRoot, basename(targetBaseDir));
	const stagedInstallDir = join(stagedBaseDir, relative(targetBaseDir, targetInstallDir));
	const rollbackDir = join(
		parentDir,
		`.plugin-rollback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	let movedExistingPlugin = false;
	let preserveRollbackDir = false;

	if (dryRun) {
		log(`[dry-run] Would install plugin files from ${sourcePath}`);
		log(`[dry-run] Would replace ${targetBaseDir}`);
		return;
	}

	try {
		await withFileOperationRetry(() => mkdirImpl(parentDir, { recursive: true }));
		await withFileOperationRetry(() => mkdirImpl(stagedInstallDir, { recursive: true }));
		try {
			await withFileOperationRetry(() => cpImpl(sourcePath, stagedInstallDir, { recursive: true }));
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				throw new Error(`Official plugin source not found at ${sourcePath}`);
			}
			throw error;
		}
		if (existsSync(targetBaseDir)) {
			await renameImpl(targetBaseDir, rollbackDir, { log });
			movedExistingPlugin = true;
		}
		try {
			await renameImpl(stagedBaseDir, targetBaseDir, { log });
		} catch (error) {
			if (movedExistingPlugin && !existsSync(targetBaseDir) && existsSync(rollbackDir)) {
				try {
					await renameImpl(rollbackDir, targetBaseDir, { log });
					movedExistingPlugin = false;
				} catch (restoreError) {
					preserveRollbackDir = true;
					throw restoreError;
				}
			}
			if (movedExistingPlugin && existsSync(rollbackDir)) {
				preserveRollbackDir = true;
			}
			throw error;
		}
		if (movedExistingPlugin) {
			await withFileOperationRetry(() => rmImpl(rollbackDir, { recursive: true, force: true }));
			movedExistingPlugin = false;
		}
	} finally {
		try {
			await withFileOperationRetry(() => rmImpl(stagedRoot, { recursive: true, force: true }));
		} catch (cleanupError) {
			log(`Warning: Could not remove staged temp dir ${stagedRoot} (${cleanupError}).`);
		}
		if (preserveRollbackDir) {
			log(`Warning: Preserving rollback temp dir ${rollbackDir} because restore did not complete.`);
		} else {
			try {
				await withFileOperationRetry(() => rmImpl(rollbackDir, { recursive: true, force: true }));
			} catch (cleanupError) {
				log(`Warning: Could not remove rollback temp dir ${rollbackDir} (${cleanupError}).`);
			}
		}
	}
	log(`Installed plugin cache at ${targetInstallDir}`);
}

export async function withInstallerLock(installerLockDir, operation, options = {}) {
	const {
		dryRun = false,
		log = () => {},
		mkdirImpl = mkdir,
		rmImpl = rm,
		statImpl = stat,
		utimesImpl = utimes,
		sleep: sleepImpl = sleep,
		heartbeatIntervalMs = INSTALL_LOCK_HEARTBEAT_INTERVAL_MS,
		now = Date.now,
	} = options;

	if (dryRun) {
		return operation();
	}

	await withFileOperationRetry(() => mkdirImpl(dirname(installerLockDir), { recursive: true }));

	for (let attempt = 0; ; attempt += 1) {
		try {
			await mkdirImpl(installerLockDir, { recursive: false });
			break;
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
			const isRetryable = typeof code === "string" && INSTALL_LOCK_RETRY_CODES.has(code);
			if (!isRetryable || attempt >= INSTALL_LOCK_MAX_ATTEMPTS - 1) {
				throw error;
			}
			if (code === "EEXIST") {
				if (attempt === 0) {
					log(`Waiting for installer lock ${installerLockDir}`);
				}
				try {
					const { mtimeMs } = await statImpl(installerLockDir);
					if (now() - mtimeMs > INSTALL_LOCK_STALE_MS) {
						log(`Warning: removing stale installer lock ${installerLockDir}`);
						await withFileOperationRetry(() => rmImpl(installerLockDir, { recursive: true, force: true }));
						continue;
					}
				} catch {
					await sleepImpl(INSTALL_LOCK_BASE_DELAY_MS);
					continue;
				}
			}
			const delayMs = Math.min(INSTALL_LOCK_BASE_DELAY_MS * 2 ** attempt, INSTALL_LOCK_MAX_DELAY_MS);
			await sleepImpl(delayMs);
		}
	}

	let heartbeat = Promise.resolve();
	const refreshLockHeartbeat = async () => {
		const touchedAt = new Date(now());
		try {
			await withFileOperationRetry(() => utimesImpl(installerLockDir, touchedAt, touchedAt));
		} catch (error) {
			log(`Warning: Could not refresh installer lock ${installerLockDir} (${error}).`);
		}
	};
	const heartbeatHandle = heartbeatIntervalMs > 0
		? setInterval(() => {
			heartbeat = heartbeat.then(() => refreshLockHeartbeat());
		}, heartbeatIntervalMs)
		: null;
	heartbeatHandle?.unref?.();

	try {
		return await operation();
	} finally {
		if (heartbeatHandle !== null) {
			clearInterval(heartbeatHandle);
			await heartbeat;
		}
		try {
			await withFileOperationRetry(() => rmImpl(installerLockDir, { recursive: true, force: true }));
		} catch (error) {
			log(`Warning: Could not remove installer lock ${installerLockDir} (${error}).`);
		}
	}
}
