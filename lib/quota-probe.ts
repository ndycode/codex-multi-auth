import { CODEX_BASE_URL } from "./constants.js";
import { createCodexHeaders, getUnsupportedCodexModelInfo } from "./request/fetch-helpers.js";
import { getCodexInstructions } from "./prompts/codex.js";
import type { RequestBody } from "./types.js";
import { isRecord } from "./utils.js";

export interface CodexQuotaWindow {
	usedPercent?: number;
	windowMinutes?: number;
	resetAtMs?: number;
}

export interface CodexQuotaSnapshot {
	status: number;
	planType?: string;
	activeLimit?: number;
	primary: CodexQuotaWindow;
	secondary: CodexQuotaWindow;
	model: string;
}

const DEFAULT_QUOTA_PROBE_MODELS = ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"] as const;

/**
 * Parse an HTTP header value and return it as a finite number.
 *
 * This is synchronous, has no filesystem side effects, and is safe for concurrent use.
 * Callers are responsible for any sensitive header handling or token redaction.
 *
 * @param headers - The Headers object to read the header from.
 * @param name - The header name to parse.
 * @returns The header value parsed as a finite number, or `undefined` if the header is missing or not a finite number.
 */
function parseFiniteNumberHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse a header value as a base-10 integer and return it if it is a finite number.
 *
 * This function is pure and side-effect-free, safe for concurrent use, and performs no filesystem I/O.
 * It does not redact or log header contents; treat header values as potentially sensitive and avoid exposing them.
 *
 * @param headers - The Headers object to read from
 * @param name - The header name to parse
 * @returns The parsed integer value, or `undefined` if the header is missing or not a finite integer
 */
function parseFiniteIntHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Compute the absolute millisecond timestamp when a quota window resets from Codex response headers.
 *
 * @param headers - Response Headers object containing reset information (e.g., `<prefix>-reset-after-seconds` or `<prefix>-reset-at`)
 * @param prefix - Header name prefix (for example, `"primary"` or `"secondary"`)
 * @returns The reset time as a Unix timestamp in milliseconds, or `undefined` if no valid reset information is present.
 *
 * Concurrency: pure and safe for concurrent use.
 * Filesystem: performs no filesystem I/O and behaves identically on Windows.
 * Security: does not emit or persist header values; callers must redact any sensitive tokens before storing or logging headers.
 */
function parseResetAtMs(headers: Headers, prefix: string): number | undefined {
	const resetAfterSeconds = parseFiniteIntHeader(headers, `${prefix}-reset-after-seconds`);
	if (typeof resetAfterSeconds === "number" && resetAfterSeconds > 0) {
		return Date.now() + resetAfterSeconds * 1000;
	}

	const resetAtRaw = headers.get(`${prefix}-reset-at`);
	if (!resetAtRaw) return undefined;

	const trimmed = resetAtRaw.trim();
	if (/^\d+$/.test(trimmed)) {
		const parsedNumber = Number.parseInt(trimmed, 10);
		if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
			return parsedNumber < 10_000_000_000 ? parsedNumber * 1000 : parsedNumber;
		}
	}

	const parsedDate = Date.parse(trimmed);
	return Number.isFinite(parsedDate) ? parsedDate : undefined;
}

/**
 * Detects whether the provided HTTP headers include any Codex quota-related keys.
 *
 * Inspects only header presence (no header values are read, logged, or written to disk). Safe to call concurrently; does not interact with the filesystem. Callers must ensure any sensitive tokens in headers are redacted before external logging.
 *
 * @param headers - The Headers object to check for Codex quota headers
 * @returns `true` if at least one Codex quota header is present, `false` otherwise
 */
function hasCodexQuotaHeaders(headers: Headers): boolean {
	const keys = [
		"x-codex-primary-used-percent",
		"x-codex-primary-window-minutes",
		"x-codex-primary-reset-at",
		"x-codex-primary-reset-after-seconds",
		"x-codex-secondary-used-percent",
		"x-codex-secondary-window-minutes",
		"x-codex-secondary-reset-at",
		"x-codex-secondary-reset-after-seconds",
	];
	return keys.some((key) => headers.get(key) !== null);
}

/**
 * Parse Codex quota-related HTTP headers into a quota snapshot (excluding the model).
 *
 * @param headers - HTTP response headers to read quota fields from; the function does not modify headers and performs no I/O.
 * @param status - HTTP status code associated with the response; included verbatim in the returned snapshot when present.
 * @returns An object with `status`, optional `planType`, optional `activeLimit`, and `primary`/`secondary` quota window objects when any Codex quota headers are present; `null` if no quota headers were found.
 *
 * Concurrency: safe to call concurrently from multiple tasks (pure header parsing with no shared state).
 * Filesystem: performs no filesystem operations and is unaffected by platform path semantics (Windows or otherwise).
 * Token redaction: this function does not redact or log header values; callers must ensure any sensitive tokens in `headers` are redacted before logging or persisting.
 */
