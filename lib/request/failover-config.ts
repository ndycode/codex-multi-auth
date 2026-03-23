import type { FailoverMode } from "./failure-policy.js";

export function parseFailoverMode(value: string | undefined): FailoverMode {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "aggressive") return "aggressive";
	if (normalized === "conservative") return "conservative";
	return "balanced";
}

export function parseEnvInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}
