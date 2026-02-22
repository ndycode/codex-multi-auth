import { createHash } from "node:crypto";

export interface CodexCliMetrics {
	readAttempts: number;
	readSuccesses: number;
	readMisses: number;
	readFailures: number;
	legacySyncEnvUses: number;
	reconcileAttempts: number;
	reconcileChanges: number;
	reconcileNoops: number;
	reconcileFailures: number;
	writeAttempts: number;
	writeSuccesses: number;
	writeFailures: number;
}

const DEFAULT_METRICS: CodexCliMetrics = {
	readAttempts: 0,
	readSuccesses: 0,
	readMisses: 0,
	readFailures: 0,
	legacySyncEnvUses: 0,
	reconcileAttempts: 0,
	reconcileChanges: 0,
	reconcileNoops: 0,
	reconcileFailures: 0,
	writeAttempts: 0,
	writeSuccesses: 0,
	writeFailures: 0,
};

let metrics: CodexCliMetrics = { ...DEFAULT_METRICS };

export function incrementCodexCliMetric(
	key: keyof CodexCliMetrics,
	delta = 1,
): void {
	metrics[key] += delta;
}

export function getCodexCliMetricsSnapshot(): CodexCliMetrics {
	return { ...metrics };
}

export function resetCodexCliMetricsForTests(): void {
	metrics = { ...DEFAULT_METRICS };
}

export function makeAccountFingerprint(input: {
	accountId?: string;
	email?: string;
}): string | undefined {
	const raw =
		typeof input.accountId === "string" && input.accountId.trim().length > 0
			? input.accountId.trim()
			: typeof input.email === "string" && input.email.trim().length > 0
				? input.email.trim().toLowerCase()
				: "";
	if (!raw) return undefined;
	return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}
