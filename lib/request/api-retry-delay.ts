import { isRecord } from "../utils.js";
import { parseRetryAfterBodyMs } from "./rate-limit-decision.js";

const positive = (value: number): number => Number.isFinite(value) && value > 0
	? Math.min(Math.ceil(value), Number.MAX_SAFE_INTEGER) : 0;

/** Retry-After is a minimum. Never truncate fractions or clamp a long wait down. */
export function apiRetryDelayMs(body: unknown, now: number, headers?: Headers): number {
	let delay = 0;
	const decimal = (value: string | null, scale: number) =>
		value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? positive(Number(value) * scale) : 0;
	if (headers) {
		const raw = headers.get("retry-after")?.trim() ?? null;
		delay = Math.max(decimal(headers.get("retry-after-ms"), 1), decimal(raw, 1000));
		if (raw && !/^\d+(?:\.\d+)?$/.test(raw)) delay = Math.max(delay, positive(Date.parse(raw) - now));
	}
	if (!isRecord(body) || !isRecord(body.error)) return delay;
	delay = Math.max(delay, positive(parseRetryAfterBodyMs(JSON.stringify({error: body.error}), now) ?? 0));
	// The Responses stream sometimes supplies only this provider wait hint.
	// Extract a duration without retaining the account/model-bearing message.
	if (body.error.code === "rate_limit_exceeded" && typeof body.error.message === "string") {
		const match = /\btry again in\s+(\d+(?:\.\d+)?)(ms|s|m|h)\b/i.exec(body.error.message.slice(0, 65536));
		if (match) delay = Math.max(delay, positive(Number(match[1]) * ({ms:1,s:1000,m:60000,h:3600000}[match[2]?.toLowerCase() ?? ""] ?? 0)));
	}
	return delay;
}
