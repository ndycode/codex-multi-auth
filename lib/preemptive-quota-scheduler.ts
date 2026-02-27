export interface QuotaSchedulerWindow {
	usedPercent?: number;
	resetAtMs?: number;
}

export interface QuotaSchedulerSnapshot {
	status: number;
	primary: QuotaSchedulerWindow;
	secondary: QuotaSchedulerWindow;
	updatedAt: number;
}

export interface QuotaDeferralDecision {
	defer: boolean;
	waitMs: number;
	reason?: "rate-limit" | "quota-near-exhaustion";
}

export interface QuotaSchedulerOptions {
	enabled?: boolean;
	remainingPercentThresholdPrimary?: number;
	remainingPercentThresholdSecondary?: number;
	usedPercentThreshold?: number;
	maxDeferralMs?: number;
}

const DEFAULT_REMAINING_PERCENT_THRESHOLD = 5;
const DEFAULT_MAX_DEFERRAL_MS = 2 * 60 * 60_000;

/**
 * Clamp a number to the inclusive integer range [min, max] after flooring.
 *
 * @param value - The input number to be floored and clamped
 * @param min - The inclusive lower bound
 * @param max - The inclusive upper bound
 * @returns The integer result equal to `Math.floor(value)` constrained to the range between `min` and `max`
 */
