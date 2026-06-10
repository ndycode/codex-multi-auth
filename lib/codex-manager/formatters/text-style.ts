import { stdout as output } from "node:process";
import { ANSI } from "../../ui/ansi.js";
import { paintUiText } from "../../ui/format.js";
import { getUiRuntimeOptions } from "../../ui/runtime.js";

export type PromptTone = "accent" | "success" | "warning" | "danger" | "muted";

export function stylePromptText(text: string, tone: PromptTone): string {
	if (!output.isTTY) return text;
	const ui = getUiRuntimeOptions();
	if (ui.v2Enabled) {
		if (tone === "muted") {
			return `${ui.theme.colors.dim}${paintUiText(ui, text, "muted")}${ui.theme.colors.reset}`;
		}
		const mapped = tone === "accent" ? "primary" : tone;
		return paintUiText(ui, text, mapped);
	}
	const legacyCode =
		tone === "accent"
			? ANSI.green
			: tone === "success"
				? ANSI.green
				: tone === "warning"
					? ANSI.yellow
					: tone === "danger"
						? ANSI.red
						: ANSI.dim;
	return `${legacyCode}${text}${ANSI.reset}`;
}

export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function formatReasonLabel(
	reason: string | undefined,
): string | undefined {
	if (!reason) return undefined;
	const normalized = collapseWhitespace(reason.replace(/_/g, " "));
	return normalized.length > 0 ? normalized : undefined;
}

export function extractErrorMessageFromPayload(
	payload: unknown,
): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;

	const directMessage =
		typeof record.message === "string"
			? collapseWhitespace(record.message)
			: "";
	const directCode =
		typeof record.code === "string" ? collapseWhitespace(record.code) : "";
	if (directMessage) {
		if (
			directCode &&
			!directMessage.toLowerCase().includes(directCode.toLowerCase())
		) {
			return `${directMessage} [${directCode}]`;
		}
		return directMessage;
	}

	const nested = record.error;
	if (nested && typeof nested === "object") {
		return extractErrorMessageFromPayload(nested);
	}
	return undefined;
}

export function parseStructuredErrorMessage(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const candidates = new Set<string>([trimmed]);
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		candidates.add(trimmed.slice(firstBrace, lastBrace + 1));
	}

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const message = extractErrorMessageFromPayload(parsed);
			if (message) return message;
		} catch {
			// ignore non-JSON candidates
		}
	}
	return undefined;
}

export function normalizeFailureDetail(
	message: string | undefined,
	reason: string | undefined,
): string {
	const reasonLabel = formatReasonLabel(reason);
	const raw = message?.trim() || reasonLabel || "refresh failed";
	const structured = parseStructuredErrorMessage(raw);
	const normalized = collapseWhitespace(structured ?? raw);
	const bounded =
		normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
	return bounded.length > 0 ? bounded : "refresh failed";
}

export function joinStyledSegments(parts: string[]): string {
	if (parts.length === 0) return "";
	const separator = stylePromptText(" | ", "muted");
	return parts.join(separator);
}

export function formatResultSummary(
	segments: ReadonlyArray<{ text: string; tone: PromptTone }>,
): string {
	const rendered = segments.map((segment) =>
		stylePromptText(segment.text, segment.tone),
	);
	return `${stylePromptText("Result:", "accent")} ${joinStyledSegments(rendered)}`;
}

export function stringifyLogArgs(args: unknown[]): string {
	return args
		.map((value) => {
			if (typeof value === "string") return value;
			try {
				return JSON.stringify(value);
			} catch {
				return String(value);
			}
		})
		.join(" ");
}
