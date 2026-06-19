import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { PLUGIN_NAME } from "./constants.js";
import { getCodexLogDir } from "./runtime-paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogClient {
	app?: {
		log?: (options: {
			body: {
				service: string;
				level: LogLevel;
				message: string;
				extra?: Record<string, unknown>;
			};
		}) => unknown;
	};
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const TOKEN_PATTERNS = [
	/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
	/[a-f0-9]{40,}/gi,
	/sk-[A-Za-z0-9]{20,}/g,
	/Bearer\s+\S+/gi,
	// This app's own local bearer tokens: `cma_local_<base64url>` (see
	// lib/local-client-tokens.ts). The structured-log key masker and the OAuth
	// scrubber cover the normal paths, but the free-text scrubber is the last
	// line of defense and must recognize the project's own token shape too.
	/cma_local_[A-Za-z0-9_-]{16,}/g,
];

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const SENSITIVE_KEYS = new Set([
	"access",
	"accesstoken",
	"access_token",
	"refresh",
	"refreshtoken",
	"refresh_token",
	"token",
	"authorization",
	"apikey",
	"api_key",
	"experimentalbearertoken",
	"secret",
	"password",
	"credential",
	"id_token",
	"idtoken",
	"email",
	"accountid",
	"account_id",
]);

function maskToken(token: string): string {
	if (token.length <= 12) return "***MASKED***";
	return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function maskEmail(email: string): string {
	const atIndex = email.indexOf("@");
	if (atIndex < 0) return "***@***";
	const local = email.slice(0, atIndex);
	const domain = email.slice(atIndex + 1);
	const parts = domain.split(".");
	const tld = parts.pop() || "";
	const prefix = local.slice(0, Math.min(2, local.length));
	return `${prefix}***@***.${tld}`;
}

function maskString(value: string): string {
	let result = value;
	// Mask emails first (before token patterns might match parts of them)
	result = result.replace(EMAIL_PATTERN, (match) => maskEmail(match));
	for (const pattern of TOKEN_PATTERNS) {
		result = result.replace(pattern, (match) => maskToken(match));
	}
	return result;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
	if (depth > 10) return "[max depth]";

	if (typeof value === "string") {
		return maskString(value);
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item, depth + 1));
	}

	if (value !== null && typeof value === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
			if (SENSITIVE_KEYS.has(normalizedKey)) {
				if (typeof val !== "string") {
					sanitized[key] = "***MASKED***";
				} else if (normalizedKey === "email") {
					// An email value masked with maskToken leaks the local part and TLD
					// (alice@example.com -> alice@....com). Use the dedicated email masker
					// so structured `email` fields match the free-text path (maskString).
					sanitized[key] = maskEmail(val);
				} else {
					sanitized[key] = maskToken(val);
				}
			} else {
				sanitized[key] = sanitizeValue(val, depth + 1);
			}
		}
		return sanitized;
	}

	return value;
}

function parseLogLevel(value: string | undefined): LogLevel {
	if (!value) return "info";
	const normalized = value.toLowerCase().trim() as LogLevel;
	if (normalized in LOG_LEVEL_PRIORITY) return normalized;
	return "info";
}

export const LOGGING_ENABLED = process.env.ENABLE_PLUGIN_REQUEST_LOGGING === "1";
export const REQUEST_BODY_LOGGING_ENABLED = process.env.CODEX_PLUGIN_LOG_BODIES === "1";
export const DEBUG_ENABLED = process.env.DEBUG_CODEX_PLUGIN === "1" || LOGGING_ENABLED;
export const LOG_LEVEL = parseLogLevel(process.env.CODEX_PLUGIN_LOG_LEVEL);
const CONSOLE_LOG_ENABLED = process.env.CODEX_CONSOLE_LOG === "1";
const LOG_DIR = join(getCodexLogDir(), "codex-plugin");
const LOG_DIR_RETRYABLE_ERRORS = new Set(["EBUSY", "EPERM"]);
const LOG_DIR_MAX_ATTEMPTS = 3;

let client: LogClient | null = null;

