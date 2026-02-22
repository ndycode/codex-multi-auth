export interface AuthRateLimitConfig {
	maxAttempts: number;
	windowMs: number;
}

const DEFAULT_CONFIG: AuthRateLimitConfig = {
	maxAttempts: 5,
	windowMs: 60_000,
};

interface AttemptRecord {
	timestamps: number[];
}

const attemptsByAccount = new Map<string, AttemptRecord>();
let config: AuthRateLimitConfig = { ...DEFAULT_CONFIG };

export function configureAuthRateLimit(newConfig: Partial<AuthRateLimitConfig>): void {
	config = { ...config, ...newConfig };
}

export function getAuthRateLimitConfig(): AuthRateLimitConfig {
	return { ...config };
}

function getAccountKey(accountId: string): string {
	return accountId.toLowerCase().trim();
}

function pruneOldAttempts(record: AttemptRecord, now: number): void {
	const cutoff = now - config.windowMs;
	record.timestamps = record.timestamps.filter((ts) => ts > cutoff);
}

export function canAttemptAuth(accountId: string): boolean {
	const key = getAccountKey(accountId);
	const record = attemptsByAccount.get(key);
	
	if (!record) {
		return true;
	}
	
	const now = Date.now();
	pruneOldAttempts(record, now);
	
	return record.timestamps.length < config.maxAttempts;
}

export function recordAuthAttempt(accountId: string): void {
	const key = getAccountKey(accountId);
	const now = Date.now();
	
	let record = attemptsByAccount.get(key);
	if (!record) {
		record = { timestamps: [] };
		attemptsByAccount.set(key, record);
	}
	
	pruneOldAttempts(record, now);
	record.timestamps.push(now);
}

export function getAttemptsRemaining(accountId: string): number {
	const key = getAccountKey(accountId);
	const record = attemptsByAccount.get(key);
	
	if (!record) {
		return config.maxAttempts;
	}
	
	const now = Date.now();
	pruneOldAttempts(record, now);
	
	return Math.max(0, config.maxAttempts - record.timestamps.length);
}

export function getTimeUntilReset(accountId: string): number {
	const key = getAccountKey(accountId);
	const record = attemptsByAccount.get(key);
	
	if (!record || record.timestamps.length === 0) {
		return 0;
	}
	
	const now = Date.now();
	pruneOldAttempts(record, now);
	
	if (record.timestamps.length === 0) {
		return 0;
	}
	
	const oldestAttempt = Math.min(...record.timestamps);
	const resetTime = oldestAttempt + config.windowMs;
	
	return Math.max(0, resetTime - now);
}

export function resetAuthRateLimit(accountId: string): void {
	const key = getAccountKey(accountId);
	attemptsByAccount.delete(key);
}

export function resetAllAuthRateLimits(): void {
	attemptsByAccount.clear();
}

export class AuthRateLimitError extends Error {
	constructor(
		public readonly accountId: string,
		public readonly attemptsRemaining: number,
		public readonly resetAfterMs: number,
	) {
		const resetSeconds = Math.ceil(resetAfterMs / 1000);
		super(`Auth rate limit exceeded for account. Retry after ${resetSeconds}s`);
		this.name = "AuthRateLimitError";
	}
}

export function checkAuthRateLimit(accountId: string): void {
	if (!canAttemptAuth(accountId)) {
		throw new AuthRateLimitError(
			accountId,
			getAttemptsRemaining(accountId),
			getTimeUntilReset(accountId),
		);
	}
}
