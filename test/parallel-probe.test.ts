import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	probeAccountsInParallel,
	createProbeCandidates,
	getTopCandidates,
	type ProbeCandidate,
} from "../lib/parallel-probe.js";
import {
	AccountManager,
	getRuntimeTrackerKey,
	type ManagedAccount,
} from "../lib/accounts.js";
import { getHealthTracker, resetTrackers } from "../lib/rotation.js";
import { getRuntimeAccountIdentityKey } from "../lib/storage/identity.js";

function createMockAccount(index: number, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
	return {
		index,
		refreshToken: `token-${index}`,
		lastUsed: Date.now() - index * 1000 * 60 * 60,
		addedAt: Date.now(),
		rateLimitResetTimes: {},
		...overrides,
	};
}

describe("parallel-probe", () => {
	beforeEach(() => {
		resetTrackers();
	});

	afterEach(() => {
		resetTrackers();
	});

	describe("createProbeCandidates", () => {
		it("creates candidates with abort controllers", () => {
			const accounts = [createMockAccount(0), createMockAccount(1)];
			const candidates = createProbeCandidates(accounts);

			expect(candidates).toHaveLength(2);
			expect(candidates[0].account).toBe(accounts[0]);
			expect(candidates[0].controller).toBeInstanceOf(AbortController);
			expect(candidates[1].account).toBe(accounts[1]);
		});
	});

	describe("probeAccountsInParallel", () => {
		it("returns null for empty candidates", async () => {
			const result = await probeAccountsInParallel([], async () => "success");
			expect(result).toBeNull();
		});

		it("returns success for single candidate", async () => {
			const account = createMockAccount(0);
			const candidates = createProbeCandidates([account]);

			const result = await probeAccountsInParallel(
				candidates,
				async () => "response-data",
			);

			expect(result?.type).toBe("success");
			expect(result?.account).toBe(account);
			expect(result?.response).toBe("response-data");
		});

		it("returns failure for single failing candidate", async () => {
			const account = createMockAccount(0);
			const candidates = createProbeCandidates([account]);

			const result = await probeAccountsInParallel(candidates, async () => {
				throw new Error("network error");
			});

			expect(result?.type).toBe("failure");
			expect(result?.error?.message).toBe("network error");
		});

		it("normalizes non-Error probe failures for single candidates", async () => {
			const account = createMockAccount(0);
			const candidates = createProbeCandidates([account]);

			const result = await probeAccountsInParallel(candidates, async () => {
				throw "string failure";
			});

			expect(result?.type).toBe("failure");
			expect(result?.error).toBeInstanceOf(Error);
			expect(result?.error?.message).toBe("string failure");
		});

		it("returns first success in parallel probing", async () => {
			const accounts = [createMockAccount(0), createMockAccount(1), createMockAccount(2)];
			const candidates = createProbeCandidates(accounts);

			const result = await probeAccountsInParallel(candidates, async (account) => {
				if (account.index === 0) {
					await new Promise((r) => setTimeout(r, 50));
					throw new Error("first fails");
				}
				if (account.index === 1) {
					await new Promise((r) => setTimeout(r, 30));
					return "second-slower";
				}
				await new Promise((r) => setTimeout(r, 10));
				return "third-fastest";
			});

			expect(result?.type).toBe("success");
			expect(result?.response).toBe("third-fastest");
		});

		it("aborts losing candidates after winner found", async () => {
			const accounts = [createMockAccount(0), createMockAccount(1)];
			const candidates = createProbeCandidates(accounts);

			await probeAccountsInParallel(candidates, async (account) => {
				if (account.index === 0) {
					return "winner";
				}
				await new Promise((r) => setTimeout(r, 100));
				return "loser";
			});

			expect(candidates[1].controller.signal.aborted).toBe(true);
		});

		it("returns null when all candidates fail", async () => {
			const accounts = [createMockAccount(0), createMockAccount(1)];
			const candidates = createProbeCandidates(accounts);

			const result = await probeAccountsInParallel(candidates, async () => {
				throw new Error("all fail");
			});

			expect(result).toBeNull();
		});

		it("returns null for single undefined candidate (sparse array)", async () => {
			const candidates = [undefined] as unknown as ProbeCandidate[];

			const result = await probeAccountsInParallel(candidates, async () => "success");

			expect(result).toBeNull();
		});

		it("ignores late success after winner is already declared", async () => {
			const accounts = [createMockAccount(0), createMockAccount(1)];
			const candidates = createProbeCandidates(accounts);
			const successOrder: number[] = [];

			const result = await probeAccountsInParallel(candidates, async (account) => {
				if (account.index === 0) {
					successOrder.push(0);
					return "winner";
				}
				await new Promise((r) => setTimeout(r, 50));
				successOrder.push(1);
				return "late-success";
			});

			await new Promise((r) => setTimeout(r, 100));

			expect(result?.type).toBe("success");
			expect(result?.response).toBe("winner");
			expect(successOrder).toContain(0);
		});

		it("ignores late failure after winner is already declared", async () => {
			const accounts = [createMockAccount(0), createMockAccount(1)];
			const candidates = createProbeCandidates(accounts);

			const result = await probeAccountsInParallel(candidates, async (account) => {
				if (account.index === 0) {
					return "winner";
				}
				await new Promise((r) => setTimeout(r, 50));
				throw new Error("late failure");
			});

			await new Promise((r) => setTimeout(r, 100));

			expect(result?.type).toBe("success");
			expect(result?.response).toBe("winner");
		});
	});

	describe("getTopCandidates", () => {
		it("accepts named params without overload casts", () => {
			const accounts = [createMockAccount(0), createMockAccount(1)];
			const mockManager = {
				getAccountsSnapshot: vi.fn().mockReturnValue(accounts),
			};

			const candidates = getTopCandidates({
				accountManager: mockManager as AccountManager,
				modelFamily: "codex",
				model: null,
				maxCandidates: 1,
			});

			expect(candidates).toHaveLength(1);
			expect(mockManager.getAccountsSnapshot).toHaveBeenCalledTimes(1);
		});

		it("returns empty array when no accounts available", () => {
			const mockManager = {
				getAccountsSnapshot: vi.fn().mockReturnValue([]),
			};

			const candidates = getTopCandidates(
				mockManager as unknown as Parameters<typeof getTopCandidates>[0],
				"codex",
				null,
				3,
			);

			expect(candidates).toHaveLength(0);
		});

		it("returns up to maxCandidates accounts", () => {
			const accounts = [
				createMockAccount(0),
				createMockAccount(1),
				createMockAccount(2),
			];

			const mockManager = {
				getAccountsSnapshot: vi.fn().mockReturnValue(accounts),
			};

			const candidates = getTopCandidates(
				mockManager as unknown as Parameters<typeof getTopCandidates>[0],
				"codex",
				null,
				2,
			);

			expect(candidates).toHaveLength(2);
		});

		it("filters out rate-limited accounts", () => {
			const rateLimitedAccount = createMockAccount(0, {
				rateLimitResetTimes: {
					codex: Date.now() + 60000,
				},
			});
			const availableAccount = createMockAccount(1);

			const mockManager = {
				getAccountsSnapshot: vi.fn().mockReturnValue([rateLimitedAccount, availableAccount]),
			};

			const candidates = getTopCandidates(
				mockManager as unknown as Parameters<typeof getTopCandidates>[0],
				"codex",
				null,
				3,
			);

			expect(candidates).toHaveLength(1);
			expect(candidates[0].index).toBe(1);
		});

		it("filters out cooling down accounts", () => {
			const coolingAccount = createMockAccount(0, {
				coolingDownUntil: Date.now() + 60000,
			});
			const availableAccount = createMockAccount(1);

			const mockManager = {
				getAccountsSnapshot: vi.fn().mockReturnValue([coolingAccount, availableAccount]),
			};

			const candidates = getTopCandidates(
				mockManager as unknown as Parameters<typeof getTopCandidates>[0],
				"codex",
				null,
				3,
			);

			expect(candidates).toHaveLength(1);
			expect(candidates[0].index).toBe(1);
		});

		it("returns accounts sorted by hybrid score", () => {
			const accounts = [
				createMockAccount(0, { lastUsed: Date.now() }),
				createMockAccount(1, { lastUsed: Date.now() - 1000 * 60 * 60 * 2 }),
			];

			const mockManager = {
				getAccountsSnapshot: vi.fn().mockReturnValue(accounts),
			};

			const candidates = getTopCandidates(
				mockManager as unknown as Parameters<typeof getTopCandidates>[0],
				"codex",
				null,
				3,
			);

			expect(candidates).toHaveLength(2);
			expect(candidates[0].index).toBe(1);
		});

		it("uses runtime tracker keys when ranking candidates", () => {
			const now = Date.now();
			const penalizedAccount = createMockAccount(0, {
				email: "first@example.com",
				lastUsed: now,
			});
			const healthyAccount = createMockAccount(1, {
				email: "second@example.com",
				lastUsed: now,
			});
			const trackerKey = getRuntimeAccountIdentityKey(penalizedAccount)!;
			getHealthTracker().recordFailure(trackerKey, "codex");

			const mockManager = {
				getAccountsSnapshot: vi
					.fn()
					.mockReturnValue([penalizedAccount, healthyAccount]),
			};

			const candidates = getTopCandidates(
				mockManager as unknown as Parameters<typeof getTopCandidates>[0],
				"codex",
				null,
				2,
			);

			expect(candidates).toHaveLength(2);
			expect(candidates[0]?.email).toBe("second@example.com");
			expect(candidates[1]?.email).toBe("first@example.com");
		});

		it("reuses pinned tracker keys after accounts gain identity fields", () => {
			const now = Date.now();
			const stored = {
				version: 3 as const,
				activeIndex: 0,
				accounts: [
					{ refreshToken: "token-1", addedAt: now, lastUsed: now },
					{
						refreshToken: "token-2",
						email: "healthy@example.com",
						addedAt: now,
						lastUsed: now,
					},
				],
			};

			const manager = new AccountManager(undefined, stored);
			const account = manager.getAccountByIndex(0)!;
			const pinnedTrackerKey = getRuntimeTrackerKey(account);
			getHealthTracker().recordFailure(pinnedTrackerKey, "codex");

			const payload = Buffer.from(JSON.stringify({
				email: "enriched@example.com",
				"https://api.openai.com/auth": {
					chatgpt_account_id: "account-enriched",
				},
				exp: Math.floor((now + 3600000) / 1000),
			})).toString("base64url");
			const accessToken = `header.${payload}.signature`;

			manager.updateFromAuth(account, {
				type: "oauth",
				access: accessToken,
				refresh: "token-1-rotated",
				expires: now + 3600000,
			});

			const candidates = getTopCandidates(manager, "codex", null, 2);
			const enrichedCandidate = candidates.find(
				(candidate) => candidate.refreshToken === "token-1-rotated",
			);

			expect(candidates).toHaveLength(2);
			expect(candidates[0]?.email).toBe("healthy@example.com");
			expect(enrichedCandidate?._runtimeTrackerKey).toBe(pinnedTrackerKey);
		});

		it("does not alias tracker state when tracker and quota keys contain delimiters", () => {
			const now = Date.now();
			const collidingWriter = createMockAccount(0, {
				accountId: "one",
				lastUsed: now,
			});
			const shouldStayHealthy = createMockAccount(1, {
				accountId: "one:codex",
				lastUsed: now,
			});
			const healthyPeer = createMockAccount(2, {
				accountId: "peer",
				lastUsed: now,
			});

			getHealthTracker().recordFailure(
				getRuntimeTrackerKey(collidingWriter),
				"codex:gpt-5.1:three",
			);

			const mockManager = {
				getAccountsSnapshot: vi
					.fn()
					.mockReturnValue([shouldStayHealthy, healthyPeer]),
			};

			const candidates = getTopCandidates(
				mockManager as unknown as Parameters<typeof getTopCandidates>[0],
				"gpt-5.1",
				"three",
				2,
			);

			expect(candidates).toHaveLength(2);
			expect(candidates[0]?.accountId).toBe("one:codex");
			expect(candidates[1]?.accountId).toBe("peer");
		});

		it("supports named-parameter options form", () => {
			const accounts = [
				createMockAccount(0, { lastUsed: Date.now() }),
				createMockAccount(1, { lastUsed: Date.now() - 1000 * 60 * 60 * 2 }),
			];

			const mockManager = {
				getAccountsSnapshot: vi.fn().mockReturnValue(accounts),
			};

			const positional = getTopCandidates(
				mockManager as unknown as Parameters<typeof getTopCandidates>[0],
				"codex",
				null,
				2,
			);
			const named = getTopCandidates({
				accountManager: mockManager as unknown as Parameters<typeof getTopCandidates>[0],
				modelFamily: "codex",
				model: null,
				maxCandidates: 2,
			});

			expect(named).toEqual(positional);
		});

		it("throws clear TypeError when accountManager is missing required shape", () => {
			expect(() =>
				getTopCandidates({
					accountManager: {} as unknown as Parameters<typeof getTopCandidates>[0],
					modelFamily: "codex",
					model: null,
					maxCandidates: 2,
				}),
			).toThrowError("getTopCandidates requires accountManager");
		});

		it("throws clear TypeError for invalid maxCandidates values", () => {
			const mockManager = {
				getAccountsSnapshot: vi.fn().mockReturnValue([createMockAccount(0)]),
			};
			const invalidValues = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5];
			for (const value of invalidValues) {
				expect(() =>
					getTopCandidates({
						accountManager: mockManager as unknown as Parameters<typeof getTopCandidates>[0],
						modelFamily: "codex",
						model: null,
						maxCandidates: value,
					}),
				).toThrowError("getTopCandidates requires maxCandidates to be a positive integer");
			}
		});
	});
});
