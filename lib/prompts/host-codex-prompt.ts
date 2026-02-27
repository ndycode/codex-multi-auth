/**
 * Codex Prompt Fetcher
 *
 * Fetches and caches the codex.txt system prompt from upstream GitHub sources.
 * Uses ETag-based caching to efficiently track updates.
 */

import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { logDebug } from "../logger.js";
import { getCodexCacheDir } from "../runtime-paths.js";
import { sleep } from "../utils.js";

const DEFAULT_HOST_CODEX_PROMPT_URLS = [
	"https://raw.githubusercontent.com/anomalyco/Codex/dev/packages/Codex/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/sst/Codex/dev/packages/Codex/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/anomalyco/Codex/main/packages/Codex/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/sst/Codex/main/packages/Codex/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/anomalyco/Codex/dev/packages/Codex/src/session/prompt/codex.md",
	"https://raw.githubusercontent.com/sst/Codex/dev/packages/Codex/src/session/prompt/codex.md",
	"https://raw.githubusercontent.com/anomalyco/Codex/main/packages/Codex/src/session/prompt/codex.md",
	"https://raw.githubusercontent.com/sst/Codex/main/packages/Codex/src/session/prompt/codex.md",
] as const;
const CODEX_PROMPT_URL_OVERRIDE_ENV = "CODEX_PROMPT_SOURCE_URL";
const LEGACY_HOST_CODEX_URL_OVERRIDE_ENV = "CODEX_CODEX_PROMPT_URL";
const CACHE_DIR = getCodexCacheDir();
const CACHE_FILE = join(CACHE_DIR, "host-codex-prompt.txt");
const CACHE_META_FILE = join(CACHE_DIR, "host-codex-prompt-meta.json");
const LEGACY_CACHE_FILES: ReadonlyArray<{ content: string; meta: string }> = [
	{
		content: join(CACHE_DIR, "opencode-codex-prompt.txt"),
		meta: join(CACHE_DIR, "opencode-codex-prompt-meta.json"),
	},
	{
		content: join(CACHE_DIR, "codex-prompt.txt"),
		meta: join(CACHE_DIR, "codex-prompt-meta.json"),
	},
];
const CACHE_TTL_MS = 15 * 60 * 1000;
const RETRYABLE_FS_ERROR_CODES = new Set(["EBUSY", "EPERM"]);
const WRITE_RETRY_ATTEMPTS = 5;
const WRITE_RETRY_BASE_DELAY_MS = 10;

interface CacheMeta {
	etag: string;
	lastFetch?: string; // Legacy field for backwards compatibility
	lastChecked: number; // Timestamp for rate limit protection
	sourceKey?: string;
	sourceUrl?: string; // Legacy field kept for compatibility reads.
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

function redactSourceForLog(source: string): string {
	try {
		const parsed = new URL(source);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "<invalid-url>";
	}
}

function parseSourceUrl(source: string | undefined): string | undefined {
	if (!source) return undefined;
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			logDebug("Ignoring codex prompt source override due to protocol", {
				source: redactSourceForLog(trimmed),
			});
			return undefined;
		}
		return trimmed;
	} catch {
		logDebug("Ignoring invalid codex prompt source override", {
			source: redactSourceForLog(trimmed),
		});
		return undefined;
	}
}

function sourceCacheKey(source: string): string {
	try {
		const parsed = new URL(source);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return source.trim();
	}
}

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_ERROR_CODES.has(code);
}

async function writeFileWithRetry(filePath: string, content: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < WRITE_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await writeFile(filePath, content, "utf-8");
			return;
		} catch (error) {
			if (!isRetryableFsError(error) || attempt + 1 >= WRITE_RETRY_ATTEMPTS) {
				throw error;
			}
			lastError = error;
			await sleep(WRITE_RETRY_BASE_DELAY_MS * 2 ** attempt);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Failed to write prompt cache file");
}

function resolvePromptSources(): string[] {
	const sources: string[] = [];
	const seen = new Set<string>();

	const add = (source: string | undefined) => {
		const parsed = parseSourceUrl(source);
		if (!parsed || seen.has(parsed)) return;
		seen.add(parsed);
		sources.push(parsed);
	};

	add(process.env[CODEX_PROMPT_URL_OVERRIDE_ENV]);
	add(process.env[LEGACY_HOST_CODEX_URL_OVERRIDE_ENV]);
	for (const source of DEFAULT_HOST_CODEX_PROMPT_URLS) {
		add(source);
	}
	return sources;
}

