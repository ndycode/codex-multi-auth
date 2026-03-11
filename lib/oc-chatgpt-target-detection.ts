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

function isWindowsDriveRoot(candidate: string): boolean {
	return /^[a-zA-Z]:\\?$/.test(candidate);
}

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

function hasStorageSignals(root: string): boolean {
	return (
		existsSync(join(root, BACKUPS_DIR_NAME)) ||
		existsSync(join(root, PROJECTS_DIR_NAME))
	);
}

function inferScopeFromRoot(
	root: string,
	canonicalRoot: string,
): OcChatgptTargetScope {
	const relativeRoot = relative(canonicalRoot, root);
	return relativeRoot.startsWith(`${PROJECTS_DIR_NAME}${sep}`)
		? "project"
		: "global";
}

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
