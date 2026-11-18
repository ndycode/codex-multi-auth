/**
 * Shared helpers for parsing string environment variables.
 *
 * Pulled out of three near-identical local copies (lib/config.ts,
 * lib/refresh-lease.ts, lib/codex-manager/commands/rotation.ts) so every
 * call site agrees on accepted truthy/falsy literals and on what an
 * unparseable value returns.
 */

const TRUE_VALUES = new Set(["1", "true", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "no"]);

/**
 * Parses a boolean environment-variable string.
 *
 * Accepts (case-insensitive, trimmed): "1"/"0", "true"/"false", "yes"/"no".
 * Returns `undefined` for `undefined` input, an empty/whitespace-only
 * string, or any value that doesn't match an accepted literal — letting
 * callers fall back to nullish coalescing or default-handling logic.
 *
 * @param value - Raw env-variable value (or `undefined` when unset).
 * @returns `true`/`false` for recognised literals, otherwise `undefined`.
 */
export function parseBooleanEnv(
	value: string | undefined,
): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized.length === 0) return undefined;
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return undefined;
}

/**
 * Parses an integer environment-variable string.
 *
 * Returns `undefined` for `undefined` input, an empty/whitespace-only string,
 * or any value that does not start with a parseable integer — letting callers
 * fall back through nullish coalescing to their default. Matches the semantics
 * of the local `parseEnvInt` copies in lib/refresh-lease.ts and
 * lib/request/failover-config.ts.
 *
 * @param value - Raw env-variable value (or `undefined` when unset).
 * @returns The parsed integer, otherwise `undefined`.
 */
export function parseIntegerEnv(
	value: string | undefined,
): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}
