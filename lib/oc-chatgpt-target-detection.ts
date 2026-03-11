import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, relative, resolve, sep, win32 } from "node:path";
import {
	findProjectRoot,
	getProjectStorageKey,
	resolveProjectStorageIdentityRoot,
} from "./storage/paths.js";

const ACCOUNT_FILE_NAME = "openai-codex-accounts.json";
const BACKUPS_DIR_NAME = "backups";
const PROJECTS_DIR_NAME = "projects";
const CANONICAL_HOME_BASENAME = ".opencode";

type OcChatgptTargetScope = "global" | "project";

type OcChatgptTargetSource = "explicit" | "default-global" | "project";

type OcChatgptTargetCandidate = {
	scope: OcChatgptTargetScope;
	source: OcChatgptTargetSource;
	root: string;
	accountPath: string;
	backupRoot: string;
	hasAccountArtifacts: boolean;
	hasSignals: boolean;
};

export type OcChatgptTargetDescriptor = {
	scope: OcChatgptTargetScope;
	root: string;
	accountPath: string;
	backupRoot: string;
	source: OcChatgptTargetSource;
	resolution: "accounts" | "signals";
};

export type OcChatgptTargetAmbiguous = {
	kind: "ambiguous";
	reason: string;
	candidates: Array<
		Pick<
			OcChatgptTargetCandidate,
			| "scope"
			| "root"
			| "accountPath"
			| "backupRoot"
			| "source"
			| "hasAccountArtifacts"
			| "hasSignals"
		>
	>;
};

export type OcChatgptTargetNone = {
	kind: "none";
	reason: string;
	tried: Array<
		Pick<
			OcChatgptTargetCandidate,
			"scope" | "root" | "accountPath" | "backupRoot" | "source"
		>
	>;
};

export type OcChatgptTargetFound = {
	kind: "target";
	descriptor: OcChatgptTargetDescriptor;
};

export type OcChatgptTargetDetectionResult =
	| OcChatgptTargetFound
	| OcChatgptTargetAmbiguous
	| OcChatgptTargetNone;

/**
 * Selects the first non-empty trimmed string from the provided array.
 *
 * @param values - An array of strings or undefined values to examine
 * @returns The first value with surrounding whitespace removed, or `null` if no non-empty value is found
 */
function firstNonEmpty(values: Array<string | undefined>): string | null {
	for (const value of values) {
		const trimmed = (value ?? "").trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return null;
}

/**
 * Resolve the effective user home directory, preferring sensible platform-specific environment variables.
 *
 * @returns The resolved home directory path.
 *
 * @remarks
 * - On Windows this prefers USERPROFILE, then HOME, then the combination of HOMEDRIVE+HOMEPATH, and finally os.homedir(). On non-Windows it prefers HOME then os.homedir().
 * - The function is pure and safe for concurrent calls within a single process (it only reads environment and os state).
 * - Environment-derived paths may contain sensitive tokens; callers should redact or treat returned paths as potentially sensitive before logging or emitting them.
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
 * Determines whether a path string represents a Windows drive root (e.g., `C:` or `C:\`).
 *
 * @param candidate - The path string to test; typically a normalized candidate path.
 * @returns `true` if `candidate` is a Windows drive root like `C:` or `C:\`, `false` otherwise.
 *
 * Notes:
 * - This is a pure, concurrency-safe predicate.
 * - Windows-specific behavior: accepts both `X:` and `X:\` forms as drive roots.
 * - No token or secret redaction is performed by this function; it only inspects the string.
 */
function isWindowsDriveRoot(candidate: string): boolean {
	return /^[a-zA-Z]:\\?$/.test(candidate);
}

/**
 * Normalize and canonicalize a filesystem candidate path for comparison and storage.
 *
 * @param candidate - Path string to normalize; leading and trailing whitespace are ignored.
 * @returns The normalized, resolved path. On Windows drive roots a trailing backslash is preserved (e.g. `C:\`); for non-root paths trailing path separators are removed. Returns an empty string when `candidate` is empty or only whitespace.
 *
 * @remarks This function is pure and safe to call concurrently. It applies platform-aware normalization (Windows drive-root handling) and does not perform token redaction or other secret-masking IO. */
function normalizeCandidatePath(candidate: string): string {
	const trimmed = candidate.trim();
	if (trimmed.length === 0) return "";
	const normalized = normalize(resolve(trimmed));
	if (process.platform === "win32" && isWindowsDriveRoot(normalized)) {
		return normalized.endsWith("\\") ? normalized : normalized + "\\";
	}
	if (normalized.length > 1 && /[\\/]$/.test(normalized)) {
		return normalized.replace(/[\\/]+$/, "");
	}
	return normalized;
}

/**
 * Normalize and deduplicate a list of filesystem candidate paths while preserving first-seen ordering.
 *
 * This function normalizes each input path (via normalizeCandidatePath), drops empty results,
 * and removes duplicates. On Windows the deduplication is case-insensitive; on other platforms it is case-sensitive.
 * The function is synchronous and free of side effects, so it is safe to call concurrently from multiple callers.
 * Note: this function does not redact or mask any sensitive tokens that may appear in path strings.
 *
 * @param paths - Array of candidate path strings to normalize and de-duplicate
 * @returns An array of normalized, unique paths in their first-seen order
 */
function deduplicatePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const candidate of paths) {
		const normalized = normalizeCandidatePath(candidate);
		if (normalized.length === 0) continue;
		const key =
			process.platform === "win32" ? normalized.toLowerCase() : normalized;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

/**
 * Detects whether an account file or rotated account artifacts exist under the specified storage root.
 *
 * Scans for the canonical account file and its WAL variant, rotated/archived files matching the account filename pattern (excluding `.tmp`, `.wal`, and names containing `.rotate.`), and the backups directory. The probe is tolerant of unreadable directories (errors are ignored) and does not read file contents. Callers should be aware of concurrent filesystem changes — a `false` result does not guarantee no artifact will appear shortly after. On Windows, filesystem matching should be considered case-insensitive by callers. This check does not expose or parse any token contents.
 *
 * @param root - Filesystem path of the storage root to probe
 * @returns `true` if any account file or rotated account artifact exists under `root` or its backups directory, `false` otherwise.
 */
function hasAccountArtifacts(root: string): boolean {
	const accountPath = join(root, ACCOUNT_FILE_NAME);
	if (existsSync(accountPath) || existsSync(`${accountPath}.wal`)) {
		return true;
	}

	const hasRotated = (dir: string): boolean => {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				if (!entry.name.startsWith(`${ACCOUNT_FILE_NAME}.`)) continue;
				if (entry.name.endsWith(".tmp")) continue;
				if (entry.name.endsWith(".wal")) continue;
				if (entry.name.includes(".rotate.")) continue;
				return true;
			}
		} catch {
			// Ignore unreadable directories and fall back to other probes.
		}
		return false;
	};

	if (hasRotated(root)) {
		return true;
	}

	const backupsDir = join(root, BACKUPS_DIR_NAME);
	if (existsSync(join(backupsDir, ACCOUNT_FILE_NAME))) {
		return true;
	}
	if (hasRotated(backupsDir)) {
		return true;
	}

	return false;
}