function clampInt(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Parses a header value as a finite number and returns it when valid.
 *
 * This function is pure: it has no concurrency or filesystem side effects, does not access the Windows filesystem, and does not perform any token redaction.
 *
 * @param headers - The Headers object to read the header from
 * @param name - The name of the header to parse
 * @returns The parsed finite number from the header, or `undefined` if the header is absent or not a finite number
 */
function parseFiniteNumberHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse an HTTP header value as a base-10 integer.
 *
 * @param headers - The Headers object to read the value from.
 * @param name - The header name to parse.
 * @returns The parsed integer if the header exists and is a finite base-10 integer, `undefined` otherwise.
 */
function parseFiniteIntHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse a reset timestamp header for the given prefix and normalize it to milliseconds since the epoch.
 *
 * Interprets `<prefix>-reset-after-seconds` as a relative seconds offset from now, and `<prefix>-reset-at` as
 * either an absolute epoch seconds value or an HTTP-date; returns the corresponding millisecond timestamp or
 * `undefined` when no valid value is present.
 *
 * Concurrency: callers should treat `headers` as an immutable snapshot. Behavior is independent of Windows
 * filesystem semantics. Sensitive header values (tokens) are not logged or persisted by this function.
 *
 * @param headers - The Headers object to read values from.
 * @param prefix - Header name prefix (for example `"x-rate-limit"` to read `"x-rate-limit-reset-at"` or `"x-rate-limit-reset-after-seconds"`).
 * @returns The reset time in milliseconds since epoch, or `undefined` if no valid value is found.
 */
function parseResetAtMs(headers: Headers, prefix: string, now: number): number | undefined {
	const resetAfterSeconds = parseFiniteIntHeader(headers, `${prefix}-reset-after-seconds`);
	if (typeof resetAfterSeconds === "number" && resetAfterSeconds > 0) {
		return now + resetAfterSeconds * 1000;
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
 * Create a quota snapshot from HTTP headers when quota signals are present.
 *
 * Parses primary and secondary used-percent and reset timestamps and produces a snapshot; returns `null` if no quota signals are present.
 *
 * Concurrency: pure and safe for concurrent calls.
 * Filesystem: does not access the filesystem (no Windows-specific behavior).
 * Token handling: does not log or persist header values; callers should redact sensitive headers before logging or storing.
 *
 * @param headers - HTTP headers to read quota signals from; may contain sensitive values
 * @param status - HTTP status code associated with the snapshot
 * @param now - Millisecond epoch used as the snapshot's `updatedAt` timestamp
 * @returns A QuotaSchedulerSnapshot built from available header values, or `null` when no signals are present
 */
export function readQuotaSchedulerSnapshot(headers: Headers, status: number, now = Date.now()): QuotaSchedulerSnapshot | null {
	const primaryPrefix = "x-codex-primary";
	const secondaryPrefix = "x-codex-secondary";
	const primaryUsed = parseFiniteNumberHeader(headers, `${primaryPrefix}-used-percent`);
	const secondaryUsed = parseFiniteNumberHeader(headers, `${secondaryPrefix}-used-percent`);
	const primaryResetAt = parseResetAtMs(headers, primaryPrefix, now);
	const secondaryResetAt = parseResetAtMs(headers, secondaryPrefix, now);

	const hasSignal =
		typeof primaryUsed === "number" ||
		typeof secondaryUsed === "number" ||
		typeof primaryResetAt === "number" ||
		typeof secondaryResetAt === "number";
	if (!hasSignal) return null;

	return {
		status,
		primary: { usedPercent: primaryUsed, resetAtMs: primaryResetAt },
		secondary: { usedPercent: secondaryUsed, resetAtMs: secondaryResetAt },
		updatedAt: now,
	};
}

export class PreemptiveQuotaScheduler {
	private readonly snapshots = new Map<string, QuotaSchedulerSnapshot>();
	private enabled: boolean;
	private primaryRemainingPercentThreshold: number;
	private secondaryRemainingPercentThreshold: number;
	private maxDeferralMs: number;
	private lastPruneAt = 0;

	constructor(options: QuotaSchedulerOptions = {}) {
		this.enabled = true;
		this.primaryRemainingPercentThreshold = DEFAULT_REMAINING_PERCENT_THRESHOLD;
		this.secondaryRemainingPercentThreshold = DEFAULT_REMAINING_PERCENT_THRESHOLD;
		this.maxDeferralMs = DEFAULT_MAX_DEFERRAL_MS;
		this.configure(options);
	}

	configure(options: QuotaSchedulerOptions = {}): void {
		if (typeof options.enabled === "boolean") {
			this.enabled = options.enabled;
		}

		const legacyUsedPercentThreshold = options.usedPercentThreshold;
		if (
			typeof legacyUsedPercentThreshold === "number" &&
			Number.isFinite(legacyUsedPercentThreshold)
		) {
			const clampedUsed = clampInt(legacyUsedPercentThreshold, 0, 100);
			const derivedRemaining = clampInt(100 - clampedUsed, 0, 100);
			this.primaryRemainingPercentThreshold = derivedRemaining;
			this.secondaryRemainingPercentThreshold = derivedRemaining;
		}

		if (
			typeof options.remainingPercentThresholdPrimary === "number" &&
			Number.isFinite(options.remainingPercentThresholdPrimary)
		) {
			this.primaryRemainingPercentThreshold = clampInt(
				options.remainingPercentThresholdPrimary,
				0,
				100,
			);
		}

		if (
			typeof options.remainingPercentThresholdSecondary === "number" &&
			Number.isFinite(options.remainingPercentThresholdSecondary)
		) {
			this.secondaryRemainingPercentThreshold = clampInt(
				options.remainingPercentThresholdSecondary,
				0,
				100,
			);
		}

		if (typeof options.maxDeferralMs === "number" && Number.isFinite(options.maxDeferralMs)) {
			this.maxDeferralMs = Math.max(1_000, Math.floor(options.maxDeferralMs));
		}
	}

	private maybePrune(now = Date.now()): void {
		if (now - this.lastPruneAt < 60_000) return;
		this.prune(now);
		this.lastPruneAt = now;
	}

	update(key: string, snapshot: QuotaSchedulerSnapshot): void {
		if (!key) return;
		this.maybePrune(snapshot.updatedAt || Date.now());
		this.snapshots.set(key, snapshot);
	}

	markRateLimited(key: string, retryAfterMs: number, now = Date.now()): void {
		if (!key) return;
		const waitMs = Number.isFinite(retryAfterMs) ? Math.max(0, Math.floor(retryAfterMs)) : 0;
		this.snapshots.set(key, {
			status: 429,
			primary: {
				usedPercent: 100,
				resetAtMs: now + waitMs,
			},
			secondary: {},
			updatedAt: now,
		});
	}

	getDeferral(key: string, now = Date.now()): QuotaDeferralDecision {
		this.maybePrune(now);
		if (!this.enabled) {
			return { defer: false, waitMs: 0 };
		}

		const snapshot = this.snapshots.get(key);
		if (!snapshot) return { defer: false, waitMs: 0 };

		const waitCandidates = [snapshot.primary.resetAtMs, snapshot.secondary.resetAtMs]
			.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > now)
			.map((value) => value - now)
			.filter((value) => value > 0);
		const nearestWait = waitCandidates.length > 0 ? Math.min(...waitCandidates) : 0;

		if (snapshot.status === 429 && nearestWait > 0) {
			const bounded = Math.min(nearestWait, this.maxDeferralMs);
			if (bounded > 0) {
				return { defer: true, waitMs: bounded, reason: "rate-limit" };
			}
		}

		const primaryNearExhausted =
			typeof snapshot.primary.usedPercent === "number" &&
			Number.isFinite(snapshot.primary.usedPercent) &&
			snapshot.primary.usedPercent >= 100 - this.primaryRemainingPercentThreshold;
		const secondaryNearExhausted =
			typeof snapshot.secondary.usedPercent === "number" &&
			Number.isFinite(snapshot.secondary.usedPercent) &&
			snapshot.secondary.usedPercent >= 100 - this.secondaryRemainingPercentThreshold;
		const nearExhausted = primaryNearExhausted || secondaryNearExhausted;
		if (nearExhausted && nearestWait > 0) {
			const bounded = Math.min(nearestWait, this.maxDeferralMs);
			if (bounded > 0) {
				return { defer: true, waitMs: bounded, reason: "quota-near-exhaustion" };
			}
		}

		return { defer: false, waitMs: 0 };
	}

	prune(now = Date.now()): number {
		let removed = 0;
		for (const [key, snapshot] of this.snapshots.entries()) {
			const latestReset = Math.max(snapshot.primary.resetAtMs ?? 0, snapshot.secondary.resetAtMs ?? 0);
			if (latestReset > 0 && latestReset <= now) {
				this.snapshots.delete(key);
				removed += 1;
			}
		}
		return removed;
	}
}
