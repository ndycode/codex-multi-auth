import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeJWT } from "../auth/auth.js";
import { extractAccountEmail, extractAccountId } from "../auth/token-utils.js";
import { createLogger } from "../logger.js";
import { sleep } from "../utils.js";
import {
	incrementCodexCliMetric,
	makeAccountFingerprint,
} from "./observability.js";

const log = createLogger("codex-cli-state");
const CACHE_TTL_MS = 5_000;
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM"]);

export interface CodexCliTokenCacheEntry {
	accessToken: string;
	expiresAt?: number;
	refreshToken?: string;
	accountId?: string;
}

export interface CodexCliAccountSnapshot extends CodexCliTokenCacheEntry {
	email?: string;
	isActive?: boolean;
}

export interface CodexCliState {
	path: string;
	accounts: CodexCliAccountSnapshot[];
	activeAccountId?: string;
	activeEmail?: string;
	syncVersion?: number;
	sourceUpdatedAtMs?: number;
}

let cache: CodexCliState | null = null;
let cacheLoadedAt = 0;
let inFlightLoadPromise: Promise<CodexCliState | null> | null = null;
const emittedWarnings = new Set<string>();

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

async function retryFsOperation<T>(task: () => Promise<T>, attempts = 4): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			return await task();
		} catch (error) {
			lastError = error;
			if (!isRetryableFsError(error) || attempt >= attempts - 1) {
				throw error;
			}
			await sleep(10 * 2 ** attempt);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("filesystem retry exhausted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEmail(value: unknown): string | undefined {
	const email = readTrimmedString(value);
	return email ? email.toLowerCase() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lc = value.trim().toLowerCase();
		if (lc === "true" || lc === "1") return true;
		if (lc === "false" || lc === "0") return false;
	}
	return undefined;
}

function readNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function extractTokenFromRecord(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const token = readTrimmedString(record[key]);
		if (token) return token;
	}
	return undefined;
}

function extractAccountSnapshot(raw: unknown): CodexCliAccountSnapshot | null {
	if (!isRecord(raw)) return null;

	const auth = isRecord(raw.auth) ? raw.auth : undefined;
	const tokens = auth && isRecord(auth.tokens) ? auth.tokens : undefined;

	const accessToken =
		extractTokenFromRecord(raw, ["accessToken", "access_token"]) ??
		(tokens ? extractTokenFromRecord(tokens, ["access_token", "accessToken"]) : undefined);
	const refreshToken =
		extractTokenFromRecord(raw, ["refreshToken", "refresh_token"]) ??
		(tokens ? extractTokenFromRecord(tokens, ["refresh_token", "refreshToken"]) : undefined);

	const accountId =
		readTrimmedString(raw.accountId) ??
		readTrimmedString(raw.account_id) ??
		readTrimmedString(raw.workspace_id) ??
		readTrimmedString(raw.organization_id) ??
		readTrimmedString(raw.id);
	const email =
		normalizeEmail(raw.email) ??
		normalizeEmail(raw.user_email) ??
		normalizeEmail(raw.username);
	const expiresAtRaw =
		readNumber(raw.expiresAt) ??
		readNumber(raw.expires_at) ??
		(tokens ? readNumber(tokens.expires_at) : undefined);

	let expiresAt = expiresAtRaw;
	if (!expiresAt && accessToken) {
		const decoded = decodeJWT(accessToken);
		const exp = decoded?.exp;
		if (typeof exp === "number" && Number.isFinite(exp)) {
			expiresAt = exp * 1000;
		}
	}

	const isActive =
		readBoolean(raw.active) ??
		readBoolean(raw.isActive) ??
		readBoolean(raw.is_active);

	if (!accessToken && !refreshToken) {
		return null;
	}

	return {
		email,
		accountId,
		accessToken: accessToken ?? "",
		refreshToken,
		expiresAt,
		isActive,
	};
}

/**
 * Determines whether Codex CLI sync is enabled based on environment variables.
 *
 * Checks CODEX_MULTI_AUTH_SYNC_CODEX_CLI first (explicit "1" enables, "0" disables),
 * then falls back to the legacy CODEX_AUTH_SYNC_CODEX_CLI (also "1"/"0"). If the
 * legacy variable is used, a single warning is emitted and a metric is incremented.
 *
 * Concurrency: the function may perform a one-time side effect (emitting a legacy-use
 * warning and incrementing a metric); that side effect is guarded to run at most once
 * per process and is safe to call from concurrent contexts.
 *
 * Filesystem and tokens: this function does not access the filesystem and does not
 * read or log any tokens (no token redaction is required here).
 *
 * @returns `true` if sync is enabled, `false` otherwise.
 */
