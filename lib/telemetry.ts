import {
	existsSync,
	promises as fs,
	readdirSync,
} from "node:fs";
import { join } from "node:path";
import { getCorrelationId, maskEmail } from "./logger.js";
import { getCodexLogDir } from "./runtime-paths.js";

export type TelemetrySource = "cli" | "plugin";
export type TelemetryOutcome = "start" | "success" | "failure" | "recovery" | "info";

export interface TelemetryEvent {
	timestamp: string;
	source: TelemetrySource;
	event: string;
	outcome: TelemetryOutcome;
	correlationId: string | null;
	details?: Record<string, unknown>;
}

export interface TelemetryEventInput {
	source: TelemetrySource;
	event: string;
	outcome: TelemetryOutcome;
	details?: Record<string, unknown>;
}

export interface TelemetryConfig {
	enabled: boolean;
	logDir: string;
	fileName: string;
	maxFileSizeBytes: number;
	maxFiles: number;
}

export interface QueryTelemetryOptions {
	sinceMs?: number;
	limit?: number;
}

export interface TelemetrySummary {
	total: number;
	bySource: Record<TelemetrySource, number>;
	byOutcome: Record<TelemetryOutcome, number>;
	byEvent: Array<{ event: string; count: number }>;
	firstTimestamp: string | null;
	lastTimestamp: string | null;
}

const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
	enabled: true,
	logDir: getCodexLogDir(),
	fileName: "product-telemetry.jsonl",
	maxFileSizeBytes: 1 * 1024 * 1024,
	maxFiles: 4,
};

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
	"secret",
	"password",
	"credential",
	"id_token",
	"idtoken",
]);

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi;
const TOKEN_PATTERNS = [
	/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
	/sk-[A-Za-z0-9]{20,}/g,
	/Bearer\s+\S+/gi,
];
const RETRYABLE_FILE_OP_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const FILE_OP_MAX_ATTEMPTS = 6;
const FILE_OP_BASE_DELAY_MS = 25;

let telemetryConfig: TelemetryConfig = { ...DEFAULT_TELEMETRY_CONFIG };
let appendQueue: Promise<void> = Promise.resolve();

function getTelemetryPath(): string {
	return join(telemetryConfig.logDir, telemetryConfig.fileName);
}

async function ensureLogDir(): Promise<void> {
	if (existsSync(telemetryConfig.logDir)) return;
	await fs.mkdir(telemetryConfig.logDir, { recursive: true, mode: 0o700 });
}

function maskToken(value: string): string {
	if (value.length <= 12) {
		return "***MASKED***";
	}
	return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sanitizeString(value: string): string {
	let sanitized = value.replace(EMAIL_PATTERN, (email) => maskEmail(email));
	for (const pattern of TOKEN_PATTERNS) {
		sanitized = sanitized.replace(pattern, (match) => maskToken(match));
	}
	return sanitized;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[max depth]";
	if (typeof value === "string") {
		return sanitizeString(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item, depth + 1));
	}
	if (value !== null && typeof value === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
			if (SENSITIVE_KEYS.has(normalizedKey)) {
				sanitized[key] = "***MASKED***";
				continue;
			}
			sanitized[key] = sanitizeValue(entry, depth + 1);
		}
		return sanitized;
	}
	return value;
}

function parseArchiveSuffix(fileName: string): number | null {
	const base = telemetryConfig.fileName;
	if (fileName === base) return 0;
	if (!fileName.startsWith(`${base}.`)) return null;
	const suffix = fileName.slice(base.length + 1).trim();
	if (!/^\d+$/.test(suffix)) return null;
	const parsed = Number.parseInt(suffix, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}

function shouldRetryFileOperation(error: unknown): boolean {
	if (!isErrnoException(error)) return false;
	return Boolean(error.code && RETRYABLE_FILE_OP_CODES.has(error.code));
}

function waitForRetryDelay(attempt: number): Promise<void> {
	return new Promise((resolve) =>
		setTimeout(resolve, FILE_OP_BASE_DELAY_MS * 2 ** attempt),
	);
}

async function runFileOperationWithRetry<T>(operation: () => Promise<T>): Promise<T> {
	let attempt = 0;
	while (true) {
		try {
			return await operation();
		} catch (error) {
			if (!shouldRetryFileOperation(error) || attempt >= FILE_OP_MAX_ATTEMPTS - 1) {
				throw error;
			}
			await waitForRetryDelay(attempt);
			attempt += 1;
		}
	}
}

function isErrnoCode(error: unknown, code: string): boolean {
	if (!isErrnoException(error)) return false;
	return error.code === code;
}

async function rotateLogsIfNeeded(): Promise<void> {
	const logPath = getTelemetryPath();
	if (!existsSync(logPath)) return;

	let size = 0;
	try {
		size = (await runFileOperationWithRetry(() => fs.stat(logPath))).size;
	} catch (error) {
		if (isErrnoCode(error, "ENOENT")) return;
		throw error;
	}
	if (size < telemetryConfig.maxFileSizeBytes) return;

	for (let i = telemetryConfig.maxFiles - 1; i >= 1; i -= 1) {
		const target = `${logPath}.${i}`;
		const source = i === 1 ? logPath : `${logPath}.${i - 1}`;
		if (i === telemetryConfig.maxFiles - 1 && existsSync(target)) {
			try {
				await runFileOperationWithRetry(() => fs.unlink(target));
			} catch (error) {
				if (!isErrnoCode(error, "ENOENT")) throw error;
			}
		}
		if (existsSync(source)) {
			try {
				await runFileOperationWithRetry(() => fs.rename(source, target));
			} catch (error) {
				if (!isErrnoCode(error, "ENOENT")) throw error;
			}
		}
	}
}

function queueAppend(task: () => Promise<void>): Promise<void> {
	const next = appendQueue.then(task, task);
	appendQueue = next.catch(() => {});
	return next;
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.timestamp === "string" &&
		typeof record.source === "string" &&
		typeof record.event === "string" &&
		typeof record.outcome === "string"
	);
}

