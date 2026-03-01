import { join } from "node:path";
import { homedir } from "node:os";
import { rename as fsRename } from "node:fs/promises";

const PLUGIN_NAME = "codex-multi-auth";

export function resolveInstallPaths(
	platform = process.platform,
	env = process.env,
	home = homedir(),
) {
	const isWindows = platform === "win32";
	const appData = (env.APPDATA ?? "").trim();
	const localAppData = (env.LOCALAPPDATA ?? appData).trim();
	const configBase = isWindows
		? appData || join(home, "AppData", "Roaming")
		: join(home, ".config");
	const cacheBase = isWindows
		? localAppData || join(home, "AppData", "Local")
		: join(home, ".cache");
	const configDir = join(configBase, "Codex");
	const configPath = join(configDir, "Codex.json");
	const cacheDir = join(cacheBase, "Codex");
	return {
		configDir,
		configPath,
		cacheDir,
		cacheNodeModules: join(cacheDir, "node_modules", PLUGIN_NAME),
		cacheBunLock: join(cacheDir, "bun.lock"),
		cachePackageJson: join(cacheDir, "package.json"),
	};
}

export function normalizePluginList(list) {
	const entries = Array.isArray(list) ? list.filter(Boolean) : [];
	const filtered = entries.filter((entry) => {
		if (typeof entry !== "string") return true;
		return entry !== PLUGIN_NAME && !entry.startsWith(`${PLUGIN_NAME}@`);
	});
	const deduped = [];
	const seen = new Set();
	for (const entry of filtered) {
		const key = typeof entry === "string" ? `s:${entry}` : `j:${JSON.stringify(entry)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}
	return [...deduped, PLUGIN_NAME];
}

export async function renameWithRetry(sourcePath, targetPath, options = {}) {
	const {
		rename = fsRename,
		log = () => {},
		maxRetries = 5,
		baseDelayMs = 20,
		jitterMs = 10,
		random = Math.random,
		sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
	} = options;
	const retryableCodes = new Set(["ENOTEMPTY", "EPERM", "EBUSY", "EACCES"]);
	for (let attempt = 0; attempt < maxRetries; attempt += 1) {
		try {
			await rename(sourcePath, targetPath);
			return;
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
			const isRetryable = typeof code === "string" && retryableCodes.has(code);
			if (!isRetryable || attempt === maxRetries - 1) {
				throw error;
			}
			const delayMs = baseDelayMs * 2 ** attempt + Math.floor(random() * jitterMs);
			log(
				`Retrying atomic rename (${attempt + 1}/${maxRetries}) code=${code ?? "unknown"} source=${sourcePath} target=${targetPath} delayMs=${delayMs}`,
			);
			await sleep(delayMs);
		}
	}
}

