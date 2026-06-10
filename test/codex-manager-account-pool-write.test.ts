import { describe, expect, it } from "vitest";
import type { Workspace } from "../lib/accounts.js";
import {
	buildInsertedAccount,
	buildUpdatedAccount,
	mergeAccountWorkspaces,
	pickInitialWorkspaceIndex,
	type ResolvedAccountWrite,
	resolveCurrentWorkspaceIndex,
} from "../lib/codex-manager/account-pool-write.js";
import type { AccountMetadataV3 } from "../lib/storage/public-types.js";

// Regression coverage for issue #512: the CLI `login` path persists through
// persistAccountPool() in codex-manager.ts, which delegates the workspace
// tracking and the Added/Updated/Rebound classification to this helper. Before
// the fix the CLI copy dropped `workspaces` entirely and always printed
// "Added account", so a same-email/different-workspace login silently
// overwrote an existing saved row.

const NOW = 1_700_000_000_000;

function write(
	overrides: Partial<ResolvedAccountWrite> = {},
): ResolvedAccountWrite {
	return {
		accountId: "acct_default",
		accountIdSource: "token",
		accountLabel: "Default",
		email: "user@example.com",
		refreshToken: "refresh-new",
		accessToken: "access-new",
		expiresAt: NOW + 3600,
		now: NOW,
		...overrides,
	};
}