async function readDiskCache(): Promise<CacheSnapshot | null> {
	const tryRead = async (contentPath: string, metaPath: string): Promise<CacheSnapshot | null> => {
		try {
			const [content, metaContent] = await Promise.all([
				readFile(contentPath, "utf-8"),
				readFile(metaPath, "utf-8"),
			]);
			const meta = JSON.parse(metaContent) as CacheMeta;
			if (!meta.lastChecked) {
				return null;
			}
			return { content, meta };
		} catch {
			return null;
		}
	};

	const currentCache = await tryRead(CACHE_FILE, CACHE_META_FILE);
	if (currentCache) {
		return currentCache;
	}

	for (const legacy of LEGACY_CACHE_FILES) {
		const legacyCache = await tryRead(legacy.content, legacy.meta);
		if (!legacyCache) continue;
		await mkdir(CACHE_DIR, { recursive: true });
		await Promise.all([
			writeFileWithRetry(CACHE_FILE, legacyCache.content),
			writeFileWithRetry(CACHE_META_FILE, JSON.stringify(legacyCache.meta, null, 2)),
		]);
		return legacyCache;
	}

	return null;
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
		sourceKey: sourceCacheKey(sourceUrl),
	};
	await Promise.all([
		writeFileWithRetry(CACHE_FILE, content),
		writeFileWithRetry(CACHE_META_FILE, JSON.stringify(meta, null, 2)),
	]);
	return meta;
}

async function refreshPrompt(
	cachedMeta: CacheMeta | null,
	cachedContent: string | null,
): Promise<string> {
	const sources = resolvePromptSources();
	let lastFailure: string | null = null;

	for (const sourceUrl of sources) {
		const headers: Record<string, string> = {};
		const currentSourceKey = sourceCacheKey(sourceUrl);
		const cachedSourceKey = cachedMeta?.sourceKey ??
			(cachedMeta?.sourceUrl ? sourceCacheKey(cachedMeta.sourceUrl) : undefined);
		const canUseConditionalRequest =
			!!cachedMeta?.etag &&
			(!cachedSourceKey || cachedSourceKey === currentSourceKey);
		if (canUseConditionalRequest) {
			headers["If-None-Match"] = cachedMeta.etag;
		}

		let response: Response;
		try {
			response = await fetch(sourceUrl, { headers });
		} catch (error) {
			lastFailure = `${redactSourceForLog(sourceUrl)}: ${String(error)}`;
			logDebug("Codex prompt source fetch failed", {
				sourceUrl: redactSourceForLog(sourceUrl),
				error: String(error),
			});
			continue;
		}

		if (response.status === 304 && cachedContent) {
			const refreshedMeta: CacheMeta = {
				etag: cachedMeta?.etag ?? "",
				lastFetch: cachedMeta?.lastFetch ?? new Date().toISOString(),
				lastChecked: Date.now(),
				sourceKey: currentSourceKey,
			};
			memoryCache = { content: cachedContent, meta: refreshedMeta };
			await mkdir(CACHE_DIR, { recursive: true });
			await writeFileWithRetry(CACHE_META_FILE, JSON.stringify(refreshedMeta, null, 2));
			return cachedContent;
		}

		if (!response.ok) {
			lastFailure = `${redactSourceForLog(sourceUrl)}: HTTP ${response.status}`;
			logDebug("Codex prompt source returned non-OK response", {
				sourceUrl: redactSourceForLog(sourceUrl),
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
		`Failed to fetch codex prompt from all sources${lastFailure ? ` (${lastFailure})` : ""}`,
	);
}

function scheduleRefresh(cachedMeta: CacheMeta | null, cachedContent: string | null): void {
	if (refreshPromise) return;
	refreshPromise = refreshPrompt(cachedMeta, cachedContent)
		.then(() => undefined)
		.catch((error) => {
			logDebug("Codex prompt background refresh failed", {
				error: String(error),
			});
		})
		.finally(() => {
			refreshPromise = null;
		});
}

/**
 * Fetch codex.txt prompt with ETag-based caching
 * Uses HTTP conditional requests to efficiently check for updates
 *
 * Rate limit protection: Only checks GitHub if cache is older than 15 minutes
 * @returns The codex.txt content
 */
export async function getHostCodexPrompt(): Promise<string> {
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
			`Failed to fetch codex.txt and no cache available: ${error}`,
		);
	}
}

/**
 * Get first N characters of the cached prompt for verification
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
 * Prewarm the prompt cache without blocking startup.
 */
export function prewarmHostCodexPrompt(): void {
	void getHostCodexPrompt().catch((error) => {
		logDebug("Codex prompt prewarm failed", { error: String(error) });
	});
}



