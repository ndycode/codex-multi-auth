import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeJWT } from "../auth/auth.js";
import { extractAccountEmail, extractAccountId } from "../auth/token-utils.js";
import { createLogger } from "../logger.js";
import {
	incrementCodexCliMetric,
	makeAccountFingerprint,
} from "./observability.js";

const log = createLogger("codex-cli-state");
const CACHE_TTL_MS = 5_000;

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
const emittedWarnings = new Set<string>();

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

export function getCodexCliAccountsPath(): string {
	const override = (process.env.CODEX_CLI_ACCOUNTS_PATH ?? "").trim();
	if (override.length > 0) return override;
	return join(homedir(), ".codex", "accounts.json");
}

export function getCodexCliAuthPath(): string {
	const override = (process.env.CODEX_CLI_AUTH_PATH ?? "").trim();
	if (override.length > 0) return override;
	return join(homedir(), ".codex", "auth.json");
}

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

	const accountsPath = getCodexCliAccountsPath();
	const authPath = getCodexCliAuthPath();
	incrementCodexCliMetric("readAttempts");
	cacheLoadedAt = now;

	const hasAccountsPath = existsSync(accountsPath);
	const hasAuthPath = existsSync(authPath);
	if (!hasAccountsPath && !hasAuthPath) {
		incrementCodexCliMetric("readMisses");
		cache = null;
		return null;
	}

	try {
		if (hasAccountsPath) {
			const raw = await fs.readFile(accountsPath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			let sourceUpdatedAtMs: number | undefined;
			try {
				sourceUpdatedAtMs = (await fs.stat(accountsPath)).mtimeMs;
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
		}

		if (hasAuthPath) {
			const raw = await fs.readFile(authPath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			let sourceUpdatedAtMs: number | undefined;
			try {
				sourceUpdatedAtMs = (await fs.stat(authPath)).mtimeMs;
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
}

export function __resetCodexCliWarningCacheForTests(): void {
	emittedWarnings.clear();
}
