import type { ManagedAccount } from "../accounts.js";

const POOL_EXHAUSTION_COOLDOWN_MS = 15_000;
const SERVER_BURST_COOLDOWN_MS = 10_000;
const SERVER_BURST_THRESHOLD = 3;

type ServerBurstState = {
	windowStartedAt: number;
	accountIndices: Set<number>;
	cooldownUntil: number | null;
};

let poolExhaustionCooldownUntil: number | null = null;
let serverBurstState: ServerBurstState = {
	windowStartedAt: 0,
	accountIndices: new Set<number>(),
	cooldownUntil: null,
};

export function getPoolExhaustionCooldownRemaining(now = Date.now()): number {
	if (!poolExhaustionCooldownUntil || poolExhaustionCooldownUntil <= now) {
		return 0;
	}
	return poolExhaustionCooldownUntil - now;
}

export function armPoolExhaustionCooldown(waitMs: number, now = Date.now()): number {
	const bounded = Math.max(POOL_EXHAUSTION_COOLDOWN_MS, Math.floor(waitMs));
	poolExhaustionCooldownUntil = now + bounded;
	return poolExhaustionCooldownUntil;
}

export function clearPoolExhaustionCooldown(): void {
	poolExhaustionCooldownUntil = null;
}

export function getServerBurstCooldownRemaining(now = Date.now()): number {
	if (!serverBurstState.cooldownUntil || serverBurstState.cooldownUntil <= now) {
		return 0;
	}
	return serverBurstState.cooldownUntil - now;
}

export function recordServerBurstFailure(
	accountIndex: number,
	now = Date.now(),
): number {
	if (now - serverBurstState.windowStartedAt > SERVER_BURST_COOLDOWN_MS) {
		serverBurstState = {
			windowStartedAt: now,
			accountIndices: new Set<number>(),
			cooldownUntil: null,
		};
	}
	if (!serverBurstState.windowStartedAt) {
		serverBurstState.windowStartedAt = now;
	}
	serverBurstState.accountIndices.add(accountIndex);
	if (serverBurstState.accountIndices.size >= SERVER_BURST_THRESHOLD) {
		serverBurstState.cooldownUntil = now + SERVER_BURST_COOLDOWN_MS;
	}
	return serverBurstState.cooldownUntil ?? 0;
}

export function clearServerBurstCooldown(): void {
	serverBurstState = {
		windowStartedAt: 0,
		accountIndices: new Set<number>(),
		cooldownUntil: null,
	};
}

export function buildAdaptiveStreamFailoverCandidateOrder(
	primaryIndex: number,
	accounts: Array<Pick<ManagedAccount, "index" | "lastUsed" | "enabled" | "coolingDownUntil" | "rateLimitResetTimes">>,
	now = Date.now(),
): number[] {
	const primary = accounts.find((account) => account.index === primaryIndex);
	const alternates = accounts
		.filter((account) => account.index !== primaryIndex && account.enabled !== false)
		.filter((account) => {
			const coolingDownUntil = account.coolingDownUntil ?? 0;
			if (coolingDownUntil > now) return false;
			const rateLimitValues = Object.values(account.rateLimitResetTimes ?? {});
			return !rateLimitValues.some(
				(value) => typeof value === "number" && value > now,
			);
		})
		.sort((left, right) => (right.lastUsed ?? 0) - (left.lastUsed ?? 0))
		.slice(0, 1)
		.map((account) => account.index);
	return [primary?.index ?? primaryIndex, ...alternates];
}

export function resetRequestResilienceStateForTests(): void {
	clearPoolExhaustionCooldown();
	clearServerBurstCooldown();
}
