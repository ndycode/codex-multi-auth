import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Resolves the Codex home directory path, preferring the trimmed `CODEX_HOME` environment variable when set.
 *
 * If `CODEX_HOME` is empty or unset, returns the platform-specific default: `$HOME/.codex`.
 *
 * Concurrency: safe for concurrent calls; it only reads environment and OS homedir. Returned paths are not validated or normalized beyond the join operation.
 *
 * Windows: the returned path is a raw string for the platform; any case-sensitivity semantics are determined by the underlying filesystem (Windows is typically case-insensitive).
 *
 * Token handling: this function does not redact or inspect values for secrets — if `CODEX_HOME` contains sensitive data, it will be returned as-is.
 *
 * @returns The resolved Codex home directory path
 */

export function getCodexHomeDir(): string {
	const fromEnv = (process.env.CODEX_HOME ?? "").trim();
	return fromEnv.length > 0 ? fromEnv : join(homedir(), ".codex");
}

/**
 * Produce a new array of unique, trimmed path strings while preserving input order.
 *
 * The function trims each candidate, skips empty results, and deduplicates paths.
 * On Windows, comparison for deduplication is case-insensitive (paths are lowercased);
 * on other platforms, comparison is case-sensitive. The function is pure and has no
 * side effects, so it is safe to call concurrently. It does not perform any token
 * redaction or normalization beyond trimming and case folding for Windows.
 *
 * @param paths - Array of path candidates to filter and deduplicate
 * @returns A new array containing the first occurrence of each unique, non-empty, trimmed path in input order
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

/**
 * Detects whether a directory contains files or a subdirectory that indicate existing Codex/OpenCode storage.
 *
 * This performs only existence checks (no file contents are read). The check is subject to filesystem
 * state at call time and may change concurrently; callers should tolerate races. On Windows, filename
 * lookups follow the OS case-insensitive semantics. Because file contents are not inspected, no tokens
 * or secrets are exposed by this function.
 *
 * @param dir - Filesystem path to the directory to probe
 * @returns `true` if any of the known signal files exist (`openai-codex-accounts.json`, `settings.json`, `config.json`, `dashboard-settings.json`)
 *          or if a `projects` subdirectory exists, `false` otherwise
 */
function hasStorageSignals(dir: string): boolean {
	const signals = [
		"openai-codex-accounts.json",
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

/**
 * Return candidate Codex home directories used as fallbacks.
 *
 * The returned list preserves priority order and has duplicate entries removed
 * (comparison is case-insensitive on Windows). Paths are derived from the current
 * user's home directory and include the primary Codex home, a DevTools config
 * location, and the legacy `~/.codex` path.
 *
 * Concurrency: this function has no side effects and is safe to call concurrently.
 *
 * Security: returned paths may contain sensitive identifiers; redact them before logging.
 *
 * @returns An array of unique candidate Codex home directory paths in priority order.
 */
function getFallbackCodexHomeDirs(): string[] {
	return deduplicatePaths([
		getCodexHomeDir(),
		join(homedir(), "DevTools", "config", "codex"),
		join(homedir(), ".codex"),
	]);
}

/**
 * Selects the filesystem path to use for Codex multi-auth data, preferring an explicit environment override or an existing storage location.
 *
 * The function honors the CODEX_MULTI_AUTH_DIR environment variable when set. If not set, it prefers the primary multi-auth path under the resolved Codex home and falls back to other candidate locations that contain known storage signal files or the legacy OpenCode path. On Windows, existence checks and path deduplication treat paths case-insensitively.
 *
 * Concurrency: callers should assume the filesystem may change between this check and subsequent use of the returned path; callers must handle races when creating or modifying files under the returned directory.
 *
 * Security: the returned path can point to directories that contain sensitive tokens or credentials; callers should redact or avoid logging the full path when exposing it in logs or telemetry.
 *
 * @returns The chosen multi-auth directory path to use for storing multi-auth data.
 */
export function getCodexMultiAuthDir(): string {
	const fromEnv = (process.env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (fromEnv.length > 0) {
		return fromEnv;
	}

	const primary = join(getCodexHomeDir(), "multi-auth");
	if (hasStorageSignals(primary)) {
		return primary;
	}

	const fallbackCandidates = deduplicatePaths([
		...getFallbackCodexHomeDirs().map((dir) => join(dir, "multi-auth")),
		getLegacyOpenCodeDir(),
	]);

	for (const candidate of fallbackCandidates) {
		if (candidate === primary) continue;
		if (hasStorageSignals(candidate)) {
			return candidate;
		}
	}

	return primary;
}

/**
 * Compute the cache directory path under the active Codex multi-auth directory.
 *
 * The returned path is derived from the chosen multi-auth directory and appends
 * a `cache` segment. Callers are responsible for handling concurrent access to
 * files within this directory (no internal concurrency guarantees). On Windows,
 * path comparisons elsewhere in this module are treated case-insensitively.
 * The path may contain or be adjacent to sensitive tokens or identifiers; redact
 * or avoid logging raw paths when they might disclose secrets.
 *
 * @returns The filesystem path to the Codex cache directory (i.e., `<multi-auth>/cache`).
 */
export function getCodexCacheDir(): string {
	return join(getCodexMultiAuthDir(), "cache");
}

/**
 * Get the directory path where Codex multi-auth logs are stored.
 *
 * Derived by joining the resolved multi-auth directory with the "logs" subdirectory.
 * This function performs no I/O and is deterministic. It does not create the directory
 * or perform any locking; concurrent processes may read/write files there without
 * coordination. On Windows, path comparisons elsewhere in this module are case-insensitive;
 * this function merely returns the computed path string. The returned path may contain
 * sensitive identifiers or tokens—redact before logging or exposing externally.
 *
 * @returns The filesystem path to the Codex logs directory (the `logs` subdirectory of the resolved multi-auth directory).
 */
export function getCodexLogDir(): string {
	return join(getCodexMultiAuthDir(), "logs");
}

/**
 * Resolve the legacy OpenCode home directory path.
 *
 * Note: safe for concurrent calls; on Windows the returned path should be treated as case-insensitive.
 * The directory may contain sensitive tokens—do not log or expose its contents without redaction.
 *
 * @returns The absolute path to the legacy OpenCode directory (user home + ".opencode")
 */
export function getLegacyOpenCodeDir(): string {
	return join(homedir(), ".opencode");
}