export function isCodexCliSyncEnabled(): boolean {
	const override = (process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI ?? "").trim();
	if (override === "0") return false;
	if (override === "1") return true;

	const legacy = (process.env.CODEX_AUTH_SYNC_CODEX_CLI ?? "").trim();
	if (legacy.length > 0 && !emittedWarnings.has("legacy-sync-env")) {
		emittedWarnings.add("legacy-sync-env");
		incrementCodexCliMetric("legacySyncEnvUses");
		log.warn(
			"Using legacy CODEX_AUTH_SYNC_CODEX_CLI. Prefer CODEX_MULTI_AUTH_SYNC_CODEX_CLI.",
		);
	}
	if (legacy === "0") return false;
	if (legacy === "1") return true;
	return true;
}

/**
 * Resolves the filesystem path to the Codex CLI accounts file.
 *
 * If the environment variable CODEX_CLI_ACCOUNTS_PATH is set to a non-empty value it will be returned; otherwise the default is "$HOME/.codex/accounts.json".
 *
 * Concurrency: callers should treat the returned path as a location that may be concurrently read or written by other processes.
 * Windows: returns a path using the platform path separators (may contain backslashes on Windows).
 * Token redaction: this function only returns the file path; it does not read or expose token contents and callers must redact sensitive fields when logging the file contents.
 *
 * @returns The resolved path to the accounts JSON file, either the overridden value from CODEX_CLI_ACCOUNTS_PATH or the platform-specific "$HOME/.codex/accounts.json".
 */
export function getCodexCliAccountsPath(): string {
	const override = (process.env.CODEX_CLI_ACCOUNTS_PATH ?? "").trim();
	if (override.length > 0) return override;
	return join(homedir(), ".codex", "accounts.json");
}

/**
 * Resolve the filesystem path for the Codex CLI auth JSON file, allowing an environment override.
 *
 * If the environment variable `CODEX_CLI_AUTH_PATH` is set to a non-empty value (after trimming) that value is returned;
 * otherwise the default path is homedir/.codex/auth.json. The returned path may reference a file containing authentication tokens—
 * treat it as sensitive (avoid logging full paths or file contents without redaction). The function returns a platform-native path
 * (path separators follow the current OS); callers should handle concurrent access to the file when reading or writing.
 *
 * @returns The resolved path to the Codex CLI `auth.json` file.
 */
export function getCodexCliAuthPath(): string {
	const override = (process.env.CODEX_CLI_AUTH_PATH ?? "").trim();
	if (override.length > 0) return override;
	return join(homedir(), ".codex", "auth.json");
}

/**
 * Resolve the filesystem path for the Codex CLI config TOML file, allowing an environment override.
 *
 * If `CODEX_CLI_CONFIG_PATH` is set to a non-empty value (after trimming), that path is returned.
 * Otherwise, defaults to `$HOME/.codex/config.toml`.
 *
 * @returns The resolved path to Codex CLI `config.toml`.
 */
export function getCodexCliConfigPath(): string {
	const override = (process.env.CODEX_CLI_CONFIG_PATH ?? "").trim();
	if (override.length > 0) return override;
	return join(homedir(), ".codex", "config.toml");
}

/**
 * Convert a parsed Codex CLI accounts JSON payload into a CodexCliState snapshot.
 *
 * Parses the provided JSON object expected to contain an `accounts` array and optional metadata, producing a state object that includes accounts, active account/email if present, `syncVersion`, and the optional `sourceUpdatedAtMs`. The supplied `path` is recorded as-is and is not normalized (may be a Unix or Windows path). This function performs no synchronization or locking and may produce stale results relative to on-disk changes. Tokens are copied verbatim from the payload and are not redacted; callers must redact sensitive values before logging or exposing the returned state.
 *
 * @param path - Filesystem path of the source payload; path separators are preserved and not normalized.
 * @param parsed - The already-parsed JSON value expected to contain an `accounts` array and optional metadata.
 * @param sourceUpdatedAtMs - Optional source modification timestamp (milliseconds) to attach to the returned state.
 * @returns A populated `CodexCliState` when `parsed` contains a valid `accounts` array, or `null` when the payload is not in the expected shape.
 */
function parseCodexCliState(
	path: string,
	parsed: unknown,
	sourceUpdatedAtMs?: number,
): CodexCliState | null {
	if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) {
		return null;
	}

	const accounts = parsed.accounts
		.map((entry) => extractAccountSnapshot(entry))
		.filter((entry): entry is CodexCliAccountSnapshot => entry !== null);

	let activeAccountId =
		readTrimmedString(parsed.activeAccountId) ??
		readTrimmedString(parsed.active_account_id);
	let activeEmail =
		normalizeEmail(parsed.activeEmail) ??
		normalizeEmail(parsed.active_email);

	if (!activeAccountId && !activeEmail) {
		const activeFromList = accounts.find((account) => account.isActive);
		if (activeFromList) {
			activeAccountId = activeFromList.accountId;
			activeEmail = activeFromList.email;
		}
	}

	return {
		path,
		accounts,
		activeAccountId,
		activeEmail,
		syncVersion: readNumber(parsed.codexMultiAuthSyncVersion),
		sourceUpdatedAtMs,
	};
}

