import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JWT_CLAIM_PATH } from "../lib/constants.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";

// Maps fake token strings to decoded JWT payloads so the real candidate
// extraction in lib/auth/token-utils.ts runs against controlled claims.
const { jwtPayloads, withAccountStorageTransactionMock } = vi.hoisted(() => ({
	jwtPayloads: new Map<string, unknown>(),
	withAccountStorageTransactionMock: vi.fn(),
}));

vi.mock("../lib/auth/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth/auth.js")>();
	return {
		...actual,
		decodeJWT: (token: string) => jwtPayloads.get(token) ?? null,
	};
});

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
	};
});

const {
	isAbortError,
	isOAuthCancellation,
	persistAccountPool,
	resolveAccountSelection,
} = await import("../lib/codex-manager/login-oauth.js");

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
	withAccountStorageTransactionMock.mockReset();
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

	it("selects the targeted saved workspace instead of the default candidate", () => {
		jwtPayloads.set("access-token", {
			[JWT_CLAIM_PATH]: { chatgpt_account_id: "acc_personal" },
			organizations: [
				{ id: "org_default", name: "Default", is_default: true },
				{ id: "org_target", name: "Target" },
			],
		});

		const result = resolveAccountSelection(
			BASE_TOKENS,
			undefined,
			"org_target",
		);

		expect(result.accountIdOverride).toBe("org_target");
		expect(result.accountIdSource).toBe("org");
		expect(result.accountLabel).toContain("Target");
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

function savedAccount(id: string): AccountMetadataV3 {
	return {
		accountId: `acc_${id}`,
		email: `${id}@example.com`,
		refreshToken: `old-refresh-${id}`,
		accessToken: `old-access-${id}`,
		expiresAt: 10,
		enabled: true,
		addedAt: 1,
		lastUsed: 1,
	};
}

function incoming(id: string) {
	const access = `access-${id}`;
	const idToken = `id-${id}`;
	jwtPayloads.set(access, {
		email: `${id}@example.com`,
		[JWT_CLAIM_PATH]: { chatgpt_account_id: `acc_${id}` },
	});
	jwtPayloads.set(idToken, { email: `${id}@example.com` });
	return {
		type: "success" as const,
		access,
		refresh: `new-refresh-${id}`,
		expires: 20,
		idToken,
		accountIdOverride: `acc_${id}`,
		accountIdSource: "token" as const,
	};
}

describe("persistAccountPool selection-preserving re-auth", () => {
	let persisted: AccountStorageV3 | null;

	beforeEach(() => {
		persisted = null;
	});

	function installTransaction(storage: AccountStorageV3): void {
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(storage, async (next: AccountStorageV3) => {
				persisted = next;
			}),
		);
	}

	it("refreshes the target while preserving global, family, pin, and affinity state", async () => {
		const a = savedAccount("a");
		const b = savedAccount("b");
		installTransaction({
			version: 3,
			accounts: [a, b],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0, "codex-max": 1 },
			pinnedAccountIndex: 0,
			affinityGeneration: 7,
		});

		await persistAccountPool([incoming("b")], false, {
			preserveSelection: true,
			expectedAccount: b,
		});

		expect(persisted).toMatchObject({
			activeIndex: 0,
			pinnedAccountIndex: 0,
			affinityGeneration: 7,
		});
		expect(persisted?.activeIndexByFamily?.codex).toBe(0);
		expect(persisted?.activeIndexByFamily?.["codex-max"]).toBe(1);
		expect(persisted?.accounts).toHaveLength(2);
		expect(persisted?.accounts[1]?.refreshToken).toBe("new-refresh-b");
	});

	it("preserves a pin even for a normal add that selects the new login", async () => {
		const a = savedAccount("a");
		const b = savedAccount("b");
		installTransaction({
			version: 3,
			accounts: [a, b],
			activeIndex: 0,
			activeIndexByFamily: {},
			pinnedAccountIndex: 0,
		});

		await persistAccountPool([incoming("b")], false);

		expect(persisted?.activeIndex).toBe(1);
		expect(persisted?.pinnedAccountIndex).toBe(0);
	});

	it("rejects a different OAuth identity before persistence", async () => {
		const a = savedAccount("a");
		const b = savedAccount("b");
		installTransaction({
			version: 3,
			accounts: [a, b],
			activeIndex: 0,
			activeIndexByFamily: {},
			pinnedAccountIndex: 0,
		});

		await expect(
			persistAccountPool([incoming("a")], false, {
				preserveSelection: true,
				expectedAccount: b,
			}),
		).rejects.toThrow("does not match");
		expect(persisted).toBeNull();
	});

	it("updates the exact targeted row when saved identities are duplicated", async () => {
		const target = savedAccount("dup");
		const other = {
			...savedAccount("dup"),
			refreshToken: "old-refresh-other-row",
			lastUsed: 99,
		};
		installTransaction({
			version: 3,
			accounts: [target, other],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
			pinnedAccountIndex: 1,
		});

		await persistAccountPool([incoming("dup")], false, {
			preserveSelection: true,
			expectedAccount: target,
		});

		expect(persisted?.accounts[0]?.refreshToken).toBe("new-refresh-dup");
		expect(persisted?.accounts[1]?.refreshToken).toBe(
			"old-refresh-other-row",
		);
		expect(persisted?.activeIndex).toBe(1);
		expect(persisted?.activeIndexByFamily?.codex).toBe(1);
		expect(persisted?.pinnedAccountIndex).toBe(1);
	});

	it("accepts an email change when the provider account id is unchanged", async () => {
		const target = savedAccount("renamed");
		installTransaction({
			version: 3,
			accounts: [target],
			activeIndex: 0,
			activeIndexByFamily: {},
			pinnedAccountIndex: 0,
		});
		const result = incoming("renamed");
		jwtPayloads.set(result.access, {
			email: "new-address@example.com",
			[JWT_CLAIM_PATH]: { chatgpt_account_id: "acc_renamed" },
		});
		jwtPayloads.set(result.idToken, { email: "new-address@example.com" });

		await persistAccountPool([result], false, {
			preserveSelection: true,
			expectedAccount: target,
		});

		expect(persisted?.accounts[0]?.email).toBe("new-address@example.com");
		expect(persisted?.pinnedAccountIndex).toBe(0);
	});

	it("tracks the exact record across a concurrent refresh-token rotation", async () => {
		const expected = { ...savedAccount("stable"), recordId: "record-stable" };
		installTransaction({
			version: 3,
			accounts: [
				{
					...expected,
					refreshToken: "runtime-rotated-refresh",
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
			pinnedAccountIndex: 0,
		});

		await persistAccountPool([incoming("stable")], false, {
			preserveSelection: true,
			expectedAccount: expected,
		});

		expect(persisted?.accounts[0]?.recordId).toBe("record-stable");
		expect(persisted?.accounts[0]?.refreshToken).toBe("new-refresh-stable");
		expect(persisted?.pinnedAccountIndex).toBe(0);
	});
});
