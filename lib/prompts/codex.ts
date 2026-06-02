import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { CacheMetadata, GitHubRelease } from "../types.js";
import { logWarn, logError, logDebug } from "../logger.js";
import { getCodexCacheDir } from "../runtime-paths.js";
import { getModelProfile, type PromptModelFamily } from "../request/helpers/model-map.js";
import { fetchWithTimeout, readBodyTextGuarded, withBodyTimeout } from "./fetch-utils.js";
import { withFileOperationRetry } from "../fs-retry.js";

/** SHA-256 of cache content for integrity verification (prompts-03). */
function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Atomically write content + meta (prompts-06).
 *
 * The previous parallel writeFile of cacheFile and cacheMetaFile could tear:
 * a crash between them left content and meta (etag/sha) out of sync. Write each
 * to a temp sibling then rename, and write the content before the meta so the
 * meta's sha always describes a content file already on disk.
 *
 * Note on atomicity: this is a *two-rename* operation (content, then meta), not
 * a single atomic commit. If the second rename fails permanently the disk holds
 * new content with stale meta — which the next read self-heals via the sha256
 * integrity check (mismatch ⇒ discard + refetch). Each fs step is wrapped in
 * withFileOperationRetry so a transient Windows EBUSY/EPERM/ENOTEMPTY/EACCES
 * from antivirus, the file indexer, or a concurrent reader is retried with
 * backoff instead of turning a successful fetch into a cache-write failure.
 */
async function writeCacheAtomically(
	cacheFile: string,
	cacheMetaFile: string,
	content: string,
	meta: CacheMetadata,
): Promise<void> {
	await withFileOperationRetry(() => fs.mkdir(CACHE_DIR, { recursive: true }));
	const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const contentTmp = `${cacheFile}.${nonce}.tmp`;
	const metaTmp = `${cacheMetaFile}.${nonce}.tmp`;
	try {
		await withFileOperationRetry(() =>
			fs.writeFile(contentTmp, content, { encoding: "utf8" }),
		);
		await withFileOperationRetry(() =>
			fs.writeFile(metaTmp, JSON.stringify(meta), { encoding: "utf8" }),
		);
		await withFileOperationRetry(() => fs.rename(contentTmp, cacheFile));
		await withFileOperationRetry(() => fs.rename(metaTmp, cacheMetaFile));
	} finally {
		// Route cleanup through withFileOperationRetry too: a transient Windows
		// EBUSY/EPERM/ENOTEMPTY/EACCES from antivirus/the indexer/a concurrent
		// reader on the temp sibling would otherwise leak a *.tmp file. force:true
		// keeps ENOENT (already-renamed) a no-op; the catch swallows a persistent
		// failure so cleanup never masks a successful write.
		await withFileOperationRetry(() => fs.rm(contentTmp, { force: true })).catch(
			() => undefined,
		);
		await withFileOperationRetry(() => fs.rm(metaTmp, { force: true })).catch(
			() => undefined,
		);
	}
}

const GITHUB_API_RELEASES =
	"https://api.github.com/repos/openai/codex/releases/latest";
const GITHUB_HTML_RELEASES =
	"https://github.com/openai/codex/releases/latest";
const CACHE_DIR = getCodexCacheDir();
const CACHE_TTL_MS = 15 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_CACHE_SIZE = 50;
const memoryCache = new Map<string, { content: string; timestamp: number }>();
const refreshPromises = new Map<ModelFamily, Promise<void>>();
const RELEASE_TAG_TTL_MS = 5 * 60 * 1000;
let latestReleaseTagCache: { tag: string; checkedAt: number } | null = null;

/**
 * Clear the memory cache - exposed for testing
 * @internal
 */
export function __clearCacheForTesting(): void {
	memoryCache.clear();
	refreshPromises.clear();
	latestReleaseTagCache = null;
}

function setCacheEntry(key: string, value: { content: string; timestamp: number }): void {
	if (memoryCache.size >= MAX_CACHE_SIZE && !memoryCache.has(key)) {
		const firstKey = memoryCache.keys().next().value;
		// istanbul ignore next -- defensive: firstKey always exists when size >= MAX_CACHE_SIZE
		if (firstKey) memoryCache.delete(firstKey);
	}
	memoryCache.set(key, value);
}

