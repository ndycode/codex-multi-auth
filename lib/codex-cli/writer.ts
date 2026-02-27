import { existsSync, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";
import {
	clearCodexCliStateCache,
	getCodexCliAccountsPath,
	getCodexCliAuthPath,
	isCodexCliSyncEnabled,
} from "./state.js";
import {
	incrementCodexCliMetric,
	makeAccountFingerprint,
} from "./observability.js";

const log = createLogger("codex-cli-writer");
let lastCodexCliSelectionWriteAt = 0;

interface ActiveSelection {
	accountId?: string;
	email?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	idToken?: string;
}

/**
 * Determines whether a value is a plain object (non-null and not an array).
 *
 * @param value - The value to test
 * @returns `true` if `value` is an object and not `null` or an array, `false` otherwise
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize a value into a non-empty trimmed string.
 *
 * @param value - The input to coerce; only string inputs are considered.
 * @returns The input string trimmed of surrounding whitespace if it contains at least one character after trimming, `undefined` otherwise.
 */
function readTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parses the given value and returns it as a finite number when possible.
 *
 * @param value - A value that may be a number or a numeric string
 * @returns The finite numeric value parsed from `value`, or `undefined` if it cannot be interpreted as a finite number
 */
function readNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/**
 * Selects the first non-empty, trimmed string value from `record` for the provided candidate `keys`.
 *
 * Treats the result as sensitive (token) data: callers must redact it before logging or persisting.
 * The function is pure and has no side effects, so it is safe for concurrent calls and has no filesystem or platform-specific behavior (including Windows).
 *
 * @param record - A heterogenous key/value map to search for string values.
 * @param keys - Ordered candidate keys to probe in `record`; the first key with a non-empty trimmed string wins.
 * @returns The first matching trimmed string value, or `undefined` if none found.
 */
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

/**
 * Normalizes an email-like string by trimming surrounding whitespace and converting to lowercase.
 *
 * @param value - The input to normalize; only string inputs are processed.
 * @returns The trimmed, lowercased string if `value` is a non-empty string, `undefined` otherwise.
 */
function normalizeEmail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extracts a trimmed, non-empty account identifier from a heterogeneous record.
 *
 * @param record - Object to inspect for common account identifier keys
 * @returns The first matching trimmed identifier (`accountId`, `account_id`, `workspace_id`, `organization_id`, or `id`) or `undefined` if none found
 *
 * Concurrency: pure and side-effect-free (callers are responsible for any concurrent access coordination).
 * Filesystem: not applicable (no filesystem I/O; behavior same on Windows).
 * Token redaction: this function does not handle redaction or sensitive-data masking.
 */
function readAccountId(record: Record<string, unknown>): string | undefined {
	const keys = ["accountId", "account_id", "workspace_id", "organization_id", "id"];
	for (const key of keys) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return undefined;
}

/**
 * Produce an ActiveSelection by extracting common fields and token variants from an account record.
 *
 * @param record - Account object that may contain fields at top level or inside `auth.tokens`; keys may be camelCase or snake_case.
 * @returns An ActiveSelection with any discovered properties (`accountId`, `email`, `accessToken`, `refreshToken`, `expiresAt`, `idToken`); missing values are `undefined`.
 *
 * Concurrency: pure and side-effect-free; safe for concurrent use.
 * Filesystem/OS note: callers performing atomic file writes should handle platform-specific rename semantics (Windows may replace in-use targets).
 * Security: tokens are returned verbatim and must be redacted or secured by callers before logging or persisting.
 */
function extractSelectionFromAccountRecord(record: Record<string, unknown>): ActiveSelection {
	const auth = isRecord(record.auth) ? record.auth : undefined;
	const tokens = auth && isRecord(auth.tokens) ? auth.tokens : undefined;

	const accessToken =
		extractTokenFromRecord(record, ["accessToken", "access_token"]) ??
		(tokens ? extractTokenFromRecord(tokens, ["access_token", "accessToken"]) : undefined);
	const refreshToken =
		extractTokenFromRecord(record, ["refreshToken", "refresh_token"]) ??
		(tokens ? extractTokenFromRecord(tokens, ["refresh_token", "refreshToken"]) : undefined);
	const accountId =
		readAccountId(record) ??
		(tokens ? readTrimmedString(tokens.account_id) ?? readTrimmedString(tokens.accountId) : undefined);
	const idToken =
		extractTokenFromRecord(record, ["idToken", "id_token"]) ??
		(tokens ? extractTokenFromRecord(tokens, ["id_token", "idToken"]) : undefined);
	const email =
		normalizeEmail(record.email) ??
		normalizeEmail(record.user_email) ??
		normalizeEmail(record.username);
	const expiresAt =
		readNumber(record.expiresAt) ??
		readNumber(record.expires_at) ??
		(tokens ? readNumber(tokens.expires_at) : undefined);

	return {
		accountId,
		email,
		accessToken,
		refreshToken,
		expiresAt,
		idToken,
	};
}

/**
 * Locate the zero-based index of an account in `accounts` that matches the provided `selection`.
 *
 * Matches by `selection.accountId` first (exact trimmed account identifier), then by normalized `selection.email`.
 * The function operates on the provided in-memory snapshot and does not perform any I/O; callers should pass a stable array (no concurrent mutation during the call).
 * Note: this routine does not expose or redact token values — token handling/redaction must be performed by callers when logging or persisting results.
 * On Windows where account lists may be read from files, ensure the caller supplies the parsed array with platform-normalized paths/line endings.
 *
 * @param accounts - An array of account entries (each expected to be an object record); non-record entries are ignored.
 * @param selection - ActiveSelection containing `accountId` and/or `email` to match against accounts.
 * @returns The zero-based index of the first matching account, or `-1` if no match is found.
 */
function resolveMatchIndex(
	accounts: unknown[],
	selection: ActiveSelection,
): number {
	const desiredId = selection.accountId?.trim();
	const desiredEmail = normalizeEmail(selection.email);

	if (desiredId) {
		const byId = accounts.findIndex((entry) => {
			if (!isRecord(entry)) return false;
			return readAccountId(entry) === desiredId;
		});
		if (byId >= 0) return byId;
	}

	if (desiredEmail) {
		const byEmail = accounts.findIndex((entry) => {
			if (!isRecord(entry)) return false;
			return normalizeEmail(entry.email) === desiredEmail;
		});
		if (byEmail >= 0) return byEmail;
	}

	return -1;
}

/**
 * Produce an ISO 8601 timestamp for the given millisecond epoch or for the current time when the input is missing or invalid.
 *
 * @param ms - Milliseconds since the Unix epoch; if `undefined`, not finite, or not greater than zero, the current time is used.
 * @returns The timestamp as an ISO 8601 string corresponding to `ms`, or the current time if `ms` is absent or invalid.
 */
function toIsoTime(ms: number | undefined): string {
	if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
		return new Date(ms).toISOString();
	}
	return new Date().toISOString();
}

