import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CacheMetadata, GitHubRelease } from "../types.js";
import { logWarn, logError, logDebug } from "../logger.js";
import { fetchWithTimeoutAndRetry } from "../network.js";
import { getCodexCacheDir } from "../runtime-paths.js";

const GITHUB_API_RELEASES =
	"https://api.github.com/repos/openai/codex/releases/latest";
const GITHUB_HTML_RELEASES =
	"https://github.com/openai/codex/releases/latest";
const CACHE_DIR = getCodexCacheDir();
const CACHE_TTL_MS = 15 * 60 * 1000;
const GITHUB_FETCH_TIMEOUT_MS = 8_000;
const GITHUB_FETCH_RETRIES = 1;
const GITHUB_RETRYABLE_STATUSES = [429] as const;
const GITHUB_FETCH_RETRY_BASE_DELAY_MS = 20;
const GITHUB_FETCH_RETRY_MAX_DELAY_MS = 200;
const GITHUB_FETCH_RETRY_JITTER_MS = 10;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_CACHE_SIZE = 50;
const memoryCache = new Map<string, { content: string; timestamp: number }>();
const refreshPromises = new Map<ModelFamily, Promise<void>>();
const RELEASE_TAG_TTL_MS = 5 * 60 * 1000;
const PROMPT_FETCH_TIMEOUT_MS = 15_000;
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
export type ModelFamily =
	| "gpt-5-codex"
	| "codex-max"
	| "codex"
	| "gpt-5.2"
	| "gpt-5.1";

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
 * Determine the model family based on the normalized model name
 * @param normalizedModel - The normalized model name (e.g., "gpt-5-codex", "gpt-5.1-codex-max", "gpt-5.2", "gpt-5.1")
 * @returns The model family for prompt selection
 */
