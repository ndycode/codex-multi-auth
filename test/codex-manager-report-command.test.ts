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
		resolveActiveIndex: vi.fn(() => 0),
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
