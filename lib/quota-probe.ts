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

function parseFiniteNumberHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFiniteIntHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

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

function formatQuotaWindowLabel(windowMinutes: number | undefined): string {
	if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

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
