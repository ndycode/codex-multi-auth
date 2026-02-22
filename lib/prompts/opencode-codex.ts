/**
 * OpenCode Codex Prompt Fetcher
 *
 * Fetches and caches the codex.txt system prompt from OpenCode's GitHub repository.
 * Uses ETag-based caching to efficiently track updates.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { logDebug } from "../logger.js";

const DEFAULT_OPENCODE_CODEX_URLS = [
	"https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/anomalyco/opencode/main/packages/opencode/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/sst/opencode/main/packages/opencode/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.md",
	"https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/session/prompt/codex.md",
	"https://raw.githubusercontent.com/anomalyco/opencode/main/packages/opencode/src/session/prompt/codex.md",
	"https://raw.githubusercontent.com/sst/opencode/main/packages/opencode/src/session/prompt/codex.md",
] as const;
const OPENCODE_CODEX_URL_OVERRIDE_ENV = "OPENCODE_CODEX_PROMPT_URL";
const CACHE_DIR = join(homedir(), ".opencode", "cache");
const CACHE_FILE = join(CACHE_DIR, "opencode-codex.txt");
const CACHE_META_FILE = join(CACHE_DIR, "opencode-codex-meta.json");
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheMeta {
	etag: string;
	lastFetch?: string; // Legacy field for backwards compatibility
	lastChecked: number; // Timestamp for rate limit protection
	sourceUrl?: string;
}

interface CacheSnapshot {
	content: string;
	meta: CacheMeta;
}

let memoryCache: CacheSnapshot | null = null;
let refreshPromise: Promise<void> | null = null;

function isFresh(lastChecked: number): boolean {
	return Date.now() - lastChecked < CACHE_TTL_MS;
}

function parseSourceUrl(source: string | undefined): string | undefined {
	if (!source) return undefined;
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			logDebug("Ignoring OpenCode codex prompt source override due to protocol", {
				source: trimmed,
			});
			return undefined;
		}
		return trimmed;
	} catch {
		logDebug("Ignoring invalid OpenCode codex prompt source override", {
			source: trimmed,
		});
		return undefined;
	}
}

function resolvePromptSources(cachedMeta: CacheMeta | null): string[] {
	const sources: string[] = [];
	const seen = new Set<string>();

	const add = (source: string | undefined) => {
		const parsed = parseSourceUrl(source);
		if (!parsed || seen.has(parsed)) return;
		seen.add(parsed);
		sources.push(parsed);
	};

	add(process.env[OPENCODE_CODEX_URL_OVERRIDE_ENV]);
	add(cachedMeta?.sourceUrl);
	for (const source of DEFAULT_OPENCODE_CODEX_URLS) {
		add(source);
	}
	return sources;
}

async function readDiskCache(): Promise<CacheSnapshot | null> {
	try {
		const [content, metaContent] = await Promise.all([
			readFile(CACHE_FILE, "utf-8"),
			readFile(CACHE_META_FILE, "utf-8"),
		]);
		const meta = JSON.parse(metaContent) as CacheMeta;
		if (!meta.lastChecked) {
			return null;
		}
		return { content, meta };
	} catch {
		return null;
	}
}

async function saveDiskCache(
	content: string,
	etag: string,
	sourceUrl: string,
): Promise<CacheMeta> {
	await mkdir(CACHE_DIR, { recursive: true });
	const meta: CacheMeta = {
		etag,
		lastFetch: new Date().toISOString(),
		lastChecked: Date.now(),
		sourceUrl,
	};
	await Promise.all([
		writeFile(CACHE_FILE, content, "utf-8"),
		writeFile(CACHE_META_FILE, JSON.stringify(meta, null, 2), "utf-8"),
	]);
	return meta;
}

async function refreshPrompt(
	cachedMeta: CacheMeta | null,
	cachedContent: string | null,
): Promise<string> {
	const sources = resolvePromptSources(cachedMeta);
	let lastFailure: string | null = null;

	for (const sourceUrl of sources) {
		const headers: Record<string, string> = {};
		const canUseConditionalRequest =
			!!cachedMeta?.etag &&
			(!cachedMeta.sourceUrl || cachedMeta.sourceUrl === sourceUrl);
		if (canUseConditionalRequest) {
			headers["If-None-Match"] = cachedMeta.etag;
		}

		let response: Response;
		try {
			response = await fetch(sourceUrl, { headers });
		} catch (error) {
			lastFailure = `${sourceUrl}: ${String(error)}`;
			logDebug("OpenCode prompt source fetch failed", {
				sourceUrl,
				error: String(error),
			});
			continue;
		}

		if (response.status === 304 && cachedContent) {
			const refreshedMeta: CacheMeta = {
				etag: cachedMeta?.etag ?? "",
				lastFetch: cachedMeta?.lastFetch ?? new Date().toISOString(),
				lastChecked: Date.now(),
				sourceUrl,
			};
			memoryCache = { content: cachedContent, meta: refreshedMeta };
			await mkdir(CACHE_DIR, { recursive: true });
			await writeFile(
				CACHE_META_FILE,
				JSON.stringify(refreshedMeta, null, 2),
				"utf-8",
			);
			return cachedContent;
		}

		if (!response.ok) {
			lastFailure = `${sourceUrl}: HTTP ${response.status}`;
			logDebug("OpenCode prompt source returned non-OK response", {
				sourceUrl,
				status: response.status,
			});
			continue;
		}

		const content = await response.text();
		const etag = response.headers.get("etag") || "";
		const meta = await saveDiskCache(content, etag, sourceUrl);
		memoryCache = { content, meta };
		return content;
	}

	throw new Error(
		`Failed to fetch OpenCode codex prompt from all sources${lastFailure ? ` (${lastFailure})` : ""}`,
	);
}

function scheduleRefresh(cachedMeta: CacheMeta | null, cachedContent: string | null): void {
	if (refreshPromise) return;
	refreshPromise = refreshPrompt(cachedMeta, cachedContent)
		.then(() => undefined)
		.catch((error) => {
			logDebug("OpenCode prompt background refresh failed", {
				error: String(error),
			});
		})
		.finally(() => {
			refreshPromise = null;
		});
}

/**
 * Fetch OpenCode's codex.txt prompt with ETag-based caching
 * Uses HTTP conditional requests to efficiently check for updates
 *
 * Rate limit protection: Only checks GitHub if cache is older than 15 minutes
 * @returns The codex.txt content
 */
