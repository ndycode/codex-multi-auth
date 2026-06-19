import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { getCodexHomeDir } from "../../runtime-paths.js";

/**
 * `codex-multi-auth history` — provider-agnostic local session browser.
 *
 * Codex CLI's `/resume` view filters local rollout threads by the model
 * provider that is currently active in `config.toml`. When runtime rotation /
 * app bind is enabled the active provider becomes
 * `codex-multi-auth-runtime-proxy`, so sessions recorded under the native
 * `openai` provider (or vice versa) become invisible in `/resume` even though
 * the rollout files still live side-by-side under `~/.codex/sessions/`. Users
 * perceive this as "history is not shared across accounts" (issue #612), but
 * the split is by provider name, not by account.
 *
 * This command reads the rollout files directly and lists every local session
 * regardless of the provider it was created under, giving a complete view that
 * `/resume` cannot. It performs no network calls and never mutates state.
 */

const ROLLOUT_FILENAME_PATTERN =
	/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const DEFAULT_PREVIEW_MESSAGE_COUNT = 3;
const MAX_THREAD_NAME_LENGTH = 80;

export interface HistorySessionSummary {
	id: string;
	threadName: string;
	updatedAt: string;
	provider: string | null;
	originator: string | null;
	cwd: string | null;
	path: string;
}

export interface HistorySessionDetail extends HistorySessionSummary {
	cliVersion: string | null;
	messages: string[];
}

export interface HistoryCommandDeps {
	getCodexHome?: () => string;
	readDirRecursive?: (dir: string) => string[];
	readFile?: (path: string) => string;
	statMtime?: (path: string) => Date;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

interface JsonRecord {
	type?: unknown;
	timestamp?: unknown;
	payload?: Record<string, unknown>;
}

function readStringField(
	record: Record<string, unknown> | undefined,
	key: string,
): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function defaultReadDirRecursive(dir: string): string[] {
	const results: string[] = [];
	let entries: Dirent[] = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		const entryPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...defaultReadDirRecursive(entryPath));
			continue;
		}
		if (entry.isFile() && ROLLOUT_FILENAME_PATTERN.test(entry.name)) {
			results.push(entryPath);
		}
	}
	return results;
}

function extractIdFromFilename(fileName: string): string | null {
	const match = fileName.match(ROLLOUT_FILENAME_PATTERN);
	return match?.[1] ?? null;
}

/**
 * Separator-agnostic basename. Rollout paths may carry Windows separators even
 * when this runs on POSIX (e.g. injected paths in tests, or a CODEX_HOME on a
 * mounted Windows volume), so split on both `/` and `\` rather than relying on
 * the platform-specific node:path basename.
 */
function baseNameOf(filePath: string): string {
	const segments = filePath.split(/[\\/]/);
	return segments[segments.length - 1] ?? filePath;
}

/**
 * Parse a single rollout file into a session summary.
 *
 * Mirrors the index-building logic the wrapper uses (scripts/codex.js
 * parseRolloutIndexEntry) but additionally surfaces the `model_provider` and
 * `originator` from `session_meta`, which is the field that actually drives the
 * `/resume` visibility split. Returns null for files without a `session_meta`
 * record or that cannot be read, so partially-written rollouts are skipped
 * rather than crashing the listing.
 */
