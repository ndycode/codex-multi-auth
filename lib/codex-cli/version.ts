/**
 * Detects the installed Codex CLI version for the `client_version` parameter
 * the upstream models catalog requires (issue #733). The catalog filters by
 * `minimal_client_version`, so the honest value is whatever `codex --version`
 * reports on this host — never a hardcoded string.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

interface ResolvedCodexBin {
	path: string;
	launchWithNode: boolean;
}

interface BinResolverModule {
	resolveRealCodexBin?: () => ResolvedCodexBin | null;
	isWindowsShimPath?: (candidatePath: string) => boolean;
	resolveWindowsShimPackageEntry?: (shimPath: string) => string | null;
}

export interface CodexCliVersionDeps {
	resolveBin?: () => Promise<ResolvedCodexBin | null>;
	execFile?: (
		file: string,
		args: readonly string[],
		options: { timeout: number },
	) => Promise<{ stdout: string }>;
}

// scripts/codex-bin-resolver.js is plain shipped JS, so it loads by URL:
// dist/lib/codex-cli/ resolves ../../../scripts, the source tree ../../scripts.
const RESOLVER_CANDIDATES = [
	fileURLToPath(new URL("../../../scripts/codex-bin-resolver.js", import.meta.url)),
	fileURLToPath(new URL("../../scripts/codex-bin-resolver.js", import.meta.url)),
];

async function loadBinResolver(): Promise<BinResolverModule | null> {
	for (const candidate of RESOLVER_CANDIDATES) {
		if (!existsSync(candidate)) continue;
		const resolverModule = (await import(pathToFileURL(candidate).href).catch(
			() => null,
		)) as BinResolverModule | null;
		if (typeof resolverModule?.resolveRealCodexBin === "function") {
			return resolverModule;
		}
	}
	return null;
}

async function defaultResolveBin(): Promise<ResolvedCodexBin | null> {
	const resolverModule = await loadBinResolver();
	const resolve = resolverModule?.resolveRealCodexBin;
	if (!resolve) return null;
	const bin = resolve();
	// PATH discovery can hand back npm's extensionless `codex` shim on Windows,
	// which no spawn API can exec. The resolver knows the sibling package entry
	// the shim points at; launch that through node instead.
	if (
		bin &&
		process.platform === "win32" &&
		!bin.launchWithNode &&
		resolverModule.isWindowsShimPath?.(bin.path)
	) {
		const entry = resolverModule.resolveWindowsShimPackageEntry?.(bin.path);
		if (entry) return { path: entry, launchWithNode: true };
	}
	return bin;
}

const defaultExecFile: NonNullable<CodexCliVersionDeps["execFile"]> = (
	file,
	args,
	options,
) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			[...args],
			{ ...options, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				if (error) reject(error);
				else resolve({ stdout: String(stdout) });
			},
		);
	});

export const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,80}$/;

/** Extracts `0.160.1` from `codex --version` output such as `codex-cli 0.160.1`. */
export function parseCodexCliVersion(output: string): string | null {
	const match = /(?:^|\s)v?(\d+\.\d+\.\d+[-0-9A-Za-z.+_]*)/.exec(output);
	const version = match?.[1];
	return version && CLIENT_VERSION_PATTERN.test(version) ? version : null;
}

/**
 * Returns the installed Codex CLI version, or null when no binary resolves or
 * the probe fails. Detection failure must never break a check: the caller just
 * sends no `client_version`, exactly as before.
 */
export async function detectInstalledCodexCliVersion(
	deps: CodexCliVersionDeps = {},
): Promise<string | null> {
	try {
		const bin = await (deps.resolveBin ?? defaultResolveBin)();
		if (!bin || typeof bin.path !== "string" || bin.path.length === 0) return null;
		const exec = deps.execFile ?? defaultExecFile;
		const { stdout } = await exec(
			bin.launchWithNode ? process.execPath : bin.path,
			bin.launchWithNode ? [bin.path, "--version"] : ["--version"],
			{ timeout: 10_000 },
		);
		return parseCodexCliVersion(stdout);
	} catch {
		return null;
	}
}
