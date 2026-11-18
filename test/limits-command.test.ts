import { describe, expect, it, vi } from "vitest";
import { runLimitsCommand } from "../lib/codex-manager/commands/limits.js";
import type { QuotaCacheData } from "../lib/quota-cache.js";
import {
	accountStorageV3Fixture,
	storageAccountFixture,
} from "./helpers/cli-test-fixtures.js";

const NOW = 1_790_000_000_000;

function quotaCache(): QuotaCacheData {
	return {
		byAccountId: {
			"acct-1": {
				updatedAt: NOW - 60_000,
				status: 200,
				model: "gpt-5.6-codex",
				planType: "plus",
				primary: {
					usedPercent: 12.5,
					windowMinutes: 300,
					resetAtMs: NOW + 3_600_000,
				},
				secondary: {
					usedPercent: 63,
					windowMinutes: 10_080,
					resetAtMs: NOW + 86_400_000,
				},
			},
			orphan: {
				updatedAt: NOW,
				status: 200,
				model: "gpt-5.6-codex",
				primary: {},
				secondary: {},
			},
		},
		byEmail: {},
	};
}

function createDeps(cache = quotaCache()) {
	const storage = accountStorageV3Fixture([
		storageAccountFixture({
			accountId: "acct-1",
			email: "one@example.com",
			accessToken: "secret-access-token",
		}),
		storageAccountFixture({
			accountId: "acct-2",
			email: "two@example.com",
			accessToken: "second-secret-token",
			enabled: false,
		}),
	]);
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn().mockResolvedValue(storage),
		loadQuotaCache: vi.fn().mockResolvedValue(cache),
		refreshQuotaCache: vi.fn().mockResolvedValue(cache),
		refreshLunaReserveUsage: vi.fn().mockResolvedValue({}),
		resolveActiveIndex: vi.fn(() => 0),
		getNow: vi.fn(() => NOW),
		logInfo: vi.fn(),
		logError: vi.fn(),
	};
}

function emittedJson(deps: ReturnType<typeof createDeps>): Record<string, unknown> {
	expect(deps.logInfo).toHaveBeenCalledTimes(1);
	return JSON.parse(deps.logInfo.mock.calls[0]?.[0] as string) as Record<
		string,
		unknown
	>;
}

