import { describe, expect, it } from "vitest";
import { normalizeAuthAlias, shouldHandleMultiAuthAuth } from "../scripts/codex-routing.js";

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
});