// Correlation id storage (errors-logging-02).
//
// A single process-global was wrong for the concurrent runtime proxy: many
// requests are in flight at once, so a global last-writer-wins value tags log
// lines with the wrong request. AsyncLocalStorage scopes the id to the async
// context of each request. A module-global fallback is retained ONLY for the
// legacy set/clear callers (index.ts plugin-host path) that are effectively
// single-flight; new concurrent code should use runWithCorrelationId.
const correlationStore = new AsyncLocalStorage<{ id: string | null }>();
let fallbackCorrelationId: string | null = null;

/**
 * Run `fn` with a correlation id bound to its async context. Concurrent-safe:
 * each invocation gets an isolated id that does not leak across requests.
 */
export function runWithCorrelationId<T>(id: string | undefined, fn: () => T): T {
	return correlationStore.run({ id: id ?? randomUUID() }, fn);
}

export function setCorrelationId(id?: string): string {
	const resolved = id ?? randomUUID();
	const store = correlationStore.getStore();
	if (store) {
		// Inside an ALS scope: update the scoped id in place.
		store.id = resolved;
	} else {
		// Legacy single-flight path: keep the module-global fallback working.
		fallbackCorrelationId = resolved;
	}
	return resolved;
}

export function getCorrelationId(): string | null {
	// Inside an ALS scope the scoped id is authoritative (including a cleared
	// null); only fall back to the module-global when no scope is active. This
	// keeps the declared `string | null` contract honest after clearCorrelationId
	// runs inside runWithCorrelationId — returning the empty sentinel would leak
	// "" to callers doing an explicit `=== null` check.
	const store = correlationStore.getStore();
	return store ? store.id : fallbackCorrelationId;
}

export function clearCorrelationId(): void {
	const store = correlationStore.getStore();
	if (store) {
		store.id = null;
	} else {
		fallbackCorrelationId = null;
	}
}

export function initLogger(newClient: LogClient): void {
	client = newClient;
}

function logToApp(
	level: LogLevel,
	message: string,
	data?: unknown,
	service: string = PLUGIN_NAME,
): void {
	const appLog = client?.app?.log;
	if (!appLog) return;

	const sanitizedMessage = maskString(message).replace(/[\r\n]+/g, " ");
	const sanitizedData = data === undefined ? undefined : sanitizeValue(data);
	const correlationId = getCorrelationId();
	const extraData: Record<string, unknown> = {};
	
	if (correlationId) {
		extraData.correlationId = correlationId;
	}
	if (sanitizedData !== undefined) {
		extraData.data = typeof sanitizedData === "object" ? sanitizedData : { value: sanitizedData };
	}
	
	const extra = Object.keys(extraData).length > 0 ? extraData : undefined;

	try {
		const result = appLog({
			body: {
				service,
				level,
				message: sanitizedMessage,
				extra,
			},
		});
		if (result && typeof (result as Promise<unknown>).catch === "function") {
			(result as Promise<unknown>).catch(() => {});
		}
	} catch {
		// Ignore app log failures
	}
}

function logToConsole(level: LogLevel, message: string, data?: unknown): void {
	if (!CONSOLE_LOG_ENABLED) return;
	// Strip CR/LF like logToApp does: a message carrying embedded newlines could
	// otherwise forge extra log lines when console output is captured to a file
	// or aggregator (log injection).
	const sanitizedMessage = maskString(message).replace(/[\r\n]+/g, " ");
	const sanitizedData = data === undefined ? undefined : sanitizeValue(data);
	// This is the single sanctioned console sink for the whole package: every
	// message is mask-sanitized above before it reaches the terminal. The
	// no-console lint rule (request-10) intentionally points all other lib code
	// here, so the direct console calls below are allowed.
	/* eslint-disable no-console */
	if (sanitizedData !== undefined) {
		if (level === "warn") console.warn(sanitizedMessage, sanitizedData);
		else if (level === "error") console.error(sanitizedMessage, sanitizedData);
		else console.log(sanitizedMessage, sanitizedData);
		return;
	}

	if (level === "warn") console.warn(sanitizedMessage);
	else if (level === "error") console.error(sanitizedMessage);
	else console.log(sanitizedMessage);
	/* eslint-enable no-console */
}

