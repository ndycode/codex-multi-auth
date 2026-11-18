import { describe, it, expect, vi } from "vitest";
import {
	parseAuthorizedAccounts,
	constrainSelectionToAuthorized,
	fetchAuthorizedAccounts,
	applyAuthorizedAccountConstraint,
	reboundUnauthorizedAccountIdentity,
	refreshCodexCliMirror,
} from "../lib/auth/account-access.js";
import { CODEX_BASE_URL } from "../lib/constants.js";

/**
 * Codex CLI >= 0.156.0 validates the account it is told to act as against
 * `GET /backend-api/wham/accounts/check` before sending a request. An id that is
 * absent from that response fails every call with "selected workspace missing
 * from routing discovery". These tests pin the contract of asking the same
 * question before we persist an account id.
 */
describe("parseAuthorizedAccounts", () => {
	it("reads the ids and the default from a wham/accounts/check payload", () => {
		const parsed = parseAuthorizedAccounts({
			account_ordering: ["65f1cc7a-personal"],
			accounts: [{ id: "65f1cc7a-personal", structure: "personal" }],
			default_account_id: "65f1cc7a-personal",
		});

		expect(parsed).toEqual({
			accountIds: ["65f1cc7a-personal"],
			defaultAccountId: "65f1cc7a-personal",
		});
	});

	it("keeps every listed account, not just the default", () => {
		const parsed = parseAuthorizedAccounts({
			accounts: [{ id: "personal-id" }, { id: "org-team" }],
			default_account_id: "personal-id",
		});

		expect(parsed?.accountIds).toEqual(["personal-id", "org-team"]);
	});

	it("returns null for a payload with no usable account list", () => {
		expect(parseAuthorizedAccounts({ accounts: [] })).toBeNull();
		expect(parseAuthorizedAccounts({})).toBeNull();
		expect(parseAuthorizedAccounts(null)).toBeNull();
		expect(parseAuthorizedAccounts("nope")).toBeNull();
	});

	it("ignores entries without a usable id", () => {
		const parsed = parseAuthorizedAccounts({
			accounts: [{ id: "" }, { name: "no id" }, { id: "good" }],
		});

		expect(parsed?.accountIds).toEqual(["good"]);
	});
});

describe("constrainSelectionToAuthorized", () => {
	const authorized = {
		accountIds: ["personal-id"],
		defaultAccountId: "personal-id",
	};

	it("replaces an account id the server does not authorize", () => {
		const result = constrainSelectionToAuthorized("org-team", authorized);

		expect(result).toEqual({
			accountId: "personal-id",
			changed: true,
			rejected: "org-team",
		});
	});

	it("leaves an authorized account id untouched", () => {
		const result = constrainSelectionToAuthorized("personal-id", authorized);

		expect(result).toEqual({ accountId: "personal-id", changed: false });
	});

	// Never make login worse than before: with nothing to fall back to we keep
	// the caller's own choice rather than writing an empty account id.
	it("keeps the original id when the response offers no default", () => {
		const result = constrainSelectionToAuthorized("org-team", {
			accountIds: ["personal-id"],
		});

		expect(result).toEqual({ accountId: "org-team", changed: false });
	});

	it("keeps the original id when authorization could not be determined", () => {
		const result = constrainSelectionToAuthorized("org-team", null);

		expect(result).toEqual({ accountId: "org-team", changed: false });
	});
});

describe("fetchAuthorizedAccounts", () => {
	it("asks wham/accounts/check with the access token as bearer", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					accounts: [{ id: "personal-id" }],
					default_account_id: "personal-id",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const result = await fetchAuthorizedAccounts("token-abc", {
			fetch: fetchMock,
		});

		expect(result).toEqual({
			accountIds: ["personal-id"],
			defaultAccountId: "personal-id",
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(`${CODEX_BASE_URL}/wham/accounts/check`);
		const headers = new Headers(
			(init as RequestInit | undefined)?.headers ?? {},
		);
		expect(headers.get("authorization")).toBe("Bearer token-abc");
	});

	// Fail open: a login must not break because this advisory check was
	// unreachable, rate limited, or rejected.
	it("returns null instead of throwing on a non-ok response", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));

		await expect(
			fetchAuthorizedAccounts("token-abc", { fetch: fetchMock }),
		).resolves.toBeNull();
	});

	it("returns null instead of throwing on a network error", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("offline");
		});

		await expect(
			fetchAuthorizedAccounts("token-abc", { fetch: fetchMock }),
		).resolves.toBeNull();
	});

	it("returns null on a malformed body", async () => {
		const fetchMock = vi.fn(
			async () => new Response("<html>", { status: 200 }),
		);

		await expect(
			fetchAuthorizedAccounts("token-abc", { fetch: fetchMock }),
		).resolves.toBeNull();
	});
});

