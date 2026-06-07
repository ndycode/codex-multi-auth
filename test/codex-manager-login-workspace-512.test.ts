import { describe, expect, it } from "vitest";
import {
	applyAccountPoolResults,
	type ResolvedAccountWrite,
} from "../lib/codex-manager/account-pool-write.js";
import { findMatchingAccountIndex } from "../lib/storage.js";

// End-to-end reproduction of issue #512 using the REAL findMatchingAccountIndex
// dedup strategy that the CLI login path (persistAccountPool) uses. This proves
// the user-facing scenario is fixed, not just the isolated helpers.
//
// Key behaviour the test pins down: resolveAccountSelection runs
// selectBestAccountCandidate deterministically, so a same-email login resolves
// to the SAME default-org accountId no matter which workspace the user picked
// in the browser. The token still carries every org the email belongs to. So
// the saved row is matched (composite accountId+email) and the pool stays flat
// — exactly the "Total did not increase" the reporter saw. Before the fix that
// row also lost its `workspaces` (persisted as null), so `workspace <account>`
// was unusable. After the fix the workspaces are tracked, and the CLI reports
// updated/rebound instead of always saying "Added account".

const NOW = 1_700_000_000_000;

const ORG_DEFAULT = "org-izb8024fENXhpMsfDt5A7gz3"; // "Adithya workspace" (default)
const ORG_PERSONAL = "org-r15LU9acpBzLqar9JQgqYqDH"; // "Personal" (non-default)
const EMAIL = "adithya@example.com";

const DEFAULT_WS = {
	id: ORG_DEFAULT,
	name: "Adithya workspace",
	enabled: true,
	isDefault: true,
} as const;
const PERSONAL_WS = { id: ORG_PERSONAL, name: "Personal", enabled: true } as const;

function loginWrite(
	overrides: Partial<ResolvedAccountWrite> = {},
): ResolvedAccountWrite {
	return {
		// Deterministic best-candidate selection always binds the default org.
		accountId: ORG_DEFAULT,
		accountIdSource: "org",
		accountLabel: "Adithya workspace",
		email: EMAIL,
		refreshToken: "refresh-token",
		accessToken: "access-token",
		expiresAt: NOW + 3600,
		now: NOW,
		...overrides,
	};
}