export function getModelFamily(normalizedModel: string): ModelFamily {
	if (normalizedModel.includes("codex-max")) {
		return "codex-max";
	}
	if (
		normalizedModel.includes("gpt-5-codex") ||
		normalizedModel.includes("gpt 5 codex") ||
		normalizedModel.includes("gpt-5.3-codex-spark") ||
		normalizedModel.includes("gpt 5.3 codex spark") ||
		normalizedModel.includes("gpt-5.3-codex") ||
		normalizedModel.includes("gpt 5.3 codex") ||
		normalizedModel.includes("gpt-5.2-codex") ||
		normalizedModel.includes("gpt 5.2 codex") ||
		normalizedModel.includes("gpt-5.1-codex") ||
		normalizedModel.includes("gpt 5.1 codex")
	) {
		return "gpt-5-codex";
	}
	if (
		normalizedModel.includes("codex") ||
		normalizedModel.startsWith("codex-")
	) {
		return "codex";
	}
	if (normalizedModel.includes("gpt-5.2")) {
		return "gpt-5.2";
	}
	return "gpt-5.1";
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
		const { response, attempts, durationMs } = await fetchWithTimeoutAndRetry(
			GITHUB_API_RELEASES,
			undefined,
			{
				timeoutMs: GITHUB_FETCH_TIMEOUT_MS,
				retries: GITHUB_FETCH_RETRIES,
				retryOnErrors: false,
				retryOnTimeout: false,
				retryOnStatuses: GITHUB_RETRYABLE_STATUSES,
				baseDelayMs: GITHUB_FETCH_RETRY_BASE_DELAY_MS,
				maxDelayMs: GITHUB_FETCH_RETRY_MAX_DELAY_MS,
				jitterMs: GITHUB_FETCH_RETRY_JITTER_MS,
				onRetry: (retry) => {
					logDebug("Retrying GitHub release API fetch", retry);
				},
			},
		);
		if (attempts > 1) {
			logDebug("Recovered GitHub release API fetch after retries", {
				attempts,
				durationMs,
			});
		}
		if (response.ok) {
			const data = (await response.json()) as GitHubRelease;
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

	const { response: htmlResponse, attempts: htmlAttempts, durationMs: htmlDurationMs } =
		await fetchWithTimeoutAndRetry(GITHUB_HTML_RELEASES, undefined, {
			timeoutMs: GITHUB_FETCH_TIMEOUT_MS,
			retries: GITHUB_FETCH_RETRIES,
			retryOnErrors: false,
			retryOnTimeout: false,
			retryOnStatuses: GITHUB_RETRYABLE_STATUSES,
			baseDelayMs: GITHUB_FETCH_RETRY_BASE_DELAY_MS,
			maxDelayMs: GITHUB_FETCH_RETRY_MAX_DELAY_MS,
			jitterMs: GITHUB_FETCH_RETRY_JITTER_MS,
			onRetry: (retry) => {
				logDebug("Retrying GitHub HTML release fetch", retry);
			},
		});
	if (htmlAttempts > 1) {
		logDebug("Recovered GitHub HTML release fetch after retries", {
			attempts: htmlAttempts,
			durationMs: htmlDurationMs,
		});
	}
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

	const html = await htmlResponse.text();
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
 * @param normalizedModel - The normalized model name (optional, defaults to "gpt-5-codex")
 * @returns Codex instructions for the specified model family
 */
export async function getCodexInstructions(
	normalizedModel = "gpt-5-codex",
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

	if (diskContent && cachedMetadata?.lastChecked) {
		if (now - cachedMetadata.lastChecked < CACHE_TTL_MS) {
			setCacheEntry(modelFamily, { content: diskContent, timestamp: now });
			return diskContent;
		}
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

		if (diskContent) {
			logWarn(`Using cached ${modelFamily} instructions`);
			setCacheEntry(modelFamily, { content: diskContent, timestamp: now });
			return diskContent;
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

	const { response, attempts, durationMs } = await fetchWithTimeoutAndRetry(
		instructionsUrl,
		{ headers },
		{
			timeoutMs: PROMPT_FETCH_TIMEOUT_MS,
			retries: GITHUB_FETCH_RETRIES,
			retryOnErrors: false,
			retryOnTimeout: false,
			retryOnStatuses: GITHUB_RETRYABLE_STATUSES,
			baseDelayMs: GITHUB_FETCH_RETRY_BASE_DELAY_MS,
			maxDelayMs: GITHUB_FETCH_RETRY_MAX_DELAY_MS,
			jitterMs: GITHUB_FETCH_RETRY_JITTER_MS,
			onRetry: (retry) => {
				logDebug("Retrying Codex prompt download", {
					url: instructionsUrl,
					...retry,
				});
			},
		},
	);
	if (attempts > 1) {
		logDebug("Recovered Codex prompt download after retries", {
			url: instructionsUrl,
			attempts,
			durationMs,
		});
	}
	if (response.status === 304) {
		const diskContent = await readFileOrNull(cacheFile);
		if (diskContent) {
			setCacheEntry(modelFamily, { content: diskContent, timestamp: Date.now() });
			await fs.mkdir(CACHE_DIR, { recursive: true });
			await fs.writeFile(
				cacheMetaFile,
				JSON.stringify(
					{
						etag: cachedETag,
						tag: latestTag,
						lastChecked: Date.now(),
						url: instructionsUrl,
					} satisfies CacheMetadata,
				),
				"utf8",
			);
			return diskContent;
		}
	}

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}

	const instructions = await response.text();
	const newETag = response.headers.get("etag");
	await fs.mkdir(CACHE_DIR, { recursive: true });
	await Promise.all([
		fs.writeFile(cacheFile, instructions, "utf8"),
		fs.writeFile(
			cacheMetaFile,
			JSON.stringify(
				{
					etag: newETag,
					tag: latestTag,
					lastChecked: Date.now(),
					url: instructionsUrl,
				} satisfies CacheMetadata,
			),
			"utf8",
		),
	]);
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
	const candidates = models.length > 0 ? models : ["gpt-5-codex", "gpt-5.2", "gpt-5.1"];
	for (const model of candidates) {
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
