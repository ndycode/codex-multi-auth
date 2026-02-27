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
let activeSelectionWriteQueue: Promise<void> = Promise.resolve();

interface ActiveSelection {
	accountId?: string;
	email?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	idToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
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

function normalizeEmail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : undefined;
}

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

function toIsoTime(ms: number | undefined): string {
	if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
		return new Date(ms).toISOString();
	}
	return new Date().toISOString();
}

async function atomicWriteJson(path: string, payload: Record<string, unknown>): Promise<void> {
	const tempPath = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	await fs.mkdir(dirname(path), { recursive: true });
	try {
		await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});

		let lastRenameError: NodeJS.ErrnoException | null = null;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				await fs.rename(tempPath, path);
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EPERM" || code === "EBUSY") {
					lastRenameError = error as NodeJS.ErrnoException;
					await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
					continue;
				}
				throw error;
			}
		}
		if (lastRenameError) throw lastRenameError;
	} finally {
		try {
			await fs.unlink(tempPath);
		} catch {
			// Best effort temp-file cleanup.
		}
	}
}

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
		(typeof existingTokens.id_token === "string" ? existingTokens.id_token : undefined);
	if (resolvedIdToken) {
		nextTokens.id_token = resolvedIdToken;
	}
	if (selection.accountId?.trim()) {
		nextTokens.account_id = selection.accountId.trim();
	}
	next.tokens = nextTokens;
	next.last_refresh = toIsoTime(selection.expiresAt);
	next.codexMultiAuthSyncVersion = syncVersion;

	await atomicWriteJson(path, next);
	lastCodexCliSelectionWriteAt = Math.max(lastCodexCliSelectionWriteAt, syncVersion);
	return true;
}

async function enqueueActiveSelectionWrite<T>(task: () => Promise<T>): Promise<T> {
	let releaseQueue!: () => void;
	const queueTail = new Promise<void>((resolve) => {
		releaseQueue = resolve;
	});
	const previous = activeSelectionWriteQueue;
	activeSelectionWriteQueue = previous
		.catch(() => {
			// Keep queue alive even if a previous task failed.
		})
		.then(() => queueTail);
	await previous.catch(() => {
		// Ignore previous failure, current task still runs.
	});
	try {
		return await task();
	} finally {
		releaseQueue();
	}
}

export async function setCodexCliActiveSelection(
	selection: ActiveSelection,
): Promise<boolean> {
	return enqueueActiveSelectionWrite(async () => {
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
						const hasSelectionTokens =
							typeof selection.accessToken === "string" &&
							selection.accessToken.trim().length > 0 &&
							typeof selection.refreshToken === "string" &&
							selection.refreshToken.trim().length > 0;
						log.warn("Failed to persist Codex CLI active selection", {
							operation: "write-active-selection",
							outcome: "no-match",
							path: accountsPath,
							accountRef: makeAccountFingerprint({
								accountId: selection.accountId,
								email: selection.email,
							}),
						});
						if (!hasAuthPath || !hasSelectionTokens) {
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

							await atomicWriteJson(accountsPath, next);
							lastCodexCliSelectionWriteAt = Math.max(lastCodexCliSelectionWriteAt, syncVersion);
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
	});
}

export function getLastCodexCliSelectionWriteTimestamp(): number {
	return lastCodexCliSelectionWriteAt;
}
