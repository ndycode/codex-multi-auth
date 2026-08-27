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

	it("prefers an explicit --account target over an ambient env override", () => {
		// CODEX_AUTH_ACCOUNT_ID is ambient config; `--account` names one saved row
		// for this call. Letting the env win hijacked the targeted re-auth and
		// then failed the identity guard with a misleading mismatch error.
		process.env.CODEX_AUTH_ACCOUNT_ID = "org_env";
		jwtPayloads.set("access-token", {
			[JWT_CLAIM_PATH]: { chatgpt_account_id: "acc_personal" },
			organizations: [
				{ id: "org_env", name: "Env" },
				{ id: "org_target", name: "Target" },
			],
		});

		const result = resolveAccountSelection(
			BASE_TOKENS,
			undefined,
			"org_target",
		);

		expect(result.accountIdOverride).toBe("org_target");
	});

	it("pins an id_token-sourced target so the access token cannot overwrite it", () => {
		// `id_token` auto-follows the access token in resolveRequestAccountId,
		// which would rewrite the binding back to the access-token account and
		// make persistAccountPool reject our own write.
		jwtPayloads.set("access-token", {
			[JWT_CLAIM_PATH]: { chatgpt_account_id: "acc_access" },
		});
		jwtPayloads.set("id-token", {
			[JWT_CLAIM_PATH]: { chatgpt_account_id: "acc_id_only" },
		});

		const result = resolveAccountSelection(
			{ ...BASE_TOKENS, idToken: "id-token" },
			undefined,
			"acc_id_only",
		);

		expect(result.accountIdOverride).toBe("acc_id_only");
		expect(result.accountIdSource).toBe("manual");
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

	it("keeps a per-family assignment the user made deliberately", async () => {
		// A plain login used to overwrite EVERY activeIndexByFamily entry with the
		// account just signed in, silently destroying a deliberate
		// `codex-max -> account 2` binding when a third account was added.
		const a = savedAccount("a");
		const b = savedAccount("b");
		installTransaction({
			version: 3,
			accounts: [a, b],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0, "codex-max": 1 },
		});

		await persistAccountPool([incoming("c")], false);

		expect(persisted?.accounts).toHaveLength(3);
		expect(persisted?.activeIndex).toBe(2);
		// codex was merely following the global selection, so it follows the new
		// account; codex-max was pointed somewhere else on purpose and stays.
		expect(persisted?.activeIndexByFamily?.codex).toBe(2);
		expect(persisted?.activeIndexByFamily?.["codex-max"]).toBe(1);
	});

	it("moves every family that was following the global selection", async () => {
		const a = savedAccount("a");
		const b = savedAccount("b");
		installTransaction({
			version: 3,
			accounts: [a, b],
			activeIndex: 1,
			// Both families sit on the global selection, so neither is a
			// deliberate override and both follow the new login.
			activeIndexByFamily: { codex: 1, "codex-max": 1 },
		});

		await persistAccountPool([incoming("c")], false);

		expect(persisted?.activeIndex).toBe(2);
		expect(persisted?.activeIndexByFamily?.codex).toBe(2);
		expect(persisted?.activeIndexByFamily?.["codex-max"]).toBe(2);
	});

	it("moves families with no saved entry of their own", async () => {
		const a = savedAccount("a");
		installTransaction({
			version: 3,
			accounts: [a],
			activeIndex: 0,
			activeIndexByFamily: {},
		});

		await persistAccountPool([incoming("b")], false);

		expect(persisted?.activeIndex).toBe(1);
		for (const family of Object.values(persisted?.activeIndexByFamily ?? {})) {
			expect(family).toBe(1);
		}
	});

	it("drops a stale pin on a normal add that selects the new login", async () => {
		// A plain login moves activeIndex onto the account just signed in and
		// publishes it to ~/.codex/auth.json. Carrying the old pin through would
		// leave storage claiming one account is active while the runtime proxy
		// (which resolves pinnedAccountIndex first) routes every request to
		// another -- what `status` surfaces as "runtime using N, pin requests M".
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
		expect(persisted?.pinnedAccountIndex).toBeUndefined();
	});

	it("finds the target after the runtime rotated its refresh token", async () => {
		// AccountManager.commitRefreshedAuth rewrites a stored refreshToken
		// whenever a live codex session refreshes the account. Matching the target
		// by refresh token alone threw away a completed OAuth as "no longer
		// present" whenever a sign-in overlapped an active session.
		const expected = savedAccount("rot");
		installTransaction({
			version: 3,
			accounts: [{ ...expected, refreshToken: "runtime-rotated-refresh" }],
			activeIndex: 0,
			activeIndexByFamily: {},
		});

		await persistAccountPool([incoming("rot")], false, {
			preserveSelection: true,
			expectedAccount: expected,
		});

		expect(persisted?.accounts[0]?.refreshToken).toBe("new-refresh-rot");
	});

	it("re-authenticates a legacy row that carries no account id", async () => {
		// Rows saved before workspace tracking (#491) have no accountId, while
		// fresh tokens essentially always carry one. Demanding the id on both
		// sides made every such row permanently un-refreshable via --account.
		const legacy: AccountMetadataV3 = {
			...savedAccount("legacy"),
			accountId: undefined,
		};
		installTransaction({
			version: 3,
			accounts: [legacy],
			activeIndex: 0,
			activeIndexByFamily: {},
		});

		await persistAccountPool([incoming("legacy")], false, {
			preserveSelection: true,
			expectedAccount: legacy,
		});

		expect(persisted?.accounts[0]?.refreshToken).toBe("new-refresh-legacy");
		expect(persisted?.accounts[0]?.accountId).toBe("acc_legacy");
	});

	it("keeps a deliberately disabled account out of rotation", async () => {
		const disabled: AccountMetadataV3 = {
			...savedAccount("off"),
			enabled: false,
		};
		installTransaction({
			version: 3,
			accounts: [disabled],
			activeIndex: 0,
			activeIndexByFamily: {},
		});

		const result = await persistAccountPool([incoming("off")], false, {
			preserveSelection: true,
			expectedAccount: disabled,
		});

		expect(persisted?.accounts[0]?.refreshToken).toBe("new-refresh-off");
		expect(persisted?.accounts[0]?.enabled).toBe(false);
		expect(result?.accountEnabled).toBe(false);
	});

	it("re-enables an account on a plain login", async () => {
		// Signing in without a target IS the user asking for that account back.
		const disabled: AccountMetadataV3 = {
			...savedAccount("off"),
			enabled: false,
		};
		installTransaction({
			version: 3,
			accounts: [disabled],
			activeIndex: 0,
			activeIndexByFamily: {},
		});

		const result = await persistAccountPool([incoming("off")], false);

		expect(persisted?.accounts[0]?.enabled).toBe(true);
		expect(result?.accountEnabled).toBe(true);
	});

	it("ignores an index hint that no longer holds the expected identity", async () => {
		const a = savedAccount("a");
		const b = savedAccount("b");
		installTransaction({
			version: 3,
			accounts: [a, b],
			activeIndex: 0,
			activeIndexByFamily: {},
		});

		// The caller saw `b` at index 0; a concurrent write reordered the pool.
		await persistAccountPool([incoming("b")], false, {
			preserveSelection: true,
			expectedAccount: b,
			expectedAccountIndex: 0,
		});

		expect(persisted?.accounts[0]?.refreshToken).toBe("old-refresh-a");
		expect(persisted?.accounts[1]?.refreshToken).toBe("new-refresh-b");
	});

	it("reports which row it wrote and whether that row owns the Codex selection", async () => {
		const a = savedAccount("a");
		const b = savedAccount("b");
		installTransaction({
			version: 3,
			accounts: [a, b],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		});

		const refreshedActive = await persistAccountPool([incoming("b")], false, {
			preserveSelection: true,
			expectedAccount: b,
		});
		expect(refreshedActive).toMatchObject({
			outcome: "updated",
			accountIndex: 1,
			activeIndex: 1,
			isActiveAccount: true,
		});

		const refreshedOther = await persistAccountPool([incoming("a")], false, {
			preserveSelection: true,
			expectedAccount: a,
		});
		expect(refreshedOther).toMatchObject({
			accountIndex: 0,
			activeIndex: 1,
			isActiveAccount: false,
		});
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

		// Identity matching alone cannot separate these rows, and its newest-wins
		// tie-break actively points at the other one (lastUsed 99 vs 1). The
		// caller's verified position is what keeps `--account 1` deterministic.
		await persistAccountPool([incoming("dup")], false, {
			preserveSelection: true,
			expectedAccount: target,
			expectedAccountIndex: 0,
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
