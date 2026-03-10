import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { existsSync, readdirSync } from "node:fs";

function firstNonEmpty(values: Array<string | undefined>): string | null {
	for (const value of values) {
		const trimmed = (value ?? "").trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return null;
}

function getResolvedUserHomeDir(): string {
	if (process.platform === "win32") {
		const homeDrive = (process.env.HOMEDRIVE ?? "").trim();
		const homePath = (process.env.HOMEPATH ?? "").trim();
		const drivePathHome =
			homeDrive.length > 0 && homePath.length > 0
				? win32.resolve(`${homeDrive}\\`, homePath)
				: undefined;
		return (
			firstNonEmpty([
				process.env.USERPROFILE,
				process.env.HOME,
				drivePathHome,
				homedir(),
			]) ?? homedir()
		);
	}
	return firstNonEmpty([process.env.HOME, homedir()]) ?? homedir();
}

/**
 * Resolve the Codex home directory path used by the CLI, honoring an environment override or a sensible default.
 *
 * This function is safe to call concurrently and returns a filesystem path string as-is; on Windows the underlying filesystem is case-insensitive so callers should avoid relying on case for equality. The returned path may contain sensitive identifiers; redact or avoid logging it in plaintext.
 *
 * @returns The resolved Codex home directory path: the value of `CODEX_HOME` when set and non-empty, otherwise the user's home directory joined with `.codex`.
 */

export function getCodexHomeDir(): string {
	const fromEnv = (process.env.CODEX_HOME ?? "").trim();
	return fromEnv.length > 0 ? fromEnv : join(getResolvedUserHomeDir(), ".codex");
}

/**
 * Returns a deduplicated list of path strings preserving the first occurrence order.
 *
 * Trims each input entry and ignores empty results; comparison for uniqueness is
 * case-insensitive on Windows and case-sensitive on other platforms. This function
 * performs no I/O and is safe to call concurrently.
 *
 * Note: entries are preserved as trimmed strings and are not modified for token
 * redaction or normalization beyond trimming and optional lowercasing on Windows.
 *
 * @param paths - Array of path strings to deduplicate
 * @returns An array of unique, trimmed path strings in their original first-seen order
 */
function deduplicatePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const candidate of paths) {
		const trimmed = candidate.trim();
		if (trimmed.length === 0) continue;
		const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
	}
	return result;
}

function pathsEqualNormalized(a: string, b: string): boolean {
	const normalize = (value: string): string => {
		const trimmed = value.trim();
		if (process.platform === "win32") {
			const normalized = win32.normalize(trimmed);
			const root = win32.parse(normalized).root;
			const withoutTrailing =
				normalized === root ? normalized : normalized.replace(/[\\/]+$/, "");
			return withoutTrailing.toLowerCase();
		}
		return trimmed === "/" ? "/" : trimmed.replace(/\/+$/, "");
	};
	return normalize(a) === normalize(b);
}

/**
 * Detects whether a directory contains known Codex storage indicators.
 *
 * Checks for the presence of known signal files (for example: openai-codex-accounts.json, settings.json, config.json, dashboard-settings.json)
 * or a "projects" subdirectory to determine if the directory appears to hold Codex data.
 *
 * Notes:
 * - The check only tests filesystem existence; it does not read file contents (no token or secret inspection/redaction is performed).
 * - Results can change if other processes modify the filesystem concurrently; callers should tolerate races.
 * - On Windows, filesystem case-insensitivity affects existence checks.
 *
 * @param dir - Filesystem path of the directory to probe
 * @returns `true` if any known signal file or a "projects" subdirectory exists, `false` otherwise.
 */
function hasStorageSignals(dir: string): boolean {
	const signals = [
		"openai-codex-accounts.json",
		"codex-accounts.json",
		"settings.json",
		"config.json",
		"dashboard-settings.json",
	];
	for (const signal of signals) {
		if (existsSync(join(dir, signal))) {
			return true;
		}
	}
	return existsSync(join(dir, "projects"));
}

function hasAccountsStorage(dir: string): boolean {
	const accountFiles = ["openai-codex-accounts.json", "codex-accounts.json"];
	for (const fileName of accountFiles) {
		if (existsSync(join(dir, fileName))) {
			return true;
		}
		if (existsSync(join(dir, `${fileName}.wal`))) {
			return true;
		}
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			for (const fileName of accountFiles) {
				if (!entry.name.startsWith(`${fileName}.`)) continue;
				if (entry.name.endsWith(".tmp")) continue;
				if (entry.name.includes(".rotate.")) continue;
				return true;
			}
		}
	} catch {
		// Ignore unreadable directories and fall back to known filename probes.
	}

	return false;
}

