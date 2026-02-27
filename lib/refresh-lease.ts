import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { safeParseTokenResult } from "./schemas.js";
import type { TokenResult } from "./types.js";

const log = createLogger("refresh-lease");

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 35_000;
const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_RESULT_TTL_MS = 20_000;

interface LeaseFilePayload {
	tokenHash: string;
	pid: number;
	acquiredAt: number;
	expiresAt: number;
}

interface ResultFilePayload {
	tokenHash: string;
	createdAt: number;
	result: TokenResult;
}

export interface RefreshLeaseCoordinatorOptions {
	enabled?: boolean;
	leaseDir?: string;
	leaseTtlMs?: number;
	waitTimeoutMs?: number;
	pollIntervalMs?: number;
	resultTtlMs?: number;
}

export interface RefreshLeaseHandle {
	role: "owner" | "follower" | "bypass";
	result?: TokenResult;
	release: (result?: TokenResult) => Promise<void>;
}

/**
 * Parse an environment-style boolean string into a boolean value.
 *
 * Recognizes (case-insensitive, trimmed) "1", "true", and "yes" as true; "0", "false", and "no" as false.
 *
 * @param value - The environment string to parse, or undefined if not set
 * @returns `true` for recognized true values, `false` for recognized false values, or `undefined` if the input is undefined or not recognized
 */
function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no") return false;
	return undefined;
}

/**
 * Parse a base-10 integer from a string, returning undefined for missing or invalid input.
 *
 * @param value - The string to parse; may be `undefined`.
 * @returns The parsed integer, or `undefined` if `value` is `undefined` or not a valid integer.
 */
function parseEnvInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Pause execution for the specified number of milliseconds.
 *
 * @param delayMs - Number of milliseconds to wait before resuming
 * @returns Nothing
 */
function sleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, delayMs);
	});
}

/**
 * Compute a stable SHA-256 hex digest of a refresh token for safe identification and storage.
 *
 * The result is a deterministic, non-reversible identifier suitable for use in filenames and comparisons
 * across platforms (including Windows). Treat the input `refreshToken` as sensitive and redact or avoid
 * logging it; only the hex digest should be stored or displayed. This function is pure and safe for concurrent use.
 *
 * @param refreshToken - The raw refresh token (sensitive); do not log or expose this value.
 * @returns The hex-encoded SHA-256 digest of `refreshToken`.
 */
function hashRefreshToken(refreshToken: string): string {
	return createHash("sha256").update(refreshToken).digest("hex");
}

/**
 * Type guard that determines whether a value is a non-null object.
 *
 * @param value - The value to test
 * @returns `true` if `value` is an object and not `null`, `false` otherwise
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * Validate and normalize a parsed lease file payload produced from JSON.
 *
 * Accepts an arbitrary value (typically the result of JSON.parse) and returns a
 * normalized LeaseFilePayload if the value contains valid `tokenHash` (non-empty
 * string), `pid`, `acquiredAt`, and `expiresAt` (all finite numbers). Numeric
 * fields are floored to integers.
 *
 * Concurrency & platform notes: this function performs pure validation only;
 * it does not examine filesystem state or concurrency. `tokenHash` is treated
 * as an opaque, already-redacted identifier (e.g., a SHA-256 hex digest) and
 * is not transformed or un-redacted here.
 *
 * @param raw - The raw parsed JSON value to validate as a lease payload
 * @returns A normalized LeaseFilePayload when `raw` is valid, or `null` otherwise
 */
function parseLeasePayload(raw: unknown): LeaseFilePayload | null {
	if (!isRecord(raw)) return null;
	const tokenHash = typeof raw.tokenHash === "string" ? raw.tokenHash : "";
	const pid = typeof raw.pid === "number" ? raw.pid : Number.NaN;
	const acquiredAt = typeof raw.acquiredAt === "number" ? raw.acquiredAt : Number.NaN;
	const expiresAt = typeof raw.expiresAt === "number" ? raw.expiresAt : Number.NaN;
	if (
		tokenHash.length === 0 ||
		!Number.isFinite(pid) ||
		!Number.isFinite(acquiredAt) ||
		!Number.isFinite(expiresAt)
	) {
		return null;
	}
	return {
		tokenHash,
		pid: Math.floor(pid),
		acquiredAt: Math.floor(acquiredAt),
		expiresAt: Math.floor(expiresAt),
	};
}

