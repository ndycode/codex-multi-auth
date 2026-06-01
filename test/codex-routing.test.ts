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

	it("routes the newer auth subcommands (unpin, workspace, uninstall) locally", () => {
		// cli-manager-01/02: guard against accidental forwarding regressions for the
		// subcommands added after the original wrapper list was written.
		for (const subcommand of ["unpin", "workspace", "uninstall"]) {
			expect(AUTH_SUBCOMMANDS.has(subcommand), subcommand).toBe(true);
			expect(shouldHandleMultiAuthAuth(["auth", subcommand]), subcommand).toBe(true);
		}
	});

	it("keeps wrapper auth routing aligned with manager subcommands", async () => {
		// Import the REAL dispatcher command set instead of hardcoding it, so this
		// test fails whenever a manager command is added without a matching wrapper
		// route (cli-manager-01/02). Every command the standalone manager dispatches
		// must also be routable through the `codex-multi-auth-codex auth <cmd>` wrapper.
		// Sourced from the shared internal module (not the CLI entrypoint) so the set
		// is a single source of truth for both the dispatcher and this test.
		const { ACCOUNT_MANAGER_COMMANDS } = await import(
			"../lib/codex-manager/account-manager-commands.js"
		);

		for (const subcommand of ACCOUNT_MANAGER_COMMANDS) {
			expect(AUTH_SUBCOMMANDS.has(subcommand), subcommand).toBe(true);
			expect(shouldHandleMultiAuthAuth(["auth", subcommand]), subcommand).toBe(true);
		}
	});
});
