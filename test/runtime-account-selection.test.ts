import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/accounts.js", () => ({
	getAccountIdCandidates: vi.fn(),
	selectBestAccountCandidate: vi.fn(),
}));

import {
	getAccountIdCandidates,
	selectBestAccountCandidate,
} from "../lib/accounts.js";
import {
	resolveAccountSelection,
	type TokenSuccess,
} from "../lib/runtime/account-selection.js";

function createTokens(): TokenSuccess {
	return {
		type: "success",
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 60_000,
		idToken: "id-token",
	};
}

describe("resolveAccountSelection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	});

	afterEach(() => {
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	});

	it("uses CODEX_AUTH_ACCOUNT_ID override before token-derived candidates", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "override-account-12345";
		const tokens = createTokens();
		const logInfo = vi.fn();

		const result = resolveAccountSelection(tokens, { logInfo });

		expect(result).toEqual({
			...tokens,
			accountIdOverride: "override-account-12345",
			accountIdSource: "manual",
			accountLabel: "Override [id:-12345]",
		});
		expect(logInfo).toHaveBeenCalledWith(
			"Using account override from CODEX_AUTH_ACCOUNT_ID (id:-12345).",
		);
		expect(getAccountIdCandidates).not.toHaveBeenCalled();
		expect(selectBestAccountCandidate).not.toHaveBeenCalled();
	});

	it("returns the original tokens when no account candidates are available", () => {
		vi.mocked(getAccountIdCandidates).mockReturnValueOnce([]);
		const tokens = createTokens();

		const result = resolveAccountSelection(tokens, { logInfo: vi.fn() });

		expect(result).toBe(tokens);
		expect(selectBestAccountCandidate).not.toHaveBeenCalled();
	});

	it("attaches the only token-derived candidate directly", () => {
		vi.mocked(getAccountIdCandidates).mockReturnValueOnce([
			{
				accountId: "workspace-alpha",
				source: "token",
				label: "Workspace Alpha [id:-alpha]",
				isDefault: true,
			},
		]);
		const tokens = createTokens();

		const result = resolveAccountSelection(tokens, { logInfo: vi.fn() });

		expect(result).toEqual({
			...tokens,
			accountIdOverride: "workspace-alpha",
			accountIdSource: "token",
			accountLabel: "Workspace Alpha [id:-alpha]",
			workspaces: [
				{
					id: "workspace-alpha",
					name: "Workspace Alpha [id:-alpha]",
					enabled: true,
					isDefault: true,
				},
			],
		});
		expect(selectBestAccountCandidate).not.toHaveBeenCalled();
	});

	it("uses the best account candidate when multiple workspaces are available", () => {
		const candidates = [
			{
				accountId: "workspace-alpha",
				source: "token" as const,
				label: "Workspace Alpha [id:-alpha]",
			},
			{
				accountId: "workspace-beta",
				source: "org" as const,
				label: "Workspace Beta [id:-beta]",
				isDefault: true,
			},
		];
		vi.mocked(getAccountIdCandidates).mockReturnValueOnce(candidates);
		vi.mocked(selectBestAccountCandidate).mockReturnValueOnce(candidates[1]);
		const tokens = createTokens();

		const result = resolveAccountSelection(tokens, { logInfo: vi.fn() });

		expect(selectBestAccountCandidate).toHaveBeenCalledWith(candidates);
		expect(result).toEqual({
			...tokens,
			accountIdOverride: "workspace-beta",
			accountIdSource: "org",
			accountLabel: "Workspace Beta [id:-beta]",
			workspaces: [
				{
					id: "workspace-alpha",
					name: "Workspace Alpha [id:-alpha]",
					enabled: true,
					isDefault: undefined,
				},
				{
					id: "workspace-beta",
					name: "Workspace Beta [id:-beta]",
					enabled: true,
					isDefault: true,
				},
			],
		});
	});

	it("falls back to the original tokens when no best candidate is selected", () => {
		const candidates = [
			{
				accountId: "workspace-alpha",
				source: "token" as const,
				label: "Workspace Alpha [id:-alpha]",
			},
			{
				accountId: "workspace-beta",
				source: "org" as const,
				label: "Workspace Beta [id:-beta]",
			},
		];
		vi.mocked(getAccountIdCandidates).mockReturnValueOnce(candidates);
		vi.mocked(selectBestAccountCandidate).mockReturnValueOnce(null);
		const tokens = createTokens();

		const result = resolveAccountSelection(tokens, { logInfo: vi.fn() });

		expect(selectBestAccountCandidate).toHaveBeenCalledWith(candidates);
		expect(result).toBe(tokens);
	});
});
