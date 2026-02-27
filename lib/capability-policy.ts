export interface CapabilityPolicySnapshot {
	successes: number;
	failures: number;
	unsupported: number;
	lastSuccessAt?: number;
	lastFailureAt?: number;
}

interface CapabilityEntry extends CapabilityPolicySnapshot {
	updatedAt: number;
}

const MAX_ENTRIES = 2048;
const PASSIVE_RECOVERY_PER_MIN = 0.5;

function normalizeModel(model: string | undefined): string | null {
	if (!model) return null;
	const trimmed = model.trim().toLowerCase();
	if (!trimmed) return null;
	const stripped = trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
	return stripped.replace(/-(none|minimal|low|medium|high|xhigh)$/i, "");
}

function makeKey(accountKey: string, model: string | undefined): string | null {
	const normalized = normalizeModel(model);
	if (!accountKey || !normalized) return null;
	return `${accountKey}:${normalized}`;
}

export class CapabilityPolicyStore {
	private readonly entries = new Map<string, CapabilityEntry>();

	recordSuccess(accountKey: string, model: string, now = Date.now()): void {
		const key = makeKey(accountKey, model);
		if (!key) return;
		const existing = this.entries.get(key);
		this.entries.set(key, {
			successes: (existing?.successes ?? 0) + 1,
			failures: Math.max(0, (existing?.failures ?? 0) - 1),
			unsupported: Math.max(0, (existing?.unsupported ?? 0) - 1),
			lastSuccessAt: now,
			lastFailureAt: existing?.lastFailureAt,
			updatedAt: now,
		});
		this.evictIfNeeded();
	}

	recordFailure(accountKey: string, model: string, now = Date.now()): void {
		const key = makeKey(accountKey, model);
		if (!key) return;
		const existing = this.entries.get(key);
		this.entries.set(key, {
			successes: existing?.successes ?? 0,
			failures: (existing?.failures ?? 0) + 1,
			unsupported: existing?.unsupported ?? 0,
			lastSuccessAt: existing?.lastSuccessAt,
			lastFailureAt: now,
			updatedAt: now,
		});
		this.evictIfNeeded();
	}

	recordUnsupported(accountKey: string, model: string, now = Date.now()): void {
		const key = makeKey(accountKey, model);
		if (!key) return;
		const existing = this.entries.get(key);
		this.entries.set(key, {
			successes: existing?.successes ?? 0,
			failures: (existing?.failures ?? 0) + 1,
			unsupported: (existing?.unsupported ?? 0) + 1,
			lastSuccessAt: existing?.lastSuccessAt,
			lastFailureAt: now,
			updatedAt: now,
		});
		this.evictIfNeeded();
	}

	getBoost(accountKey: string, model: string, now = Date.now()): number {
		const key = makeKey(accountKey, model);
		if (!key) return 0;
		const entry = this.entries.get(key);
		if (!entry) return 0;

		const minutesSinceUpdate = Math.max(0, (now - entry.updatedAt) / 60_000);
		const recoveredFailures = Math.max(0, entry.failures - minutesSinceUpdate * PASSIVE_RECOVERY_PER_MIN);
		const recoveredUnsupported = Math.max(0, entry.unsupported - minutesSinceUpdate * PASSIVE_RECOVERY_PER_MIN);

		const successScore = Math.min(12, entry.successes * 2);
		const failurePenalty = Math.min(18, recoveredFailures * 3);
		const unsupportedPenalty = Math.min(24, recoveredUnsupported * 6);
		const net = successScore - failurePenalty - unsupportedPenalty;
		return Math.max(-30, Math.min(20, net));
	}

	getSnapshot(accountKey: string, model: string): CapabilityPolicySnapshot | null {
		const key = makeKey(accountKey, model);
		if (!key) return null;
		const entry = this.entries.get(key);
		if (!entry) return null;
		return {
			successes: entry.successes,
			failures: entry.failures,
			unsupported: entry.unsupported,
			lastSuccessAt: entry.lastSuccessAt,
			lastFailureAt: entry.lastFailureAt,
		};
	}

	clearAccount(accountKey: string): number {
		if (!accountKey) return 0;
		let removed = 0;
		for (const key of this.entries.keys()) {
			if (key.startsWith(`${accountKey}:`)) {
				this.entries.delete(key);
				removed += 1;
			}
		}
		return removed;
	}

	private evictIfNeeded(): void {
		if (this.entries.size <= MAX_ENTRIES) return;
		const oldest = this.entries.entries().next().value;
		if (!oldest) return;
		const [key] = oldest;
		if (typeof key === "string") {
			this.entries.delete(key);
		}
	}
}
