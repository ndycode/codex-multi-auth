import { createHash, randomUUID } from "node:crypto";
import type {
	UsageLedgerAccountRef,
	UsageLedgerAppendInput,
	UsageLedgerOperation,
	UsageLedgerOutcome,
	UsageLedgerRow,
	UsageLedgerSource,
	UsageTokenCounts,
} from "./types.js";
import { estimateUsageCostUsd } from "./pricing.js";

const VALID_SOURCES = new Set<UsageLedgerSource>([
	"runtime-proxy",
	"plugin-host",
	"local-bridge",
	"cli",
	"unknown",
]);
const VALID_OPERATIONS = new Set<UsageLedgerOperation>([
	"responses",
	"models",
	"auth-refresh",
	"diagnostic",
	"unknown",
]);
const VALID_OUTCOMES = new Set<UsageLedgerOutcome>([
	"success",
	"failure",
	"blocked",
	"cancelled",
]);

function normalizeFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeNonNegativeInteger(value: unknown): number {
	const numeric = normalizeFiniteNumber(value);
	return numeric === null ? 0 : Math.max(0, Math.trunc(numeric));
}

function normalizeOptionalString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeStatusCode(value: unknown): number | null {
	const numeric = normalizeFiniteNumber(value);
	if (numeric === null) return null;
	const statusCode = Math.trunc(numeric);
	return statusCode >= 100 && statusCode <= 599 ? statusCode : null;
}

function normalizeDurationMs(value: unknown): number | null {
	const numeric = normalizeFiniteNumber(value);
	return numeric === null ? null : Math.max(0, Math.trunc(numeric));
}

function normalizeSource(value: unknown): UsageLedgerSource {
	return typeof value === "string" && VALID_SOURCES.has(value as UsageLedgerSource)
		? (value as UsageLedgerSource)
		: "unknown";
}

function normalizeOperation(value: unknown): UsageLedgerOperation {
	return typeof value === "string" &&
		VALID_OPERATIONS.has(value as UsageLedgerOperation)
		? (value as UsageLedgerOperation)
		: "unknown";
}

function normalizeOutcome(value: unknown): UsageLedgerOutcome {
	if (
		typeof value === "string" &&
		VALID_OUTCOMES.has(value as UsageLedgerOutcome)
	) {
		return value as UsageLedgerOutcome;
	}
	return "failure";
}

export function hashUsageIdentifier(value: string): string {
	return `sha256:${createHash("sha256").update(value.trim()).digest("hex")}`;
}

export function createUsageAccountRef(input: {
	accountId?: string | null;
	email?: string | null;
	accountIndex?: number | null;
}): UsageLedgerAccountRef | null {
	const accountId = normalizeOptionalString(input.accountId);
	const email = normalizeOptionalString(input.email)?.toLowerCase() ?? null;
	const index =
		typeof input.accountIndex === "number" &&
		Number.isInteger(input.accountIndex) &&
		input.accountIndex >= 0
			? input.accountIndex
			: null;
	if (!accountId && !email && index === null) {
		return null;
	}

	return {
		accountHash: accountId ? hashUsageIdentifier(accountId) : undefined,
		emailHash: email ? hashUsageIdentifier(email) : undefined,
		index: index ?? undefined,
	};
}

function normalizeTokens(input: UsageLedgerAppendInput): UsageTokenCounts {
	const inputTokens = normalizeNonNegativeInteger(input.inputTokens);
	const outputTokens = normalizeNonNegativeInteger(input.outputTokens);
	const cachedInputTokens = normalizeNonNegativeInteger(input.cachedInputTokens);
	const reasoningTokens = normalizeNonNegativeInteger(input.reasoningTokens);
	const providedTotal = normalizeFiniteNumber(input.totalTokens);
	const computedTotal =
		inputTokens + outputTokens + cachedInputTokens + reasoningTokens;

	return {
		inputTokens,
		outputTokens,
		cachedInputTokens,
		reasoningTokens,
		totalTokens:
			providedTotal === null
				? computedTotal
				: Math.max(0, Math.trunc(providedTotal)),
	};
}

export function normalizeUsageLedgerRow(
	input: UsageLedgerAppendInput,
): UsageLedgerRow {
	const model = normalizeOptionalString(input.model);
	const tokens = normalizeTokens(input);
	const explicitCost = normalizeFiniteNumber(input.costUsd);

	return {
		version: 1,
		id: normalizeOptionalString(input.id) ?? randomUUID(),
		createdAt:
			normalizeFiniteNumber(input.createdAt) ?? Date.now(),
		source: normalizeSource(input.source),
		operation: normalizeOperation(input.operation),
		outcome: normalizeOutcome(input.outcome),
		model,
		projectKey: normalizeOptionalString(input.projectKey),
		account: createUsageAccountRef(input),
		requestId: normalizeOptionalString(input.requestId),
		statusCode: normalizeStatusCode(input.statusCode),
		errorCode: normalizeOptionalString(input.errorCode),
		durationMs: normalizeDurationMs(input.durationMs),
		tokens,
		costUsd:
			explicitCost === null
				? estimateUsageCostUsd(model, tokens)
				: Math.max(0, explicitCost),
	};
}

export function usageRowToJsonLine(row: UsageLedgerRow): string {
	return `${JSON.stringify(row)}\n`;
}