describe("account-pool-write helper (issue #512)", () => {
	describe("pickInitialWorkspaceIndex", () => {
		const workspaces: Workspace[] = [
			{ id: "ws_a", name: "A", enabled: true },
			{ id: "ws_b", name: "B", enabled: true },
		];

		it("prefers the workspace whose id matches the resolved accountId", () => {
			expect(pickInitialWorkspaceIndex(workspaces, "ws_b")).toBe(1);
		});

		it("falls back to the first enabled workspace when nothing matches", () => {
			const mixed: Workspace[] = [
				{ id: "ws_a", name: "A", enabled: false },
				{ id: "ws_b", name: "B", enabled: true },
			];
			expect(pickInitialWorkspaceIndex(mixed, "ws_missing")).toBe(1);
		});

		it("falls back to index 0 when no workspace is enabled", () => {
			const disabled: Workspace[] = [
				{ id: "ws_a", name: "A", enabled: false },
			];
			expect(pickInitialWorkspaceIndex(disabled, undefined)).toBe(0);
		});
	});

	describe("mergeAccountWorkspaces", () => {
		it("keeps the existing list untouched when the login returns no workspaces", () => {
			const existing = {
				workspaces: [{ id: "ws_a", name: "A", enabled: true }],
			};
			expect(mergeAccountWorkspaces(existing, undefined)).toBe(
				existing.workspaces,
			);
		});

		it("preserves the user's enabled/disabled state across a re-login", () => {
			const existing = {
				workspaces: [
					{ id: "ws_a", name: "A", enabled: false, disabledAt: 42 },
				] satisfies Workspace[],
			};
			const incoming: Workspace[] = [
				{ id: "ws_a", name: "A (renamed)", enabled: true },
			];
			const merged = mergeAccountWorkspaces(existing, incoming);
			expect(merged).toEqual([
				{ id: "ws_a", name: "A (renamed)", enabled: false, disabledAt: 42 },
			]);
		});

		it("adds workspaces that were not previously tracked", () => {
			const existing = {
				workspaces: [{ id: "ws_a", name: "A", enabled: true }],
			};
			const incoming: Workspace[] = [
				{ id: "ws_a", name: "A", enabled: true },
				{ id: "ws_b", name: "B", enabled: true },
			];
			const merged = mergeAccountWorkspaces(existing, incoming);
			expect(merged?.map((w) => w.id)).toEqual(["ws_a", "ws_b"]);
		});
	});

	describe("resolveCurrentWorkspaceIndex", () => {
		it("keeps the user on their current workspace when it survived the merge", () => {
			const existing: Pick<
				AccountMetadataV3,
				"workspaces" | "currentWorkspaceIndex"
			> = {
				workspaces: [
					{ id: "ws_a", name: "A", enabled: true },
					{ id: "ws_b", name: "B", enabled: true },
				],
				currentWorkspaceIndex: 1,
			};
			const merged: Workspace[] = [
				{ id: "ws_b", name: "B", enabled: true },
				{ id: "ws_a", name: "A", enabled: true },
			];
			expect(resolveCurrentWorkspaceIndex(existing, merged)).toBe(0);
		});

		it("prefers the default workspace when the prior selection vanished", () => {
			const existing: Pick<
				AccountMetadataV3,
				"workspaces" | "currentWorkspaceIndex"
			> = {
				workspaces: [{ id: "ws_gone", name: "Gone", enabled: true }],
				currentWorkspaceIndex: 0,
			};
			const merged: Workspace[] = [
				{ id: "ws_a", name: "A", enabled: true },
				{ id: "ws_b", name: "B", enabled: true, isDefault: true },
			];
			expect(resolveCurrentWorkspaceIndex(existing, merged)).toBe(1);
		});
	});

	describe("buildInsertedAccount", () => {
		it("seeds workspace tracking for a brand new account", () => {
			const workspaces: Workspace[] = [
				{ id: "acct_default", name: "Default", enabled: true, isDefault: true },
				{ id: "ws_personal", name: "Personal", enabled: true },
			];
			const { account, outcome } = buildInsertedAccount(
				write({ workspaces }),
			);
			expect(outcome).toBe("inserted");
			expect(account.workspaces).toEqual(workspaces);
			expect(account.currentWorkspaceIndex).toBe(0);
			expect(account.addedAt).toBe(NOW);
			expect(account.enabled).toBe(true);
		});

		it("leaves workspace fields undefined when the token exposed none", () => {
			const { account } = buildInsertedAccount(write({ workspaces: undefined }));
			expect(account.workspaces).toBeUndefined();
			expect(account.currentWorkspaceIndex).toBeUndefined();
		});
	});

	describe("buildUpdatedAccount", () => {
		const existing: AccountMetadataV3 = {
			accountId: "acct_default",
			accountIdSource: "token",
			accountLabel: "Default",
			email: "user@example.com",
			refreshToken: "refresh-old",
			accessToken: "access-old",
			expiresAt: NOW,
			enabled: true,
			addedAt: NOW - 10_000,
			lastUsed: NOW - 10_000,
			workspaces: [
				{ id: "acct_default", name: "Default", enabled: true, isDefault: true },
			],
			currentWorkspaceIndex: 0,
		};

		it("classifies a same-workspace re-login as 'updated' and refreshes tokens", () => {
			const { account, outcome } = buildUpdatedAccount(
				existing,
				write({
					workspaces: [
						{ id: "acct_default", name: "Default", enabled: true },
					],
				}),
			);
			expect(outcome).toBe("updated");
			expect(account.refreshToken).toBe("refresh-new");
			expect(account.accessToken).toBe("access-new");
			expect(account.lastUsed).toBe(NOW);
			// addedAt is preserved — this was not a new slot.
			expect(account.addedAt).toBe(NOW - 10_000);
		});

		it("classifies a previously-unknown workspace as 'rebound' and tracks it", () => {
			const { account, outcome } = buildUpdatedAccount(
				existing,
				write({
					accountId: "ws_personal",
					accountIdSource: "org",
					workspaces: [
						{ id: "acct_default", name: "Default", enabled: true },
						{ id: "ws_personal", name: "Personal", enabled: true },
					],
				}),
			);
			expect(outcome).toBe("rebound");
			expect(account.workspaces?.map((w) => w.id)).toEqual([
				"acct_default",
				"ws_personal",
			]);
		});

		it("does not invent workspace tracking when the login returned none", () => {
			const bare: AccountMetadataV3 = { ...existing, workspaces: undefined };
			const { account, outcome } = buildUpdatedAccount(
				bare,
				write({ workspaces: undefined }),
			);
			expect(outcome).toBe("updated");
			expect(account.workspaces).toBeUndefined();
		});

		it("treats first-time workspace enrichment of a legacy row as 'updated', not 'rebound'", () => {
			// Pre-#491 account row: no tracked workspaces yet. The first
			// workspace-aware re-login should enrich it quietly, not tell the user
			// "Rebound workspace for existing account" (#512 follow-up).
			const legacy: AccountMetadataV3 = {
				...existing,
				workspaces: undefined,
				currentWorkspaceIndex: undefined,
			};
			const { account, outcome } = buildUpdatedAccount(
				legacy,
				write({
					workspaces: [
						{ id: "acct_default", name: "Default", enabled: true },
						{ id: "ws_personal", name: "Personal", enabled: true },
					],
				}),
			);
			expect(outcome).toBe("updated");
			expect(account.workspaces?.map((w) => w.id)).toEqual([
				"acct_default",
				"ws_personal",
			]);
			// `currentWorkspaceIndex: undefined` falls back to the default/0 slot.
			expect(account.currentWorkspaceIndex).toBe(0);
		});
	});
});