function parseRollout(
	rolloutPath: string,
	deps: Required<Pick<HistoryCommandDeps, "readFile" | "statMtime">>,
	previewLimit: number,
): HistorySessionDetail | null {
	const idFromName = extractIdFromFilename(baseNameOf(rolloutPath));
	if (!idFromName) return null;

	let content: string;
	try {
		content = deps.readFile(rolloutPath);
	} catch {
		return null;
	}

	const lines = content.split(/\r?\n/);
	let id = idFromName;
	let threadName = "";
	let updatedAt: string | null = null;
	let provider: string | null = null;
	let originator: string | null = null;
	let cwd: string | null = null;
	let cliVersion: string | null = null;
	let hasSessionMeta = false;
	const messages: string[] = [];

	for (const line of lines) {
		if (line.trim().length === 0) continue;
		let record: JsonRecord;
		try {
			record = JSON.parse(line) as JsonRecord;
		} catch {
			// Tolerate malformed/partial lines; a single bad line must not drop
			// the whole session from the listing.
			continue;
		}

		if (typeof record.timestamp === "string") {
			updatedAt = record.timestamp;
		}

		if (record.type === "session_meta") {
			const payload = record.payload;
			const metaId = readStringField(payload, "id");
			if (metaId) id = metaId;
			provider = readStringField(payload, "model_provider") ?? provider;
			originator = readStringField(payload, "originator") ?? originator;
			cwd = readStringField(payload, "cwd") ?? cwd;
			cliVersion = readStringField(payload, "cli_version") ?? cliVersion;
			hasSessionMeta = true;
		}

		if (record.type === "event_msg") {
			const payload = record.payload;
			const payloadType = readStringField(payload, "type");
			if (!threadName && payloadType) {
				const message = readStringField(payload, "message");
				if (message) {
					threadName = message;
				}
			}
			if (
				payloadType === "user_message" &&
				messages.length < previewLimit
			) {
				const message = readStringField(payload, "message");
				if (message) {
					messages.push(message);
				}
			}
		}
	}

	if (!hasSessionMeta) {
		return null;
	}

	if (!updatedAt) {
		try {
			updatedAt = deps.statMtime(rolloutPath).toISOString();
		} catch {
			updatedAt = new Date().toISOString();
		}
	}

	if (!threadName) {
		threadName = "Codex session";
	}
	if (threadName.length > MAX_THREAD_NAME_LENGTH) {
		threadName = `${threadName.slice(0, MAX_THREAD_NAME_LENGTH - 3)}...`;
	}

	return {
		id,
		threadName,
		updatedAt,
		provider,
		originator,
		cwd,
		cliVersion,
		messages,
		path: rolloutPath,
	};
}

function resolveDeps(deps: HistoryCommandDeps): {
	getCodexHome: () => string;
	readDirRecursive: (dir: string) => string[];
	readFile: (path: string) => string;
	statMtime: (path: string) => Date;
	logInfo: (message: string) => void;
	logError: (message: string) => void;
} {
	return {
		getCodexHome: deps.getCodexHome ?? getCodexHomeDir,
		readDirRecursive: deps.readDirRecursive ?? defaultReadDirRecursive,
		readFile: deps.readFile ?? ((path) => readFileSync(path, "utf8")),
		statMtime: deps.statMtime ?? ((path) => statSync(path).mtime),
		logInfo: deps.logInfo ?? ((message) => console.log(message)),
		logError: deps.logError ?? ((message) => console.error(message)),
	};
}

function collectSessions(
	resolved: ReturnType<typeof resolveDeps>,
	previewLimit: number,
): HistorySessionDetail[] {
	const sessionsDir = join(resolved.getCodexHome(), "sessions");
	let files: string[];
	try {
		files = resolved.readDirRecursive(sessionsDir);
	} catch {
		// A missing or unreadable sessions directory is a normal "no history yet"
		// state, not an error — return an empty listing rather than crashing.
		files = [];
	}
	const sessions: HistorySessionDetail[] = [];
	for (const file of files) {
		const parsed = parseRollout(
			file,
			{ readFile: resolved.readFile, statMtime: resolved.statMtime },
			previewLimit,
		);
		if (parsed) sessions.push(parsed);
	}
	// Most-recent first, matching how /resume presents threads.
	sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return sessions;
}

function toSummary(detail: HistorySessionDetail): HistorySessionSummary {
	const { cliVersion: _cliVersion, messages: _messages, ...summary } = detail;
	void _cliVersion;
	void _messages;
	return summary;
}