/**
 * Persist the provided authentication tokens and metadata into the Codex CLI auth state file.
 *
 * Performs an atomic replace of the target JSON file (temp file + rename) and updates a numeric
 * sync version timestamp stored as `codexMultiAuthSyncVersion`. The function clears any existing
 * `OPENAI_API_KEY` field. Callers must treat token values as sensitive — they will be written to
 * disk with file mode 0600. The write is atomic but concurrent writers can race; callers should
 * serialize calls when possible. On Windows the rename may replace the target file.
 *
 * @param path - Filesystem path to the auth state JSON file to update.
 * @param selection - ActiveSelection containing token fields (`accessToken`, `refreshToken`, `idToken`),
 *   optional `accountId`, `email`, and `expiresAt` used to populate persisted tokens and metadata.
 * @returns `true` if the auth state was validated and written successfully, `false` otherwise.
 */
async function writeCodexAuthState(
	path: string,
	selection: ActiveSelection,
): Promise<boolean> {
	const raw = existsSync(path) ? await fs.readFile(path, "utf-8") : "{}";
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed)) {
		log.warn("Failed to persist Codex auth selection", {
			operation: "write-active-selection",
			outcome: "malformed-auth-state",
			path,
		});
		return false;
	}

	const existingTokens = isRecord(parsed.tokens) ? parsed.tokens : {};
	const next = { ...parsed } as Record<string, unknown>;
	const nextTokens = { ...existingTokens } as Record<string, unknown>;

	const syncVersion = Date.now();
	const selectedAccessToken = readTrimmedString(selection.accessToken);
	const selectedRefreshToken = readTrimmedString(selection.refreshToken);
	const accessToken =
		selectedAccessToken ??
		(typeof existingTokens.access_token === "string" ? existingTokens.access_token : undefined);
	const refreshToken =
		selectedRefreshToken ??
		(typeof existingTokens.refresh_token === "string" ? existingTokens.refresh_token : undefined);

	if (!accessToken || !refreshToken) {
		log.warn("Failed to persist Codex auth selection", {
			operation: "write-active-selection",
			outcome: "missing-token-payload",
			path,
			accountRef: makeAccountFingerprint({
				accountId: selection.accountId,
				email: selection.email,
			}),
		});
		return false;
	}

	next.auth_mode = typeof parsed.auth_mode === "string" ? parsed.auth_mode : "chatgpt";
	next.OPENAI_API_KEY = null;
	const selectedEmail = normalizeEmail(selection.email);
	if (selectedEmail) {
		next.email = selectedEmail;
	}
	nextTokens.access_token = accessToken;
	nextTokens.refresh_token = refreshToken;
	const resolvedIdToken =
		readTrimmedString(selection.idToken) ??
		accessToken;
	nextTokens.id_token = resolvedIdToken;
	if (selection.accountId?.trim()) {
		nextTokens.account_id = selection.accountId.trim();
	}
	next.tokens = nextTokens;
	next.last_refresh = toIsoTime(selection.expiresAt);
	next.codexMultiAuthSyncVersion = syncVersion;

	const tempPath = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	await fs.mkdir(dirname(path), { recursive: true });
	await fs.writeFile(tempPath, JSON.stringify(next, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
	await fs.rename(tempPath, path);
	lastCodexCliSelectionWriteAt = syncVersion;
	return true;
}

/**
 * Persist the provided active selection into Codex CLI accounts and/or auth stores on disk.
 *
 * Writes are atomic (temp file + rename); at least one store must be successfully written for the function to return `true`. Callers should expect concurrent writers; on Windows rename semantics may fail if the target file is open. Sensitive token values from `selection` may be persisted to disk and are treated as sensitive for telemetry/logging — this function does not scrub tokens elsewhere.
 *
 * @param selection - Partial active selection with any of: accountId, email, accessToken, refreshToken, expiresAt, idToken. Provided fields are merged with discovered account data when updating the accounts store.
 * @returns `true` if changes were written to at least one persistent Codex CLI store (accounts or auth), `false` otherwise.
 */
export async function setCodexCliActiveSelection(
	selection: ActiveSelection,
): Promise<boolean> {
	if (!isCodexCliSyncEnabled()) return false;

	incrementCodexCliMetric("writeAttempts");
	const accountsPath = getCodexCliAccountsPath();
	const authPath = getCodexCliAuthPath();
	const hasAccountsPath = existsSync(accountsPath);
	const hasAuthPath = existsSync(authPath);

	if (!hasAccountsPath && !hasAuthPath) {
		incrementCodexCliMetric("writeFailures");
		return false;
	}

	try {
		let resolvedSelection: ActiveSelection = { ...selection };
		let wroteAccounts = false;
		let wroteAuth = false;

		if (hasAccountsPath) {
			const raw = await fs.readFile(accountsPath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) {
				log.warn("Failed to persist Codex CLI active selection", {
					operation: "write-active-selection",
					outcome: "malformed",
					path: accountsPath,
				});
			} else {
				const matchIndex = resolveMatchIndex(parsed.accounts, selection);
				if (matchIndex < 0) {
					log.warn("Failed to persist Codex CLI active selection", {
						operation: "write-active-selection",
						outcome: "no-match",
						path: accountsPath,
						accountRef: makeAccountFingerprint({
							accountId: selection.accountId,
							email: selection.email,
						}),
					});
					if (!hasAuthPath) {
						incrementCodexCliMetric("writeFailures");
						return false;
					}
				} else {
					const chosen = parsed.accounts[matchIndex];
					if (!isRecord(chosen)) {
						log.warn("Failed to persist Codex CLI active selection", {
							operation: "write-active-selection",
							outcome: "invalid-account-record",
							path: accountsPath,
						});
						if (!hasAuthPath) {
							incrementCodexCliMetric("writeFailures");
							return false;
						}
					} else {
						const chosenSelection = extractSelectionFromAccountRecord(chosen);
						resolvedSelection = {
							...resolvedSelection,
							accountId: resolvedSelection.accountId ?? chosenSelection.accountId,
							email: resolvedSelection.email ?? chosenSelection.email,
							accessToken: resolvedSelection.accessToken ?? chosenSelection.accessToken,
							refreshToken: resolvedSelection.refreshToken ?? chosenSelection.refreshToken,
							expiresAt: resolvedSelection.expiresAt ?? chosenSelection.expiresAt,
							idToken: resolvedSelection.idToken ?? chosenSelection.idToken,
						};

						const next = { ...parsed };
						const syncVersion = Date.now();
						const chosenAccountId = readAccountId(chosen) ?? selection.accountId?.trim();
						const chosenEmail = normalizeEmail(chosen.email) ?? normalizeEmail(selection.email);

						if (chosenAccountId) {
							next.activeAccountId = chosenAccountId;
							next.active_account_id = chosenAccountId;
						}
						if (chosenEmail) {
							next.activeEmail = chosenEmail;
							next.active_email = chosenEmail;
						}

						next.accounts = parsed.accounts.map((entry, index) => {
							if (!isRecord(entry)) return entry;
							const updated = { ...entry };
							updated.active = index === matchIndex;
							updated.isActive = index === matchIndex;
							updated.is_active = index === matchIndex;
							return updated;
						});
						next.codexMultiAuthSyncVersion = syncVersion;

						const tempPath = `${accountsPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
						await fs.mkdir(dirname(accountsPath), { recursive: true });
						await fs.writeFile(tempPath, JSON.stringify(next, null, 2), {
							encoding: "utf-8",
							mode: 0o600,
						});
						await fs.rename(tempPath, accountsPath);
						lastCodexCliSelectionWriteAt = syncVersion;
						wroteAccounts = true;
						log.debug("Persisted Codex CLI accounts selection", {
							operation: "write-active-selection",
							outcome: "success",
							path: accountsPath,
							accountRef: makeAccountFingerprint({
								accountId: chosenAccountId,
								email: chosenEmail,
							}),
						});
					}
				}
			}
		}

		if (hasAuthPath) {
			wroteAuth = await writeCodexAuthState(authPath, resolvedSelection);
			if (!wroteAuth) {
				if (!wroteAccounts) {
					incrementCodexCliMetric("writeFailures");
					return false;
				}
				log.warn("Codex auth state update skipped after accounts selection update", {
					operation: "write-active-selection",
					outcome: "accounts-updated-auth-failed",
					path: authPath,
					accountRef: makeAccountFingerprint({
						accountId: resolvedSelection.accountId,
						email: resolvedSelection.email,
					}),
				});
			} else {
				log.debug("Persisted Codex auth active selection", {
					operation: "write-active-selection",
					outcome: "success",
					path: authPath,
					accountRef: makeAccountFingerprint({
						accountId: resolvedSelection.accountId,
						email: resolvedSelection.email,
					}),
				});
			}
		}

		if (wroteAccounts || wroteAuth) {
			clearCodexCliStateCache();
			incrementCodexCliMetric("writeSuccesses");
			return true;
		}

		incrementCodexCliMetric("writeFailures");
		return false;
	} catch (error) {
		incrementCodexCliMetric("writeFailures");
		log.warn("Failed to persist Codex CLI active selection", {
			operation: "write-active-selection",
			outcome: "error",
			path: hasAccountsPath ? accountsPath : authPath,
			accountRef: makeAccountFingerprint({
				accountId: selection.accountId,
				email: selection.email,
			}),
			error: String(error),
		});
		return false;
	}
}

/**
 * Retrieve the most recent timestamp when a Codex CLI active selection was written.
 *
 * This value is maintained in-process and represents the last successful atomic write performed
 * by this process; it may not reflect writes made by other processes or external edits to the
 * underlying files. The timestamp is expressed as milliseconds since the Unix epoch (UTC).
 *
 * Notes:
 * - Concurrency: best-effort, process-local tracking — external concurrent writers are not observed.
 * - Windows filesystem: semantics reflect the process clock and do not imply any platform-specific
 *   atomicity guarantees beyond the writer's atomic rename behavior.
 * - Token redaction: this value contains no credential data and is safe to expose for observability.
 *
 * @returns The last write time as milliseconds since epoch, or `0` if no write has occurred.
 */
export function getLastCodexCliSelectionWriteTimestamp(): number {
	return lastCodexCliSelectionWriteAt;
}
