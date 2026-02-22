import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isRecord, nowMs, toStringValue, sleep } from '../lib/utils.js';

describe('Utils Module', () => {
	describe('isRecord', () => {
		it('should return true for plain objects', () => {
			expect(isRecord({})).toBe(true);
			expect(isRecord({ key: 'value' })).toBe(true);
			expect(isRecord({ nested: { obj: true } })).toBe(true);
		});

		it('should return false for null', () => {
			expect(isRecord(null)).toBe(false);
		});

		it('should return false for arrays', () => {
			expect(isRecord([])).toBe(false);
			expect(isRecord([1, 2, 3])).toBe(false);
			expect(isRecord(['a', 'b'])).toBe(false);
		});

		it('should return false for primitives', () => {
			expect(isRecord('string')).toBe(false);
			expect(isRecord(123)).toBe(false);
			expect(isRecord(true)).toBe(false);
			expect(isRecord(undefined)).toBe(false);
			expect(isRecord(Symbol('test'))).toBe(false);
		});

		it('should return true for class instances (they are objects)', () => {
			class TestClass {
				prop = 'value';
			}
			expect(isRecord(new TestClass())).toBe(true);
		});

		it('should return true for Object.create(null)', () => {
			expect(isRecord(Object.create(null))).toBe(true);
		});

		it('should return false for functions', () => {
			expect(isRecord(() => {})).toBe(false);
			expect(isRecord(function named() {})).toBe(false);
		});
	});

	describe('nowMs', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should return current timestamp in milliseconds', () => {
			const fixedTime = 1704067200000;
			vi.setSystemTime(fixedTime);
			expect(nowMs()).toBe(fixedTime);
		});

		it('should advance with mocked time', () => {
			const startTime = 1704067200000;
			vi.setSystemTime(startTime);
			expect(nowMs()).toBe(startTime);

			vi.advanceTimersByTime(1000);
			expect(nowMs()).toBe(startTime + 1000);
		});

		it('should return a number', () => {
			expect(typeof nowMs()).toBe('number');
		});
	});

	describe('toStringValue', () => {
		it('should return strings unchanged', () => {
			expect(toStringValue('hello')).toBe('hello');
			expect(toStringValue('')).toBe('');
			expect(toStringValue('123')).toBe('123');
		});

		it('should convert null to "null"', () => {
			expect(toStringValue(null)).toBe('null');
		});

		it('should convert undefined to "undefined"', () => {
			expect(toStringValue(undefined)).toBe('undefined');
		});

		it('should convert numbers to string', () => {
			expect(toStringValue(123)).toBe('123');
			expect(toStringValue(0)).toBe('0');
			expect(toStringValue(-42)).toBe('-42');
			expect(toStringValue(3.14)).toBe('3.14');
			expect(toStringValue(NaN)).toBe('NaN');
			expect(toStringValue(Infinity)).toBe('Infinity');
		});

		it('should convert booleans to string', () => {
			expect(toStringValue(true)).toBe('true');
			expect(toStringValue(false)).toBe('false');
		});

		it('should JSON.stringify objects', () => {
			expect(toStringValue({})).toBe('{}');
			expect(toStringValue({ key: 'value' })).toBe('{"key":"value"}');
			expect(toStringValue([1, 2, 3])).toBe('[1,2,3]');
		});

		it('should handle nested objects', () => {
			const nested = { a: { b: { c: 1 } } };
			expect(toStringValue(nested)).toBe('{"a":{"b":{"c":1}}}');
		});

		it('should fall back to String() for circular references', () => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			expect(toStringValue(circular)).toBe('[object Object]');
		});

		it('should convert symbols using String()', () => {
			expect(toStringValue(Symbol('test'))).toBe('Symbol(test)');
		});

		it('should convert BigInt using String()', () => {
			expect(toStringValue(BigInt(9007199254740991))).toBe('9007199254740991');
		});
	});

	describe('sleep', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should return a promise', () => {
			const result = sleep(100);
			expect(result).toBeInstanceOf(Promise);
		});

		it('should resolve after specified milliseconds', async () => {
			const resolved = vi.fn();
			const promise = sleep(1000).then(resolved);

			expect(resolved).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(500);
			expect(resolved).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(500);
			await promise;
			expect(resolved).toHaveBeenCalledOnce();
		});

		it('should resolve immediately for 0ms', async () => {
			const resolved = vi.fn();
			const promise = sleep(0).then(resolved);

			await vi.advanceTimersByTimeAsync(0);
			await promise;
			expect(resolved).toHaveBeenCalledOnce();
		});

		it('should resolve with undefined', async () => {
			const promise = sleep(100);
			vi.advanceTimersByTime(100);
			const result = await promise;
			expect(result).toBeUndefined();
		});
	});
});
