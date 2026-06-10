import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStorageV3 } from "../lib/storage.js";

// Audit roadmap §4.4.3: snapshot/contract tests for the CLI's machine-readable
// output surfaces. These tests pin the *shape* of each stable contract — usage
// text command list, exact top-level JSON key sets, value types, and exit
// codes — so an accidental rename/removal of a documented field fails loudly.
//
// Repo style note: the test suite favors explicit assertions over vitest
// snapshots (the only snapshot in the repo is a build-artifact file snapshot in
// copy-oauth-success.test.ts), so the usage text is pinned with explicit
// toContain assertions on every documented command invocation.
//
// Coverage intentionally skipped here because it is already asserted elsewhere:
// - why-selected --json populated payload fields and exit codes:
//   test/codex-manager-why-selected-command.test.ts (command/mode/ok/selected/
//   candidates) and test/codex-manager-cli.test.ts ("dispatches why-selected
//   --json command"). This file adds the exact top-level key set and the
//   empty-pool --json exit-1 contract, which were not pinned there.
// - status/list --json flag plumbing (-j/--json, auth-prefixed forms):
//   test/codex-manager-status-command.test.ts.
// - fix/verify-flagged --json payloads: test/repair-commands.test.ts.
// - config explain --json: test/codex-manager-cli.test.ts.
// - rotation reset-runtime --json: test/codex-manager-rotation-command.test.ts.

// Deterministic frozen clock. Only Date is faked so async fs/promise plumbing
// keeps running on real timers (matches the stream-failover suite guidance).
const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5, 0);

const MOCK_STORAGE_PATH = "/mock/openai-codex-accounts.json";

// Distinctive secrets so the leak assertions cannot pass by accident. The
// fixture accounts intentionally carry no email: account labels echo the
// stored email by design in user-facing CLI output, so the e-mail leak net
// pins that none of these machine-readable surfaces *introduces* an email
// (e.g. from token claims or codex auth files) when the pool has none.
const REFRESH_TOKEN_ONE = "contract-refresh-secret-one-7f3a9c1d2e";
const REFRESH_TOKEN_TWO = "contract-refresh-secret-two-5b8e4f6a0c";
const ACCESS_TOKEN_ONE = "contract-access-secret-one-9d2c7b4e1f";
const SECRET_VALUES = [
	REFRESH_TOKEN_ONE,
	REFRESH_TOKEN_TWO,
	ACCESS_TOKEN_ONE,
] as const;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				accountId: "acct_contract_one",
				refreshToken: REFRESH_TOKEN_ONE,
				accessToken: ACCESS_TOKEN_ONE,
				expiresAt: FIXED_NOW + 3_600_000,
				addedAt: FIXED_NOW - 86_400_000,
				lastUsed: FIXED_NOW - 7_200_000,
			},
			{
				accountId: "acct_contract_two",
				refreshToken: REFRESH_TOKEN_TWO,
				addedAt: FIXED_NOW - 172_800_000,
				lastUsed: FIXED_NOW - 14_400_000,
				enabled: false,
			},
		],
	};
}

const loadAccountsMock = vi.fn();
const loadFlaggedAccountsMock = vi.fn();
const saveAccountsMock = vi.fn();
const saveFlaggedAccountsMock = vi.fn();
const setStoragePathMock = vi.fn();
const getStoragePathMock = vi.fn(() => MOCK_STORAGE_PATH);
const inspectStorageHealthMock = vi.fn();
const queuedRefreshMock = vi.fn();
const fetchCodexQuotaSnapshotMock = vi.fn();
const loadQuotaCacheMock = vi.fn();
const saveQuotaCacheMock = vi.fn();
const loadPersistedRuntimeObservabilitySnapshotMock = vi.fn();
const getAppBindStatusMock = vi.fn();
const bindCodexAppRuntimeRotationMock = vi.fn();
const unbindCodexAppRuntimeRotationMock = vi.fn();
const loadCodexCliStateMock = vi.fn();
const setCodexCliActiveSelectionMock = vi.fn();