describe("applyAuthorizedAccountConstraint", () => {
	const authorized = {
		accountIds: ["personal-id"],
		defaultAccountId: "personal-id",
	};

	it("rewrites an unauthorized selection and marks it as token-derived", () => {
		const { selection, result } = applyAuthorizedAccountConstraint(
			{ accountIdOverride: "org-team", accountIdSource: "org" as const },
			authorized,
		);

		expect(result?.changed).toBe(true);
		expect(selection.accountIdOverride).toBe("personal-id");
		// The backend's default IS the account these credentials are, so it must
		// auto-follow later token refreshes instead of staying pinned like an
		// explicit org/manual choice would.
		expect(selection.accountIdSource).toBe("token");
	});

	it("leaves an authorized selection byte-identical", () => {
		const input = {
			accountIdOverride: "personal-id",
			accountIdSource: "org" as const,
		};
		const { selection, result } = applyAuthorizedAccountConstraint(
			input,
			authorized,
		);

		expect(result?.changed).toBe(false);
		expect(selection).toEqual(input);
	});

	it("is a no-op when the selection carries no account id", () => {
		const { selection, result } = applyAuthorizedAccountConstraint(
			{},
			authorized,
		);

		expect(result).toBeNull();
		expect(selection).toEqual({});
	});

	it("is a no-op when authorization is unknown", () => {
		const input = { accountIdOverride: "org-team" };
		const { selection, result } = applyAuthorizedAccountConstraint(input, null);

		expect(result).toBeNull();
		expect(selection).toEqual(input);
	});
});

