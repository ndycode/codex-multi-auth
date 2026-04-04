import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

export function resolveRealCodexBin(options = {}) {
	const {
		env = process.env,
		argv = process.argv,
		platform = process.platform,
		moduleUrl = import.meta.url,
		existsSyncImpl = existsSync,
		spawnSyncImpl = spawnSync,
		resolvePackageBin = defaultResolvePackageBin,
	} = options;

	const override = (env.CODEX_MULTI_AUTH_REAL_CODEX_BIN ?? "").trim();
	if (override.length > 0) {
		if (existsSyncImpl(override)) return override;
		return null;
	}

	const resolved = resolvePackageBin(moduleUrl);
	if (typeof resolved === "string" && resolved.length > 0 && existsSyncImpl(resolved)) {
		return resolved;
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
		if (existsSyncImpl(candidate)) return candidate;
	}

	try {
		const rootResult =
			platform === "win32"
				? spawnSyncImpl(resolveWindowsCmdPath(env), ["/d", "/s", "/c", "npm root -g"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
						windowsHide: true,
					})
				: spawnSyncImpl("npm", ["root", "-g"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
					});
		if (rootResult.status === 0) {
			const globalRoot = rootResult.stdout.trim();
			if (globalRoot.length > 0) {
				const globalBin = join(globalRoot, "@openai", "codex", "bin", "codex.js");
				if (existsSyncImpl(globalBin)) return globalBin;
			}
		}
	} catch {
		// Ignore and fall through to null.
	}

	return null;
}