/**
 * Model family type for prompt selection
 * Maps to different system prompts in the Codex CLI
 */
export type ModelFamily = PromptModelFamily;

/**
 * All supported model families
 * Used for per-family account rotation and rate limit tracking
 */
export const MODEL_FAMILIES: readonly ModelFamily[] = [
	"gpt-5-codex",
	"codex-max",
	"codex",
	"gpt-5.2",
	"gpt-5.1",
] as const;

/**
 * Prompt file mapping for each model family
 * Based on codex-rs/core/src/model_family.rs logic
 */
const PROMPT_FILES: Record<ModelFamily, string> = {
	"gpt-5-codex": "gpt_5_codex_prompt.md",
	"codex-max": "gpt-5.1-codex-max_prompt.md",
	codex: "gpt_5_codex_prompt.md",
	"gpt-5.2": "gpt_5_2_prompt.md",
	"gpt-5.1": "gpt_5_1_prompt.md",
};

/**
 * Cache file mapping for each model family
 */
const CACHE_FILES: Record<ModelFamily, string> = {
	"gpt-5-codex": "gpt-5-codex-instructions.md",
	"codex-max": "codex-max-instructions.md",
	codex: "codex-instructions.md",
	"gpt-5.2": "gpt-5.2-instructions.md",
	"gpt-5.1": "gpt-5.1-instructions.md",
};

/**
 * Determine the prompt family based on the effective model name.
 *
 * GPT-5.4/5.5-era general-purpose models intentionally stay on the GPT-5.2
 * prompt family until upstream Codex releases a newer general prompt file.
 *
 * @param normalizedModel - The normalized model name (e.g., "gpt-5-codex", "gpt-5.4", "gpt-5-mini")
 * @returns The model family for prompt selection
 */
export function getModelFamily(normalizedModel: string): ModelFamily {
	return getModelProfile(normalizedModel).promptFamily;
}