/**
 * Determines whether the given storage root contains on-disk storage signals (backups or projects).
 *
 * Checks for the presence of a "backups" or "projects" directory directly under `root`. The result
 * reflects the filesystem state at the time of the call and may change concurrently; callers should
 * treat this as a best-effort, race-prone probe. On Windows this uses the OS filesystem semantics
 * for path existence checks. This function does not read or expose file contents and therefore does
 * not reveal tokens or other secret material.
 *
 * @param root - Filesystem path to the candidate storage root
 * @returns `true` if either a `backups` or `projects` directory exists under `root`, `false` otherwise
 */
function hasStorageSignals(root: string): boolean {
	return (
		existsSync(join(root, BACKUPS_DIR_NAME)) ||
		existsSync(join(root, PROJECTS_DIR_NAME))
	);
}

/**
 * Determines whether a storage root is a per-project location or the global location.
 *
 * @param root - The candidate storage root path to classify.
 * @param canonicalRoot - The canonical root path (typically the user-level `.opencode` directory).
 * @returns The inferred scope: `"project"` if `root` is located under the `projects` subdirectory of `canonicalRoot`, `"global"` otherwise.
 *
 * Notes:
 * - Uses Node's path.relative and the platform path separator; on Windows this comparison uses backslashes.
 * - Pure and side-effect free; safe for concurrent use.
 * - Only inspects path structure, not file contents, so no secrets or tokens are read or redacted here.
 */
function inferScopeFromRoot(
	root: string,
	canonicalRoot: string,
): OcChatgptTargetScope {
	const relativeRoot = relative(canonicalRoot, root);
	return relativeRoot.startsWith(`${PROJECTS_DIR_NAME}${sep}`)
		? "project"
		: "global";
}

/**
 * Detects the oc-chatgpt multi-auth storage target by evaluating explicit, canonical, and per-project candidate roots.
 *
 * Examines an explicit override (OC_CHATGPT_MULTI_AUTH_DIR or options.explicitRoot), the canonical user store (~/.opencode),
 * and a per-project storage location (derived from options.projectRoot or the current working directory). For each candidate
 * it checks for account artifacts and storage signals and returns a single resolved target, an ambiguity listing multiple
 * matching candidates, or a "none" result with the attempted candidates. This function performs synchronous filesystem checks
 * and tolerates unreadable directories; callers should treat it as a blocking operation. On Windows, path normalization and
 * deduplication are case-insensitive and drive-root variants (e.g. `C:` vs `C:\`) are normalized consistently. Returned
 * descriptors include normalized paths but do not contain authentication tokens or other secret material.
 *
 * @param options - Optional overrides:
 *   - explicitRoot: absolute path to force as the candidate root (use `null` to explicitly disable); if omitted the
 *     OC_CHATGPT_MULTI_AUTH_DIR environment variable is considered.
 *   - projectRoot: explicit project root to derive per-project storage; if omitted the current working directory is used to
 *     discover the project root.
 * @returns An OcChatgptTargetDetectionResult describing either a resolved `target` (with `descriptor` and a `resolution`
 *   of `"accounts"` or `"signals"`), an `ambiguous` outcome listing conflicting candidates, or `none` with the tried candidates.
 */