/**
 * Validates and normalizes a parsed result-file payload.
 *
 * Accepts an arbitrary value (typically parsed JSON) and returns a validated
 * ResultFilePayload when it contains a non-empty `tokenHash` (expected to be a
 * redacted SHA-256 hex digest), a finite numeric `createdAt` (returned as an
 * integer), and a parsable `result`. Does not expose raw tokens.
 *
 * Note: this function performs pure validation only (no filesystem or concurrency
 * side effects) and is safe to use on Windows.
 *
 * @param raw - The untrusted value to validate (usually the result of JSON.parse)
 * @returns The normalized ResultFilePayload when valid, or `null` if validation fails
 */
function parseResultPayload(raw: unknown): ResultFilePayload | null {
	if (!isRecord(raw)) return null;
	const tokenHash = typeof raw.tokenHash === "string" ? raw.tokenHash : "";
	const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Number.NaN;
	const result = safeParseTokenResult(raw.result);
	if (tokenHash.length === 0 || !Number.isFinite(createdAt) || !result) return null;
	return {
		tokenHash,
		createdAt: Math.floor(createdAt),
		result,
	};
}

/**
 * Read and parse a UTF-8 JSON file, returning the parsed value or null on error.
 *
 * Concurrency note: the file may be concurrently written; this function treats
 * read or parse failures (including partial writes) as a null result.
 *
 * Windows note: file locking/atomic rename semantics vary on Windows; callers
 * should not assume atomicity of on-disk updates when coordinating across
 * processes on Windows.
 *
 * Security note: the returned value may contain sensitive fields (e.g., tokens);
 * callers are responsible for redacting or handling secrets appropriately.
 *
 * @param path - Filesystem path to the JSON file
 * @returns The parsed JSON value, or `null` if the file cannot be read or parsed
 */
async function readJson(path: string): Promise<unknown | null> {
	try {
		const content = await fs.readFile(path, "utf8");
		return JSON.parse(content) as unknown;
	} catch {
		return null;
	}
}

/**
 * Attempts to remove a file at the given path; ignores "file not found" and never throws.
 *
 * This is a best-effort, non-failing unlink used for cleanup: any ENOENT is silently ignored;
 * other errors (for example on Windows when a file is locked) are logged at debug level and not propagated.
 *
 * Concurrency: safe to call concurrently from multiple processes or threads — race conditions that cause
 * the file to already be removed are handled via ENOENT suppression.
 *
 * Security: the function logs the supplied path on failures; callers should redact any sensitive tokens
 * from paths before passing them in.
 *
 * @param path - Filesystem path to remove (caller is responsible for providing a sanitized/redacted path if needed)
 */
