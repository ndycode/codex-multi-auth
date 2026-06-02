export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	// A tampered/corrupt activeIndex can be NaN; Math.trunc(NaN) is NaN and would
	// propagate through Math.min/Math.max, yielding NaN and undefined array access.
	// Coerce it to the first valid index. (±Infinity still clamp correctly below.)
	if (Number.isNaN(index)) return 0;
	return Math.max(0, Math.min(Math.trunc(index), length - 1));
}
