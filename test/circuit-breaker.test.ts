import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  getCircuitBreaker,
  resetAllCircuitBreakers,
  clearCircuitBreakers,
} from "../lib/circuit-breaker.js";

describe("Circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts closed with default config", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe("closed");
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(3);
  });

  it("allows execution when closed", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.canExecute()).toBe(true);
  });

  it("opens after threshold failures within window", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
  });

  it("does not open if failures are outside window", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureWindowMs + 1));
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
  });

  it("throws CircuitOpenError while open", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(() => breaker.canExecute()).toThrow(CircuitOpenError);
  });

  it("transitions to half-open after reset timeout", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs + 1));
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe("half-open");
  });

  it("allows a single trial request in half-open", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs + 1));
    expect(breaker.canExecute()).toBe(true);
    expect(() => breaker.canExecute()).toThrow(CircuitOpenError);
  });

  it("closes on success from half-open", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs + 1));
    breaker.canExecute();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });

  it("reopens on failure from half-open", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs + 1));
    breaker.canExecute();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
  });

  it("reset returns to closed and clears failures", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });

  it("prunes failures on success in closed state", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureWindowMs + 1));
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
  });

  it("half-open max attempts can be customized", () => {
    const breaker = new CircuitBreaker({ halfOpenMaxAttempts: 2 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs + 1));
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.canExecute()).toBe(true);
    expect(() => breaker.canExecute()).toThrow(CircuitOpenError);
  });

  it("records failure in half-open and reopens", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs + 1));
    breaker.canExecute();
    breaker.recordFailure();
    expect(() => breaker.canExecute()).toThrow(CircuitOpenError);
  });

  it("uses failure window threshold boundary", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureWindowMs - 1));
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
  });

  it("returns singleton per key", () => {
    const first = getCircuitBreaker("alpha");
    const second = getCircuitBreaker("alpha");
    expect(first).toBe(second);
  });

  it("returns different instances for different keys", () => {
    const first = getCircuitBreaker("alpha");
    const second = getCircuitBreaker("beta");
    expect(first).not.toBe(second);
  });

  it("evicts oldest entry when max circuit breakers exceeded", () => {
    clearCircuitBreakers();
    for (let i = 0; i < 100; i++) {
      getCircuitBreaker(`key-${i}`);
    }
    const firstBreaker = getCircuitBreaker("key-0");
    getCircuitBreaker("new-key-101");
    const refetchedFirst = getCircuitBreaker("key-0");
    expect(refetchedFirst).not.toBe(firstBreaker);
  });

  it("resetAllCircuitBreakers resets all breakers to closed", () => {
    clearCircuitBreakers();
    const breaker1 = getCircuitBreaker("reset-test-1");
    const breaker2 = getCircuitBreaker("reset-test-2");
    breaker1.recordFailure();
    breaker1.recordFailure();
    breaker1.recordFailure();
    breaker2.recordFailure();
    breaker2.recordFailure();
    breaker2.recordFailure();
    expect(breaker1.getState()).toBe("open");
    expect(breaker2.getState()).toBe("open");
    resetAllCircuitBreakers();
    expect(breaker1.getState()).toBe("closed");
    expect(breaker2.getState()).toBe("closed");
  });

  it("clearCircuitBreakers removes all breakers", () => {
    const breaker = getCircuitBreaker("clear-test");
    breaker.recordFailure();
    clearCircuitBreakers();
    const newBreaker = getCircuitBreaker("clear-test");
    expect(newBreaker.getFailureCount()).toBe(0);
  });

  it("getFailureCount returns pruned failure count", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getFailureCount()).toBe(2);
    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureWindowMs + 1));
    expect(breaker.getFailureCount()).toBe(0);
  });

  it("getTimeUntilReset returns 0 when not open", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getTimeUntilReset()).toBe(0);
    breaker.recordFailure();
    expect(breaker.getTimeUntilReset()).toBe(0);
  });

  it("getTimeUntilReset returns remaining time when open", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    vi.setSystemTime(new Date(10000));
    expect(breaker.getTimeUntilReset()).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs - 10000);
  });

  it("getTimeUntilReset returns 0 when reset timeout elapsed", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    vi.setSystemTime(new Date(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs + 1000));
    expect(breaker.getTimeUntilReset()).toBe(0);
  });
});