/**
 * Parse an auth-style Codex CLI payload into a CodexCliState snapshot.
 *
 * The returned state represents a point-in-time conversion of the provided payload and may include raw tokens
 * and derived metadata (account id, email, expiration, sync version, and optional sourceUpdatedAtMs).
 *
 * Concurrency: the result reflects the payload at the time of parsing; callers should not assume it remains
 * valid if the underlying file changes concurrently.
 *
 * Windows/filesystem note: filesystem-derived timestamps (sourceUpdatedAtMs) may be coarse or approximate on some
 * platforms (notably Windows); treat them as best-effort indicators of source modification time.
 *
 * Token handling: the returned state includes raw access/refresh tokens. Callers must redact or avoid logging tokens
 * or other sensitive fields when emitting logs, telemetry, or external diagnostics.
 *
 * @param path - Filesystem path that served as the source of `parsed`; stored verbatim on the returned state.
 * @param parsed - The parsed JSON payload from an auth-style file; expected to contain a `tokens` object.
 * @param sourceUpdatedAtMs - Optional best-effort source modification timestamp (milliseconds since epoch).
 * @returns A CodexCliState built from the auth payload, or `null` if `parsed` is not a valid auth payload containing no tokens.
 */
function parseCodexCliAuthState(
	path: string,
	parsed: unknown,
	sourceUpdatedAtMs?: number,
): CodexCliState | null {
	if (!isRecord(parsed)) return null;
	const tokens = isRecord(parsed.tokens) ? parsed.tokens : null;
	if (!tokens) return null;

	const accessToken = extractTokenFromRecord(tokens, ["access_token", "accessToken"]);
	const refreshToken = extractTokenFromRecord(tokens, ["refresh_token", "refreshToken"]);
	if (!accessToken && !refreshToken) return null;

	const idToken = extractTokenFromRecord(tokens, ["id_token", "idToken"]);
	const accountId =
		readTrimmedString(tokens.account_id) ??
		readTrimmedString(tokens.accountId) ??
		(accessToken ? extractAccountId(accessToken) : undefined);
	const email =
		(accessToken ? extractAccountEmail(accessToken, idToken) : undefined) ??
		normalizeEmail(parsed.email);

	let expiresAt: number | undefined = undefined;
	if (accessToken) {
		const decoded = decodeJWT(accessToken);
		const exp = decoded?.exp;
		if (typeof exp === "number" && Number.isFinite(exp)) {
			expiresAt = exp * 1000;
		}
	}

	const snapshot: CodexCliAccountSnapshot = {
		accountId,
		email,
		accessToken: accessToken ?? "",
		refreshToken,
		expiresAt,
		isActive: true,
	};

	return {
		path,
		accounts: [snapshot],
		activeAccountId: accountId,
		activeEmail: email,
		syncVersion: readNumber(parsed.codexMultiAuthSyncVersion),
		sourceUpdatedAtMs,
	};
}

/**
 * Loads Codex CLI authentication state from disk, with an in-memory TTL cache and optional force refresh.
 *
 * Reads either the accounts JSON or the legacy auth JSON (whichever is present) and returns a normalized
 * CodexCliState including tokens, active account, optional sync version, and source file modification time.
 * Uses an in-memory cache valid for CACHE_TTL_MS; if `forceRefresh` is true the cache is bypassed.
 *
 * Concurrency: callers may race to read/update the in-memory cache; this function performs best-effort caching
 * and does not provide external synchronization primitives.
 *
 * Windows filesystem notes: file modification timestamps (sourceUpdatedAtMs) are derived from fs.stat().mtimeMs
 * and may have coarser resolution on some Windows filesystems.
 *
 * Token redaction: returned state may contain token values (accessToken, refreshToken); consumers should treat
 * these values as sensitive and redact or avoid logging them.
 *
 * @param options - Optional settings.
 * @param options.forceRefresh - If true, bypass the in-memory TTL cache and re-read files from disk.
 * @returns The parsed CodexCliState when a valid accounts/auth payload is found, or `null` if sync is disabled,
 * no valid payload exists, or a read/parse error occurred.
 */