export function detectOcChatgptMultiAuthTarget(options?: {
	explicitRoot?: string | null;
	projectRoot?: string | null;
}): OcChatgptTargetDetectionResult {
	const explicitFromEnv = (process.env.OC_CHATGPT_MULTI_AUTH_DIR ?? "").trim();
	const explicitRoot = (options?.explicitRoot ?? explicitFromEnv).trim();
	const userHome = getResolvedUserHomeDir();
	const canonicalRoot = join(userHome, CANONICAL_HOME_BASENAME);
	const projectRoot = options?.projectRoot ?? findProjectRoot(process.cwd());
	const identityRoot = projectRoot
		? resolveProjectStorageIdentityRoot(projectRoot)
		: null;
	const projectStorageRoot = identityRoot
		? join(canonicalRoot, PROJECTS_DIR_NAME, getProjectStorageKey(identityRoot))
		: null;

	const normalizedExplicitRoot = explicitRoot
		? normalizeCandidatePath(explicitRoot)
		: "";
	const orderedRoots = deduplicatePaths(
		[normalizedExplicitRoot, canonicalRoot, projectStorageRoot].filter(
			(entry): entry is string => Boolean(entry),
		),
	);

	const candidates: OcChatgptTargetCandidate[] = orderedRoots.map((root) => {
		const inferredScope = inferScopeFromRoot(root, canonicalRoot);
		const source: OcChatgptTargetSource =
			root === normalizedExplicitRoot
				? "explicit"
				: inferredScope === "project"
					? "project"
					: "default-global";
		const accountPath = join(root, ACCOUNT_FILE_NAME);
		const backupRoot = join(root, BACKUPS_DIR_NAME);
		const hasAccountArtifactsFlag = hasAccountArtifacts(root);
		return {
			scope: inferredScope,
			source,
			root,
			accountPath,
			backupRoot,
			hasAccountArtifacts: hasAccountArtifactsFlag,
			hasSignals: hasAccountArtifactsFlag || hasStorageSignals(root),
		};
	});

	const withAccounts = candidates.filter(
		(candidate) => candidate.hasAccountArtifacts,
	);
	if (withAccounts.length === 1) {
		const winner = withAccounts[0];
		if (!winner) {
			throw new Error("Expected one target candidate with account artifacts");
		}
		return {
			kind: "target",
			descriptor: {
				scope: winner.scope,
				source: winner.source,
				root: winner.root,
				accountPath: winner.accountPath,
				backupRoot: winner.backupRoot,
				resolution: "accounts",
			},
		};
	}
	if (withAccounts.length > 1) {
		return {
			kind: "ambiguous",
			reason:
				"Multiple oc-chatgpt-multi-auth targets contain account artifacts; refusing to guess.",
			candidates: withAccounts.map(
				({
					scope,
					source,
					root,
					accountPath,
					backupRoot,
					hasAccountArtifacts,
					hasSignals,
				}) => ({
					scope,
					source,
					root,
					accountPath,
					backupRoot,
					hasAccountArtifacts,
					hasSignals,
				}),
			),
		};
	}

	const withSignals = candidates.filter((candidate) => candidate.hasSignals);
	if (withSignals.length === 1) {
		const winner = withSignals[0];
		if (!winner) {
			throw new Error("Expected one target candidate with storage signals");
		}
		return {
			kind: "target",
			descriptor: {
				scope: winner.scope,
				source: winner.source,
				root: winner.root,
				accountPath: winner.accountPath,
				backupRoot: winner.backupRoot,
				resolution: "signals",
			},
		};
	}
	if (withSignals.length > 1) {
		return {
			kind: "ambiguous",
			reason:
				"Multiple oc-chatgpt-multi-auth targets contain storage signals; refusing to guess.",
			candidates: withSignals.map(
				({
					scope,
					source,
					root,
					accountPath,
					backupRoot,
					hasAccountArtifacts,
					hasSignals,
				}) => ({
					scope,
					source,
					root,
					accountPath,
					backupRoot,
					hasAccountArtifacts,
					hasSignals,
				}),
			),
		};
	}

	return {
		kind: "none",
		reason:
			"No oc-chatgpt-multi-auth target root found; create ~/.opencode or supply OC_CHATGPT_MULTI_AUTH_DIR.",
		tried: candidates.map(
			({ scope, source, root, accountPath, backupRoot }) => ({
				scope,
				source,
				root,
				accountPath,
				backupRoot,
			}),
		),
	};
}