async function readFileOrNull(path: string): Promise<string | null> {
	try {
		return await fs.readFile(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Get the latest release tag from GitHub
 * @returns Release tag name (e.g., "rust-v0.43.0")
 */
async function getLatestReleaseTag(): Promise<string> {
	if (
		latestReleaseTagCache &&
		Date.now() - latestReleaseTagCache.checkedAt < RELEASE_TAG_TTL_MS
	) {
		return latestReleaseTagCache.tag;
	}

	try {
		const response = await fetchWithTimeout(GITHUB_API_RELEASES, { json: true });
		if (response.ok) {
			// Guard the body read: the fetch AbortSignal only covers connect+headers
			// (see fetch-utils), so a release API response that stalls mid-body would
			// otherwise hang getLatestReleaseTag() indefinitely on this blocking path.
			const data = (await withBodyTimeout(response, response.json())) as GitHubRelease;
			if (data.tag_name) {
				latestReleaseTagCache = {
					tag: data.tag_name,
					checkedAt: Date.now(),
				};
				return data.tag_name;
			}
		}
	} catch {
		// Fall through to HTML fallback
	}

	const htmlResponse = await fetchWithTimeout(GITHUB_HTML_RELEASES);
	if (!htmlResponse.ok) {
		throw new Error(
			`Failed to fetch latest release: ${htmlResponse.status}`,
		);
	}

	const finalUrl = htmlResponse.url;
	if (finalUrl) {
		const parts = finalUrl.split("/tag/");
		const last = parts[parts.length - 1];
		if (last && !last.includes("/")) {
			latestReleaseTagCache = {
				tag: last,
				checkedAt: Date.now(),
			};
			return last;
		}
	}

	// Same mid-body-stall guard as the JSON path above for the HTML fallback.
	const html = await withBodyTimeout(htmlResponse, htmlResponse.text());
	const match = html.match(/\/openai\/codex\/releases\/tag\/([^"]+)/);
	if (match && match[1]) {
		const tag = match[1];
		latestReleaseTagCache = {
			tag,
			checkedAt: Date.now(),
		};
		return tag;
	}

	throw new Error("Failed to determine latest release tag from GitHub");
}

/**
 * Fetch Codex instructions from GitHub with ETag-based caching
 * Uses HTTP conditional requests to efficiently check for updates
 * Always fetches from the latest release tag, not main branch
 *
 * Rate limit protection: Only checks GitHub if cache is older than 15 minutes
 *
 * @param normalizedModel - The normalized model name (optional, defaults to "gpt-5.3-codex")
 * @returns Codex instructions for the specified model family
 */
export async function getCodexInstructions(
	normalizedModel = "gpt-5.3-codex",
): Promise<string> {
	const modelFamily = getModelFamily(normalizedModel);
	const now = Date.now();
	const cached = memoryCache.get(modelFamily);
	if (cached && now - cached.timestamp < CACHE_TTL_MS) {
		return cached.content;
	}

	const promptFile = PROMPT_FILES[modelFamily];
	const cacheFile = join(CACHE_DIR, CACHE_FILES[modelFamily]);
	const cacheMetaFile = join(
		CACHE_DIR,
		`${CACHE_FILES[modelFamily].replace(".md", "-meta.json")}`,
	);

	let cachedMetadata: CacheMetadata | null = null;
	const [metaContent, diskContent] = await Promise.all([
		readFileOrNull(cacheMetaFile),
		readFileOrNull(cacheFile),
	]);

	if (metaContent) {
		try {
			cachedMetadata = JSON.parse(metaContent) as CacheMetadata;
		} catch {
			cachedMetadata = null;
		}
	}

	// prompts-03: once we know the disk content fails its sha256, it must not be
	// trusted anywhere downstream — not served, not used as the 304 revalidation
	// body, and not used as the offline fallback in the catch below. Track a
	// "usable" view of the disk content separate from the raw read.
	let usableDiskContent = diskContent;

	if (diskContent && cachedMetadata?.lastChecked) {
		// prompts-03: a sha256 mismatch means a corrupted/tampered cache — discard it
		// everywhere (not served, not the 304 body, not the offline fallback). A
		// MISSING sha (pre-upgrade legacy cache) is merely *unverified*: it must not
		// be fast-path served and must not drive conditional revalidation (a 304
		// would mint a fresh digest over un-vetted bytes), so we force one full 200
		// fetch to establish trust — but we keep the old bytes as an offline fallback
		// in case that fetch fails.
		const priorSha = cachedMetadata.sha256;
		if (!priorSha) {
			// Unverified legacy entry: clear meta so no If-None-Match is sent and the
			// cache isn't served as-is; retain usableDiskContent for offline fallback.
			cachedMetadata = null;
		} else if (priorSha !== sha256(diskContent)) {
			logWarn(`Discarding corrupt prompt cache for ${modelFamily} (sha256 mismatch)`);
			// Force a full refetch: drop the corrupt body so it cannot be served or
			// used as the catch fallback, and clear the cached metadata so no
			// If-None-Match is sent (a 304 would otherwise re-serve and re-bless the
			// exact corrupt content this check is meant to reject).
			usableDiskContent = null;
			cachedMetadata = null;
		} else if (now - cachedMetadata.lastChecked < CACHE_TTL_MS) {
			setCacheEntry(modelFamily, { content: diskContent, timestamp: now });
			return diskContent;
		} else {
			// Stale-while-revalidate: return stale cache immediately and refresh in background.
			setCacheEntry(modelFamily, { content: diskContent, timestamp: now });
			void refreshInstructionsInBackground(
				modelFamily,
				promptFile,
				cacheFile,
				cacheMetaFile,
				cachedMetadata,
			);
			return diskContent;
		}
	}

	if (cached && now - cached.timestamp >= CACHE_TTL_MS) {
		// Keep session latency stable by serving stale memory cache while refreshing.
		setCacheEntry(modelFamily, { content: cached.content, timestamp: now });
		void refreshInstructionsInBackground(
			modelFamily,
			promptFile,
			cacheFile,
			cacheMetaFile,
			cachedMetadata,
		);
		return cached.content;
	}

	try {
		return await fetchAndPersistInstructions(
			modelFamily,
			promptFile,
			cacheFile,
			cacheMetaFile,
			cachedMetadata,
		);
	} catch (error) {
		const err = error as Error;
		logError(
			`Failed to fetch ${modelFamily} instructions from GitHub: ${err.message}`,
		);

		if (usableDiskContent) {
			logWarn(`Using cached ${modelFamily} instructions`);
			setCacheEntry(modelFamily, { content: usableDiskContent, timestamp: now });
			return usableDiskContent;
		}

		logWarn(`Falling back to bundled instructions for ${modelFamily}`);
		const bundled = await fs.readFile(
			join(__dirname, "codex-instructions.md"),
			"utf8",
		);
		setCacheEntry(modelFamily, { content: bundled, timestamp: now });
		return bundled;
	}
}

async function fetchAndPersistInstructions(
	modelFamily: ModelFamily,
	promptFile: string,
	cacheFile: string,
	cacheMetaFile: string,
	cachedMetadata: CacheMetadata | null,
): Promise<string> {
	let cachedETag = cachedMetadata?.etag ?? null;
	const cachedTag = cachedMetadata?.tag ?? null;
	const latestTag = await getLatestReleaseTag();
	const instructionsUrl = `https://raw.githubusercontent.com/openai/codex/${latestTag}/codex-rs/core/${promptFile}`;

	if (cachedTag !== latestTag) {
		cachedETag = null;
	}

	const headers: Record<string, string> = {};
	if (cachedETag) {
		headers["If-None-Match"] = cachedETag;
	}

	const response = await fetchWithTimeout(instructionsUrl, { headers });
	// A 304 is only meaningful if we actually sent a conditional request. When the
	// caller cleared the metadata (e.g. an sha256 mismatch forced a full refetch),
	// cachedETag is null and no If-None-Match was sent, so a 304 here cannot be
	// trusted to describe our disk content — fall through to the error path rather
	// than re-serving (and re-blessing) whatever is on disk.
	if (response.status === 304 && cachedETag) {
		const diskContent = await readFileOrNull(cacheFile);
		// Only re-serve the disk content if it still matches the integrity hash we
		// had on record. Recomputing and trusting the hash unconditionally would
		// launder tampered bytes; verifying against the prior sha closes that.
		const priorSha = cachedMetadata?.sha256;
		// Require a prior sha to trust a 304: without one the on-disk bytes are
		// unverified, so re-serving them and minting a fresh digest would launder
		// un-vetted content. A missing sha forces the full-fetch path below.
		const diskIntegrityOk =
			diskContent !== null && !!priorSha && priorSha === sha256(diskContent);
		if (diskContent && diskIntegrityOk) {
			setCacheEntry(modelFamily, { content: diskContent, timestamp: Date.now() });
			// Refresh the meta (lastChecked) atomically and re-affirm the content sha
			// so a 304 keeps the integrity record in sync with the on-disk content.
			await writeCacheAtomically(cacheFile, cacheMetaFile, diskContent, {
				etag: cachedETag,
				tag: latestTag,
				lastChecked: Date.now(),
				url: instructionsUrl,
				sha256: sha256(diskContent),
			});
			return diskContent;
		}
		// 304 but the disk content is missing or fails its integrity check: treat as
		// a fetch failure so the caller falls back to bundled instructions.
		throw new Error("304 revalidation failed integrity check");
	}

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}

	// Size-cap + reject empty bodies (prompts-04/05) before caching/serving.
	const instructions = await readBodyTextGuarded(response);
	const newETag = response.headers.get("etag");
	// prompts-03/06: write content + meta atomically with a content sha256 so the
	// cache cannot tear and can be integrity-checked on the next read.
	await writeCacheAtomically(cacheFile, cacheMetaFile, instructions, {
		etag: newETag,
		tag: latestTag,
		lastChecked: Date.now(),
		url: instructionsUrl,
		sha256: sha256(instructions),
	});
	setCacheEntry(modelFamily, { content: instructions, timestamp: Date.now() });
	return instructions;
}

function refreshInstructionsInBackground(
	modelFamily: ModelFamily,
	promptFile: string,
	cacheFile: string,
	cacheMetaFile: string,
	cachedMetadata: CacheMetadata | null,
): Promise<void> {
	const existing = refreshPromises.get(modelFamily);
	if (existing) return existing;

	const refreshPromise = fetchAndPersistInstructions(
		modelFamily,
		promptFile,
		cacheFile,
		cacheMetaFile,
		cachedMetadata,
	)
		.then(() => undefined)
		.catch((error) => {
			logDebug(`Background prompt refresh failed for ${modelFamily}`, {
				error: String(error),
			});
		})
		.finally(() => {
			refreshPromises.delete(modelFamily);
		});

	refreshPromises.set(modelFamily, refreshPromise);
	return refreshPromise;
}

/**
 * Prewarm instruction caches for the provided models/families.
 */
export function prewarmCodexInstructions(models: string[] = []): void {
	const candidates = models.length > 0 ? models : ["gpt-5.3-codex", "gpt-5.5", "gpt-5.1"];
	const prewarmTargets = new Map<string, string>();
	for (const model of candidates) {
		const promptFamily = getModelFamily(model);
		if (!prewarmTargets.has(promptFamily)) {
			prewarmTargets.set(promptFamily, model);
		}
	}
	for (const model of prewarmTargets.values()) {
		void getCodexInstructions(model).catch((error) => {
			logDebug("Codex instruction prewarm failed", {
				model,
				error: String(error),
			});
		});
	}
}

/**
 * Tool remapping instructions for host runtime tools
 */
export const TOOL_REMAP_MESSAGE = `<user_instructions priority="0">
<environment_override priority="0">
YOU ARE IN A DIFFERENT ENVIRONMENT. These instructions override ALL previous tool references.
</environment_override>

<tool_replacements priority="0">
<critical_rule priority="0">
apply_patch/applyPatch are Codex names, but host tool names vary by version.
- Inspect the actual tool list before editing.
- If edit exists: use edit for precise in-place string replacements and hashline edits.
- If edit is absent and apply_patch exists: use apply_patch for those precise/hashline edits in this plugin.
- For diff-style or multi-line structural edits: use patch if available, otherwise use apply_patch.
- In this plugin, edit/apply_patch support hashline refs (lineRef, endLineRef, operation, content)
</critical_rule>

<critical_rule priority="0">
UPDATE_PLAN DOES NOT EXIST -> USE "todowrite" INSTEAD
- NEVER use: update_plan, updatePlan
- ALWAYS use: todowrite for ALL task/plan operations
- Use todoread to read current plan
- Before plan operations: Verify you're using "todowrite", NOT "update_plan"
</critical_rule>
</tool_replacements>

<available_tools priority="0">
File Operations:
  - write  - Create new files (if available)
  - edit   - Modify existing files with string replacement (version-dependent)
  - oldString must be literal text from the current file; never pass unresolved placeholders like \${TARGET_SNIPPET}
  - apply_patch - May be the edit/patch tool name in newer host builds (version-dependent)
  - hashline_read - Read lines with hashline refs (L<line>#<hash>) for deterministic edits
  - patch  - Apply diff patches (version-dependent)
  - read   - Read file contents

Search/Discovery:
  - grep   - Search file contents
  - glob   - Find files by pattern
  - list   - List directories (if available)

Execution:
  - bash   - Run shell commands

Network:
  - webfetch - Fetch web content

Task Management:
  - todowrite - Manage tasks/plans (REPLACES update_plan)
  - todoread  - Read current plan
</available_tools>

<substitution_rules priority="0">
Base instruction says:    You MUST use instead:
apply_patch           ->   patch (preferred if available), otherwise edit/apply_patch based on actual tool list
update_plan           ->   todowrite
read_plan             ->   todoread
absolute paths        ->   relative paths
</substitution_rules>

<verification_checklist priority="0">
Before file/plan modifications:
1. Am I using the actual available edit tool name (edit, patch, or apply_patch)?
2. Am I using "todowrite" NOT "update_plan"?
3. Is this tool in the approved list above?
4. Am I using relative paths?

If ANY answer is NO -> STOP and correct before proceeding.
</verification_checklist>

<hashline_workflow priority="0">
When hashline_read is available:
1. call hashline_read on the file
2. edit/apply_patch using lineRef/endLineRef + operation + content
3. use oldString/newString only as fallback, and only with literal file text (no template placeholders)
</hashline_workflow>

<safety_rules priority="0">
- Never run destructive git commands (\`git reset --hard\`, \`git checkout --\`) unless explicitly requested by the user.
- Never call \`request_user_input\` unless collaboration mode is explicitly Plan mode.
</safety_rules>
</user_instructions>`;
