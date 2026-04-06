import { describe, expect, it, vi } from "vitest";
import {
	type ReportCommandDeps,
	runReportCommand,
} from "../lib/codex-manager/commands/report.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(
	accounts: AccountStorageV3["accounts"] = [
		{
			email: "one@example.com",
			refreshToken: "refresh-token-1",
			accessToken: "access-token-1",
			expiresAt: 10,
			addedAt: 1,
			lastUsed: 1,
			enabled: true,
		},
	],
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts,
	};
}

function createDeps(
	overrides: Partial<ReportCommandDeps> = {},
): ReportCommandDeps {
	return {
		setStoragePath: vi.fn(),
		getStoragePath: vi.fn(() => "/mock/openai-codex-accounts.json"),
		loadAccounts: vi.fn(async () => createStorage()),
		saveAccounts: vi.fn(async () => undefined),
		resolveActiveIndex: vi.fn(() => 0),
		hasUsableAccessToken: vi.fn(() => false),
		queuedRefresh: vi.fn(async () => ({
			type: "success",
			access: "access-token-1",
			refresh: "refresh-token-1",
			expires: 100,
			idToken: "id-token-1",
		})),
		fetchCodexQuotaSnapshot: vi.fn(async () => ({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		})),
		formatRateLimitEntry: vi.fn(() => null),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		getCwd: vi.fn(() => "/repo"),
		writeFile: vi.fn(async () => undefined),
		...overrides,
	};
}

