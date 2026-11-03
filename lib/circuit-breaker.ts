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

/**
 * Non-throwing admission result, for hot paths that would otherwise pay for a
 * {@link CircuitOpenError} allocation on every rejection during a storm.
 * `reason` names the gate that rejected so callers can keep their own error
 * taxonomy without parsing exception messages.
 */
export type CircuitAdmissionResult =
	| { ok: true }
	| {
			ok: false;
			reason: "open" | "half-open";
			/** Milliseconds until a fresh attempt may be admitted. */
			retryAfterMs: number;
	  };

export class CircuitBreaker {
	private state: CircuitState = "closed";
	private failures: number[] = [];
	private lastStateChange: number = Date.now();
	private halfOpenAttempts: number = 0;
	private probeWindow = {};
	private config: CircuitBreakerConfig;

	constructor(config: Partial<CircuitBreakerConfig> = {}) {
		this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
	}

	/**
	 * Same admission decision as {@link canExecute} but returns a result
	 * object instead of throwing, so reject-heavy callers stay exception-free.
	 * Admitting a probe still consumes the half-open attempt slot.
	 */
	tryCanExecute(onProbeAcquired?: (release: () => void) => void): CircuitAdmissionResult {
		const now = Date.now();

		if (this.state === "open") {
			if (now - this.lastStateChange >= this.config.resetTimeoutMs) {
				this.transitionToHalfOpen(now);
			} else {
				return {
					ok: false,
					reason: "open",
					retryAfterMs: Math.max(
						0,
						this.config.resetTimeoutMs - (now - this.lastStateChange),
					),
				};
			}
		}

		if (this.state === "half-open") {
			if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
				if (this.hasHalfOpenProbeWaitElapsed(now)) {
					this.resetHalfOpenProbeWindow(now);
				} else {
					return {
						ok: false,
						reason: "half-open",
						retryAfterMs: Math.max(
							0,
							this.config.resetTimeoutMs - (now - this.lastStateChange),
						),
					};
				}
			}
			this.halfOpenAttempts += 1;
            const window = this.probeWindow;
            let released = false;
            onProbeAcquired?.(() => {
                if (released) return;
                released = true;
                if (this.state === "half-open" && this.probeWindow === window) this.halfOpenAttempts -= 1;
            });
			return { ok: true };
		}

		return { ok: true };
	}

	canExecute(): boolean {
		const result = this.tryCanExecute();
		if (result.ok) return true;
		throw new CircuitOpenError(
			result.reason === "half-open" ? "Circuit is half-open" : "Circuit is open",
		);
	}

	isAvailable(now = Date.now()): boolean {
		if (this.state === "open") {
			return now - this.lastStateChange >= this.config.resetTimeoutMs;
		}

		if (this.state === "half-open") {
			return (
				this.halfOpenAttempts < this.config.halfOpenMaxAttempts ||
				this.hasHalfOpenProbeWaitElapsed(now)
			);
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

	getTimeUntilAvailable(now = Date.now()): number {
		if (this.state === "open") {
			return Math.max(0, this.config.resetTimeoutMs - (now - this.lastStateChange));
		}

		if (
			this.state === "half-open" &&
			this.halfOpenAttempts >= this.config.halfOpenMaxAttempts
		) {
			return Math.max(0, this.config.resetTimeoutMs - (now - this.lastStateChange));
		}

		return 0;
	}

	private pruneFailures(now: number): void {
		const cutoff = now - this.config.failureWindowMs;
		this.failures = this.failures.filter((timestamp) => timestamp >= cutoff);
	}

	private transitionToOpen(now: number): void {
		this.state = "open";
		this.lastStateChange = now;
		this.halfOpenAttempts = 0;
		this.probeWindow = {};
	}

	private transitionToHalfOpen(now: number): void {
		this.state = "half-open";
		this.lastStateChange = now;
		this.halfOpenAttempts = 0;
		this.probeWindow = {};
	}

	private hasHalfOpenProbeWaitElapsed(now: number): boolean {
		return now - this.lastStateChange >= this.config.resetTimeoutMs;
	}

	private resetHalfOpenProbeWindow(now: number): void {
		this.lastStateChange = now;
		this.halfOpenAttempts = 0;
		this.probeWindow = {};
	}

	private resetToClosed(now: number): void {
		this.state = "closed";
		this.lastStateChange = now;
		this.halfOpenAttempts = 0;
		this.probeWindow = {};
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

/**
 * Remove a single circuit breaker by key. Used when an account is removed so a
 * later re-add of the same identity starts with a fresh (closed) circuit rather
 * than inheriting an open one (accounts-02).
 */
export function removeCircuitBreaker(key: string): void {
	circuitBreakers.delete(key);
}
