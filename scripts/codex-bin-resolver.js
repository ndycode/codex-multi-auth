import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function isJavaScriptEntryPath(candidate) {
	const extension = extname(candidate).toLowerCase();
	return extension === ".js" || extension === ".mjs" || extension === ".cjs";
}

function createResolvedCodexBin(path) {
	return {
		path,
		launchWithNode: isJavaScriptEntryPath(path),
	};
}

function normalizeResolvedPath(candidatePath, realpathSyncImpl) {
	try {
		return realpathSyncImpl(candidatePath);
	} catch {
		return candidatePath;
	}
}

// Defense-in-depth self-recursion guard. The exact-realpath check only blocks
// the wrapper's own codex.js (the POSIX symlink case). If the wrapper were ever
// exposed as a native codex/codex.exe sitting alongside it, that exact-path
// check would miss it. Skipping any candidate that resolves inside the
// wrapper's own directory closes that latent self-loop.
function isWithinDirectory(candidatePath, directoryPath, realpathSyncImpl) {
	if (!directoryPath) return false;
	const resolvedCandidate = normalizeResolvedPath(candidatePath, realpathSyncImpl);
	const relativePath = relative(directoryPath, resolvedCandidate);
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

function resolveWrapperScriptPath(moduleUrl, realpathSyncImpl) {
	return normalizeResolvedPath(fileURLToPath(moduleUrl), realpathSyncImpl);
}

const DEFAULT_WRAPPER_MODULE_URL = new URL("./codex.js", import.meta.url).href;

function defaultResolvePackageBin(moduleUrl) {
	try {
		const require = createRequire(moduleUrl);
		return require.resolve("@openai/codex/bin/codex.js");
	} catch {
		return null;
	}
}

function resolveWindowsCmdPath(env) {
	const comSpec = (env.ComSpec ?? env.COMSPEC ?? "").trim();
	if (comSpec.length > 0) return comSpec;

	const systemRoot = (env.SystemRoot ?? env.SYSTEMROOT ?? "").trim();
	if (systemRoot.length > 0) {
		return `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\cmd.exe`;
	}

	return "cmd.exe";
}

export function splitPathEntries(pathValue) {
	if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
		return [];
	}
	return pathValue
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function resolvePathExecutableName(platform) {
	return platform === "win32" ? "codex.exe" : "codex";
}

function resolveCandidateExecutableNames(platform) {
	if (platform !== "win32") {
		return [resolvePathExecutableName(platform)];
	}
	return ["codex.exe", "codex"];
}

function resolveCodexExecutableFromPath(
	pathEntries,
	platform,
	existsSyncImpl,
	selfScriptPath,
	realpathSyncImpl,
) {
	for (const entry of pathEntries) {
		for (const executableName of resolveCandidateExecutableNames(platform)) {
			const candidate = join(entry, executableName);
			if (!existsSyncImpl(candidate)) {
				continue;
			}
			if (
				selfScriptPath &&
				normalizeResolvedPath(candidate, realpathSyncImpl) === selfScriptPath
			) {
				continue;
			}
			if (
				selfScriptPath &&
				isWithinDirectory(candidate, dirname(selfScriptPath), realpathSyncImpl)
			) {
				continue;
			}
			return candidate;
		}
	}
	return null;
}

function normalizeWhereOutput(stdout) {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function resolveCodexExecutableFromSystemPath(
	env,
	platform,
	spawnSyncImpl,
	existsSyncImpl,
	selfScriptPath,
	realpathSyncImpl,
) {
	const pathEntries = splitPathEntries(env.PATH ?? env.Path ?? "");
	const fromEnvPath = resolveCodexExecutableFromPath(
		pathEntries,
		platform,
		existsSyncImpl,
		selfScriptPath,
		realpathSyncImpl,
	);
	if (fromEnvPath) {
		return fromEnvPath;
	}

	try {
		const lookupResult =
			platform === "win32"
				? spawnSyncImpl(resolveWindowsCmdPath(env), ["/d", "/s", "/c", "where codex"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 5000,
						windowsHide: true,
					})
				: spawnSyncImpl("which", ["codex"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 5000,
					});
		if (lookupResult.status !== 0) {
			return null;
		}
		for (const candidate of normalizeWhereOutput(lookupResult.stdout)) {
			if (!existsSyncImpl(candidate)) {
				continue;
			}
			if (
				selfScriptPath &&
				normalizeResolvedPath(candidate, realpathSyncImpl) === selfScriptPath
			) {
				continue;
			}
			if (
				selfScriptPath &&
				isWithinDirectory(candidate, dirname(selfScriptPath), realpathSyncImpl)
			) {
				continue;
			}
			const fileName = basename(candidate).toLowerCase();
			if (fileName === "codex" || fileName === "codex.exe") {
				return candidate;
			}
		}
	} catch {
		// Ignore and fall through.
	}

	return null;
}

export function resolveRealCodexBin(options = {}) {
	const {
		env = process.env,
		argv = process.argv,
		platform = process.platform,
		moduleUrl = DEFAULT_WRAPPER_MODULE_URL,
		existsSyncImpl = existsSync,
		realpathSyncImpl = realpathSync,
		spawnSyncImpl = spawnSync,
		resolvePackageBin = defaultResolvePackageBin,
	} = options;

	const override = (env.CODEX_MULTI_AUTH_REAL_CODEX_BIN ?? "").trim();
	if (override.length > 0) {
		if (existsSyncImpl(override)) return createResolvedCodexBin(override);
		return null;
	}

	const resolved = resolvePackageBin(moduleUrl);
	if (typeof resolved === "string" && resolved.length > 0 && existsSyncImpl(resolved)) {
		return createResolvedCodexBin(resolved);
	}

	const searchRoots = [];
	const scriptDir = dirname(fileURLToPath(moduleUrl));
	searchRoots.push(join(scriptDir, "..", ".."));

	const invokedScript = argv[1];
	if (typeof invokedScript === "string" && invokedScript.length > 0) {
		searchRoots.push(join(dirname(invokedScript), "..", ".."));
	}

	const npmPrefix = (env.npm_config_prefix ?? env.PREFIX ?? "").trim();
	if (npmPrefix.length > 0) {
		searchRoots.push(join(npmPrefix, "node_modules"));
		searchRoots.push(join(npmPrefix, "lib", "node_modules"));
	}

	for (const root of searchRoots) {
		const candidate = join(root, "@openai", "codex", "bin", "codex.js");
		if (existsSyncImpl(candidate)) return createResolvedCodexBin(candidate);
	}

	try {
		const rootResult =
			platform === "win32"
				? spawnSyncImpl(resolveWindowsCmdPath(env), ["/d", "/s", "/c", "npm root -g"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 5000,
						windowsHide: true,
					})
				: spawnSyncImpl("npm", ["root", "-g"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 5000,
					});
		if (rootResult.status === 0) {
			const globalRoot = rootResult.stdout.trim();
			if (globalRoot.length > 0) {
				const globalBin = join(globalRoot, "@openai", "codex", "bin", "codex.js");
				if (existsSyncImpl(globalBin)) return createResolvedCodexBin(globalBin);
			}
		}
	} catch {
		// Ignore and fall through to null.
	}

	const selfScriptPath = resolveWrapperScriptPath(moduleUrl, realpathSyncImpl);

	const nativeCodexBin = resolveCodexExecutableFromSystemPath(
		env,
		platform,
		spawnSyncImpl,
		existsSyncImpl,
		selfScriptPath,
		realpathSyncImpl,
	);
	if (nativeCodexBin) {
		return createResolvedCodexBin(nativeCodexBin);
	}

	return null;
}
