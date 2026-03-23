import { describe, expect, it, vi } from "vitest";
import { resolveAccountSelection } from "../lib/runtime/account-selection.js";

describe("account selection helper", () => {
	it("prefers explicit env override", () => {
		const logInfo = vi.fn();
		const result = resolveAccountSelection(
			{ access: "a", idToken: "b" },
			{
				envAccountId: "acct_override_123456",
				logInfo,
				getAccountIdCandidates: () => [],
				selectBestAccountCandidate: () => null,
			},
		);

		expect(result.accountIdOverride).toBe("acct_override_123456");
		expect(result.accountIdSource).toBe("manual");
		expect(logInfo).toHaveBeenCalled();
	});

	it("returns unchanged tokens when no candidates exist", () => {
		const tokens = { access: "a", idToken: "b" };
		const result = resolveAccountSelection(tokens, {
			envAccountId: "",
			logInfo: vi.fn(),
			getAccountIdCandidates: () => [],
			selectBestAccountCandidate: () => null,
		});

		expect(result).toEqual(tokens);
	});

	it("maps candidates to workspaces and chooses a single candidate directly", () => {
		const result = resolveAccountSelection(
			{ access: "a", idToken: "b" },
			{
				logInfo: vi.fn(),
				getAccountIdCandidates: () => [
					{
						accountId: "acct_1",
						label: "Primary",
						source: "token",
						isDefault: true,
					},
				],
				selectBestAccountCandidate: () => null,
			},
		);

		expect(result.accountIdOverride).toBe("acct_1");
		expect(result.workspaces).toEqual([
			{ id: "acct_1", name: "Primary", enabled: true, isDefault: true },
		]);
	});

	it("uses best candidate when multiple candidates exist", () => {
		const candidates = [
			{ accountId: "acct_1", label: "One", source: "token" as const },
			{ accountId: "acct_2", label: "Two", source: "org" as const },
		];
		const result = resolveAccountSelection(
			{ access: "a", idToken: "b" },
			{
				logInfo: vi.fn(),
				getAccountIdCandidates: () => candidates,
				selectBestAccountCandidate: () => candidates[1],
			},
		);

		expect(result.accountIdOverride).toBe("acct_2");
		expect(result.accountIdSource).toBe("org");
		expect(result.workspaces).toHaveLength(2);
	});
});