describe("issue #512: same-email multi-workspace login (real dedup)", () => {
	it("first login inserts a row that tracks every workspace the token exposed", () => {
		const first = applyAccountPoolResults({
			existing: [],
			// A single login surfaced both orgs in the token (issue #491).
			writes: [loginWrite({ workspaces: [DEFAULT_WS, PERSONAL_WS] })],
			findMatchingAccountIndex,
		});

		expect(first.outcome).toBe("inserted");
		expect(first.accounts).toHaveLength(1);
		// The core of the bug report: the saved row must NOT have workspaces: null.
		expect(first.accounts[0]?.workspaces).toEqual([DEFAULT_WS, PERSONAL_WS]);
		expect(first.accounts[0]?.currentWorkspaceIndex).toBe(0);
	});

	it("a second same-email login folds onto the same row (pool stays flat) and is reported 'updated'", () => {
		const saved = applyAccountPoolResults({
			existing: [],
			writes: [loginWrite({ workspaces: [DEFAULT_WS, PERSONAL_WS] })],
			findMatchingAccountIndex,
		});
		expect(saved.accounts).toHaveLength(1);

		// User logs in again (fresh OAuth → rotated refresh token). Best-candidate
		// selection resolves the same default-org accountId, so dedup matches the
		// existing row on accountId+email.
		const second = applyAccountPoolResults({
			existing: saved.accounts,
			priorActiveIndex: saved.activeIndex,
			writes: [
				loginWrite({
					refreshToken: "refresh-token-rotated",
					workspaces: [DEFAULT_WS, PERSONAL_WS],
				}),
			],
			findMatchingAccountIndex,
		});

		// Pool stays flat — this is what "Total: N did not increase" meant. The
		// pre-fix bug was that the CLI nonetheless printed "Added account".
		expect(second.accounts).toHaveLength(1);
		expect(second.outcome).toBe("updated");
		// Workspaces remain tracked (not clobbered to null) so the user can run
		// `codex-multi-auth workspace <account> Personal` afterwards.
		expect(second.accounts[0]?.workspaces?.map((w) => w.id)).toEqual([
			ORG_DEFAULT,
			ORG_PERSONAL,
		]);
		// Token rotation is still applied to the folded row.
		expect(second.accounts[0]?.refreshToken).toBe("refresh-token-rotated");
	});

	it("classifies a newly-appearing workspace as 'rebound' (user joined a second org)", () => {
		// First login happened when the email only belonged to one org.
		const saved = applyAccountPoolResults({
			existing: [],
			writes: [loginWrite({ workspaces: [DEFAULT_WS] })],
			findMatchingAccountIndex,
		});
		expect(saved.accounts[0]?.workspaces?.map((w) => w.id)).toEqual([
			ORG_DEFAULT,
		]);

		// Later the user is added to a second workspace; the next login's token
		// now exposes it. Same default-org binding, so the row is still matched.
		const rebound = applyAccountPoolResults({
			existing: saved.accounts,
			priorActiveIndex: saved.activeIndex,
			writes: [
				loginWrite({
					refreshToken: "refresh-token-rotated",
					workspaces: [DEFAULT_WS, PERSONAL_WS],
				}),
			],
			findMatchingAccountIndex,
		});

		expect(rebound.accounts).toHaveLength(1);
		expect(rebound.outcome).toBe("rebound");
		expect(rebound.accounts[0]?.workspaces?.map((w) => w.id)).toEqual([
			ORG_DEFAULT,
			ORG_PERSONAL,
		]);
	});

	it("a genuinely different email still creates a separate saved row", () => {
		const saved = applyAccountPoolResults({
			existing: [],
			writes: [loginWrite({ workspaces: [DEFAULT_WS] })],
			findMatchingAccountIndex,
		});

		const other = applyAccountPoolResults({
			existing: saved.accounts,
			priorActiveIndex: saved.activeIndex,
			writes: [
				loginWrite({
					accountId: "org-different",
					accountLabel: "Other Co",
					email: "someone-else@example.com",
					refreshToken: "different-refresh",
					workspaces: [
						{ id: "org-different", name: "Other Co", enabled: true },
					],
				}),
			],
			findMatchingAccountIndex,
		});

		expect(other.outcome).toBe("inserted");
		expect(other.accounts).toHaveLength(2);
		// The newest account becomes active.
		expect(other.activeIndex).toBe(1);
	});

	it("preserves a user's disabled workspace flag across a re-login", () => {
		// User disabled the Personal workspace via `workspace ... disable`.
		const saved = applyAccountPoolResults({
			existing: [
				{
					accountId: ORG_DEFAULT,
					accountIdSource: "org",
					accountLabel: "Adithya workspace",
					email: EMAIL,
					refreshToken: "refresh-token",
					enabled: true,
					addedAt: NOW - 10_000,
					lastUsed: NOW - 10_000,
					workspaces: [
						DEFAULT_WS,
						{
							id: ORG_PERSONAL,
							name: "Personal",
							enabled: false,
							disabledAt: NOW - 5_000,
						},
					],
					currentWorkspaceIndex: 0,
				},
			],
			priorActiveIndex: 0,
			writes: [loginWrite({ workspaces: [DEFAULT_WS, PERSONAL_WS] })],
			findMatchingAccountIndex,
		});

		expect(saved.outcome).toBe("updated");
		const personal = saved.accounts[0]?.workspaces?.find(
			(w) => w.id === ORG_PERSONAL,
		);
		expect(personal?.enabled).toBe(false);
		expect(personal?.disabledAt).toBe(NOW - 5_000);
	});
});