function parseQuotaSnapshotBase(
	headers: Headers,
	status: number,
): Omit<CodexQuotaSnapshot, "model"> | null {
	if (!hasCodexQuotaHeaders(headers)) return null;

	const primaryPrefix = "x-codex-primary";
	const secondaryPrefix = "x-codex-secondary";
	const primary: CodexQuotaWindow = {
		usedPercent: parseFiniteNumberHeader(headers, `${primaryPrefix}-used-percent`),
		windowMinutes: parseFiniteIntHeader(headers, `${primaryPrefix}-window-minutes`),
		resetAtMs: parseResetAtMs(headers, primaryPrefix),
	};
	const secondary: CodexQuotaWindow = {
		usedPercent: parseFiniteNumberHeader(headers, `${secondaryPrefix}-used-percent`),
		windowMinutes: parseFiniteIntHeader(headers, `${secondaryPrefix}-window-minutes`),
		resetAtMs: parseResetAtMs(headers, secondaryPrefix),
	};

	const planTypeRaw = headers.get("x-codex-plan-type");
	const planType = planTypeRaw && planTypeRaw.trim() ? planTypeRaw.trim() : undefined;
	const activeLimit = parseFiniteIntHeader(headers, "x-codex-active-limit");

	return { status, planType, activeLimit, primary, secondary };
}

/**
 * Build a deduplicated, trimmed list of candidate probe model names from a primary model and fallbacks.
 *
 * Produces a unique array where each entry is a non-empty, trimmed model string. Empty or whitespace-only
 * inputs are ignored and duplicates are removed while preserving the first occurrence order.
 *
 * Concurrency assumptions: pure and side-effect-free — safe to call concurrently.
 * Windows filesystem behavior: no filesystem interaction.
 * Token redaction: does not log or retain authentication tokens; callers must redact tokens when logging model names if required.
 *
 * @param primaryModel - Optional preferred model name to try first
 * @param fallbackModels - Optional array of fallback model names; if omitted, a built-in default list is used
 * @returns An array of unique, trimmed model names to probe, in priority order
 */
function normalizeProbeModels(
	primaryModel: string | undefined,
	fallbackModels: readonly string[] | undefined,
): string[] {
	const base = primaryModel?.trim();
	const merged = [
		base,
		...(fallbackModels ?? DEFAULT_QUOTA_PROBE_MODELS),
	].filter((model): model is string => typeof model === "string" && model.trim().length > 0);
	return Array.from(new Set(merged.map((model) => model.trim())));
}

/**
 * Extracts the most informative error message from an HTTP response body.
 *
 * Safe for concurrent use and performs no filesystem access (including no Windows-specific file operations).
 * This function does not redact tokens or other sensitive values from the returned message.
 *
 * @param bodyText - Raw response body text
 * @param status - HTTP status code associated with the response
 * @returns The best available message: `error.message` or `message` from parsed JSON if present, `HTTP <status>` when the body is empty, or the trimmed raw body text otherwise
 */
function extractErrorMessage(bodyText: string, status: number): string {
	const trimmed = bodyText.trim();
	if (!trimmed) return `HTTP ${status}`;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (isRecord(parsed)) {
			const maybeError = parsed.error;
			if (isRecord(maybeError) && typeof maybeError.message === "string") {
				return maybeError.message;
			}
			if (typeof parsed.message === "string") {
				return parsed.message;
			}
		}
	} catch {
		// Fall through to raw body text.
	}
	return trimmed;
}

/**
 * Produce a short human-friendly label for a quota window duration.
 *
 * @param windowMinutes - Duration of the quota window in minutes; if undefined, non-finite, or <= 0 a generic label is returned
 * @returns A short label: `Nd` when `windowMinutes` is divisible by 1440 (days), `Nh` when divisible by 60 (hours), `Nm` otherwise; returns `"quota"` for unspecified or invalid input
 *
 * Notes: safe for concurrent use, performs no filesystem I/O, and returns no sensitive tokens (safe for logging/display).
 */