describe("runLimitsCommand", () => {
	it("emits configured accounts joined to cached quota and excludes secrets and orphan entries", async () => {
		const deps = createDeps();

		const exitCode = await runLimitsCommand(["--json"], deps);

		expect(exitCode).toBe(0);
		expect(deps.refreshQuotaCache).not.toHaveBeenCalled();
		const payload = emittedJson(deps);
		expect(payload).toMatchObject({
			schemaVersion: 1,
			generatedAt: NOW,
			mode: "cached",
		});
		expect(payload).not.toHaveProperty("accountCount");
		expect(payload).not.toHaveProperty("activeIndex");
		expect(payload.accounts).toEqual([
			{
				index: 0,
				label: expect.any(String),
				enabled: true,
				current: true,
				quota: {
					updatedAt: NOW - 60_000,
					status: 200,
					planType: "plus",
					primary: {
						usedPercent: 12.5,
						windowMinutes: 300,
						resetAtMs: NOW + 3_600_000,
					},
					secondary: {
						usedPercent: 63,
						windowMinutes: 10_080,
						resetAtMs: NOW + 86_400_000,
					},
				},
				lunaReserve: null,
			},
			{
				index: 1,
				label: expect.any(String),
				enabled: false,
				current: false,
				quota: null,
				lunaReserve: null,
			},
		]);
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toContain("secret-access-token");
		expect(serialized).not.toContain("second-secret-token");
		expect(serialized).not.toContain("orphan");
	});

	it("emits explicit nulls for missing optional provider fields", async () => {
		const cache = quotaCache();
		cache.byAccountId["acct-1"] = {
			updatedAt: NOW,
			status: 200,
			model: "gpt-5.6-codex",
			primary: {},
			secondary: {},
		};
		const deps = createDeps(cache);

		expect(await runLimitsCommand(["-j"], deps)).toBe(0);

		const accounts = emittedJson(deps).accounts as Array<Record<string, unknown>>;
		expect(accounts[0]?.quota).toEqual({
			updatedAt: NOW,
			status: 200,
			planType: null,
			primary: { usedPercent: null, windowMinutes: null, resetAtMs: null },
			secondary: { usedPercent: null, windowMinutes: null, resetAtMs: null },
		});
	});

	it("uses a safe unique-email fallback without exposing orphan cache entries", async () => {
		const cache = quotaCache();
		cache.byAccountId = {};
		cache.byEmail["one@example.com"] = {
			updatedAt: NOW,
			status: 200,
			model: "gpt-5.6-codex",
			primary: { usedPercent: 9 },
			secondary: {},
		};
		const deps = createDeps(cache);

		expect(await runLimitsCommand(["--json"], deps)).toBe(0);

		const accounts = emittedJson(deps).accounts as Array<Record<string, unknown>>;
		expect(accounts[0]?.quota).toMatchObject({ primary: { usedPercent: 9 } });
	});

	it("refuses an ambiguous same-email cache fallback", async () => {
		const cache = quotaCache();
		cache.byAccountId = {};
		cache.byEmail["shared@example.com"] = {
			updatedAt: NOW,
			status: 200,
			model: "gpt-5.6-codex",
			primary: { usedPercent: 9 },
			secondary: {},
		};
		const deps = createDeps(cache);
		deps.loadAccounts.mockResolvedValueOnce(
			accountStorageV3Fixture([
				storageAccountFixture({ accountId: "acct-a", email: "shared@example.com" }),
				storageAccountFixture({ accountId: "acct-b", email: "shared@example.com" }),
			]),
		);

		expect(await runLimitsCommand(["--json"], deps)).toBe(0);

		const accounts = emittedJson(deps).accounts as Array<Record<string, unknown>>;
		expect(accounts.map((account) => account.quota)).toEqual([null, null]);
	});

	it("age-gates an explicit refresh before emitting the refreshed cache", async () => {
		const deps = createDeps();
		const refreshed = quotaCache();
		refreshed.byAccountId["acct-1"] = {
			...refreshed.byAccountId["acct-1"],
			updatedAt: NOW,
			primary: { usedPercent: 20, windowMinutes: 300 },
		};
		deps.refreshQuotaCache.mockResolvedValueOnce(refreshed);

		const exitCode = await runLimitsCommand(["--refresh", "--json"], deps);

		expect(exitCode).toBe(0);
		expect(deps.refreshQuotaCache).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			300_000,
		);
		expect(deps.refreshQuotaCache.mock.invocationCallOrder[0]).toBeLessThan(
			deps.getNow.mock.invocationCallOrder[0] ?? 0,
		);
		const payload = emittedJson(deps);
		expect(payload.mode).toBe("refresh");
		const accounts = payload.accounts as Array<Record<string, unknown>>;
		expect(accounts[0]).toMatchObject({
			quota: { updatedAt: NOW, primary: { usedPercent: 20 } },
		});
	});

	it("emits a separately metered Luna Reserve percentage on refresh", async () => {
		const deps = createDeps();
		deps.refreshLunaReserveUsage.mockResolvedValueOnce({
			0: {
				observedAt: NOW,
				offered: true,
				available: true,
				limitId: "base_model_inference",
				limitName: "gpt-reserve",
				normalModelSlug: "gpt-6-luna",
				primary: {
					usedPercent: 6,
					remainingPercent: 94,
					windowMinutes: 10_080,
					resetAtMs: NOW + 86_400_000,
				},
				secondary: null,
			},
		});

		expect(await runLimitsCommand(["--refresh", "--json"], deps)).toBe(0);

		expect(deps.refreshLunaReserveUsage).toHaveBeenCalledTimes(1);
		const accounts = emittedJson(deps).accounts as Array<Record<string, unknown>>;
		expect(accounts[0]?.lunaReserve).toEqual({
			observedAt: NOW,
			offered: true,
			available: true,
			limitId: "base_model_inference",
			limitName: "gpt-reserve",
			normalModelSlug: "gpt-6-luna",
			primary: {
				usedPercent: 6,
				remainingPercent: 94,
				windowMinutes: 10_080,
				resetAtMs: NOW + 86_400_000,
			},
			secondary: null,
		});
	});

	it("emits a stable empty snapshot when no accounts are configured", async () => {
		const deps = createDeps();
		deps.loadAccounts.mockResolvedValueOnce(null);

		const exitCode = await runLimitsCommand(["--json"], deps);

		expect(exitCode).toBe(0);
		expect(deps.loadQuotaCache).not.toHaveBeenCalled();
		expect(deps.refreshQuotaCache).not.toHaveBeenCalled();
		expect(emittedJson(deps)).toEqual({
			schemaVersion: 1,
			generatedAt: NOW,
			mode: "cached",
			selection: {
				pinnedIndex: null,
				routedIndex: null,
				activeIndexByFamily: {},
			},
			accounts: [],
		});
	});

	it("reports the configured target even when that account cannot serve", async () => {
		// `selection` is configuration, not liveness. The proxy skips a disabled,
		// rate-limited, cooling-down or circuit-broken account, and applies
		// session affinity and --account, none of which touch storage. Predicting
		// that here would be a third copy of the selector; `why-selected` owns it.
		// The contract is pinned so the field is not mistaken for a live answer:
		// `current` follows the configured pin, and `enabled` stays visible next
		// to it so a consumer can see the account cannot serve.
		const deps = createDeps();
		const storage = accountStorageV3Fixture([
			storageAccountFixture({ accountId: "acct-1", email: "one@example.com" }),
			storageAccountFixture({
				accountId: "acct-2",
				email: "two@example.com",
				enabled: false,
			}),
		]);
		storage.pinnedAccountIndex = 1;
		deps.loadAccounts.mockResolvedValueOnce(storage);

		expect(await runLimitsCommand(["--json"], deps)).toBe(0);

		const payload = emittedJson(deps);
		expect(payload.selection).toMatchObject({ pinnedIndex: 1, routedIndex: 1 });
		const accounts = payload.accounts as Array<Record<string, unknown>>;
		expect(accounts[1]).toMatchObject({ current: true, enabled: false });
	});

	it("marks the pinned account current, not the family active index", async () => {
		// Regression: `current` was derived from the codex active index alone, so
		// any flow that moves the active index without touching the `switch` pin
		// (rotation saves, unpin, an ephemeral --account) reported `current: true`
		// on a row the runtime proxy is not serving from.
		const deps = createDeps();
		const storage = accountStorageV3Fixture([
			storageAccountFixture({ accountId: "acct-1", email: "one@example.com" }),
			storageAccountFixture({ accountId: "acct-2", email: "two@example.com" }),
		]);
		storage.pinnedAccountIndex = 1;
		deps.loadAccounts.mockResolvedValueOnce(storage);
		deps.resolveActiveIndex.mockReturnValue(0);

		expect(await runLimitsCommand(["--json"], deps)).toBe(0);

		const payload = emittedJson(deps);
		expect(payload.selection).toMatchObject({
			pinnedIndex: 1,
			routedIndex: 1,
		});
		const accounts = payload.accounts as Array<Record<string, unknown>>;
		expect(accounts.map((account) => account.current)).toEqual([false, true]);
	});

	it("reports the per-family active index and ignores an out-of-range pin", async () => {
		const deps = createDeps();
		const storage = accountStorageV3Fixture([
			storageAccountFixture({ accountId: "acct-1", email: "one@example.com" }),
			storageAccountFixture({ accountId: "acct-2", email: "two@example.com" }),
		]);
		storage.pinnedAccountIndex = 9;
		deps.loadAccounts.mockResolvedValueOnce(storage);
		deps.resolveActiveIndex.mockImplementation((_storage, family) =>
			family === "codex" ? 1 : 0,
		);

		expect(await runLimitsCommand(["--json"], deps)).toBe(0);

		const selection = emittedJson(deps).selection as {
			pinnedIndex: number | null;
			routedIndex: number;
			activeIndexByFamily: Record<string, number>;
		};
		expect(selection.pinnedIndex).toBeNull();
		expect(selection.routedIndex).toBe(1);
		expect(selection.activeIndexByFamily.codex).toBe(1);
		expect(Object.keys(selection.activeIndexByFamily).length).toBeGreaterThan(1);
	});

	it("masks account emails in the emitted label", async () => {
		// `limits --json` is meant to be piped into logs, dashboards and tickets,
		// so it masks addresses the same way `forecast --json` does.
		const deps = createDeps();

		expect(await runLimitsCommand(["--json"], deps)).toBe(0);

		const serialized = JSON.stringify(emittedJson(deps));
		expect(serialized).not.toContain("one@example.com");
		expect(serialized).not.toContain("two@example.com");
		expect(serialized).toContain("on***@***.com");
	});

	it("prints focused help without reading account storage", async () => {
		const deps = createDeps();

		const exitCode = await runLimitsCommand(["--help"], deps);

		expect(exitCode).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			"Usage: codex-multi-auth limits --json [--refresh]",
		);
		expect(deps.loadAccounts).not.toHaveBeenCalled();
	});

	it("requires the explicit JSON output flag", async () => {
		const deps = createDeps();

		const exitCode = await runLimitsCommand([], deps);

		expect(exitCode).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Usage: codex-multi-auth limits --json [--refresh]",
		);
		expect(deps.logInfo).not.toHaveBeenCalled();
	});

	it("rejects unsupported options without emitting a snapshot", async () => {
		const deps = createDeps();

		const exitCode = await runLimitsCommand(["--json", "--unknown"], deps);

		expect(exitCode).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"Unknown limits option: --unknown",
		);
		expect(deps.logInfo).not.toHaveBeenCalled();
	});
});
