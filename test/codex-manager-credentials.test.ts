import { describe, expect, it } from "vitest";
import {
	applyTokenAccountIdentity,
	hasLikelyInvalidRefreshToken,
	hasUsableAccessToken,
	resolveStoredAccountIdentity,
} from "../lib/codex-manager/account-credentials.js";

const FRESH_WINDOW_MS = 5 * 60 * 1000;

describe("hasUsableAccessToken", () => {
	const now = 1_700_000_000_000;

	it("requires an access token and a finite expiry", () => {
		expect(hasUsableAccessToken({ accessToken: undefined, expiresAt: now + 10 * 60 * 1000 }, now)).toBe(false);
		expect(hasUsableAccessToken({ accessToken: "", expiresAt: now + 10 * 60 * 1000 }, now)).toBe(false);
		expect(hasUsableAccessToken({ accessToken: "access", expiresAt: undefined }, now)).toBe(false);
		expect(
			hasUsableAccessToken({ accessToken: "access", expiresAt: Number.POSITIVE_INFINITY }, now),
		).toBe(false);
		expect(hasUsableAccessToken({ accessToken: "access", expiresAt: Number.NaN }, now)).toBe(false);
	});

	it("pins the 5-minute freshness boundary as strictly greater-than", () => {
		expect(
			hasUsableAccessToken({ accessToken: "access", expiresAt: now + FRESH_WINDOW_MS }, now),
		).toBe(false);
		expect(
			hasUsableAccessToken({ accessToken: "access", expiresAt: now + FRESH_WINDOW_MS + 1 }, now),
		).toBe(true);
		expect(hasUsableAccessToken({ accessToken: "access", expiresAt: now - 1 }, now)).toBe(false);
	});
});

describe("hasLikelyInvalidRefreshToken", () => {
	it("treats missing, short, and placeholder tokens as invalid", () => {
		expect(hasLikelyInvalidRefreshToken(undefined)).toBe(true);
		expect(hasLikelyInvalidRefreshToken("")).toBe(true);
		expect(hasLikelyInvalidRefreshToken("short-token")).toBe(true);
		expect(hasLikelyInvalidRefreshToken(`   ${"x".repeat(10)}   `)).toBe(true);
		// The "token-" prefix heuristic catches test fixtures regardless of length.
		expect(hasLikelyInvalidRefreshToken(`token-${"x".repeat(40)}`)).toBe(true);
	});

	it("accepts realistic long refresh tokens", () => {
		expect(hasLikelyInvalidRefreshToken("rf_".padEnd(40, "a"))).toBe(false);
		expect(hasLikelyInvalidRefreshToken(`  ${"a".repeat(20)}  `)).toBe(false);
	});
});

describe("resolveStoredAccountIdentity", () => {
	it("returns empty when nothing resolves", () => {
		expect(resolveStoredAccountIdentity(undefined, undefined, undefined)).toEqual({});
	});

	it("adopts the token identity when nothing is stored", () => {
		expect(resolveStoredAccountIdentity(undefined, undefined, "acc_token")).toEqual({
			accountId: "acc_token",
			accountIdSource: "token",
		});
	});

	it("keeps org and manual selections stable across token changes", () => {
		expect(resolveStoredAccountIdentity("acc_org", "org", "acc_token")).toEqual({
			accountId: "acc_org",
			accountIdSource: "org",
		});
		expect(resolveStoredAccountIdentity("acc_manual", "manual", "acc_token")).toEqual({
			accountId: "acc_manual",
			accountIdSource: "manual",
		});
	});

	it("follows token changes for token-sourced identities", () => {
		expect(resolveStoredAccountIdentity("acc_old", "token", "acc_new")).toEqual({
			accountId: "acc_new",
			accountIdSource: "token",
		});
	});

	it("keeps the stored id and source when the token offers nothing", () => {
		expect(resolveStoredAccountIdentity("acc_old", "token", undefined)).toEqual({
			accountId: "acc_old",
			accountIdSource: "token",
		});
	});
});

describe("applyTokenAccountIdentity", () => {
	it("mutates the account and reports a change when the identity moves", () => {
		const account: { accountId?: string; accountIdSource?: "token" | "id_token" | "org" | "manual" } = {};
		expect(applyTokenAccountIdentity(account, "acc_token")).toBe(true);
		expect(account).toEqual({ accountId: "acc_token", accountIdSource: "token" });
	});

	it("reports no change when nothing resolves or the identity is identical", () => {
		const empty: { accountId?: string } = {};
		expect(applyTokenAccountIdentity(empty, undefined)).toBe(false);
		expect(empty).toEqual({});

		const settled = { accountId: "acc_token", accountIdSource: "token" as const };
		expect(applyTokenAccountIdentity(settled, "acc_token")).toBe(false);
		expect(settled).toEqual({ accountId: "acc_token", accountIdSource: "token" });
	});

	it("does not overwrite a manual selection", () => {
		const manual = { accountId: "acc_manual", accountIdSource: "manual" as const };
		expect(applyTokenAccountIdentity(manual, "acc_token")).toBe(false);
		expect(manual).toEqual({ accountId: "acc_manual", accountIdSource: "manual" });
	});
});
