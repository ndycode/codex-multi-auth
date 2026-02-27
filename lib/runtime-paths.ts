import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Runtime path helpers for Codex CLI-first layout.
 * Legacy OpenCode paths are retained only for migration compatibility.
 */

export function getCodexHomeDir(): string {
	const fromEnv = (process.env.CODEX_HOME ?? "").trim();
	return fromEnv.length > 0 ? fromEnv : join(homedir(), ".codex");
}

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

function getFallbackCodexHomeDirs(): string[] {
	return deduplicatePaths([
		getCodexHomeDir(),
		join(homedir(), "DevTools", "config", "codex"),
		join(homedir(), ".codex"),
	]);
}

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

export function getCodexCacheDir(): string {
	return join(getCodexMultiAuthDir(), "cache");
}

export function getCodexLogDir(): string {
	return join(getCodexMultiAuthDir(), "logs");
}

export function getLegacyOpenCodeDir(): string {
	return join(homedir(), ".opencode");
}