async function readEventsFromFile(filePath: string): Promise<TelemetryEvent[]> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
		const events: TelemetryEvent[] = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as unknown;
				if (isTelemetryEvent(parsed)) {
					events.push(parsed);
				}
			} catch {
				// Ignore malformed lines.
			}
		}
		return events;
	} catch {
		return [];
	}
}

function listTelemetryFiles(): string[] {
	try {
		const entries = readdirSync(telemetryConfig.logDir);
		const sortable = entries
			.map((name) => {
				const archiveIndex = parseArchiveSuffix(name);
				if (archiveIndex === null) return null;
				return { name, archiveIndex };
			})
			.filter((value): value is { name: string; archiveIndex: number } => value !== null)
			.sort((left, right) => right.archiveIndex - left.archiveIndex);
		return sortable.map((entry) => join(telemetryConfig.logDir, entry.name));
	} catch {
		return [];
	}
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return 100;
	return Math.max(1, Math.min(500, Math.floor(limit)));
}

export function configureTelemetry(config: Partial<TelemetryConfig>): void {
	telemetryConfig = { ...telemetryConfig, ...config };
}

export function getTelemetryConfig(): TelemetryConfig {
	return { ...telemetryConfig };
}

export function getTelemetryLogPath(): string {
	return getTelemetryPath();
}

export async function recordTelemetryEvent(input: TelemetryEventInput): Promise<void> {
	if (!telemetryConfig.enabled) return;
	if (!input.event.trim()) return;

	const entry: TelemetryEvent = {
		timestamp: new Date().toISOString(),
		source: input.source,
		event: input.event,
		outcome: input.outcome,
		correlationId: getCorrelationId(),
		details: input.details
			? (sanitizeValue(input.details) as Record<string, unknown>)
			: undefined,
	};

	try {
		await queueAppend(async () => {
			await ensureLogDir();
			await rotateLogsIfNeeded();
			const line = `${JSON.stringify(entry)}\n`;
			await fs.appendFile(getTelemetryPath(), line, "utf8");
		});
	} catch {
		// Telemetry must never break runtime behavior.
	}
}

export async function queryTelemetryEvents(
	options: QueryTelemetryOptions = {},
): Promise<TelemetryEvent[]> {
	const sinceMs = options.sinceMs ?? 0;
	const limit = clampLimit(options.limit);
	const events: TelemetryEvent[] = [];

	for (const filePath of listTelemetryFiles()) {
		const parsed = await readEventsFromFile(filePath);
		for (const event of parsed) {
			const timestampMs = Date.parse(event.timestamp);
			if (Number.isFinite(timestampMs) && timestampMs < sinceMs) {
				continue;
			}
			events.push(event);
		}
	}

	if (events.length <= limit) return events;
	return events.slice(events.length - limit);
}

export function summarizeTelemetryEvents(events: readonly TelemetryEvent[]): TelemetrySummary {
	const bySource: Record<TelemetrySource, number> = { cli: 0, plugin: 0 };
	const byOutcome: Record<TelemetryOutcome, number> = {
		start: 0,
		success: 0,
		failure: 0,
		recovery: 0,
		info: 0,
	};
	const eventCounts = new Map<string, number>();

	for (const event of events) {
		bySource[event.source] += 1;
		byOutcome[event.outcome] += 1;
		eventCounts.set(event.event, (eventCounts.get(event.event) ?? 0) + 1);
	}

	const byEvent = [...eventCounts.entries()]
		.sort((left, right) => right[1] - left[1])
		.map(([event, count]) => ({ event, count }));

	return {
		total: events.length,
		bySource,
		byOutcome,
		byEvent,
		firstTimestamp: events[0]?.timestamp ?? null,
		lastTimestamp: events[events.length - 1]?.timestamp ?? null,
	};
}