vi.mock("../lib/storage.js", async () => {
	const actual = await vi.importActual("../lib/storage.js");
	return {
		...(actual as Record<string, unknown>),
		loadAccounts: loadAccountsMock,
		loadFlaggedAccounts: loadFlaggedAccountsMock,
		saveAccounts: saveAccountsMock,
		saveFlaggedAccounts: saveFlaggedAccountsMock,
		setStoragePath: setStoragePathMock,
		getStoragePath: getStoragePathMock,
		inspectStorageHealth: inspectStorageHealthMock,
	};
});

// No network: token refresh and live quota probes must never run for the
// non---live surfaces under contract. Rejected mocks make any attempt fail
// the test loudly instead of silently reaching out.
vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: queuedRefreshMock,
}));

vi.mock("../lib/quota-probe.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/quota-probe.js")>()),
	fetchCodexQuotaSnapshot: fetchCodexQuotaSnapshotMock,
}));

vi.mock("../lib/quota-cache.js", () => ({
	loadQuotaCache: loadQuotaCacheMock,
	saveQuotaCache: saveQuotaCacheMock,
}));

vi.mock("../lib/runtime/runtime-observability.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../lib/runtime/runtime-observability.js")
	>()),
	loadPersistedRuntimeObservabilitySnapshot:
		loadPersistedRuntimeObservabilitySnapshotMock,
}));

vi.mock("../lib/runtime/app-bind.js", () => ({
	bindCodexAppRuntimeRotation: bindCodexAppRuntimeRotationMock,
	getAppBindStatus: getAppBindStatusMock,
	unbindCodexAppRuntimeRotation: unbindCodexAppRuntimeRotationMock,
}));

vi.mock("../lib/codex-cli/state.js", () => ({
	getCodexCliAuthPath: vi.fn(() => "/mock/.codex/auth.json"),
	getCodexCliConfigPath: vi.fn(() => "/mock/.codex/config.toml"),
	loadCodexCliState: loadCodexCliStateMock,
}));

vi.mock("../lib/codex-cli/writer.js", () => ({
	setCodexCliActiveSelection: setCodexCliActiveSelectionMock,
}));

interface CliRunResult {
	exitCode: number;
	stdout: string[];
	stderr: string[];
}

async function runCli(args: string[]): Promise<CliRunResult> {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	const errorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined);
	try {
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(args);
		return {
			exitCode,
			stdout: logSpy.mock.calls.map((call) => call.map(String).join(" ")),
			stderr: errorSpy.mock.calls.map((call) => call.map(String).join(" ")),
		};
	} finally {
		logSpy.mockRestore();
		errorSpy.mockRestore();
	}
}

function parseSingleJsonObject(result: CliRunResult): Record<string, unknown> {
	// JSON-mode contract: exactly one machine-readable object on stdout.
	expect(result.stdout).toHaveLength(1);
	const parsed: unknown = JSON.parse(result.stdout[0] ?? "");
	expect(parsed).toBeTypeOf("object");
	expect(Array.isArray(parsed)).toBe(false);
	expect(parsed).not.toBeNull();
	return parsed as Record<string, unknown>;
}

function expectNoSecretOrEmailLeak(result: CliRunResult): void {
	const text = [...result.stdout, ...result.stderr].join("\n");
	for (const secret of SECRET_VALUES) {
		expect(text).not.toContain(secret);
	}
	expect(text).not.toMatch(EMAIL_PATTERN);
}

function sortedKeys(value: Record<string, unknown>): string[] {
	return Object.keys(value).sort();
}

