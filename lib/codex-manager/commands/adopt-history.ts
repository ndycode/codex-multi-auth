import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RUNTIME_ROTATION_PROXY_PROVIDER_ID } from "../../runtime-constants.js";
import { getCodexMultiAuthDir } from "../../runtime-paths.js";
import { withFileOperationRetry } from "../../fs-retry.js";

const execFileAsync = promisify(execFile);

/**
 * The provider id Codex records for sessions created without the runtime
 * rotation proxy. Adopt rewrites this marker to
 * {@link RUNTIME_ROTATION_PROXY_PROVIDER_ID}; `--reverse` swaps the
 * direction back.
 */
const NATIVE_PROVIDER_ID = "openai" as const;

const MANIFEST_FILE = "history-adopt-manifest.json" as const;

interface AdoptHistoryOptions {
	dryRun: boolean;
	reverse: boolean;
	yes: boolean;
	json: boolean;
}

export interface AdoptHistoryDeps {
	/** Codex home override; defaults to `CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME` or `~/.codex`. */
	resolveCodexHome?: () => string;
	/** Interactive Yes/No prompt; injected so tests stay non-interactive. */
	confirm?: (message: string) => Promise<boolean>;
	/** Runs `sqlite3 <db> <sql>`; injected for tests and environments without the binary. */
	runSqlite?: (dbPath: string, sql: string) => Promise<string>;
	isInteractive?: () => boolean;
	getNow?: () => number;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

interface AdoptHistorySummary {
	direction: "adopt" | "reverse";
	dryRun: boolean;
	sessionFilesScanned: number;
	sessionFilesMatched: number;
	sessionFilesRewritten: number;
	threadRowsMatched: number | null;
	threadRowsUpdated: number | null;
	stateDbPath: string | null;
	sqliteAvailable: boolean;
	manifestPath: string | null;
}

function resolveDefaultCodexHome(): string {
	const override = (process.env.CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME ?? "").trim();
	return override || join(homedir(), ".codex");
}

async function defaultRunSqlite(dbPath: string, sql: string): Promise<string> {
	const { stdout } = await execFileAsync("sqlite3", [dbPath, ".timeout 5000", sql], {
		timeout: 30_000,
	});
	return stdout.trim();
}

function providerToken(providerId: string): string {
	return `"model_provider":"${providerId}"`;
}

/**
 * Recursively collect Codex rollout session files under `sessions/`.
 *
 * Codex organizes rollouts as `sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`;
 * the walk stays tolerant of unexpected layouts so partially-migrated or
 * hand-organized session trees are still covered.
 */
async function collectRolloutFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	const pending: string[] = [root];
	while (pending.length > 0) {
		const dir = pending.pop();
		if (!dir) continue;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				pending.push(full);
			} else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
				out.push(full);
			}
		}
	}
	return out.sort();
}

/**
 * Locate the newest Codex desktop state database (`state_<n>.sqlite`).
 *
 * The desktop app versions its thread index by suffix; picking the highest
 * numeric suffix matches the database the currently-installed build reads.
 */
async function findStateDb(codexHome: string): Promise<string | null> {
	let entries;
	try {
		entries = await readdir(codexHome);
	} catch {
		return null;
	}
	let best: { path: string; version: number } | null = null;
	for (const name of entries) {
		const match = /^state_(\d+)\.sqlite$/.exec(name);
		const suffix = match?.[1];
		if (!suffix) continue;
		const version = Number.parseInt(suffix, 10);
		if (!Number.isFinite(version)) continue;
		if (!best || version > best.version) {
			best = { path: join(codexHome, name), version };
		}
	}
	return best?.path ?? null;
}

function printMechanismAndCaveats(
	logInfo: (message: string) => void,
	reverse: boolean,
): void {
	const from = reverse ? RUNTIME_ROTATION_PROXY_PROVIDER_ID : NATIVE_PROVIDER_ID;
	const to = reverse ? NATIVE_PROVIDER_ID : RUNTIME_ROTATION_PROXY_PROVIDER_ID;
	logInfo(
		[
			"What this does:",
			`  Codex filters conversation history by the active model provider. While the`,
			`  app bind is active the provider is "${RUNTIME_ROTATION_PROXY_PROVIDER_ID}",`,
			`  so sessions recorded under "${NATIVE_PROVIDER_ID}" disappear from the picker and`,
			"  from Codex Desktop history (the data itself stays on disk).",
			`  This command rewrites the recorded provider from "${from}" to "${to}" in:`,
			"    1. local rollout files under <codex-home>/sessions/",
			"    2. the Codex Desktop thread index (state_<n>.sqlite), when present",
			"",
			"Caveats:",
			"  - Quit Codex Desktop first so the thread index is not locked mid-update.",
			"  - Rewritten history is only visible while the matching provider is active;",
			"    run with --reverse before uninstalling codex-multi-auth.",
			"  - Rollout files are rewritten atomically and a manifest of changed files is",
			"    saved under the codex-multi-auth data directory.",
			"  - Restart Codex Desktop afterwards to reload the history list.",
		].join("\n"),
	);
}

function printAdoptHistoryUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex-multi-auth rotation adopt-history [--dry-run] [--reverse] [--yes] [--json]",
			"",
			"Options:",
			"  --dry-run   Report what would change without writing anything",
			"  --reverse   Rewrite provider markers back to the native Codex provider",
			"  --yes       Skip the interactive confirmation prompt",
			"  --json      Emit a machine-readable summary",
		].join("\n"),
	);
}

/**
 * Opt-in migration that makes pre-bind Codex history visible while the
 * runtime rotation provider is active (CLI picker and Codex Desktop).
 *
 * The rewrite is intentionally symmetric: `--reverse` performs the exact
 * inverse substitution, so users can switch their entire history between the
 * native and proxy provider namespaces at any time without data loss.
 */
export async function runAdoptHistory(
	args: string[],
	deps: AdoptHistoryDeps = {},
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const options: AdoptHistoryOptions = {
		dryRun: false,
		reverse: false,
		yes: false,
		json: false,
	};
	for (const arg of args) {
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--reverse") options.reverse = true;
		else if (arg === "--yes" || arg === "-y") options.yes = true;
		else if (arg === "--json" || arg === "-j") options.json = true;
		else if (arg === "--help" || arg === "-h" || arg === "help") {
			printAdoptHistoryUsage(logInfo);
			return 0;
		} else {
			logError(`Unknown adopt-history option: ${arg}`);
			printAdoptHistoryUsage(logInfo);
			return 1;
		}
	}

	const codexHome = deps.resolveCodexHome
		? deps.resolveCodexHome()
		: resolveDefaultCodexHome();
	const sessionsRoot = join(codexHome, "sessions");
	const fromProvider = options.reverse
		? RUNTIME_ROTATION_PROXY_PROVIDER_ID
		: NATIVE_PROVIDER_ID;
	const toProvider = options.reverse
		? NATIVE_PROVIDER_ID
		: RUNTIME_ROTATION_PROXY_PROVIDER_ID;
	const fromToken = providerToken(fromProvider);
	const toToken = providerToken(toProvider);

	if (!options.json) {
		printMechanismAndCaveats(logInfo, options.reverse);
		logInfo("");
	}

	if (!existsSync(sessionsRoot)) {
		logError(`No Codex sessions directory found at ${sessionsRoot}`);
		return 1;
	}

	const files = await collectRolloutFiles(sessionsRoot);
	const matched: string[] = [];
	for (const file of files) {
		try {
			const content = await readFile(file, "utf8");
			if (content.includes(fromToken)) matched.push(file);
		} catch {
			// Unreadable rollouts are skipped rather than failing the migration.
		}
	}

	const stateDbPath = await findStateDb(codexHome);
	const runSqlite = deps.runSqlite ?? defaultRunSqlite;
	let threadRowsMatched: number | null = null;
	let sqliteAvailable = true;
	if (stateDbPath) {
		try {
			const raw = await runSqlite(
				stateDbPath,
				`SELECT COUNT(*) FROM threads WHERE model_provider='${fromProvider}';`,
			);
			const parsed = Number.parseInt(raw, 10);
			threadRowsMatched = Number.isFinite(parsed) ? parsed : null;
		} catch {
			sqliteAvailable = false;
		}
	}

	const summary: AdoptHistorySummary = {
		direction: options.reverse ? "reverse" : "adopt",
		dryRun: options.dryRun,
		sessionFilesScanned: files.length,
		sessionFilesMatched: matched.length,
		sessionFilesRewritten: 0,
		threadRowsMatched,
		threadRowsUpdated: null,
		stateDbPath,
		sqliteAvailable,
		manifestPath: null,
	};

	if (!options.json) {
		logInfo(
			`Found ${matched.length} of ${files.length} session file(s) recorded under "${fromProvider}".`,
		);
		if (stateDbPath) {
			if (threadRowsMatched !== null) {
				logInfo(
					`Codex Desktop thread index ${stateDbPath}: ${threadRowsMatched} row(s) to update.`,
				);
			} else if (!sqliteAvailable) {
				logInfo(
					`Codex Desktop thread index found at ${stateDbPath}, but the sqlite3 binary is unavailable; run this SQL manually:`,
				);
				logInfo(
					`  UPDATE threads SET model_provider='${toProvider}' WHERE model_provider='${fromProvider}';`,
				);
			}
		} else {
			logInfo("No Codex Desktop thread index found (CLI-only install); skipping database step.");
		}
	}

	if (options.dryRun) {
		if (options.json) logInfo(JSON.stringify(summary, null, 2));
		else logInfo("Dry run: nothing was modified.");
		return 0;
	}

	if (matched.length === 0 && (threadRowsMatched ?? 0) === 0) {
		if (options.json) logInfo(JSON.stringify(summary, null, 2));
		else logInfo("Nothing to do.");
		return 0;
	}

	if (!options.yes) {
		const interactive = deps.isInteractive
			? deps.isInteractive()
			: process.stdout.isTTY === true;
		if (!interactive) {
			logError("Refusing to rewrite history without confirmation; re-run with --yes.");
			return 1;
		}
		const confirmFn = deps.confirm;
		if (!confirmFn) {
			logError("Confirmation prompt unavailable; re-run with --yes.");
			return 1;
		}
		const proceed = await confirmFn(
			`Rewrite ${matched.length} session file(s)${threadRowsMatched ? ` and ${threadRowsMatched} thread row(s)` : ""} from "${fromProvider}" to "${toProvider}"?`,
		);
		if (!proceed) {
			logInfo("Aborted; nothing was modified.");
			return 0;
		}
	}

	const changedFiles: string[] = [];
	for (const file of matched) {
		const content = await readFile(file, "utf8");
		const next = content.split(fromToken).join(toToken);
		if (next === content) continue;
		const tmp = `${file}.adopt-tmp`;
		await withFileOperationRetry(async () => {
			await writeFile(tmp, next, "utf8");
			await rename(tmp, file);
		});
		changedFiles.push(file);
	}
	summary.sessionFilesRewritten = changedFiles.length;

	if (stateDbPath && sqliteAvailable && (threadRowsMatched ?? 0) > 0) {
		try {
			const raw = await runSqlite(
				stateDbPath,
				`UPDATE threads SET model_provider='${toProvider}' WHERE model_provider='${fromProvider}'; SELECT changes();`,
			);
			const parsed = Number.parseInt(raw, 10);
			summary.threadRowsUpdated = Number.isFinite(parsed) ? parsed : null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logError(`Thread index update failed (is Codex Desktop running?): ${message}`);
			logError(
				`Run manually: UPDATE threads SET model_provider='${toProvider}' WHERE model_provider='${fromProvider}';`,
			);
		}
	}

	const manifestPath = join(getCodexMultiAuthDir(), MANIFEST_FILE);
	try {
		const now = deps.getNow ? deps.getNow() : Date.now();
		await writeFile(
			manifestPath,
			`${JSON.stringify(
				{
					version: 1,
					direction: summary.direction,
					at: now,
					fromProvider,
					toProvider,
					files: changedFiles,
					stateDbPath,
					threadRowsUpdated: summary.threadRowsUpdated,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		summary.manifestPath = manifestPath;
	} catch {
		// The manifest is advisory; failing to write it must not fail the migration.
	}

	if (options.json) {
		logInfo(JSON.stringify(summary, null, 2));
	} else {
		logInfo(
			`Rewrote ${summary.sessionFilesRewritten} session file(s)${summary.threadRowsUpdated !== null ? ` and ${summary.threadRowsUpdated} thread row(s)` : ""}.`,
		);
		if (summary.manifestPath) logInfo(`Manifest: ${summary.manifestPath}`);
		logInfo("Restart Codex Desktop to reload the history list.");
	}
	return 0;
}

/**
 * Verify a rollout file's first line still parses as JSON after rewrite.
 * Exposed for tests; the rewrite itself is a pure token substitution and
 * cannot change JSON structure, so this is a regression tripwire only.
 */
export async function rolloutMetaParses(file: string): Promise<boolean> {
	try {
		const content = await readFile(file, "utf8");
		const firstLine = content.slice(0, content.indexOf("\n"));
		JSON.parse(firstLine);
		return true;
	} catch {
		return false;
	}
}

/** Exposed for tests. */
export const adoptHistoryInternals = {
	collectRolloutFiles,
	findStateDb,
	providerToken,
	NATIVE_PROVIDER_ID,
};

export type { AdoptHistorySummary };
