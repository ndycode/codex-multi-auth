/**
 * Consolidated utility functions for the Codex plugin.
 * Extracted from various modules to eliminate duplication.
 */

/**
 * Type guard for plain objects (not arrays, not null).
 * @param value - The value to check
 * @returns True if value is a plain object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the current timestamp in milliseconds.
 * Wrapper for Date.now() to enable testing with mocked time.
 * @returns Current time in milliseconds since epoch
 */
export function nowMs(): number {
	return Date.now();
}

/**
 * Safely converts any value to a string representation.
 * @param value - The value to convert
 * @returns String representation of the value
 */
export function toStringValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value === null) {
		return "null";
	}
	if (value === undefined) {
		return "undefined";
	}
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

/**
 * Promisified setTimeout for async/await usage.
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the specified time
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