function formatQuotaWindowLabel(windowMinutes: number | undefined): string {
	if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

/**
 * Format a millisecond epoch timestamp into a concise human-readable reset time.
 *
 * Returns a 24-hour time "HH:MM" when the timestamp is today, otherwise "HH:MM on Mon DD".
 *
 * This function has no side effects, is safe for concurrent use, does not access the filesystem,
 * and produces no sensitive token data.
 *
 * @param resetAtMs - Timestamp in milliseconds since epoch; if `undefined`, non-finite, or <= 0, the function returns `undefined`.
 * @returns The formatted reset time string, or `undefined` if `resetAtMs` is invalid or not provided.
 */
function formatResetAt(resetAtMs: number | undefined): string | undefined {
	if (!resetAtMs || !Number.isFinite(resetAtMs) || resetAtMs <= 0) return undefined;
	const date = new Date(resetAtMs);
	if (!Number.isFinite(date.getTime())) return undefined;

	const now = new Date();
	const sameDay =
		now.getFullYear() === date.getFullYear() &&
		now.getMonth() === date.getMonth() &&
		now.getDate() === date.getDate();

	const time = date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	if (sameDay) return time;
	const day = date.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
	return `${time} on ${day}`;
}

/**
 * Create a short human-readable summary for a quota window.
 *
 * Safe for concurrent use; does not access the filesystem and never includes or exposes sensitive tokens.
 *
 * @param label - Human-friendly label for the window (e.g., "2h", "7d", "quota")
 * @param window - Quota window fields used to populate the summary (e.g., `usedPercent`, `resetAtMs`)
 * @returns A single-line summary combining the label, percent left (if available), and reset time (if available), e.g. "2h 40% left (resets 14:05)"
 */
function formatWindowSummary(label: string, window: CodexQuotaWindow): string {
	const used = window.usedPercent;
	const left =
		typeof used === "number" && Number.isFinite(used)
			? Math.max(0, Math.min(100, Math.round(100 - used)))
			: undefined;
	const reset = formatResetAt(window.resetAtMs);
	let summary = label;
	if (left !== undefined) summary = `${summary} ${left}% left`;
	if (reset) summary = `${summary} (resets ${reset})`;
	return summary;
}

/**
 * Produce a single-line human-readable summary of a Codex quota snapshot.
 *
 * This pure, deterministic formatter is safe for concurrent use, performs no
 * filesystem side effects (including on Windows), and never exposes secret
 * tokens or other sensitive values.
 *
 * @param snapshot - The quota snapshot to format
 * @returns A concise, comma-separated summary describing primary and secondary windows, optional plan and active limit, and `rate-limited` when the status is 429
 */
export function formatQuotaSnapshotLine(snapshot: CodexQuotaSnapshot): string {
	const primaryLabel = formatQuotaWindowLabel(snapshot.primary.windowMinutes);
	const secondaryLabel = formatQuotaWindowLabel(snapshot.secondary.windowMinutes);
	const parts = [
		formatWindowSummary(primaryLabel, snapshot.primary),
		formatWindowSummary(secondaryLabel, snapshot.secondary),
	];
	if (snapshot.planType) parts.push(`plan:${snapshot.planType}`);
	if (typeof snapshot.activeLimit === "number" && Number.isFinite(snapshot.activeLimit)) {
		parts.push(`active:${snapshot.activeLimit}`);
	}
	if (snapshot.status === 429) parts.push("rate-limited");
	return parts.join(", ");
}

export interface ProbeCodexQuotaOptions {
	accountId: string;
	accessToken: string;
	model?: string;
	fallbackModels?: readonly string[];
	timeoutMs?: number;
}

/**
 * Probe Codex models sequentially to obtain a quota snapshot for the specified account.
 *
 * Concurrency: models are probed one-at-a-time (no parallel requests).
 * Filesystem: performs no filesystem access and makes no Windows filesystem calls.
 * Security: `accessToken` is sent in request headers and is treated as sensitive; tokens are not persisted or written to disk.
 *
 * @param options - Probe options including:
 *   - accountId: account identifier used for Codex requests
 *   - accessToken: bearer token for authentication (sensitive)
 *   - model: optional preferred model name to probe first
 *   - fallbackModels: optional list of fallback model names to try
 *   - timeoutMs: optional per-model timeout in milliseconds (bounded between 1000 and 60000; default 15000)
 * @returns The first CodexQuotaSnapshot parsed from response quota headers, augmented with the model that produced it.
 * @throws If no candidate model produces a quota snapshot, throws the last encountered error or a generic failure error.
 */
export async function fetchCodexQuotaSnapshot(
	options: ProbeCodexQuotaOptions,
): Promise<CodexQuotaSnapshot> {
	const models = normalizeProbeModels(options.model, options.fallbackModels);
	const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 15_000, 60_000));
	let lastError: Error | null = null;

	for (const model of models) {
		try {
			const instructions = await getCodexInstructions(model);
			const probeBody: RequestBody = {
				model,
				stream: true,
				store: false,
				include: ["reasoning.encrypted_content"],
				instructions,
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "quota ping" }],
					},
				],
				reasoning: { effort: "none", summary: "auto" },
				text: { verbosity: "low" },
			};

			const headers = createCodexHeaders(undefined, options.accountId, options.accessToken, {
				model,
			});
			headers.set("content-type", "application/json");

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			let response: Response;
			try {
				response = await fetch(`${CODEX_BASE_URL}/codex/responses`, {
					method: "POST",
					headers,
					body: JSON.stringify(probeBody),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}

			const snapshotBase = parseQuotaSnapshotBase(response.headers, response.status);
			if (snapshotBase) {
				try {
					await response.body?.cancel();
				} catch {
					// Best effort cancellation.
				}
				return { ...snapshotBase, model };
			}

			if (!response.ok) {
				const bodyText = await response.text().catch(() => "");
				let errorBody: unknown = undefined;
				try {
					errorBody = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
				} catch {
					errorBody = { error: { message: bodyText } };
				}

				const unsupportedInfo = getUnsupportedCodexModelInfo(errorBody);
				if (unsupportedInfo.isUnsupported) {
					lastError = new Error(
						unsupportedInfo.message ?? `Model '${model}' unsupported for this account`,
					);
					continue;
				}

				throw new Error(extractErrorMessage(bodyText, response.status));
			}

			lastError = new Error("Codex response did not include quota headers");
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw lastError ?? new Error("Failed to fetch quotas");
}
