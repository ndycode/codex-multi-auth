import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { rename as fsRename } from "node:fs/promises";

export const PLUGIN_NAME = "codex-multi-auth";
export const PLUGIN_MARKETPLACE = "ndycode";
export const PLUGIN_VERSION = "local";
export const FILE_RETRY_CODES = new Set(["EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"]);
export const FILE_RETRY_MAX_ATTEMPTS = 6;
export const FILE_RETRY_BASE_DELAY_MS = 25;
export const FILE_RETRY_JITTER_MS = 20;

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
	return content.replace(/\r\n/g, "\n").split("\n");
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
	const normalized = content.trim().length === 0 ? [] : splitLines(content);
	const keyLine = `${key} = ${enabled ? "true" : "false"}`;
	const range = findSectionRange(normalized, sectionHeader);
	const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);

	if (!range) {
		if (normalized.length > 0 && normalized[normalized.length - 1] !== "") {
			normalized.push("");
		}
		normalized.push(sectionHeader, keyLine);
		return `${normalized.join("\n")}\n`;
	}

	for (let index = range.headerIndex + 1; index < range.endIndex; index += 1) {
		if (keyPattern.test(normalized[index])) {
			normalized[index] = keyLine;
			return `${normalized.join("\n")}\n`;
		}
	}

	normalized.splice(range.endIndex, 0, keyLine);
	return `${normalized.join("\n")}\n`;
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
