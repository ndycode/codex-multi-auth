import { describe, expect, it } from "vitest";
import {
	findPrimaryCodexCommand,
	splitCodexCommandArgs,
} from "../scripts/codex-routing.js";

describe("codex-routing", () => {
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