async function safeUnlink(path: string): Promise<void> {
	try {
		await fs.unlink(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.debug("Failed to remove lease artifact", {
				path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

export class RefreshLeaseCoordinator {
	private readonly enabled: boolean;
	private readonly leaseDir: string;
	private readonly leaseTtlMs: number;
	private readonly waitTimeoutMs: number;
	private readonly pollIntervalMs: number;
	private readonly resultTtlMs: number;

	constructor(options: RefreshLeaseCoordinatorOptions = {}) {
		this.enabled = options.enabled ?? true;
		this.leaseDir = options.leaseDir ?? join(getCodexMultiAuthDir(), "refresh-leases");
		this.leaseTtlMs = Math.max(1_000, Math.floor(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS));
		this.waitTimeoutMs = Math.max(0, Math.floor(options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
		this.pollIntervalMs = Math.max(50, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
		this.resultTtlMs = Math.max(1_000, Math.floor(options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS));
	}

	static fromEnvironment(): RefreshLeaseCoordinator {
		const testMode = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
		const enabled =
			parseBooleanEnv(process.env.CODEX_AUTH_REFRESH_LEASE) ??
			(testMode ? false : true);
		return new RefreshLeaseCoordinator({
			enabled,
			leaseDir:
				(process.env.CODEX_AUTH_REFRESH_LEASE_DIR ?? "").trim() || undefined,
			leaseTtlMs: parseEnvInt(process.env.CODEX_AUTH_REFRESH_LEASE_TTL_MS),
			waitTimeoutMs: parseEnvInt(process.env.CODEX_AUTH_REFRESH_LEASE_WAIT_MS),
			pollIntervalMs: parseEnvInt(process.env.CODEX_AUTH_REFRESH_LEASE_POLL_MS),
			resultTtlMs: parseEnvInt(process.env.CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS),
		});
	}

	async acquire(refreshToken: string): Promise<RefreshLeaseHandle> {
		if (!this.enabled) {
			return this.createBypassHandle("disabled");
		}
		if (refreshToken.trim().length === 0) {
			return this.createBypassHandle("empty-token");
		}

		const tokenHash = hashRefreshToken(refreshToken);
		const lockPath = join(this.leaseDir, `${tokenHash}.lock`);
		const resultPath = join(this.leaseDir, `${tokenHash}.result.json`);
		await fs.mkdir(this.leaseDir, { recursive: true });
		void this.pruneExpiredArtifacts();

		const deadline = Date.now() + this.waitTimeoutMs;
		while (true) {
			const cachedResult = await this.readFreshResult(resultPath, tokenHash);
			if (cachedResult) {
				return {
					role: "follower",
					result: cachedResult,
					release: async () => {
						// Follower does not own lock.
					},
				};
			}

			try {
				const handle = await fs.open(lockPath, "wx");
				try {
					const now = Date.now();
					const payload: LeaseFilePayload = {
						tokenHash,
						pid: process.pid,
						acquiredAt: now,
						expiresAt: now + this.leaseTtlMs,
					};
					await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
				} finally {
					await handle.close();
				}

				return this.createOwnerHandle(tokenHash, lockPath, resultPath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") {
					log.warn("Refresh lease acquisition failed; proceeding without lease", {
						error: error instanceof Error ? error.message : String(error),
					});
					return this.createBypassHandle("acquire-error");
				}

				if (await this.isLockStale(lockPath, tokenHash)) {
					await safeUnlink(lockPath);
					continue;
				}

				if (Date.now() >= deadline) {
					log.warn("Refresh lease wait timeout; proceeding without lease", {
						waitTimeoutMs: this.waitTimeoutMs,
					});
					return this.createBypassHandle("wait-timeout");
				}
				await sleep(this.pollIntervalMs);
			}
		}
	}

	private createBypassHandle(reason: string): RefreshLeaseHandle {
		log.debug("Bypassing refresh lease", { reason });
		return {
			role: "bypass",
			release: async () => {
				// No-op
			},
		};
	}

	private createOwnerHandle(
		tokenHash: string,
		lockPath: string,
		resultPath: string,
	): RefreshLeaseHandle {
		let released = false;
		return {
			role: "owner",
			release: async (result?: TokenResult) => {
				if (released) return;
				released = true;
				try {
					if (result) {
						await this.writeResult(resultPath, tokenHash, result);
					}
				} finally {
					await safeUnlink(lockPath);
				}
			},
		};
	}

	private async writeResult(
		resultPath: string,
		tokenHash: string,
		result: TokenResult,
	): Promise<void> {
		const payload: ResultFilePayload = {
			tokenHash,
			createdAt: Date.now(),
			result,
		};
		const tempPath = `${resultPath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
			await fs.rename(tempPath, resultPath);
		} finally {
			await safeUnlink(tempPath);
		}
	}

	private async readFreshResult(
		resultPath: string,
		tokenHash: string,
	): Promise<TokenResult | null> {
		if (!existsSync(resultPath)) return null;
		const parsed = parseResultPayload(await readJson(resultPath));
		if (!parsed || parsed.tokenHash !== tokenHash) {
			return null;
		}
		const ageMs = Date.now() - parsed.createdAt;
		if (ageMs > this.resultTtlMs) {
			await safeUnlink(resultPath);
			return null;
		}
		return parsed.result;
	}

	private async isLockStale(lockPath: string, tokenHash: string): Promise<boolean> {
		let staleByPayload = false;
		const parsed = parseLeasePayload(await readJson(lockPath));
		if (!parsed || parsed.tokenHash !== tokenHash) {
			staleByPayload = true;
		} else if (parsed.expiresAt <= Date.now()) {
			staleByPayload = true;
		}
		if (staleByPayload) {
			return true;
		}

		try {
			const stat = await fs.stat(lockPath);
			return Date.now() - stat.mtimeMs > this.leaseTtlMs;
		} catch {
			return true;
		}
	}

	private async pruneExpiredArtifacts(): Promise<void> {
		try {
			const entries = await fs.readdir(this.leaseDir, { withFileTypes: true });
			const now = Date.now();
			const maxAgeMs = Math.max(this.leaseTtlMs, this.resultTtlMs) * 2;
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				if (!entry.name.endsWith(".lock") && !entry.name.endsWith(".result.json")) continue;
				const fullPath = join(this.leaseDir, entry.name);
				try {
					const stat = await fs.stat(fullPath);
					if (now - stat.mtimeMs > maxAgeMs) {
						await safeUnlink(fullPath);
					}
				} catch {
					// Best effort.
				}
			}
		} catch {
			// Best effort.
		}
	}
}