describe("cli output contracts", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] });
		loadAccountsMock.mockImplementation(async () => createStorage());
		loadFlaggedAccountsMock.mockResolvedValue({ version: 1, accounts: [] });
		saveAccountsMock.mockResolvedValue(undefined);
		saveFlaggedAccountsMock.mockResolvedValue(undefined);
		getStoragePathMock.mockReturnValue(MOCK_STORAGE_PATH);
		inspectStorageHealthMock.mockResolvedValue({
			state: "healthy",
			path: MOCK_STORAGE_PATH,
			resetMarkerPath: `${MOCK_STORAGE_PATH}.intentional-reset`,
			walPath: `${MOCK_STORAGE_PATH}.wal`,
			hasResetMarker: false,
			hasWal: false,
		});
		queuedRefreshMock.mockRejectedValue(
			new Error("network token refresh must not run in contract tests"),
		);
		fetchCodexQuotaSnapshotMock.mockRejectedValue(
			new Error("live quota probe must not run in contract tests"),
		);
		loadQuotaCacheMock.mockResolvedValue({ byAccountId: {}, byEmail: {} });
		saveQuotaCacheMock.mockResolvedValue(undefined);
		loadPersistedRuntimeObservabilitySnapshotMock.mockResolvedValue(null);
		getAppBindStatusMock.mockResolvedValue({ running: false, router: null });
		loadCodexCliStateMock.mockResolvedValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe("usage text (--help and bare invocation)", () => {
		// Every command invocation documented by lib/codex-manager/help.ts. A
		// removed or renamed line is a breaking change to the documented surface.
		const DOCUMENTED_COMMAND_LINES = [
			"codex-multi-auth login [--device-auth|--manual|--no-browser] [--org <org_id>]",
			"codex-multi-auth status",
			"codex-multi-auth check",
			"codex-multi-auth list",
			"codex-multi-auth switch <index>",
			"codex-multi-auth unpin",
			"codex-multi-auth workspace <account> [workspace]",
			"codex-multi-auth best [--live] [--json] [--model <model>]",
			"codex-multi-auth forecast [--live] [--json] [--model <model>]",
			"codex-multi-auth account tag|untag|weight|pause|unpause|drain|undrain|note ...",
			"codex-multi-auth uninstall [--dry-run] [--json] [--clear-accounts]",
			"codex-multi-auth verify-flagged [--dry-run] [--json] [--no-restore]",
			"codex-multi-auth verify [--paths | --flagged | --all] [--json]",
			"codex-multi-auth fix [--dry-run] [--json] [--live] [--model <model>]",
			"codex-multi-auth doctor [--json] [--fix] [--dry-run]",
			"codex-multi-auth usage [--since <time|duration>] [--by <group>] [--json|--csv] [--out <path>]",
			"codex-multi-auth budget limit|check|list ...",
			"codex-multi-auth bridge token create|list|rotate|revoke",
			"codex-multi-auth integrations [--kind <name>] [--base-url <url>] [--model <model>] [--json]",
			"codex-multi-auth models [--json] [--model <model>]",
			"codex-multi-auth monitor [--json]",
			"codex-multi-auth rotation <enable|disable|status|bind-app|unbind-app>",
			"codex-multi-auth rotation reset-rate-limits [--all | --account <idx>] [--dry-run] [--json]",
			"codex-multi-auth why-selected [--now | --last] [--json]",
			"codex-multi-auth report [--live] [--json] [--explain] [--model <model>] [--out <path>]",
			"codex-multi-auth config explain [--json]",
			"codex-multi-auth debug bundle [--json]",
			"codex-multi-auth features",
		] as const;

		it("--help prints the full documented command surface and exits 0", async () => {
			const result = await runCli(["--help"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toHaveLength(1);
			const usage = result.stdout[0] ?? "";
			expect(usage).toContain("Codex Multi-Auth CLI");
			for (const line of DOCUMENTED_COMMAND_LINES) {
				expect(usage).toContain(line);
			}
			// Section headers are part of the rendered contract too.
			for (const section of [
				"Start here:",
				"Daily use:",
				"Repair:",
				"Diagnostics:",
				"Advanced:",
				"Notes:",
			]) {
				expect(usage).toContain(section);
			}
			expectNoSecretOrEmailLeak(result);
		});

		it("bare invocation and -h print the same usage text with exit 0", async () => {
			const help = await runCli(["--help"]);
			const bare = await runCli([]);
			const shortFlag = await runCli(["-h"]);

			expect(bare.exitCode).toBe(0);
			expect(shortFlag.exitCode).toBe(0);
			expect(bare.stdout).toEqual(help.stdout);
			expect(shortFlag.stdout).toEqual(help.stdout);
		});
	});

	describe("status --json", () => {
		it("emits a single JSON object with the exact top-level key set and types", async () => {
			const result = await runCli(["status", "--json"]);

			expect(result.exitCode).toBe(0);
			const payload = parseSingleJsonObject(result);
			expect(sortedKeys(payload)).toEqual([
				"accountCount",
				"accounts",
				"activeIndex",
				"pinnedAccountIndex",
				"recommendationReason",
				"recommendedIndex",
				"runtimeInUseIndex",
				"storageHealth",
				"storagePath",
			]);

			expect(payload.storagePath).toBe(MOCK_STORAGE_PATH);
			expect(payload.storageHealth).toBe("healthy");
			expect(payload.accountCount).toBe(2);
			expect(payload.activeIndex).toBe(0);
			expect(payload.pinnedAccountIndex).toBeNull();
			expect(payload.recommendedIndex).toBe(0);
			expect(payload.recommendationReason).toBeTypeOf("string");
			expect(payload.runtimeInUseIndex).toBeNull();

			const accounts = payload.accounts as Array<Record<string, unknown>>;
			expect(Array.isArray(accounts)).toBe(true);
			expect(accounts).toHaveLength(2);
			for (const account of accounts) {
				expect(sortedKeys(account)).toEqual([
					"current",
					"enabled",
					"index",
					"label",
					"lastUsed",
					"markers",
					"reason",
				]);
				expect(account.index).toBeTypeOf("number");
				expect(account.label).toBeTypeOf("string");
				expect(account.enabled).toBeTypeOf("boolean");
				expect(account.current).toBeTypeOf("boolean");
				expect(Array.isArray(account.markers)).toBe(true);
				for (const marker of account.markers as unknown[]) {
					expect(marker).toBeTypeOf("string");
				}
				if (account.lastUsed !== null) {
					expect(account.lastUsed).toBeTypeOf("number");
				}
				if (account.reason !== null) {
					expect(account.reason).toBeTypeOf("string");
				}
			}
			expect(accounts[0]?.current).toBe(true);
			expect(accounts[1]?.enabled).toBe(false);

			expectNoSecretOrEmailLeak(result);
		});
	});

	describe("report --json", () => {
		it("emits the exact report envelope with frozen generatedAt and no live probes", async () => {
			const result = await runCli(["report", "--json"]);

			expect(result.exitCode).toBe(0);
			const payload = parseSingleJsonObject(result);
			expect(sortedKeys(payload)).toEqual([
				"accounts",
				"activeIndex",
				"command",
				"forecast",
				"generatedAt",
				"liveProbe",
				"liveProbeBudget",
				"model",
				"modelSelection",
				"runtime",
				"runtimeOverlay",
				"runtimeSnapshotLoadError",
				"storageHealth",
				"storagePath",
			]);

			expect(payload.command).toBe("report");
			expect(payload.generatedAt).toBe(new Date(FIXED_NOW).toISOString());
			expect(payload.storagePath).toBe(MOCK_STORAGE_PATH);
			expect(payload.model).toBeTypeOf("string");
			expect(payload.liveProbe).toBe(false);
			expect(payload.runtimeOverlay).toBe(false);
			expect(payload.runtime).toBeNull();
			expect(payload.runtimeSnapshotLoadError).toBeNull();
			// activeIndex is 1-based in the report contract (null when empty).
			expect(payload.activeIndex).toBe(1);

			const storageHealth = payload.storageHealth as Record<string, unknown>;
			expect(storageHealth.state).toBe("healthy");

			const modelSelection = payload.modelSelection as Record<string, unknown>;
			expect(sortedKeys(modelSelection)).toEqual([
				"capabilities",
				"normalized",
				"promptFamily",
				"remapped",
				"requested",
			]);

			const liveProbeBudget = payload.liveProbeBudget as Record<
				string,
				unknown
			>;
			expect(sortedKeys(liveProbeBudget)).toEqual([
				"cachedOnly",
				"consideredAccounts",
				"executedProbes",
				"maxAccounts",
				"maxProbes",
			]);
			expect(liveProbeBudget.consideredAccounts).toBe(0);
			expect(liveProbeBudget.executedProbes).toBe(0);

			const accounts = payload.accounts as Record<string, unknown>;
			expect(sortedKeys(accounts)).toEqual([
				"coolingDown",
				"disabled",
				"enabled",
				"rateLimited",
				"total",
			]);
			expect(accounts.total).toBe(2);
			expect(accounts.enabled).toBe(1);
			expect(accounts.disabled).toBe(1);

			const forecast = payload.forecast as Record<string, unknown>;
			expect(sortedKeys(forecast)).toEqual([
				"accounts",
				"probeErrors",
				"recommendation",
				"summary",
			]);
			const recommendation = forecast.recommendation as Record<
				string,
				unknown
			>;
			expect(sortedKeys(recommendation)).toEqual([
				"reason",
				"recommendedIndex",
				"selectedReason",
			]);
			const summary = forecast.summary as Record<string, unknown>;
			expect(sortedKeys(summary)).toEqual([
				"delayed",
				"highRisk",
				"ready",
				"total",
				"unavailable",
			]);
			expect(summary.total).toBe(2);
			expect(forecast.probeErrors).toEqual([]);

			// No network was touched for the cached report.
			expect(queuedRefreshMock).not.toHaveBeenCalled();
			expect(fetchCodexQuotaSnapshotMock).not.toHaveBeenCalled();

			expectNoSecretOrEmailLeak(result);
		});
	});

	describe("doctor --json", () => {
		it("emits the exact diagnostics envelope and maps summary errors to the exit code", async () => {
			const result = await runCli(["doctor", "--json"]);

			const payload = parseSingleJsonObject(result);
			expect(sortedKeys(payload)).toEqual([
				"checks",
				"command",
				"fix",
				"storagePath",
				"summary",
			]);

			expect(payload.command).toBe("doctor");
			expect(payload.storagePath).toBe(MOCK_STORAGE_PATH);

			const summary = payload.summary as Record<string, unknown>;
			expect(sortedKeys(summary)).toEqual(["error", "ok", "warn"]);
			expect(summary.ok).toBeTypeOf("number");
			expect(summary.warn).toBeTypeOf("number");
			expect(summary.error).toBeTypeOf("number");
			// Documented exit-code contract: 1 only when error-severity checks exist.
			expect(result.exitCode).toBe((summary.error as number) > 0 ? 1 : 0);
			expect(summary.error).toBe(0);
			expect(result.exitCode).toBe(0);

			const checks = payload.checks as Array<Record<string, unknown>>;
			expect(Array.isArray(checks)).toBe(true);
			expect(checks.length).toBeGreaterThan(0);
			const checkKeys = checks.map((check) => check.key);
			// Well-known diagnostics that must stay part of the surface.
			expect(checkKeys).toContain("storage-file");
			expect(checkKeys).toContain("codex-auth-file");
			expect(checkKeys).toContain("accounts");
			for (const check of checks) {
				// Per-check entry contract: key/severity/message plus optional details.
				for (const key of Object.keys(check)) {
					expect(["details", "key", "message", "severity"]).toContain(key);
				}
				expect(check.key).toBeTypeOf("string");
				expect(check.message).toBeTypeOf("string");
				expect(["ok", "warn", "error"]).toContain(check.severity);
				if ("details" in check) {
					expect(check.details).toBeTypeOf("string");
				}
			}

			const fix = payload.fix as Record<string, unknown>;
			expect(sortedKeys(fix)).toEqual([
				"actions",
				"changed",
				"dryRun",
				"enabled",
			]);
			expect(fix.enabled).toBe(false);
			expect(fix.dryRun).toBe(false);
			expect(fix.changed).toBe(false);
			expect(fix.actions).toEqual([]);

			// doctor without --fix must stay offline.
			expect(queuedRefreshMock).not.toHaveBeenCalled();
			expect(fetchCodexQuotaSnapshotMock).not.toHaveBeenCalled();

			expectNoSecretOrEmailLeak(result);
		});
	});

	describe("forecast --json", () => {
		it("emits the exact forecast envelope without live probes", async () => {
			const result = await runCli(["forecast", "--json"]);

			expect(result.exitCode).toBe(0);
			const payload = parseSingleJsonObject(result);
			// `explanation` is only present with --explain; JSON.stringify drops it
			// otherwise, so the default envelope is exactly these keys.
			expect(sortedKeys(payload)).toEqual([
				"accounts",
				"command",
				"liveProbe",
				"model",
				"probeErrors",
				"recommendation",
				"runtimeOverlay",
				"summary",
			]);

			expect(payload.command).toBe("forecast");
			expect(payload.model).toBeTypeOf("string");
			expect(payload.liveProbe).toBe(false);
			expect(payload.runtimeOverlay).toBe(true);
			expect(payload.probeErrors).toEqual([]);

			const summary = payload.summary as Record<string, unknown>;
			expect(sortedKeys(summary)).toEqual([
				"delayed",
				"highRisk",
				"ready",
				"total",
				"unavailable",
			]);
			expect(summary.total).toBe(2);

			const recommendation = payload.recommendation as Record<
				string,
				unknown
			>;
			expect(sortedKeys(recommendation)).toEqual([
				"reason",
				"recommendedIndex",
			]);
			expect(recommendation.recommendedIndex).toBe(0);
			expect(recommendation.reason).toBeTypeOf("string");

			const accounts = payload.accounts as Array<Record<string, unknown>>;
			expect(accounts).toHaveLength(2);
			for (const account of accounts) {
				// primaryReason is optional (dropped when the account has no reasons);
				// liveQuota/refreshFailure must be absent in cached (non---live) mode.
				for (const key of Object.keys(account)) {
					expect([
						"availability",
						"index",
						"isCurrent",
						"label",
						"primaryReason",
						"reasons",
						"riskLevel",
						"riskScore",
						"selected",
						"waitMs",
					]).toContain(key);
				}
				expect(account.index).toBeTypeOf("number");
				expect(account.label).toBeTypeOf("string");
				expect(account.isCurrent).toBeTypeOf("boolean");
				expect(account.selected).toBeTypeOf("boolean");
				expect(account.availability).toBeTypeOf("string");
				expect(account.riskScore).toBeTypeOf("number");
				expect(account.riskLevel).toBeTypeOf("string");
				expect(account.waitMs).toBeTypeOf("number");
				expect(Array.isArray(account.reasons)).toBe(true);
				expect(account).not.toHaveProperty("liveQuota");
				expect(account).not.toHaveProperty("refreshFailure");
			}

			expect(queuedRefreshMock).not.toHaveBeenCalled();
			expect(fetchCodexQuotaSnapshotMock).not.toHaveBeenCalled();

			expectNoSecretOrEmailLeak(result);
		});
	});

	describe("forecast --json --explain", () => {
		it("pins the explanation envelope that --explain adds", async () => {
			const result = await runCli(["forecast", "--json", "--explain"]);

			expect(result.exitCode).toBe(0);
			const payload = parseSingleJsonObject(result);
			expect(sortedKeys(payload)).toEqual([
				"accounts",
				"command",
				"explanation",
				"liveProbe",
				"model",
				"probeErrors",
				"recommendation",
				"runtimeOverlay",
				"summary",
			]);

			const explanation = payload.explanation as Record<string, unknown>;
			expect(sortedKeys(explanation)).toEqual([
				"considered",
				"recommendationReason",
				"recommendedIndex",
			]);
			expect(explanation.recommendedIndex).toBe(0);
			expect(explanation.recommendationReason).toBeTypeOf("string");

			const considered = explanation.considered as Array<
				Record<string, unknown>
			>;
			expect(considered).toHaveLength(2);
			for (const row of considered) {
				expect(sortedKeys(row)).toEqual([
					"availability",
					"index",
					"isCurrent",
					"label",
					"reasons",
					"riskLevel",
					"riskScore",
					"selected",
					"waitMs",
				]);
			}

			expectNoSecretOrEmailLeak(result);
		});
	});

	describe("why-selected --json", () => {
		it("pins the exact top-level key set for a populated pool", async () => {
			const result = await runCli(["why-selected", "--json"]);

			expect(result.exitCode).toBe(0);
			const payload = parseSingleJsonObject(result);
			// quotaKey and runtimeSnapshot are undefined in --now mode without a
			// quota key, so JSON.stringify drops them from the envelope.
			expect(sortedKeys(payload)).toEqual([
				"availableCount",
				"candidates",
				"command",
				"config",
				"mode",
				"ok",
				"selected",
				"totalCount",
			]);

			expect(payload.command).toBe("why-selected");
			expect(payload.mode).toBe("now");
			expect(payload.ok).toBe(true);
			expect(payload.availableCount).toBe(1);
			expect(payload.totalCount).toBe(2);
			expect(payload.config).toBeTypeOf("object");

			// email/accountId/lastSwitchReason/lastRateLimitReason/cooldownReason/
			// reason are optional and dropped by JSON.stringify when undefined;
			// selectionReason exists only on the selected record.
			const candidateAllowedKeys = [
				"accountId",
				"available",
				"capabilityBoost",
				"cooldownReason",
				"email",
				"enabled",
				"health",
				"hoursSinceUsed",
				"index",
				"lastRateLimitReason",
				"lastSwitchReason",
				"oneBasedIndex",
				"pidBonus",
				"reason",
				"score",
				"tokens",
			];

			const selected = payload.selected as Record<string, unknown>;
			for (const key of Object.keys(selected)) {
				expect([...candidateAllowedKeys, "selectionReason"]).toContain(key);
			}
			expect(selected.index).toBe(0);
			expect(selected.selectionReason).toBeTypeOf("string");

			const candidates = payload.candidates as Array<
				Record<string, unknown>
			>;
			expect(Array.isArray(candidates)).toBe(true);
			for (const candidate of candidates) {
				for (const key of Object.keys(candidate)) {
					expect(candidateAllowedKeys).toContain(key);
				}
				expect(candidate.index).toBeTypeOf("number");
				expect(candidate.oneBasedIndex).toBeTypeOf("number");
				expect(candidate.enabled).toBeTypeOf("boolean");
				expect(candidate.available).toBeTypeOf("boolean");
				expect(candidate.health).toBeTypeOf("number");
				expect(candidate.tokens).toBeTypeOf("number");
				expect(candidate.hoursSinceUsed).toBeTypeOf("number");
				expect(candidate.capabilityBoost).toBeTypeOf("number");
				expect(candidate.pidBonus).toBeTypeOf("number");
				expect(candidate.score).toBeTypeOf("number");
			}

			expectNoSecretOrEmailLeak(result);
		});

		it("returns exit 1 with the documented empty-pool JSON contract", async () => {
			loadAccountsMock.mockResolvedValue(null);

			const result = await runCli(["why-selected", "--json"]);

			expect(result.exitCode).toBe(1);
			const payload = parseSingleJsonObject(result);
			expect(sortedKeys(payload)).toEqual([
				"candidates",
				"command",
				"error",
				"mode",
				"ok",
				"selected",
			]);
			expect(payload.command).toBe("why-selected");
			expect(payload.ok).toBe(false);
			expect(payload.selected).toBeNull();
			expect(payload.candidates).toEqual([]);
			expect(payload.error).toBe("no accounts configured");
		});
	});
});