if (LOGGING_ENABLED) {
	logToConsole(
		"info",
		REQUEST_BODY_LOGGING_ENABLED
			? `[${PLUGIN_NAME}] Request logging ENABLED (raw payload capture ON) - logs will be saved to: ${LOG_DIR}`
			: `[${PLUGIN_NAME}] Request logging ENABLED (metadata only; set CODEX_PLUGIN_LOG_BODIES=1 for raw payloads) - logs will be saved to: ${LOG_DIR}`,
	);
}
if (DEBUG_ENABLED && !LOGGING_ENABLED) {
	logToConsole(
		"info",
		`[${PLUGIN_NAME}] Debug logging ENABLED (level: ${LOG_LEVEL})`,
	);
}

let requestCounter = 0;

function sanitizeRequestLogData(data: Record<string, unknown>): Record<string, unknown> {
	if (REQUEST_BODY_LOGGING_ENABLED) {
		return data;
	}

	let omittedPayloads = false;
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
		if (normalizedKey === "body" || normalizedKey === "fullcontent") {
			omittedPayloads = true;
			continue;
		}
		sanitized[key] = value;
	}
	if (omittedPayloads) {
		sanitized.payloadsOmitted = true;
	}
	return sanitized;
}

function shouldLog(level: LogLevel): boolean {
	if (level === "error") return true;
	if (!DEBUG_ENABLED && !LOGGING_ENABLED) return false;
	return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[LOG_LEVEL];
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = ((ms % 60000) / 1000).toFixed(1);
	return `${minutes}m ${seconds}s`;
}

// Once the log dir is confirmed to exist we never need to stat/mkdir again for
// this process, so the hot logging path does no filesystem work after the first
// success.
let logDirReady = false;

/**
 * Ensure the log directory exists (best-effort, synchronous, non-blocking).
 *
 * Logging is fire-and-forget on a concurrent request path, so this must never
 * block the event loop. The previous implementation slept via `Atomics.wait`,
 * which froze ALL in-flight requests for up to ~30ms on a transient Windows
 * EBUSY/EPERM from antivirus/the indexer. Instead we retry the mkdir a few times
 * immediately (no sleep); a directory lock is typically released within a tick,
 * and if it genuinely persists we skip this one log line rather than stalling
 * the proxy. Success is cached so the steady state does a single existsSync.
 */
function ensureLogDir(path: string): boolean {
	if (logDirReady) return true;
	let lastError: unknown;
	for (let attempt = 0; attempt < LOG_DIR_MAX_ATTEMPTS; attempt += 1) {
		try {
			if (!existsSync(path)) {
				mkdirSync(path, { recursive: true, mode: 0o700 });
			}
			logDirReady = true;
			return true;
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (LOG_DIR_RETRYABLE_ERRORS.has(code) && attempt + 1 < LOG_DIR_MAX_ATTEMPTS) {
				// Immediate retry (no event-loop-blocking sleep). A transient lock is
				// usually gone by the next attempt; persistent contention falls through.
				continue;
			}
			break;
		}
	}
	logToConsole("warn", `[${PLUGIN_NAME}] Failed to ensure log directory`, {
		path,
		error: lastError instanceof Error ? lastError.message : String(lastError),
	});
	return false;
}

