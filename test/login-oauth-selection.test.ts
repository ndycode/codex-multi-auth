import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JWT_CLAIM_PATH } from "../lib/constants.js";

// Maps fake token strings to decoded JWT payloads so the real candidate
// extraction in lib/auth/token-utils.ts runs against controlled claims.
const { jwtPayloads } = vi.hoisted(() => ({
	jwtPayloads: new Map<string, unknown>(),
}));

vi.mock("../lib/auth/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth/auth.js")>();
	return {
		...actual,
		decodeJWT: (token: string) => jwtPayloads.get(token) ?? null,
	};
});

const { isAbortError, isOAuthCancellation, resolveAccountSelection } =
	await import("../lib/codex-manager/login-oauth.js");

const BASE_TOKENS = {
	type: "success" as const,
	access: "access-token",
	refresh: "refresh-token",
	expires: 9_999_999_999_999,
	idToken: "id-token",
};

const originalEnvOverride = process.env.CODEX_AUTH_ACCOUNT_ID;

beforeEach(() => {
	jwtPayloads.clear();
	delete process.env.CODEX_AUTH_ACCOUNT_ID;
});

afterEach(() => {
	if (originalEnvOverride === undefined) {
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	} else {
		process.env.CODEX_AUTH_ACCOUNT_ID = originalEnvOverride;
	}
});

describe("isOAuthCancellation", () => {
	it("matches cancelled/canceled in message or reason, case-insensitively", () => {
		expect(
			isOAuthCancellation({ type: "failed", message: "Login Cancelled by user" }),
		).toBe(true);
		expect(
			isOAuthCancellation({ type: "failed", message: "flow was CANCELED" }),
		).toBe(true);
		// The reason field is only consulted when message is absent.
		expect(
			isOAuthCancellation({ type: "failed", reason: "Login Cancelled" }),
		).toBe(true);
		expect(isOAuthCancellation({ type: "failed", reason: "unknown" })).toBe(false);
		expect(isOAuthCancellation({ type: "failed" })).toBe(false);
	});
});

describe("isAbortError", () => {
	it("recognizes AbortError names and ABORT_ERR codes on real Errors only", () => {
		const named = new Error("aborted");
		named.name = "AbortError";
		expect(isAbortError(named)).toBe(true);

		const coded = new Error("aborted") as Error & { code?: string };
		coded.code = "ABORT_ERR";
		expect(isAbortError(coded)).toBe(true);

		expect(isAbortError(new Error("plain"))).toBe(false);
		expect(isAbortError({ name: "AbortError" })).toBe(false);
		expect(isAbortError("AbortError")).toBe(false);
	});
});

describe("resolveAccountSelection", () => {
	it("returns the tokens unchanged when no candidates exist", () => {
		const result = resolveAccountSelection(BASE_TOKENS);
		expect(result).toEqual(BASE_TOKENS);
		expect(result.workspaces).toBeUndefined();
	});

	it("adopts a single token candidate and surfaces it as a workspace", () => {
		jwtPayloads.set("access-token", {
			[JWT_CLAIM_PATH]: { chatgpt_account_id: "acc_solo" },
		});

		const result = resolveAccountSelection(BASE_TOKENS);

		expect(result.accountIdOverride).toBe("acc_solo");
		expect(result.accountIdSource).toBe("token");
		expect(result.workspaces).toHaveLength(1);
		expect(result.workspaces?.[0]).toMatchObject({
			id: "acc_solo",
			enabled: true,
			isDefault: true,
		});
	});

	it("prefers the default non-personal org among multiple candidates and keeps every workspace", () => {
		jwtPayloads.set("access-token", {
			[JWT_CLAIM_PATH]: { chatgpt_account_id: "acc_personal" },
			organizations: [
				{ id: "org_personal", name: "Personal", is_default: false, is_personal: true },
				{ id: "org_team", name: "Acme Team", is_default: true },
			],
		});

		const result = resolveAccountSelection(BASE_TOKENS);

		expect(result.accountIdOverride).toBe("org_team");
		expect(result.accountIdSource).toBe("org");
		expect(result.accountLabel).toContain("Acme Team");
		// Issue #491/#512: every workspace exposed by the token must persist so
		// `workspace <account>` can switch between them later.
		expect(result.workspaces?.map((workspace) => workspace.id)).toEqual([
			"acc_personal",
			"org_personal",
			"org_team",
		]);
	});

	it("binds an explicit --org override as manual and reuses the candidate label", () => {
		jwtPayloads.set("access-token", {
			organizations: [
				{ id: "org_a", name: "Alpha", is_default: true },
				{ id: "org_b", name: "Beta" },
			],
		});

		const result = resolveAccountSelection(BASE_TOKENS, "org_b");

		expect(result.accountIdOverride).toBe("org_b");
		expect(result.accountIdSource).toBe("manual");
		expect(result.accountLabel).toContain("Beta");
		// Issue #512: the explicit-binding flow must persist workspaces too.
		expect(result.workspaces?.map((workspace) => workspace.id)).toEqual([
			"org_a",
			"org_b",
		]);
	});

	it("binds an unknown --org override bare, without a fabricated label", () => {
		jwtPayloads.set("access-token", {
			organizations: [{ id: "org_a", name: "Alpha", is_default: true }],
		});

		const result = resolveAccountSelection(BASE_TOKENS, "org_elsewhere");

		expect(result.accountIdOverride).toBe("org_elsewhere");
		expect(result.accountIdSource).toBe("manual");
		expect(result.accountLabel).toBeUndefined();
		expect(result.workspaces?.map((workspace) => workspace.id)).toEqual(["org_a"]);
	});

	it("falls back to the CODEX_AUTH_ACCOUNT_ID env override when no --org is given", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "org_env";
		jwtPayloads.set("access-token", {
			organizations: [{ id: "org_env", name: "EnvOrg" }],
		});

		const result = resolveAccountSelection(BASE_TOKENS);

		expect(result.accountIdOverride).toBe("org_env");
		expect(result.accountIdSource).toBe("manual");
		expect(result.accountLabel).toContain("EnvOrg");
	});

	it("lets an explicit --org win over the ambient env override", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "org_env";
		jwtPayloads.set("access-token", {
			organizations: [
				{ id: "org_env", name: "EnvOrg" },
				{ id: "org_cli", name: "CliOrg" },
			],
		});

		const result = resolveAccountSelection(BASE_TOKENS, "org_cli");

		expect(result.accountIdOverride).toBe("org_cli");
		expect(result.accountLabel).toContain("CliOrg");
	});

	it("treats a whitespace-only --org as absent so the env fallback still applies", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "org_env";
		jwtPayloads.set("access-token", {
			organizations: [{ id: "org_env", name: "EnvOrg" }],
		});

		const result = resolveAccountSelection(BASE_TOKENS, "   ");

		expect(result.accountIdOverride).toBe("org_env");
	});
});