/**
 * Builds a deduplicated list of fallback candidate directories that may contain Codex runtime data.
 *
 * The returned list preserves evaluation order (primary Codex home first, then DevTools config, then legacy ~/.codex).
 * Comparison is normalized for case-insensitive filesystems (Windows) during deduplication. Callers should treat
 * these paths as suggestions only; concurrent callers may observe different filesystem states and should handle
 * races. Paths may contain sensitive tokens; callers must redact or avoid logging them.
 *
 * @returns An array of unique, trimmed directory paths to probe for Codex home data, in prioritized order.
 */
function getFallbackCodexHomeDirs(): string[] {
	const userHome = getResolvedUserHomeDir();
	return deduplicatePaths([
		getCodexHomeDir(),
		join(userHome, "DevTools", "config", "codex"),
		join(userHome, ".codex"),
	]);
}

/**
 * Determine the directory to use for Codex multi-auth data, preferring an explicit override
 * or existing storage locations and falling back to the primary Codex location.
 *
 * @returns The resolved multi-auth directory path.
 *
 * @remarks
 * Concurrency: safe to call concurrently; the function only inspects filesystem state and does not create or mutate directories.
 *
 * Windows: deduplication and existence checks treat paths case-insensitively on Windows; returned paths preserve platform-native casing.
 *
 * Security: returned paths may contain user-specific or sensitive data; callers should redact or avoid logging full paths. 
 */
export function getCodexMultiAuthDir(): string {
	const fromEnv = (process.env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (fromEnv.length > 0) {
		return fromEnv;
	}

	const codexHomeFromEnv = (process.env.CODEX_HOME ?? "").trim();
	const defaultCodexHome = join(getResolvedUserHomeDir(), ".codex");
	const isExplicitNonDefaultHome =
		codexHomeFromEnv.length > 0 && !pathsEqualNormalized(codexHomeFromEnv, defaultCodexHome);

	const primary = join(getCodexHomeDir(), "multi-auth");
	const fallbackCandidates = deduplicatePaths([
		...getFallbackCodexHomeDirs().map((dir) => join(dir, "multi-auth")),
		getLegacyCodexDir(),
	]);
	const orderedCandidates = deduplicatePaths([primary, ...fallbackCandidates]);

	if (isExplicitNonDefaultHome) {
		return primary;
	}

	// Prefer candidates that actually contain account storage. This prevents
	// accidentally switching to a fresh empty directory that only has settings files.
	for (const candidate of orderedCandidates) {
		if (hasAccountsStorage(candidate)) {
			return candidate;
		}
	}

	if (hasStorageSignals(primary)) {
		return primary;
	}

	for (const candidate of fallbackCandidates) {
		if (candidate === primary) continue;
		if (hasStorageSignals(candidate)) {
			return candidate;
		}
	}

	return primary;
}

/**
 * Resolves the Codex cache directory used for storing cached multi-auth artifacts.
 *
 * The returned path is derived from the resolved multi-auth directory. Callers should avoid concurrent
 * mutations to the returned directory path (concurrent reads are safe). On Windows, path comparison
 * is case-insensitive elsewhere in this module; the returned path itself preserves platform casing.
 *
 * Token or secret redaction is not performed on the path; do not log paths that may contain secrets.
 *
 * @returns The filesystem path to the Codex cache directory.
 */
export function getCodexCacheDir(): string {
	return join(getCodexMultiAuthDir(), "cache");
}

/**
 * Resolve the filesystem path for Codex log files.
 *
 * Returns the `logs` subdirectory within the resolved multi-auth directory.
 * Concurrency: safe to call concurrently; this function performs no I/O or directory creation.
 * Windows: path comparisons elsewhere are case-insensitive on Windows; this function returns a path using the platform separator.
 * Security: the returned path may contain sensitive artifacts (tokens/credentials); redact before logging or diagnostics.
 *
 * @returns The path to the Codex `logs` directory (i.e., `<multi-auth-dir>/logs`)
 */
export function getCodexLogDir(): string {
	return join(getCodexMultiAuthDir(), "logs");
}

/**
 * Resolve the legacy host home directory path.
 *
 * The returned path points to the per-user legacy folder (typically `<home>/.codex`).
 *
 * Concurrency: no atomicity guarantees — callers must handle concurrent filesystem access.
 * Windows: path comparisons may be case-insensitive on Windows filesystems.
 * Security: do not embed or log secrets/tokens in this path; redact any tokens before logging or telemetry.
 *
 * @returns The filesystem path for the legacy directory (e.g. `/home/alice/.codex`).
 */
export function getLegacyCodexDir(): string {
	return join(getResolvedUserHomeDir(), ".codex");
}