function runHistoryList(
	args: string[],
	resolved: ReturnType<typeof resolveDeps>,
): number {
	const json = args.includes("--json") || args.includes("-j");
	const sessions = collectSessions(resolved, DEFAULT_PREVIEW_MESSAGE_COUNT);

	if (json) {
		resolved.logInfo(
			JSON.stringify(
				{ count: sessions.length, sessions: sessions.map(toSummary) },
				null,
				2,
			),
		);
		return 0;
	}

	if (sessions.length === 0) {
		resolved.logInfo(
			`No local Codex sessions found under ${join(resolved.getCodexHome(), "sessions")}.`,
		);
		return 0;
	}

	resolved.logInfo(
		`Local Codex sessions (${sessions.length}) — all providers, bypassing /resume provider filtering:`,
	);
	resolved.logInfo("");
	for (const session of sessions) {
		const provider = session.provider ?? "unknown-provider";
		resolved.logInfo(`  ${session.updatedAt}  [${provider}]`);
		resolved.logInfo(`    id:     ${session.id}`);
		resolved.logInfo(`    thread: ${session.threadName}`);
		if (session.cwd) {
			resolved.logInfo(`    cwd:    ${session.cwd}`);
		}
	}
	resolved.logInfo("");
	resolved.logInfo(
		"Resume any session with: codex resume <id>  (or `codex resume` for the picker).",
	);
	return 0;
}

function runHistoryShow(
	args: string[],
	resolved: ReturnType<typeof resolveDeps>,
): number {
	const json = args.includes("--json") || args.includes("-j");
	const sessionId = args.find((arg) => !arg.startsWith("-"));
	if (!sessionId) {
		resolved.logError(
			"Missing session id. Usage: codex-multi-auth history show <session-id> [--json]",
		);
		return 1;
	}

	const sessions = collectSessions(resolved, DEFAULT_PREVIEW_MESSAGE_COUNT);
	const match = sessions.find((session) => session.id === sessionId);
	if (!match) {
		resolved.logError(`Session not found: ${sessionId}`);
		return 1;
	}

	if (json) {
		resolved.logInfo(JSON.stringify(match, null, 2));
		return 0;
	}

	resolved.logInfo(`Session ${match.id}`);
	resolved.logInfo(`  provider:   ${match.provider ?? "unknown"}`);
	resolved.logInfo(`  originator: ${match.originator ?? "unknown"}`);
	resolved.logInfo(`  updated:    ${match.updatedAt}`);
	if (match.cliVersion) {
		resolved.logInfo(`  cli:        ${match.cliVersion}`);
	}
	if (match.cwd) {
		resolved.logInfo(`  cwd:        ${match.cwd}`);
	}
	resolved.logInfo(`  file:       ${match.path}`);
	resolved.logInfo("");
	if (match.messages.length === 0) {
		resolved.logInfo("  (no user messages recorded)");
	} else {
		resolved.logInfo("  First messages:");
		for (const message of match.messages) {
			const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
			const preview =
				firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
			resolved.logInfo(`    - ${preview}`);
		}
	}
	resolved.logInfo("");
	resolved.logInfo(`Resume with: codex resume ${match.id}`);
	return 0;
}

function printHistoryUsage(resolved: ReturnType<typeof resolveDeps>): void {
	resolved.logInfo(
		[
			"Usage: codex-multi-auth history <list|show> [options]",
			"",
			"  list [--json]            List every local session across all providers",
			"  show <id> [--json]       Show provider metadata and first messages for a session",
			"",
			"Lists rollout files under <codex-home>/sessions (default",
			"~/.codex/sessions, honoring CODEX_HOME) directly, so sessions",
			"created under a different model provider (e.g. while runtime rotation",
			"or app bind is active) remain visible even when `codex resume` hides",
			"them. See docs/troubleshooting.md for background.",
		].join("\n"),
	);
}

export function runHistoryCommand(
	args: string[],
	deps: HistoryCommandDeps = {},
): number {
	const resolved = resolveDeps(deps);
	const [subcommand, ...rest] = args;

	if (subcommand === "--help" || subcommand === "-h") {
		printHistoryUsage(resolved);
		return 0;
	}

	// Default to `list` when no subcommand is given, or when the first arg is a
	// flag (e.g. `history --json`), so the documented `[list] [--json]` form
	// works without an explicit `list`. A leading flag is forwarded as a list
	// argument rather than mistaken for a subcommand.
	if (!subcommand || subcommand === "list") {
		return runHistoryList(rest, resolved);
	}
	if (subcommand.startsWith("-")) {
		return runHistoryList([subcommand, ...rest], resolved);
	}

	if (subcommand === "show") {
		return runHistoryShow(rest, resolved);
	}

	resolved.logError(`Unknown history command: ${subcommand}`);
	printHistoryUsage(resolved);
	return 1;
}