export function logRequest(stage: string, data: Record<string, unknown>): void {
	if (!LOGGING_ENABLED) return;

	if (!ensureLogDir(LOG_DIR)) {
		return;
	}

	const timestamp = new Date().toISOString();
	const requestId = ++requestCounter;
	const correlationId = getCorrelationId();
	const filename = join(LOG_DIR, `request-${requestId}-${stage}.json`);
	const requestData = sanitizeRequestLogData(data);
	const sanitizedData = sanitizeValue(requestData) as Record<string, unknown>;

	try {
		writeFileSync(
			filename,
			JSON.stringify(
				{
					timestamp,
					requestId,
					...(correlationId ? { correlationId } : {}),
					stage,
					...sanitizedData,
				},
				null,
				2,
			),
			{ encoding: "utf8", mode: 0o600 },
		);
		logToApp("info", `Logged ${stage} to ${filename}`);
		logToConsole("info", `[${PLUGIN_NAME}] Logged ${stage} to ${filename}`);
	} catch (e) {
		const error = e as Error;
		// If the log dir vanished after we cached it as ready (deleted/rotated/moved
		// out from under us), a write fails with ENOENT and would stay broken until
		// restart because ensureLogDir is a no-op once ready. Invalidate the cache on
		// a directory-missing failure so the next logRequest re-creates the dir.
		const code = (e as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") {
			logDirReady = false;
		}
		logToApp("error", `Failed to write log: ${error.message}`);
		logToConsole("error", `[${PLUGIN_NAME}] Failed to write log: ${error.message}`);
	}
}

export function logDebug(message: string, data?: unknown): void {
	if (!shouldLog("debug")) return;
	logToApp("debug", message, data);

	const text = `[${PLUGIN_NAME}] ${message}`;
	logToConsole("debug", text, data);
}

export function logInfo(message: string, data?: unknown): void {
	if (!shouldLog("info")) return;
	logToApp("info", message, data);

	const text = `[${PLUGIN_NAME}] ${message}`;
	logToConsole("info", text, data);
}

export function logWarn(message: string, data?: unknown): void {
	if (!shouldLog("warn")) return;
	logToApp("warn", message, data);
	const text = `[${PLUGIN_NAME}] ${message}`;
	logToConsole("warn", text, data);
}

export function logError(message: string, data?: unknown): void {
	logToApp("error", message, data);
	const text = `[${PLUGIN_NAME}] ${message}`;
	logToConsole("error", text, data);
}

export interface ScopedLogger {
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
	time(label: string): () => number;
	timeEnd(label: string, startTime: number): void;
}

const MAX_TIMERS = 100;
const timers: Map<string, number> = new Map();

export function createLogger(scope: string): ScopedLogger {
	const prefix = `[${PLUGIN_NAME}:${scope}]`;
	const service = `${PLUGIN_NAME}.${scope}`;

	return {
		debug(message: string, data?: unknown) {
			if (!shouldLog("debug")) return;
			const text = `${prefix} ${message}`;
			logToApp("debug", text, data, service);
			logToConsole("debug", text, data);
		},
		info(message: string, data?: unknown) {
			if (!shouldLog("info")) return;
			const text = `${prefix} ${message}`;
			logToApp("info", text, data, service);
			logToConsole("info", text, data);
		},
		warn(message: string, data?: unknown) {
			if (!shouldLog("warn")) return;
			const text = `${prefix} ${message}`;
			logToApp("warn", text, data, service);
			logToConsole("warn", text, data);
		},
		error(message: string, data?: unknown) {
			const text = `${prefix} ${message}`;
			logToApp("error", text, data, service);
			logToConsole("error", text, data);
		},
		time(label: string): () => number {
			const key = `${scope}:${label}`;
			const startTime = performance.now();
		if (timers.size >= MAX_TIMERS) {
			const firstKey = timers.keys().next().value;
			// istanbul ignore next -- defensive: firstKey always exists when size >= MAX_TIMERS
			if (firstKey) timers.delete(firstKey);
		}
			timers.set(key, startTime);
			return () => {
				const endTime = performance.now();
				const duration = endTime - startTime;
				timers.delete(key);
				if (shouldLog("debug")) {
					const text = `${prefix} ${label}: ${formatDuration(duration)}`;
					logToApp("debug", text, undefined, service);
					logToConsole("debug", text);
				}
				return duration;
			};
		},
		timeEnd(label: string, startTime: number): void {
			const duration = performance.now() - startTime;
			if (shouldLog("debug")) {
				const text = `${prefix} ${label}: ${formatDuration(duration)}`;
				logToApp("debug", text, undefined, service);
				logToConsole("debug", text);
			}
		},
	};
}

export function getRequestId(): number {
	return requestCounter;
}

export { formatDuration, maskEmail, maskString, maskToken, sanitizeValue };
