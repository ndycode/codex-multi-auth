import { describe, expect, it } from "vitest";
import { authorizeAction, getAuthorizationRole } from "../lib/authorization.js";

describe("authorization", () => {
	it("defaults to admin role", () => {
		const previousRole = process.env.CODEX_AUTH_ROLE;
		try {
			delete process.env.CODEX_AUTH_ROLE;
			expect(getAuthorizationRole()).toBe("admin");
			expect(authorizeAction("secrets:rotate").allowed).toBe(true);
		} finally {
			if (previousRole === undefined) {
				delete process.env.CODEX_AUTH_ROLE;
			} else {
				process.env.CODEX_AUTH_ROLE = previousRole;
			}
		}
	});

	it("denies write actions for viewer role", () => {
		const previousRole = process.env.CODEX_AUTH_ROLE;
		try {
			process.env.CODEX_AUTH_ROLE = "viewer";
			const auth = authorizeAction("accounts:write");
			expect(auth.allowed).toBe(false);
			expect(auth.role).toBe("viewer");
			expect(auth.reason).toContain("accounts:write");
		} finally {
			if (previousRole === undefined) {
				delete process.env.CODEX_AUTH_ROLE;
			} else {
				process.env.CODEX_AUTH_ROLE = previousRole;
			}
		}
	});

	it("allows all actions when break-glass is enabled", () => {
		const previousRole = process.env.CODEX_AUTH_ROLE;
		const previousBreakGlass = process.env.CODEX_AUTH_BREAK_GLASS;
		try {
			process.env.CODEX_AUTH_ROLE = "viewer";
			process.env.CODEX_AUTH_BREAK_GLASS = "1";
			expect(authorizeAction("secrets:rotate")).toEqual({
				allowed: true,
				role: "viewer",
			});
		} finally {
			if (previousRole === undefined) {
				delete process.env.CODEX_AUTH_ROLE;
			} else {
				process.env.CODEX_AUTH_ROLE = previousRole;
			}
			if (previousBreakGlass === undefined) {
				delete process.env.CODEX_AUTH_BREAK_GLASS;
			} else {
				process.env.CODEX_AUTH_BREAK_GLASS = previousBreakGlass;
			}
		}
	});
});