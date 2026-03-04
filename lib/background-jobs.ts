import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { sleep } from "./utils.js";
import { acquireFileLock } from "./file-lock.js";
import { redactForExternalOutput } from "./data-redaction.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 50;
const DEFAULT_MAX_DELAY_MS = 500;

const DLQ_PATH = join(getCodexMultiAuthDir(), "background-job-dlq.jsonl");
const DLQ_LOCK_PATH = `${DLQ_PATH}.lock`;

export interface BackgroundJobRetryOptions<T> {
	name: string;
	task: () => Promise<T>;
	context?: Record<string, unknown>;
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	retryable?: (error: unknown) => boolean;
}

export interface DeadLetterEntry {
	version: 1;
	timestamp: string;
	job: string;
	attempts: number;
	error: string;
	context?: Record<string, unknown>;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

function isRetryableByDefault(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code !== "string") return false;
	return code === "EBUSY" || code === "EPERM" || code === "EAGAIN" || code === "ETIMEDOUT";
}

async function appendDeadLetter(entry: DeadLetterEntry): Promise<void> {
	await fs.mkdir(dirname(DLQ_PATH), { recursive: true });
	const lock = await acquireFileLock(DLQ_LOCK_PATH, {
		maxAttempts: 80,
		baseDelayMs: 15,
		maxDelayMs: 800,
		staleAfterMs: 120_000,
	});
	try {
		await fs.appendFile(DLQ_PATH, `${JSON.stringify(entry)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} finally {
		await lock.release();
	}
}

export function getBackgroundJobDlqPath(): string {
	return DLQ_PATH;
}

export async function runBackgroundJobWithRetry<T>(options: BackgroundJobRetryOptions<T>): Promise<T> {
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
	const baseDelayMs = Math.max(1, Math.floor(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS));
	const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
	const retryable = options.retryable ?? isRetryableByDefault;

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await options.task();
		} catch (error) {
			lastError = error;
			if (attempt >= maxAttempts || !retryable(error)) {
				break;
			}
			await sleep(getDelayMs(attempt, baseDelayMs, maxDelayMs));
		}
	}

	const errorMessage = toErrorMessage(lastError);
	const deadLetter: DeadLetterEntry = {
		version: 1,
		timestamp: new Date().toISOString(),
		job: options.name,
		attempts: maxAttempts,
		error: errorMessage,
		...(options.context ? { context: redactForExternalOutput(options.context) } : {}),
	};

	try {
		await appendDeadLetter(deadLetter);
	} catch (dlqError) {
		logWarn("Failed to append background job dead-letter", {
			job: options.name,
			error: toErrorMessage(dlqError),
		});
	}

	logWarn("Background job failed after retries", {
		job: options.name,
		attempts: maxAttempts,
		error: errorMessage,
	});
	throw (lastError instanceof Error ? lastError : new Error(errorMessage));
}
