import { describe, expect, it } from "vitest";
import {
	AUTH_SUBCOMMANDS,
	normalizeAuthAlias,
	shouldHandleMultiAuthAuth,
} from "../scripts/codex-routing.js";

describe("codex routing helpers", () => {
	it("normalizes supported auth aliases", () => {
		expect(normalizeAuthAlias(["multi", "auth", "status"])).toEqual(["auth", "status"]);
		expect(normalizeAuthAlias(["multi-auth", "login"])).toEqual(["auth", "login"]);
		expect(normalizeAuthAlias(["multiauth", "list"])).toEqual(["auth", "list"]);
		expect(normalizeAuthAlias(["auth", "check"])).toEqual(["auth", "check"]);
	});

	it("routes only known auth subcommands to multi-auth runner", () => {
		expect(shouldHandleMultiAuthAuth(["auth"])).toBe(true);
		expect(shouldHandleMultiAuthAuth(["auth", "login"])).toBe(true);
		expect(shouldHandleMultiAuthAuth(["auth", "--help"])).toBe(true);
		expect(shouldHandleMultiAuthAuth(["auth", "unknown-subcommand"])).toBe(false);
		expect(shouldHandleMultiAuthAuth(["status"])).toBe(false);
	});

	it("keeps wrapper auth routing aligned with manager subcommands", () => {
		const managerSubcommands = [
			"login",
			"list",
			"status",
			"switch",
			"check",
			"features",
			"usage",
			"verify-flagged",
			"forecast",
			"best",
			"report",
			"account",
			"budget",
			"bridge",
			"integrations",
			"models",
			"monitor",
			"pro-advice",
			"rotation",
			"why-selected",
			"verify",
			"fix",
			"doctor",
			"config",
			"init-config",
			"debug",
		];

		for (const subcommand of managerSubcommands) {
			expect(AUTH_SUBCOMMANDS.has(subcommand), subcommand).toBe(true);
			expect(shouldHandleMultiAuthAuth(["auth", subcommand]), subcommand).toBe(true);
		}
	});
});