describe("reboundUnauthorizedAccountIdentity", () => {
	// This is the migration path for accounts saved BEFORE this guard existed
	// (or added by `codex-multi-auth workspace <account> <workspace>`, which has
	// no live check of its own). Scoped to accountIdSource === "org": "token" /
	// "id_token" sources already auto-follow via applyTokenAccountIdentity, and a
	// "manual" `--org` binding is explicit user intent this must not override.
	it("rewrites an org-sourced id the backend does not authorize", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					accounts: [{ id: "personal-id" }],
					default_account_id: "personal-id",
				}),
				{ status: 200 },
			),
		);
		const account = { accountId: "org-team", accountIdSource: "org" as const };

		const result = await reboundUnauthorizedAccountIdentity(
			account,
			"token-abc",
			{ fetch: fetchMock },
		);

		expect(result).toEqual({
			accountId: "personal-id",
			changed: true,
			rejected: "org-team",
		});
		expect(account).toEqual({
			accountId: "personal-id",
			accountIdSource: "token",
		});
	});

	it("leaves a token-sourced id alone — that source already auto-follows the token", async () => {
		const fetchMock = vi.fn();
		const account = { accountId: "org-team", accountIdSource: "token" as const };

		const result = await reboundUnauthorizedAccountIdentity(
			account,
			"token-abc",
			{ fetch: fetchMock },
		);

		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(account.accountId).toBe("org-team");
	});

	it("leaves a manual --org binding alone — that is explicit user intent", async () => {
		const fetchMock = vi.fn();
		const account = { accountId: "org-team", accountIdSource: "manual" as const };

		const result = await reboundUnauthorizedAccountIdentity(
			account,
			"token-abc",
			{ fetch: fetchMock },
		);

		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is a no-op when the org id is already authorized", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({ accounts: [{ id: "org-team" }] }),
				{ status: 200 },
			),
		);
		const account = { accountId: "org-team", accountIdSource: "org" as const };

		const result = await reboundUnauthorizedAccountIdentity(
			account,
			"token-abc",
			{ fetch: fetchMock },
		);

		expect(result).toBeNull();
		expect(account.accountId).toBe("org-team");
	});

	it("leaves the account untouched when the check itself fails (fail open)", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("offline");
		});
		const account = { accountId: "org-team", accountIdSource: "org" as const };

		const result = await reboundUnauthorizedAccountIdentity(
			account,
			"token-abc",
			{ fetch: fetchMock },
		);

		expect(result).toBeNull();
		expect(account.accountId).toBe("org-team");
	});

	it("is a no-op when the account has no id to check", async () => {
		const fetchMock = vi.fn();
		const account = { accountIdSource: "org" as const };

		const result = await reboundUnauthorizedAccountIdentity(
			account,
			"token-abc",
			{ fetch: fetchMock },
		);

		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("workspace metadata follows a rewritten account id", () => {
	const authorized = {
		accountIds: ["personal-id"],
		defaultAccountId: "personal-id",
	};
	const workspaces = [
		{ id: "personal-id", name: "Personal", enabled: true },
		{ id: "org-team", name: "Team", enabled: true },
	];

	it("relabels a rewritten login selection from the authorized workspace", () => {
		const { selection } = applyAuthorizedAccountConstraint(
			{
				accountIdOverride: "org-team",
				accountIdSource: "org" as const,
				accountLabel: "Team",
				workspaces,
			},
			authorized,
		);

		expect(selection.accountLabel).toBe("Personal");
	});

	// Empty, not undefined: the account-pool merge keeps the saved label on
	// undefined and would keep naming the rejected workspace.
	it("blanks the label when the authorized id is not a tracked workspace", () => {
		const { selection } = applyAuthorizedAccountConstraint(
			{ accountIdOverride: "org-team", accountLabel: "Team" },
			authorized,
		);

		expect(selection.accountLabel).toBe("");
	});

	// The plugin host sends workspaces[currentWorkspaceIndex].id ahead of
	// accountId, so a rebind that leaves the pointer on the rejected workspace
	// changes nothing on that path.
	it("moves a rebound account's workspace pointer and label to the authorized id", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ accounts: [{ id: "personal-id" }], default_account_id: "personal-id" }), {
				status: 200,
			}),
		);
		const account = {
			accountId: "org-team",
			accountIdSource: "org" as const,
			accountLabel: "Team",
			workspaces: structuredClone(workspaces),
			currentWorkspaceIndex: 1,
		};

		await reboundUnauthorizedAccountIdentity(account, "token-abc", { fetch: fetchMock });

		expect(account).toMatchObject({
			accountId: "personal-id",
			accountLabel: "Personal",
			currentWorkspaceIndex: 0,
		});
	});

	it("blanks a rebound account's label when the authorized id is not tracked", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ accounts: [{ id: "personal-id" }], default_account_id: "personal-id" }), {
				status: 200,
			}),
		);
		const account = {
			accountId: "org-team",
			accountIdSource: "org" as const,
			accountLabel: "Team",
		};

		await reboundUnauthorizedAccountIdentity(account, "token-abc", { fetch: fetchMock });

		expect(account.accountLabel).toBe("");
	});

	// Greptile P1: merged into an existing row whose pointer is on the rejected
	// org, the account-pool merge keeps that pointer while the org survives in
	// the incoming list, and the plugin host keeps sending it.
	it("moves an existing row's workspace pointer off the rejected org on a constrained login", async () => {
		const { buildUpdatedAccount } = await import(
			"../lib/codex-manager/account-pool-write.js"
		);
		const { selection } = applyAuthorizedAccountConstraint(
			{
				accountIdOverride: "org-team",
				accountIdSource: "org" as const,
				accountLabel: "Team",
				workspaces: [
					{ id: "personal-id", name: "Personal", enabled: true },
					{ id: "org-team", name: "Team", enabled: true, isDefault: true },
				],
			},
			authorized,
		);
		const existing = {
			accountId: "org-team",
			accountIdSource: "org" as const,
			accountLabel: "Team",
			email: "a@example.com",
			refreshToken: "refresh",
			addedAt: 1,
			lastUsed: 1,
			workspaces: [
				{ id: "personal-id", name: "Personal", enabled: true },
				{ id: "org-team", name: "Team", enabled: true, isDefault: true },
			],
			currentWorkspaceIndex: 1,
		};

		const { account } = buildUpdatedAccount(existing, {
			accountId: selection.accountIdOverride,
			accountIdSource: selection.accountIdSource,
			accountLabel: selection.accountLabel,
			refreshToken: "refresh-next",
			workspaces: selection.workspaces,
			now: 2,
		});

		expect(account.accountId).toBe("personal-id");
		expect(account.workspaces?.[account.currentWorkspaceIndex ?? 0]?.id).toBe(
			"personal-id",
		);
		expect(account.workspaces?.map((workspace) => workspace.id)).not.toContain(
			"org-team",
		);
	});

	// Greptile P1 (round 3): the authorized default is not in the token's
	// workspace list and another unauthorized workspace carries the default
	// flag. Dropping only the rejected id let the merge point at that one.
	it("keeps the pointer off every unauthorized workspace when the authorized id is untracked", async () => {
		const { buildUpdatedAccount } = await import(
			"../lib/codex-manager/account-pool-write.js"
		);
		const incoming = [
			{ id: "org-team", name: "Team", enabled: true },
			{ id: "org-other", name: "Other", enabled: true, isDefault: true },
		];
		const { selection } = applyAuthorizedAccountConstraint(
			{
				accountIdOverride: "org-team",
				accountIdSource: "org" as const,
				accountLabel: "Team",
				workspaces: incoming,
			},
			authorized,
		);
		const existing = {
			accountId: "org-team",
			accountIdSource: "org" as const,
			accountLabel: "Team",
			email: "a@example.com",
			refreshToken: "refresh",
			addedAt: 1,
			lastUsed: 1,
			workspaces: structuredClone(incoming),
			currentWorkspaceIndex: 0,
		};

		const { account } = buildUpdatedAccount(existing, {
			accountId: selection.accountIdOverride,
			accountIdSource: selection.accountIdSource,
			accountLabel: selection.accountLabel,
			refreshToken: "refresh-next",
			workspaces: selection.workspaces,
			now: 2,
		});

		expect(account.workspaces?.[account.currentWorkspaceIndex ?? 0]?.id).toBe(
			"personal-id",
		);
		expect(account.workspaces?.map((workspace) => workspace.id)).toEqual([
			"personal-id",
		]);
	});

	it("points a rebound account at the authorized id even when the token never listed it", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ accounts: [{ id: "personal-id" }], default_account_id: "personal-id" }), {
				status: 200,
			}),
		);
		const account = {
			accountId: "org-team",
			accountIdSource: "org" as const,
			accountLabel: "Team",
			workspaces: [
				{ id: "org-team", name: "Team", enabled: true },
				{ id: "org-other", name: "Other", enabled: true, isDefault: true },
			],
			currentWorkspaceIndex: 0,
		};

		await reboundUnauthorizedAccountIdentity(account, "token-abc", { fetch: fetchMock });

		expect(account.workspaces[account.currentWorkspaceIndex]?.id).toBe("personal-id");
		expect(account.workspaces.map((workspace) => workspace.id)).toEqual(["personal-id"]);
		expect(account.accountLabel).toBe("");
	});
});

