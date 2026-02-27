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
 * @returns `true` if `value` is an object and not `null` or an array, `false` otherwise.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Produce a trimmed non-empty string from an input value.
 *
 * @param value - The value to normalize; if it's a string, leading and trailing whitespace are removed.
 * @returns `string` if `value` is a string containing non-whitespace characters after trimming, `undefined` otherwise.
 */
function readTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parses a value and returns it as a finite number when possible.
 *
 * @param value - The input to parse; may be a number or a numeric string.
 * @returns The finite numeric value represented by `value`, or `undefined` if it cannot be parsed as a finite number.
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
 * Extracts the first non-empty trimmed string value from `record` using the provided `keys`.
 *
 * @param record - Plain object to read values from.
 * @param keys - Ordered list of property names to check on `record`.
 * @returns `string` with the first found non-empty trimmed value, `undefined` if none found.
 *
 * Concurrency: pure and side-effect-free; safe for concurrent use. Windows filesystem: no filesystem interaction. 
 * Security: returned token is raw credential material and MUST be redacted before logging or emitting to telemetry.
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
 * Normalize an email-like string by trimming whitespace and converting to lowercase.
 *
 * @param value - The input value to normalize; only string inputs are processed.
 * @returns The trimmed, lowercased string if `value` is a non-empty string after trimming, `undefined` otherwise.
 */
function normalizeEmail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extracts the first non-empty account identifier from a record by checking common field names.
 *
 * @param record - Object to search for an account identifier
 * @returns The trimmed identifier from the first matching key, or `undefined` if none found
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
 * Build an ActiveSelection by extracting account id, email, tokens, and expiration from a possibly nested account record.
 *
 * This function reads common field variants (camelCase and snake_case) and favors top-level values over nested auth.tokens.
 * It performs normalization for email and numeric parsing for expiration but does not mutate the input.
 *
 * Concurrency: pure and synchronous — safe to call concurrently from multiple threads/tasks.
 * Filesystem: performs no I/O and has no Windows-specific filesystem behavior.
 * Token handling: extracted tokens are returned unmodified; callers must redact or treat them as sensitive before logging or persisting.
 *
 * @param record - A plain object representing an account entry; may contain nested `auth.tokens`.
 * @returns An ActiveSelection containing any of the following if found: `accountId`, `email`, `accessToken`, `refreshToken`, `idToken`, and `expiresAt` (milliseconds timestamp).
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
 * Find the index of an account in `accounts` that matches the given `selection` by account ID or normalized email.
 *
 * @param accounts - Array of account entries; entries may be arbitrary values (non-records are skipped).
 * @param selection - ActiveSelection containing optional `accountId` and/or `email` used for matching.
 * @returns The index of the matching account in `accounts`, or `-1` if no match is found.
 *
 * Notes:
 * - Concurrency: callers should serialize concurrent updates that rely on this index to avoid races.
 * - Filesystem/Windows: callers that persist results should handle Windows atomic-rename semantics separately.
 * - Token redaction: this function only matches identifiers and emails; it does not read or redact tokens.
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
 * Convert a millisecond epoch value to an ISO 8601 timestamp string.
 *
 * @param ms - Milliseconds since Unix epoch; if not a finite number greater than 0, the current time is used
 * @returns An ISO 8601 formatted timestamp string corresponding to `ms` when valid, otherwise the current time
 */
function toIsoTime(ms: number | undefined): string {
	if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
		return new Date(ms).toISOString();
	}
	return new Date().toISOString();
}

/**
 * Persist the provided ActiveSelection into the Codex CLI auth state file, merging with existing state.
 *
 * Merges incoming token/email/account fields with any existing auth state, enforces presence of both
 * access and refresh tokens, updates token fields (access_token, refresh_token, id_token, account_id),
 * sets `auth_mode` (defaulting to "chatgpt"), `OPENAI_API_KEY` to null, `last_refresh` to the selection's
 * expiry, and stamps `codexMultiAuthSyncVersion`. Writes atomically via a temporary file and sets file
 * permissions to 0o600 on supported platforms.
 *
 * Concurrency and platform notes:
 * - The function performs an atomic rename of a temp file to the target path; callers must still coordinate
 *   concurrent writers at a higher level to avoid lost updates.
 * - On Windows, file permission semantics differ; the mode hint may not be fully enforced by the OS.
 *
 * Token handling:
 * - Provided token strings are trimmed; existing token values are preserved when not overridden.
 * - `id_token` falls back to the access token if not explicitly provided.
 * - Sensitive tokens are written to disk; callers should treat the target file as secret and the function
 *   will set restrictive file mode where supported.
 *
 * @param path - Filesystem path to the auth state JSON file to update.
 * @param selection - ActiveSelection containing optional tokens, accountId, email, and expiresAt to persist.
 * @returns `true` if the auth state file was successfully written and tokens persisted, `false` otherwise.
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
 * Persist the provided active selection to Codex CLI storage (accounts and/or auth) and update in-memory state.
 *
 * Attempts to write the given selection to the Codex CLI accounts file and/or the auth state file depending on which paths exist.
 * When writing accounts, the matching account entry will be marked active and top-level active identifiers will be updated.
 * When writing auth, tokens and related metadata are merged with existing auth state and validated before persisting.
 *
 * Concurrency and filesystem notes:
 * - Writes are performed via atomic tempfile->rename semantics; callers should expect eventual consistency if concurrent writers run.
 * - On Windows the atomic rename behavior depends on platform semantics; temporary file and rename steps are used to minimize partial-write visibility.
 *
 * Token handling and redaction:
 * - Access, refresh, and id tokens are merged and validated; missing required tokens cause the auth write to fail.
 * - Logs and metrics avoid emitting raw tokens; any token-related fingerprinting uses redacted identifiers.
 *
 * @param selection - Partial or complete ActiveSelection describing the desired active account and tokens. Fields provided override values read from storage; missing fields are filled from matched account records when available.
 * @returns `true` if at least one storage path was successfully updated, `false` otherwise.
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
 * Returns the timestamp of the last successful Codex CLI active-selection write attempt.
 *
 * This value is updated when the library successfully writes accounts or auth state to disk.
 * Concurrency assumption: multiple processes may race; this value reflects only in-process updates
 * performed by this runtime and is not a cross-process lock. On Windows the underlying write uses
 * a temp-file-then-rename pattern which may behave differently across processes. The timestamp
 * contains only a millisecond epoch and does not include any tokens or sensitive data.
 *
 * @returns The last successful write time as milliseconds since the Unix epoch, or `0` if no write has completed.
 */
export function getLastCodexCliSelectionWriteTimestamp(): number {
	return lastCodexCliSelectionWriteAt;
}
