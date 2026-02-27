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
 * Parse a header value and return it as a finite number.
 *
 * @param headers - The Headers object to read the value from
 * @param name - The name of the header to parse
 * @returns The header value parsed as a finite number, or `undefined` if the header is missing or not a finite number
 */
function parseFiniteNumberHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse a response header value as a finite integer.
 *
 * @param headers - The Headers object to read; not modified by this function.
 * @param name - The header name to parse.
 * @returns The parsed integer if the header exists and yields a finite integer, `undefined` otherwise.
 *
 * Concurrency: pure and safe to call from concurrent contexts.
 * Filesystem: does not access the filesystem (no Windows-specific behavior).
 * Token handling: does not log or emit header values and does not perform any token redaction itself.
 */
function parseFiniteIntHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse a reset timestamp from quota-related headers and return it as milliseconds since the epoch.
 *
 * @param headers - Response Headers containing quota fields (e.g. `x-codex-primary-reset-at` or `x-codex-primary-reset-after-seconds`)
 * @param prefix - Header name prefix (for example `"x-codex-primary"` or `"x-codex-secondary"`)
 * @returns A millisecond epoch timestamp when the window resets, or `undefined` if no valid reset value is present
 *
 * Notes:
 * - The function is pure and safe for concurrent use.
 * - It has no filesystem implications (including Windows-specific behavior).
 * - It does not log or expose tokens; no special token redaction is required here.
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
 * Checks whether any Codex quota-related headers are present in the provided Headers.
 *
 * This function only examines header names and does not read or log header values (preserving token confidentiality). It is safe for concurrent use and does not access the filesystem.
 *
 * @param headers - The Headers object to inspect for quota-related keys
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
 * Parse Codex quota-related response headers into a quota snapshot object (omitting the `model` field).
 *
 * Reads primary and secondary quota windows (used percent, window minutes, reset timestamp), plan type, and active limit from the provided response headers. Safe to call concurrently; it performs no I/O or filesystem operations. This function does not log or expose sensitive tokens—callers should redact any tokens when recording headers or errors. Behavior is consistent across platforms (including Windows).
 *
 * @param headers - Response Headers to read quota values from
 * @param status - HTTP response status code associated with the headers
 * @returns An object with `status`, optional `planType`, optional `activeLimit`, and `primary`/`secondary` windows, or `null` if no quota headers are present
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
 * Builds a de-duplicated list of probe model names from a primary model and fallback models.
 *
 * @param primaryModel - Optional primary model identifier; leading/trailing whitespace is trimmed and an empty value is ignored.
 * @param fallbackModels - Optional fallbacks to use when `primaryModel` is missing; if omitted, defaults to module `DEFAULT_QUOTA_PROBE_MODELS`.
 * @returns An array of unique, trimmed model names in order: primary (if present) followed by the fallback models.
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
 * Extracts a human-friendly error message from an HTTP response body.
 *
 * Attempts to parse JSON and return `error.message` or top-level `message` when present; if the body is empty returns `HTTP {status}`, otherwise returns the trimmed raw body.
 *
 * @param bodyText - The raw response body text to inspect (may contain JSON or plain text)
 * @param status - The HTTP status code associated with the response
 * @returns The extracted error message string
 *
 * Notes:
 * - Concurrency: pure and safe for concurrent use.
 * - Filesystem: performs no filesystem operations and has no platform-specific (Windows) behavior.
 * - Token redaction: this function does not redact tokens or other secrets; callers must redact sensitive data before calling if needed.
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
 * Produces a short label for a quota window length in minutes.
 *
 * @param windowMinutes - Window length in minutes; undefined, non-finite, or non-positive values yield the default label.
 * @returns The label: `"quota"` for missing/invalid windows, `"<n>d"` when divisible by 1440, `"<n>h"` when divisible by 60, otherwise `"<n>m"`.
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
 * Format a millisecond timestamp into a short, human-readable reset time.
 *
 * Uses the runtime's locale for month and time formatting and renders time in 24-hour HH:MM form.
 * If the timestamp falls on the current day the result is "HH:MM"; otherwise it is "HH:MM on Mon DD".
 * This function is pure and has no side effects — it does not perform I/O, access the filesystem,
 * manage concurrency, or redact/emit tokens.
 *
 * @param resetAtMs - Millisecond POSIX timestamp to format; may be undefined or invalid.
 * @returns The formatted reset time string, or `undefined` when `resetAtMs` is missing or invalid.
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
 * Builds a short human-readable summary for a quota window.
 *
 * @param label - Short label for the window (e.g., "primary" or "secondary")
 * @param window - Quota window data containing `usedPercent` and optional `resetAtMs`
 * @returns A string containing the label, optionally followed by "`<n>% left`" and an optional "`(resets <time>)`" clause
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
 * Create a compact, human-readable summary line describing a Codex quota snapshot.
 *
 * This is a pure formatter: it is safe to call concurrently, performs no filesystem I/O, and does not include or reveal access tokens.
 *
 * @param snapshot - The quota snapshot containing primary/secondary windows, plan type, active limit, HTTP status, and model identifier
 * @returns A single-line summary combining primary and secondary window summaries and optional fields (plan, active limit, rate-limited)
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
 * Probes Codex models to retrieve a quota snapshot (primary/secondary windows, plan, active limit) by sending a lightweight "quota ping" request to one of the provided models.
 *
 * @param options - Probe configuration including:
 *   - accountId: account identifier used to build request headers;
 *   - accessToken: bearer token used to authenticate the request (treated as a secret and included in outgoing headers; callers must protect it and expect it to be redacted in logs);
 *   - model / fallbackModels: primary model and optional fallbacks; the function will try models sequentially until a quota snapshot is obtained;
 *   - timeoutMs: request timeout in milliseconds (bounded to at least 1000 ms and at most 60000 ms; defaults to 15000 ms).
 * @returns A CodexQuotaSnapshot containing status, planType (if any), activeLimit (if any), the parsed primary and secondary quota windows, and the model that produced the snapshot.
 * @throws Throws the last encountered Error if all candidate models fail to produce a quota snapshot.
 *
 * Notes:
 * - Models are probed sequentially (no concurrency) and the first response containing quota headers is returned.
 * - The function performs no filesystem I/O and is safe to call on Windows or other platforms.
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