describe("refreshCodexCliMirror", () => {
	const respond = (ids: string[]) =>
		vi.fn(async () =>
			new Response(
				JSON.stringify({ accounts: ids.map((id) => ({ id })), default_account_id: "personal-id" }),
				{ status: 200 },
			),
		);

	it("sets the mirror for a refused explicit id without touching the id", async () => {
		const account = { accountId: "ws-team", accountIdSource: "manual" as const };
		await expect(
			refreshCodexCliMirror(account, "token", { fetch: respond(["personal-id"]) }),
		).resolves.toBe("set");
		expect(account).toEqual({
			accountId: "ws-team",
			accountIdSource: "manual",
			codexCliMirror: { forAccountId: "ws-team", accountId: "personal-id" },
		});
	});

	it("clears the mirror once the explicit id is authorized", async () => {
		const account = {
			accountId: "ws-team",
			accountIdSource: "manual" as const,
			codexCliMirror: { forAccountId: "ws-team", accountId: "personal-id" },
		};
		await expect(
			refreshCodexCliMirror(account, "token", { fetch: respond(["ws-team", "personal-id"]) }),
		).resolves.toBe("cleared");
		expect(account).not.toHaveProperty("codexCliMirror");
	});

	it("leaves the mirror alone when the check fails (fail open) or the source is not explicit", async () => {
		const mirror = { forAccountId: "ws-team", accountId: "personal-id" };
		const failing = { accountId: "ws-team", accountIdSource: "manual" as const, codexCliMirror: mirror };
		await expect(
			refreshCodexCliMirror(failing, "token", {
				fetch: vi.fn(async () => new Response("", { status: 500 })),
			}),
		).resolves.toBeNull();
		expect(failing.codexCliMirror).toBe(mirror);

		const fetchMock = respond(["personal-id"]);
		await expect(
			refreshCodexCliMirror({ accountId: "ws-team", accountIdSource: "org" }, "token", {
				fetch: fetchMock,
			}),
		).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