export async function getOpenCodeCodexPrompt(): Promise<string> {
	if (memoryCache && isFresh(memoryCache.meta.lastChecked)) {
		return memoryCache.content;
	}

	const diskCache = await readDiskCache();
	if (diskCache) {
		memoryCache = diskCache;
		if (isFresh(diskCache.meta.lastChecked)) {
			return diskCache.content;
		}
		// Serve stale content immediately and refresh in the background.
		memoryCache = {
			content: diskCache.content,
			meta: { ...diskCache.meta, lastChecked: Date.now() },
		};
		scheduleRefresh(diskCache.meta, diskCache.content);
		return diskCache.content;
	}

	try {
		return await refreshPrompt(memoryCache?.meta ?? null, memoryCache?.content ?? null);
	} catch (error) {
		const staleContent = memoryCache?.content;
		if (staleContent) {
			return staleContent;
		}
		throw new Error(
			`Failed to fetch OpenCode codex.txt and no cache available: ${error}`,
		);
	}
}

/**
 * Get first N characters of the cached OpenCode prompt for verification
 * @param chars Number of characters to get (default: 50)
 * @returns First N characters or null if not cached
 */
export async function getCachedPromptPrefix(chars = 50): Promise<string | null> {
	try {
		const content = await readFile(CACHE_FILE, "utf-8");
		return content.substring(0, chars);
	} catch {
		return null;
	}
}

/**
 * Prewarm the OpenCode prompt cache without blocking startup.
 */
export function prewarmOpenCodeCodexPrompt(): void {
	void getOpenCodeCodexPrompt().catch((error) => {
		logDebug("OpenCode prompt prewarm failed", { error: String(error) });
	});
}
