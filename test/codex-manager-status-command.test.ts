import { describe, expect, it, vi } from "vitest";
import {
	type FeaturesCommandDeps,
	runFeaturesCommand,
	runStatusCommand,
	type StatusCommandDeps,
} from "../lib/codex-manager/commands/status.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "one@example.com",
				refreshToken: "refresh-token-1",
				addedAt: 1,
				lastUsed: 1,
			},
			{
				email: "two@example.com",
				refreshToken: "refresh-token-2",
				addedAt: 2,
				lastUsed: 2,
				enabled: false,
			},
		],
	};
}

function createStatusDeps(
	overrides: Partial<StatusCommandDeps> = {},
): StatusCommandDeps {
	return {
		setStoragePath: vi.fn(),
		getStoragePath: vi.fn(() => "/tmp/codex.json"),
		loadAccounts: vi.fn(async () => createStorage()),
		resolveActiveIndex: vi.fn(() => 0),
		formatRateLimitEntry: vi.fn(() => null),
		getNow: vi.fn(() => 2_000),
		logInfo: vi.fn(),
		...overrides,
	};
}

describe("runStatusCommand", () => {
	it("prints empty storage state", async () => {
		const deps = createStatusDeps({ loadAccounts: vi.fn(async () => null) });

		const result = await runStatusCommand(deps);

		expect(result).toBe(0);
		expect(deps.getStoragePath).toHaveBeenCalledTimes(1);
		expect(deps.logInfo).toHaveBeenCalledWith("No accounts configured.");
		expect(deps.logInfo).toHaveBeenCalledWith("Storage: /tmp/codex.json");
	});

	it("prints account rows with current and disabled markers", async () => {
		const deps = createStatusDeps({
			formatRateLimitEntry: vi.fn((_account, _now, _family) => "limited"),
		});

		const result = await runStatusCommand(deps);

		expect(result).toBe(0);
		expect(deps.getStoragePath).toHaveBeenCalledTimes(1);
		expect(deps.logInfo).toHaveBeenCalledWith("Accounts (2)");
		expect(deps.logInfo).toHaveBeenCalledWith("Storage: /tmp/codex.json");
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining(
				"1. Account 1 (one@example.com) [current, rate-limited]",
			),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining(
				"2. Account 2 (two@example.com) [disabled, rate-limited]",
			),
		);
	});
});

describe("runFeaturesCommand", () => {
	it("prints the implemented feature list", () => {
		const deps: FeaturesCommandDeps = {
			implementedFeatures: [
				{ id: 1, name: "Alpha" },
				{ id: 2, name: "Beta" },
			],
			logInfo: vi.fn(),
		};

		const result = runFeaturesCommand(deps);

		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith("Implemented features (2)");
		expect(deps.logInfo).toHaveBeenCalledWith("1. Alpha");
		expect(deps.logInfo).toHaveBeenCalledWith("2. Beta");
	});
});