export async function loadCodexCliState(
	options?: { forceRefresh?: boolean },
): Promise<CodexCliState | null> {
	if (!isCodexCliSyncEnabled()) {
		return null;
	}

	const now = Date.now();
	if (!options?.forceRefresh && cache && now - cacheLoadedAt < CACHE_TTL_MS) {
		return cache;
	}
	if (inFlightLoadPromise) {
		return inFlightLoadPromise;
	}

	const readTask = async (): Promise<CodexCliState | null> => {
		const accountsPath = getCodexCliAccountsPath();
		const authPath = getCodexCliAuthPath();
		incrementCodexCliMetric("readAttempts");

		const hasAccountsPath = existsSync(accountsPath);
		const hasAuthPath = existsSync(authPath);
		if (!hasAccountsPath && !hasAuthPath) {
			incrementCodexCliMetric("readMisses");
			cache = null;
			return null;
		}

		try {
			if (hasAccountsPath) {
				try {
					const raw = await retryFsOperation(() => fs.readFile(accountsPath, "utf-8"));
					const parsed = JSON.parse(raw) as unknown;
					let sourceUpdatedAtMs: number | undefined;
					try {
						sourceUpdatedAtMs = (await retryFsOperation(() => fs.stat(accountsPath))).mtimeMs;
					} catch {
						sourceUpdatedAtMs = undefined;
					}
					const state = parseCodexCliState(accountsPath, parsed, sourceUpdatedAtMs);
					if (state) {
						incrementCodexCliMetric("readSuccesses");
						log.debug("Loaded Codex CLI state", {
							operation: "read-state",
							outcome: "success",
							path: accountsPath,
							accountCount: state.accounts.length,
							activeAccountRef: makeAccountFingerprint({
								accountId: state.activeAccountId,
								email: state.activeEmail,
							}),
						});
						cache = state;
						return state;
					}
					log.warn("Codex CLI accounts payload is malformed", {
						operation: "read-state",
						outcome: "malformed",
						path: accountsPath,
					});
				} catch (accountsError) {
					log.warn("Failed to read Codex CLI accounts state", {
						operation: "read-state",
						outcome: "accounts-read-error",
						path: accountsPath,
						error: String(accountsError),
					});
				}
			}

			if (hasAuthPath) {
				try {
					const raw = await retryFsOperation(() => fs.readFile(authPath, "utf-8"));
					const parsed = JSON.parse(raw) as unknown;
					let sourceUpdatedAtMs: number | undefined;
					try {
						sourceUpdatedAtMs = (await retryFsOperation(() => fs.stat(authPath))).mtimeMs;
					} catch {
						sourceUpdatedAtMs = undefined;
					}
					const state = parseCodexCliAuthState(authPath, parsed, sourceUpdatedAtMs);
					if (state) {
						incrementCodexCliMetric("readSuccesses");
						log.debug("Loaded Codex CLI auth state", {
							operation: "read-state",
							outcome: "success",
							path: authPath,
							accountCount: state.accounts.length,
							activeAccountRef: makeAccountFingerprint({
								accountId: state.activeAccountId,
								email: state.activeEmail,
							}),
						});
						cache = state;
						return state;
					}
					log.warn("Codex CLI auth payload is malformed", {
						operation: "read-state",
						outcome: "malformed",
						path: authPath,
					});
				} catch (authError) {
					log.warn("Failed to read Codex CLI auth state", {
						operation: "read-state",
						outcome: "auth-read-error",
						path: authPath,
						error: String(authError),
					});
				}
			}

			incrementCodexCliMetric("readFailures");
			cache = null;
			return null;
		} catch (error) {
			incrementCodexCliMetric("readFailures");
			log.warn("Failed to read Codex CLI state", {
				operation: "read-state",
				outcome: "error",
				path: hasAccountsPath ? accountsPath : authPath,
				error: String(error),
			});
			cache = null;
			return null;
		} finally {
			cacheLoadedAt = Date.now();
		}
	};

	const currentLoad = readTask();
	inFlightLoadPromise = currentLoad;
	try {
		return await currentLoad;
	} finally {
		if (inFlightLoadPromise === currentLoad) {
			inFlightLoadPromise = null;
		}
	}
}

export async function lookupCodexCliTokensByEmail(
	email: string | undefined,
): Promise<CodexCliTokenCacheEntry | null> {
	const normalized = normalizeEmail(email);
	if (!normalized) return null;

	const state = await loadCodexCliState();
	if (!state) return null;

	const account = state.accounts.find((entry) => normalizeEmail(entry.email) === normalized);
	if (!account?.accessToken) return null;

	return {
		accessToken: account.accessToken,
		expiresAt: account.expiresAt,
		refreshToken: account.refreshToken,
		accountId: account.accountId,
	};
}

export function clearCodexCliStateCache(): void {
	cache = null;
	cacheLoadedAt = 0;
	inFlightLoadPromise = null;
}

export function __resetCodexCliWarningCacheForTests(): void {
	emittedWarnings.clear();
}
