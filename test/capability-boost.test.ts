import { describe, expect, it, vi } from "vitest";
import { buildCapabilityBoostByAccount } from "../lib/runtime/capability-boost.js";

describe("buildCapabilityBoostByAccount", () => {
	it("keeps sparse slots and prefers model over modelFamily for snapshots", () => {
		const getBoost = vi.fn().mockReturnValueOnce(5).mockReturnValueOnce(7);

		const boosts = buildCapabilityBoostByAccount({
			accountCount: 4,
			model: "gpt-5-codex",
			modelFamily: "codex",
			accountSnapshotSource: {
				getAccountsSnapshot: () => [
					{ index: 1, accountId: "acc_1" },
					{ index: 3, email: "User@example.com" },
				],
			},
			getBoost,
		});

		expect(boosts).toHaveLength(4);
		expect(0 in boosts).toBe(false);
		expect(boosts[1]).toBe(5);
		expect(2 in boosts).toBe(false);
		expect(boosts[3]).toBe(7);
		expect(getBoost.mock.calls).toEqual([
			["account:acc_1::idx:1", "gpt-5-codex"],
			["email:user@example.com", "gpt-5-codex"],
		]);
	});

	it("falls back to getAccountByIndex and skips invalid snapshot indices", () => {
		const getBoost = vi.fn().mockReturnValueOnce(11).mockReturnValueOnce(22);
		const getAccountByIndex = vi.fn((index: number) => {
			switch (index) {
				case 0:
					return { index: 0, accountId: "acc_0" };
				case 1:
					return { index: -1, email: "ignored-negative@example.com" };
				case 2:
					return { index: 5, email: "ignored-out-of-range@example.com" };
				case 3:
					return { index: 2, email: "final@example.com" };
				default:
					return null;
			}
		});

		const boosts = buildCapabilityBoostByAccount({
			accountCount: 4,
			modelFamily: "codex",
			accountSnapshotSource: {
				getAccountsSnapshot: () => [],
				getAccountByIndex,
			},
			getBoost,
		});

		expect(boosts).toHaveLength(4);
		expect(boosts[0]).toBe(11);
		expect(1 in boosts).toBe(false);
		expect(boosts[2]).toBe(22);
		expect(3 in boosts).toBe(false);
		expect(getAccountByIndex).toHaveBeenCalledTimes(4);
		expect(getBoost.mock.calls).toEqual([
			["account:acc_0::idx:0", "codex"],
			["email:final@example.com", "codex"],
		]);
	});
});
