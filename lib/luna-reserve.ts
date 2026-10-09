import { LUNA_RESERVE_MODEL } from "./constants.js";
import { isRecord } from "./utils.js";

export interface LunaReserveWindow {
	usedPercent: number | null;
	remainingPercent: number | null;
	windowMinutes: number | null;
	resetAtMs: number | null;
}

export interface LunaReserveSnapshot {
	observedAt: number;
	offered: boolean;
	available: boolean | null;
	limitId: string | null;
	limitName: typeof LUNA_RESERVE_MODEL | null;
	normalModelSlug: string | null;
	primary: LunaReserveWindow | null;
	secondary: LunaReserveWindow | null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: unknown): number | null {
	const number = finiteNumber(value);
	return number === null ? null : Math.max(0, Math.min(100, number));
}

function parseWindow(value: unknown): LunaReserveWindow | null {
	if (!isRecord(value)) return null;
	const usedPercent = clampPercent(value.usedPercent);
	const duration = finiteNumber(value.windowDurationMins);
	const resetSeconds = finiteNumber(value.resetsAt);
	return {
		usedPercent,
		remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
		windowMinutes: duration === null || duration < 0 ? null : duration,
		resetAtMs: resetSeconds === null || resetSeconds <= 0 ? null : resetSeconds * 1000,
	};
}

/**
 * Parse the official Codex app-server `account/rateLimits/read` response for
 * the separately metered Luna Reserve bucket.
 *
 * Absence is intentionally represented as `offered:false`, never as 0% left:
 * the backend may omit Reserve when an account is not currently eligible or
 * when the experiment is not active for that account.
 */
export function parseLunaReserveRateLimits(
	value: unknown,
	observedAt = Date.now(),
): LunaReserveSnapshot {
	const absent: LunaReserveSnapshot = {
		observedAt,
		offered: false,
		available: null,
		limitId: null,
		limitName: null,
		normalModelSlug: null,
		primary: null,
		secondary: null,
	};
	if (!isRecord(value) || !isRecord(value.rateLimitsByLimitId)) return absent;

	for (const [limitId, candidate] of Object.entries(value.rateLimitsByLimitId)) {
		if (!isRecord(candidate) || candidate.limitName !== LUNA_RESERVE_MODEL) continue;
		const primary = parseWindow(candidate.primary);
		const secondary = parseWindow(candidate.secondary);
		const knownWindows = [primary, secondary].filter(
			(window): window is LunaReserveWindow => window !== null && window.usedPercent !== null,
		);
		const exhausted = knownWindows.some((window) => (window.usedPercent ?? 0) >= 100);
		return {
			observedAt,
			offered: true,
			available: knownWindows.length === 0 ? null : !exhausted,
			limitId: limitId || (typeof candidate.limitId === "string" ? candidate.limitId : null),
			limitName: LUNA_RESERVE_MODEL,
			normalModelSlug:
				typeof candidate.normalModelSlug === "string" && candidate.normalModelSlug.trim()
					? candidate.normalModelSlug.trim()
					: null,
			primary,
			secondary,
		};
	}
	return absent;
}
