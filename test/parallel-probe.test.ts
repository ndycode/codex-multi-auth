import { describe, it, expect, vi } from "vitest";
import {
	probeAccountsInParallel,
	createProbeCandidates,
	getTopCandidates,
	type ProbeCandidate,
} from "../lib/parallel-probe.js";
import type { ManagedAccount } from "../lib/accounts.js";

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
	});
});
