import { describe, expect, it } from "vitest";
import { parseBooleanEnv } from "../lib/env-parsing.js";

describe("parseBooleanEnv", () => {
	describe("truthy literals", () => {
		it.each([
			["1", true],
			["0", false],
			["true", true],
			["false", false],
			["yes", true],
			["no", false],
		])("parses %s as %s", (input, expected) => {
			expect(parseBooleanEnv(input)).toBe(expected);
		});
	});

	describe("case and whitespace tolerance", () => {
		it.each([
			["TRUE", true],
			["True", true],
			["FALSE", false],
			["YES", true],
			["No", false],
			["  true  ", true],
			["\tfalse\n", false],
			["  1 ", true],
			["  0 ", false],
		])("parses %j as %s", (input, expected) => {
			expect(parseBooleanEnv(input)).toBe(expected);
		});
	});

	describe("undefined-returning inputs", () => {
		it("returns undefined for undefined input", () => {
			expect(parseBooleanEnv(undefined)).toBeUndefined();
		});

		it.each([
			[""],
			["   "],
			["\t\n"],
			["maybe"],
			["enabled"],
			["disabled"],
			["on"],
			["off"],
			["2"],
			["-1"],
			["null"],
			["undefined"],
		])("returns undefined for %j", (input) => {
			expect(parseBooleanEnv(input)).toBeUndefined();
		});
	});

	describe("nullish-coalescing semantics", () => {
		it("lets callers fall through unrecognised values to a default", () => {
			const fallback = true;
			expect(parseBooleanEnv("garbage") ?? fallback).toBe(true);
			expect(parseBooleanEnv(undefined) ?? fallback).toBe(true);
			expect(parseBooleanEnv("") ?? fallback).toBe(true);
		});

		it("respects an explicitly parsed false over the default", () => {
			const fallback = true;
			expect(parseBooleanEnv("false") ?? fallback).toBe(false);
			expect(parseBooleanEnv("0") ?? fallback).toBe(false);
		});
	});
});
