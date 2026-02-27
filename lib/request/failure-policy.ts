import { ACCOUNT_LIMITS } from "../constants.js";
import type { CooldownReason } from "../storage.js";

export type FailureKind =
	| "auth-refresh"
	| "network"
	| "server"
	| "rate-limit"
	| "empty-response";

export type FailoverMode = "aggressive" | "balanced" | "conservative";

export interface FailurePolicyInput {
	kind: FailureKind;
	consecutiveAuthFailures?: number;
	maxAuthFailuresBeforeRemoval?: number;
	serverRetryAfterMs?: number;
	failoverMode?: FailoverMode;
}

export interface FailurePolicyDecision {
	rotateAccount: boolean;
	refundToken: boolean;
	recordFailure: boolean;
	markRateLimited: boolean;
	removeAccount: boolean;
	cooldownMs?: number;
	cooldownReason?: CooldownReason;
	retrySameAccount: boolean;
	retryDelayMs?: number;
	handoffStrategy: "soft" | "hard";
}

const DEFAULT_NETWORK_COOLDOWN_MS = 6_000;
const DEFAULT_SERVER_COOLDOWN_MS = 4_000;
const NETWORK_RETRY_DELAY_MS: Record<FailoverMode, number> = {
	aggressive: 0,
	balanced: 250,
	conservative: 900,
};
const EMPTY_RESPONSE_RETRY_DELAY_MS: Record<FailoverMode, number> = {
	aggressive: 0,
	balanced: 200,
	conservative: 600,
};

function getFailoverMode(input: FailurePolicyInput): FailoverMode {
	return input.failoverMode ?? "aggressive";
}

export function evaluateFailurePolicy(
	input: FailurePolicyInput,
	overrides?: {
		networkCooldownMs?: number;
		serverCooldownMs?: number;
	},
): FailurePolicyDecision {
	switch (input.kind) {
		case "auth-refresh": {
			const failures = Math.max(0, Math.floor(input.consecutiveAuthFailures ?? 0));
			const maxFailures = Math.max(
				1,
				Math.floor(input.maxAuthFailuresBeforeRemoval ?? ACCOUNT_LIMITS.MAX_AUTH_FAILURES_BEFORE_REMOVAL),
			);
			return {
				rotateAccount: true,
				refundToken: false,
				recordFailure: false,
				markRateLimited: false,
				removeAccount: failures >= maxFailures,
				cooldownMs: ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
				cooldownReason: "auth-failure",
				retrySameAccount: false,
				handoffStrategy: "hard",
			};
		}
		case "network": {
			const mode = getFailoverMode(input);
			const cooldownMs = Math.max(
				0,
				Math.floor(overrides?.networkCooldownMs ?? DEFAULT_NETWORK_COOLDOWN_MS),
			);
			const retryDelayMs = NETWORK_RETRY_DELAY_MS[mode];
			const retrySameAccount = retryDelayMs > 0;
			return {
				rotateAccount: !retrySameAccount,
				refundToken: true,
				recordFailure: true,
				markRateLimited: false,
				removeAccount: false,
				cooldownMs,
				cooldownReason: cooldownMs > 0 ? "network-error" : undefined,
				retrySameAccount,
				retryDelayMs: retrySameAccount ? retryDelayMs : undefined,
				handoffStrategy: "soft",
			};
		}
		case "server": {
			const mode = getFailoverMode(input);
			const retryAfterMs = Math.max(0, Math.floor(input.serverRetryAfterMs ?? 0));
			const fallbackCooldown = Math.max(
				0,
				Math.floor(overrides?.serverCooldownMs ?? DEFAULT_SERVER_COOLDOWN_MS),
			);
			const cooldownMs = retryAfterMs > 0 ? retryAfterMs : fallbackCooldown;
			const retrySameAccount = mode === "conservative" && retryAfterMs <= 0;
			return {
				rotateAccount: !retrySameAccount,
				refundToken: true,
				recordFailure: true,
				markRateLimited: false,
				removeAccount: false,
				cooldownMs,
				cooldownReason: cooldownMs > 0 ? "network-error" : undefined,
				retrySameAccount,
				retryDelayMs: retrySameAccount ? 500 : undefined,
				handoffStrategy: "hard",
			};
		}
		case "rate-limit": {
			return {
				rotateAccount: true,
				refundToken: false,
				recordFailure: false,
				markRateLimited: true,
				removeAccount: false,
				retrySameAccount: false,
				handoffStrategy: "hard",
			};
		}
		case "empty-response": {
			const mode = getFailoverMode(input);
			const retryDelayMs = EMPTY_RESPONSE_RETRY_DELAY_MS[mode];
			const retrySameAccount = retryDelayMs > 0;
			return {
				rotateAccount: !retrySameAccount,
				refundToken: true,
				recordFailure: true,
				markRateLimited: false,
				removeAccount: false,
				retrySameAccount,
				retryDelayMs: retrySameAccount ? retryDelayMs : undefined,
				handoffStrategy: "soft",
			};
		}
		default:
			return {
				rotateAccount: true,
				refundToken: true,
				recordFailure: true,
				markRateLimited: false,
				removeAccount: false,
				retrySameAccount: false,
				handoffStrategy: "hard",
			};
	}
}
