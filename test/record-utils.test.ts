import { clampIndex, isRecord } from "../lib/storage/record-utils.js";

describe("clampIndex", () => {
	it("returns 0 when length is non-positive", () => {
		expect(clampIndex(3, 0)).toBe(0);
		expect(clampIndex(3, -1)).toBe(0);
	});

	it("clamps within bounds", () => {
		expect(clampIndex(-5, 3)).toBe(0);
		expect(clampIndex(10, 3)).toBe(2);
		expect(clampIndex(1, 3)).toBe(1);
	});

	it("floors fractional indices toward zero before clamping", () => {
		// Tampered/corrupt files can carry a fractional activeIndex (e.g. 2.7).
		// Without truncation it would survive normalization and produce
		// undefined when used to index an array.
		expect(clampIndex(2.7, 5)).toBe(2);
		expect(clampIndex(0.9, 5)).toBe(0);
		expect(clampIndex(4.999, 5)).toBe(4);
		expect(Number.isInteger(clampIndex(2.7, 5))).toBe(true);
	});

	it("truncates negative fractional indices toward zero before clamping", () => {
		expect(clampIndex(-0.5, 5)).toBe(0);
		expect(clampIndex(-2.9, 5)).toBe(0);
	});

	it("never exceeds the last index for large fractional input", () => {
		expect(clampIndex(7.5, 3)).toBe(2);
	});

	it("coerces a non-finite index to a valid bound", () => {
		// A tampered/corrupt activeIndex of NaN must not propagate through
		// Math.trunc/Math.min and yield undefined array indexing.
		expect(clampIndex(Number.NaN, 5)).toBe(0);
		// ±Infinity still clamp to the valid range rather than producing NaN.
		expect(clampIndex(Number.POSITIVE_INFINITY, 5)).toBe(4);
		expect(clampIndex(Number.NEGATIVE_INFINITY, 5)).toBe(0);
	});
});

describe("isRecord", () => {
	it("accepts plain objects and rejects arrays/null/primitives", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
		expect(isRecord(42)).toBe(false);
	});
});
