import { describe, expect, it } from "vitest";
import {
	findPrimaryCodexCommand,
	normalizeAuthAlias,
	shouldHandleMultiAuthAuth,
	splitCodexCommandArgs,
} from "../scripts/codex-routing.js";

describe("codex-routing", () => {
	describe("normalizeAuthAlias", () => {
		it("normalizes supported auth aliases", () => {
			expect(normalizeAuthAlias(["multi", "auth", "status"])).toEqual([
				"auth",
				"status",
			]);
			expect(normalizeAuthAlias(["multi-auth", "login"])).toEqual([
				"auth",
				"login",
			]);
			expect(normalizeAuthAlias(["multiauth", "list"])).toEqual([
				"auth",
				"list",
			]);
			expect(normalizeAuthAlias(["auth", "check"])).toEqual([
				"auth",
				"check",
			]);
		});

		it("leaves unrelated commands unchanged", () => {
			expect(normalizeAuthAlias(["status"])).toEqual(["status"]);
			expect(normalizeAuthAlias(["multi"])).toEqual(["multi"]);
		});
	});

	describe("shouldHandleMultiAuthAuth", () => {
		it("routes only known auth subcommands to multi-auth runner", () => {
			expect(shouldHandleMultiAuthAuth(["auth"])).toBe(true);
			expect(shouldHandleMultiAuthAuth(["auth", "login"])).toBe(true);
			expect(shouldHandleMultiAuthAuth(["auth", "--help"])).toBe(true);
			expect(
				shouldHandleMultiAuthAuth(["auth", "unknown-subcommand"]),
			).toBe(false);
			expect(shouldHandleMultiAuthAuth(["status"])).toBe(false);
		});

		it("rejects non-auth top-level commands", () => {
			expect(shouldHandleMultiAuthAuth([])).toBe(false);
			expect(shouldHandleMultiAuthAuth(["multi-auth", "login"])).toBe(false);
		});
	});

	it("preserves the original command token while exposing a normalized form", () => {
		expect(
			findPrimaryCodexCommand(["-c", 'profile="dev"', "ReSuMe", "session-123"]),
		).toMatchObject({
			command: "ReSuMe",
			normalizedCommand: "resume",
			index: 2,
		});
	});

	it("keeps leading and trailing args unchanged when splitting command args", () => {
		expect(
			splitCodexCommandArgs([
				"-c",
				'profile="dev"',
				"FoRk",
				"session-123",
				"--trace",
			]),
		).toEqual({
			leadingArgs: ["-c", 'profile="dev"'],
			command: "FoRk",
			normalizedCommand: "fork",
			trailingArgs: ["session-123", "--trace"],
		});
	});
});