describe("runReportCommand", () => {
	it("prints usage for help", async () => {
		const deps = createDeps();

		const result = await runReportCommand(["--help"], deps);

		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining("Usage: codex auth report"),
		);
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();

		const result = await runReportCommand(["--bogus"], deps);

		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bogus");
	});

	it("rejects invalid live probe budget values", async () => {
		const deps = createDeps();

		const result = await runReportCommand(["--max-probes", "0"], deps);

		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"--max-probes must be a positive integer",
		);
	});

	it("writes json report output when requested", async () => {
		const deps = createDeps();

		const result = await runReportCommand(
			["--json", "--out", "report.json"],
			deps,
		);

		expect(result).toBe(0);
		expect(deps.writeFile).toHaveBeenCalledWith(
			expect.stringContaining("report.json"),
			expect.stringContaining('"command": "report"'),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"forecast"'),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"liveProbeBudget"'),
		);
	});

	it("respects live probe account and probe budgets", async () => {
		const deps = createDeps({
			loadAccounts: vi.fn(async () =>
				createStorage([
					{ email: "one@example.com", refreshToken: "r1", accessToken: "a1", accountId: "acct-1", expiresAt: 5_000, addedAt: 1, lastUsed: 1, enabled: true },
					{ email: "two@example.com", refreshToken: "r2", accessToken: "a2", accountId: "acct-2", expiresAt: 5_000, addedAt: 2, lastUsed: 2, enabled: true },
					{ email: "three@example.com", refreshToken: "r3", accessToken: "a3", accountId: "acct-3", expiresAt: 5_000, addedAt: 3, lastUsed: 3, enabled: true },
				]),
			),
			hasUsableAccessToken: vi.fn(() => true),
		});

		const result = await runReportCommand(
			["--live", "--json", "--max-accounts", "2", "--max-probes", "1"],
			deps,
		);

		expect(result).toBe(0);
		expect(deps.fetchCodexQuotaSnapshot).toHaveBeenCalledTimes(1);
		const jsonOutput = JSON.parse(
			(deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? "{}",
		) as { liveProbeBudget: { consideredAccounts: number; executedProbes: number }; forecast: { probeErrors: string[] } };
		expect(jsonOutput.liveProbeBudget).toEqual(
			expect.objectContaining({ consideredAccounts: 2, executedProbes: 1 }),
		);
		expect(jsonOutput.forecast.probeErrors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("live probe request budget reached (1)"),
			]),
		);
	});

	it("skips refreshes in cached-only live mode", async () => {
		const deps = createDeps({
			hasUsableAccessToken: vi.fn(() => false),
		});

		const result = await runReportCommand(["--live", "--json", "--cached-only"], deps);

		expect(result).toBe(0);
		expect(deps.queuedRefresh).not.toHaveBeenCalled();
		expect(deps.fetchCodexQuotaSnapshot).not.toHaveBeenCalled();
		const jsonOutput = JSON.parse(
			(deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? "{}",
		) as { forecast: { probeErrors: string[] } };
		expect(jsonOutput.forecast.probeErrors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("skipped refresh because --cached-only is enabled"),
			]),
		);
	});

	it("covers live probe refresh failures, missing account ids, and probe errors", async () => {
		const deps = createDeps({
			loadAccounts: vi.fn(async () =>
				createStorage([
					{
						email: "refresh-fail@example.com",
						refreshToken: "refresh-fail",
						addedAt: 1,
						lastUsed: 1,
						enabled: true,
					},
					{
						email: "missing-id@example.com",
						refreshToken: "missing-id",
						addedAt: 2,
						lastUsed: 2,
						enabled: true,
					},
					{
						email: "probe-error@example.com",
						refreshToken: "probe-error",
						accountId: "acct-probe-error",
						addedAt: 3,
						lastUsed: 3,
						enabled: true,
					},
					{
						email: "ok@example.com",
						refreshToken: "ok-refresh",
						accountId: "acct-ok",
						addedAt: 4,
						lastUsed: 4,
						enabled: true,
					},
				]),
			),
			resolveActiveIndex: vi.fn(() => 3),
			queuedRefresh: vi.fn(async (refreshToken: string) => {
				if (refreshToken === "refresh-fail") {
					return {
						type: "error",
						reason: "auth-failure",
						message: "token expired",
					};
				}
				return {
					type: "success",
					access:
						refreshToken === "missing-id"
							? "not-a-jwt"
							: `access-${refreshToken}`,
					refresh: refreshToken,
					expires: 100,
					idToken: `id-${refreshToken}`,
				};
			}),
			fetchCodexQuotaSnapshot: vi.fn(async ({ accountId }) => {
				if (accountId === "acct-probe-error") {
					throw new Error("quota endpoint down");
				}
				return {
					status: 200,
					model: "gpt-5-codex",
					planType: "pro",
					primary: {},
					secondary: {},
				};
			}),
		});

		const result = await runReportCommand(["--live", "--json"], deps);

		expect(result).toBe(0);
		expect(deps.fetchCodexQuotaSnapshot).toHaveBeenCalledTimes(2);
		const jsonOutput = JSON.parse(
			(deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? "{}",
		) as {
			forecast: {
				probeErrors: string[];
				accounts: Array<{ refreshFailure?: { message?: string }; liveQuota?: { planType?: string } }>;
			};
		};
		expect(jsonOutput.forecast.probeErrors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("missing accountId for live probe"),
				expect.stringContaining("quota endpoint down"),
			]),
		);
		expect(jsonOutput.forecast.accounts[0]?.refreshFailure?.message).toBe(
			"token expired",
		);
		expect(jsonOutput.forecast.accounts[3]?.liveQuota?.planType).toBe("pro");
	});

	it("reuses usable access tokens for live probes without forcing refresh", async () => {
		const deps = createDeps({
			hasUsableAccessToken: vi.fn(() => true),
			loadAccounts: vi.fn(async () =>
				createStorage([
					{
						email: "one@example.com",
						accountId: "acct-live",
						refreshToken: "refresh-token-1",
						accessToken: "access-token-1",
						expiresAt: 5_000,
						addedAt: 1,
						lastUsed: 1,
						enabled: true,
					},
				]),
			),
		});

		const result = await runReportCommand(["--live", "--json"], deps);

		expect(result).toBe(0);
		expect(deps.queuedRefresh).not.toHaveBeenCalled();
		expect(deps.saveAccounts).not.toHaveBeenCalled();
		expect(deps.fetchCodexQuotaSnapshot).toHaveBeenCalledWith({
			accountId: "acct-live",
			accessToken: "access-token-1",
			model: "gpt-5-codex",
		});
	});

	it("records probe error when usable token exists but account id is missing", async () => {
		const deps = createDeps({
			hasUsableAccessToken: vi.fn(() => true),
			loadAccounts: vi.fn(async () =>
				createStorage([
					{
						email: "missing-id@example.com",
						refreshToken: "refresh-token-1",
						accessToken: "not-a-jwt",
						expiresAt: 5_000,
						addedAt: 1,
						lastUsed: 1,
						enabled: true,
					},
				]),
			),
		});

		const result = await runReportCommand(["--live", "--json"], deps);

		expect(result).toBe(0);
		expect(deps.queuedRefresh).not.toHaveBeenCalled();
		expect(deps.saveAccounts).not.toHaveBeenCalled();
		expect(deps.fetchCodexQuotaSnapshot).not.toHaveBeenCalled();
		const jsonOutput = JSON.parse(
			(deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? "{}",
		) as { forecast: { probeErrors: string[] } };
		expect(jsonOutput.forecast.probeErrors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("missing accountId for live probe"),
			]),
		);
	});

	it("persists refreshed probe tokens before report live probes", async () => {
		const storage = createStorage([
			{
				email: "one@example.com",
				accountId: "acct-report",
				accountIdSource: "org",
				refreshToken: "refresh-token-1",
				accessToken: "access-token-1",
				expiresAt: 10,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
		]);
		const concurrentStorage = createStorage([
			{
				email: "one@example.com",
				accountId: "acct-report",
				accountIdSource: "org",
				refreshToken: "refresh-token-1",
				accessToken: "access-token-1",
				expiresAt: 10,
				currentWorkspaceIndex: 5,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
		]);
		const callLog: string[] = [];
		let persistedStorage: AccountStorageV3 | null = null;
		let loadCount = 0;
		const deps = createDeps({
			loadAccounts: vi.fn(async () => {
				loadCount += 1;
				return loadCount === 1 ? storage : structuredClone(concurrentStorage);
			}),
			saveAccounts: vi.fn(async (nextStorage) => {
				callLog.push(
					`save-${callLog.filter((entry) => entry.startsWith("save-")).length + 1}`,
				);
				if (callLog.length === 1) {
					throw Object.assign(new Error("EPERM write blocked"), {
						code: "EPERM",
					});
				}
				persistedStorage = structuredClone(nextStorage);
			}),
			queuedRefresh: vi.fn(async () => ({
				type: "success",
				access: "access-token-updated",
				refresh: "refresh-token-updated",
				expires: 500,
				idToken: "id-token-updated",
			})),
			fetchCodexQuotaSnapshot: vi.fn(async (input) => {
				callLog.push("fetch");
				expect(persistedStorage?.accounts[0]?.refreshToken).toBe(
					"refresh-token-updated",
				);
				expect(persistedStorage?.accounts[0]?.accessToken).toBe(
					"access-token-updated",
				);
				expect(persistedStorage?.accounts[0]?.currentWorkspaceIndex).toBe(5);
				expect(input.accessToken).toBe(
					persistedStorage?.accounts[0]?.accessToken,
				);
				return {
					status: 200,
					model: "gpt-5-codex",
					primary: {},
					secondary: {},
				};
			}),
		});

		const result = await runReportCommand(["--live", "--json"], deps);

		expect(result).toBe(0);
		expect(callLog).toEqual(["save-1", "save-2", "fetch"]);
		expect(deps.loadAccounts).toHaveBeenCalledTimes(2);
		expect(deps.saveAccounts).toHaveBeenCalledTimes(2);
		expect(deps.saveAccounts).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({
						refreshToken: "refresh-token-updated",
						accessToken: "access-token-updated",
						expiresAt: 500,
						accountId: "acct-report",
						accountIdSource: "org",
						currentWorkspaceIndex: 5,
					}),
				],
			}),
		);
		expect(deps.fetchCodexQuotaSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acct-report",
				accessToken: "access-token-updated",
			}),
		);
	});

	it("does not mutate the in-memory report snapshot when refreshed token persistence fails", async () => {
		const storage = createStorage([
			{
				email: "persist-fail@example.com",
				accountId: "acct-report",
				accountIdSource: "org",
				refreshToken: "refresh-token-1",
				accessToken: "access-token-1",
				expiresAt: 10,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
		]);
		const deps = createDeps({
			loadAccounts: vi.fn(async () => structuredClone(storage)),
			saveAccounts: vi.fn(async () => {
				throw Object.assign(new Error("EPERM write blocked"), {
					code: "EPERM",
				});
			}),
			queuedRefresh: vi.fn(async () => ({
				type: "success",
				access: "access-token-updated",
				refresh: "refresh-token-updated",
				expires: 500,
				idToken: "id-token-updated",
			})),
			fetchCodexQuotaSnapshot: vi.fn(async () => ({
				status: 200,
				model: "gpt-5-codex",
				primary: {},
				secondary: {},
			})),
		});

		const result = await runReportCommand(["--live", "--json"], deps);

		expect(result).toBe(0);
		expect(deps.fetchCodexQuotaSnapshot).not.toHaveBeenCalled();
		const jsonOutput = JSON.parse(
			(deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? "{}",
		) as {
			forecast: { probeErrors: string[]; accounts: Array<{ label: string }> };
		};
		expect(jsonOutput.forecast.probeErrors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("EPERM write blocked"),
			]),
		);
		expect(storage.accounts[0]?.refreshToken).toBe("refresh-token-1");
		expect(storage.accounts[0]?.accessToken).toBe("access-token-1");
	});

	it("prints a human-readable report and announces the output path", async () => {
		const deps = createDeps();

		const result = await runReportCommand(["--out", "report.json"], deps);

		expect(result).toBe(0);
		const [[writtenPath, writtenReport]] = (
			deps.writeFile as ReturnType<typeof vi.fn>
		).mock.calls;
		expect(String(writtenPath).replaceAll("\\", "/")).toContain(
			"/repo/report.json",
		);
		expect(String(writtenReport)).toContain('"command": "report"');
		const infoLines = (deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.map(
			([message]) => String(message).replaceAll("\\", "/"),
		);
		expect(infoLines.some((line) => line.includes("Accounts: 1 total"))).toBe(
			true,
		);
		expect(
			infoLines.some((line) => line.includes("Recommendation: account 1")),
		).toBe(true);
		expect(
			infoLines.some(
				(line) =>
					line.startsWith("Report written: ") &&
					line.endsWith("/repo/report.json"),
			),
		).toBe(true);
	});

	it("reports an empty storage snapshot when no accounts are loaded", async () => {
		const deps = createDeps({
			loadAccounts: vi.fn(async () => null),
		});

		const result = await runReportCommand(["--json"], deps);

		expect(result).toBe(0);
		expect(deps.resolveActiveIndex).not.toHaveBeenCalled();
		const jsonOutput = JSON.parse(
			(deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? "{}",
		) as {
			accounts: { total: number };
			activeIndex: number | null;
		};
		expect(jsonOutput.accounts.total).toBe(0);
		expect(jsonOutput.activeIndex).toBeNull();
	});

	it("surfaces write failures from the injected file writer", async () => {
		const deps = createDeps({
			writeFile: vi.fn(async () => {
				throw new Error("disk full");
			}),
		});

		await expect(
			runReportCommand(["--json", "--out", "report.json"], deps),
		).rejects.toThrow("disk full");
	});
});
