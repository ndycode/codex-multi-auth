export interface CircuitBreakerConfig {
	failureThreshold: number;
	failureWindowMs: number;
	resetTimeoutMs: number;
	halfOpenMaxAttempts: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
	failureThreshold: 3,
	failureWindowMs: 60_000,
	resetTimeoutMs: 30_000,
	halfOpenMaxAttempts: 1,
};

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
	constructor(message = "Circuit is open") {
		super(message);
		this.name = "CircuitOpenError";
	}
}

export class CircuitBreaker {
	private state: CircuitState = "closed";
	private failures: number[] = [];
	private lastStateChange: number = Date.now();
	private halfOpenAttempts: number = 0;
	private config: CircuitBreakerConfig;

	constructor(config: Partial<CircuitBreakerConfig> = {}) {
		this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
	}

	canExecute(): boolean {
		const now = Date.now();

		if (this.state === "open") {
			if (now - this.lastStateChange >= this.config.resetTimeoutMs) {
				this.transitionToHalfOpen(now);
			} else {
				throw new CircuitOpenError();
			}
		}

		if (this.state === "half-open") {
			if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
				throw new CircuitOpenError("Circuit is half-open");
			}
			this.halfOpenAttempts += 1;
			return true;
		}

		return true;
	}

	recordSuccess(): void {
		const now = Date.now();
		if (this.state === "half-open") {
			this.resetToClosed(now);
			return;
		}

		if (this.state === "closed") {
			this.pruneFailures(now);
		}
	}

	recordFailure(): void {
		const now = Date.now();
		this.pruneFailures(now);
		this.failures.push(now);

		if (this.state === "half-open") {
			this.transitionToOpen(now);
			return;
		}

		if (this.state === "closed" && this.failures.length >= this.config.failureThreshold) {
			this.transitionToOpen(now);
		}
	}

	getState(): CircuitState {
		return this.state;
	}

	reset(): void {
		this.resetToClosed(Date.now());
	}

	getFailureCount(): number {
		this.pruneFailures(Date.now());
		return this.failures.length;
	}

	getTimeUntilReset(): number {
		if (this.state !== "open") return 0;
		const elapsed = Date.now() - this.lastStateChange;
		return Math.max(0, this.config.resetTimeoutMs - elapsed);
	}

	private pruneFailures(now: number): void {
		const cutoff = now - this.config.failureWindowMs;
		this.failures = this.failures.filter((timestamp) => timestamp >= cutoff);
	}

	private transitionToOpen(now: number): void {
		this.state = "open";
		this.lastStateChange = now;
		this.halfOpenAttempts = 0;
	}

	private transitionToHalfOpen(now: number): void {
		this.state = "half-open";
		this.lastStateChange = now;
		this.halfOpenAttempts = 0;
	}

	private resetToClosed(now: number): void {
		this.state = "closed";
		this.lastStateChange = now;
		this.halfOpenAttempts = 0;
		this.failures = [];
	}
}

const MAX_CIRCUIT_BREAKERS = 100;
const circuitBreakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(key: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
	let breaker = circuitBreakers.get(key);
	if (!breaker) {
		if (circuitBreakers.size >= MAX_CIRCUIT_BREAKERS) {
			const firstKey = circuitBreakers.keys().next().value;
			// istanbul ignore next -- defensive: firstKey always exists when size >= MAX_CIRCUIT_BREAKERS
			if (firstKey) circuitBreakers.delete(firstKey);
		}
		breaker = new CircuitBreaker(config);
		circuitBreakers.set(key, breaker);
	}
	return breaker;
}

export function resetAllCircuitBreakers(): void {
	for (const breaker of circuitBreakers.values()) {
		breaker.reset();
	}
}

export function clearCircuitBreakers(): void {
	circuitBreakers.clear();
}
