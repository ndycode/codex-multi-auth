import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatAccountLabel, formatCooldown, formatWaitTime } from "../../accounts.js";
import { parseBooleanEnv } from "../../env-parsing.js";
import { getCodexMultiAuthDir } from "../../runtime-paths.js";
import { saveAccountsWithRetry } from "../forecast-report-shared.js";

/**
 * Build a privacy-safe label for {@link runResetRateLimits} change reports.
 *
 * `formatAccountLabel` includes the raw email, which leaks PII into JSON output
 * that can be ingested by automation. This helper keeps just the 1-based index
 * and a tail-only fragment of the accountId so a human can still tell which
 * pool entry was affected.
 */
function redactedResetRateLimitsLabel(
	account: AccountMetadataV3,
	index: number,
): string {
	const id = typeof account.accountId === "string" ? account.accountId : "";
	const tail = id.length > 4 ? `***${id.slice(-4)}` : "***";
	return `account ${index + 1} (id:${tail})`;
}
import {
	formatAppBindStatus,
	type AppBindResult,
	type AppBindStatus,
} from "../../runtime/app-bind.js";
import { APP_RUNTIME_HELPER_STATUS_FILE } from "../../runtime-constants.js";
import {
	findQuotaCacheEntryForAccount,
	isQuotaCacheEntryExhausted,
} from "../../quota-readiness.js";
import type { QuotaCacheData } from "../../quota-cache.js";
import type { RuntimeObservabilitySnapshot } from "../../runtime/runtime-observability.js";
import {
	appRuntimeHelperStatusToSignal as appRuntimeHelperStatusToRuntimeSignal,
	resolveAccountCurrentMarkers,
	resolveRuntimeCurrentAccount,
} from "../../runtime/runtime-current-account.js";
import { isRateLimitedMarker } from "../rate-limit-markers.js";
import type { PluginConfig } from "../../types.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../../storage.js";

type LoadedStorage = AccountStorageV3 | null;

interface AppRuntimeHelperStatus {
	kind: string | null;
	state: string | null;
	pid: number | null;
	idleExpiresAt: number | null;
	totalRequests: number | null;
	rotations: number | null;
	lastAccountIndex: number | null;
	lastAccountLabel: string | null;
	lastAccountEmail: string | null;
	lastAccountId: string | null;
	lastAccountUpdatedAt: number | null;
	updatedAt: number | null;
}

export interface RotationCommandDeps {
	loadPluginConfig: () => PluginConfig;
	savePluginConfig: (config: Partial<PluginConfig>) => Promise<void>;
	getCodexRuntimeRotationProxy: (config: PluginConfig) => boolean;
	loadAccounts: () => Promise<LoadedStorage>;
	saveAccounts?: (storage: AccountStorageV3) => Promise<void>;
	resolveActiveIndex: (storage: AccountStorageV3) => number;
	getStoragePath: () => string | null;
	setStoragePath: (path: string | null) => void;
	bindCodexApp?: () => Promise<AppBindResult>;
	unbindCodexApp?: () => Promise<AppBindResult>;
	getCodexAppBindStatus?: () => Promise<AppBindStatus>;
	loadRuntimeObservabilitySnapshot?: () => Promise<RuntimeObservabilitySnapshot | null>;
	loadQuotaCache?: () => Promise<QuotaCacheData | null>;
	getNow?: () => number;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

function printRotationUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex auth rotation enable",
			"  codex auth rotation disable",
			"  codex auth rotation status",
			"  codex auth rotation bind-app",
			"  codex auth rotation unbind-app",
			"  codex auth rotation reset-rate-limits [--all | --account <idx>] [--dry-run] [--json]",
			"",
			"Behavior:",
			"  - Runtime rotation is enabled by default for request-bearing Codex sessions",
			"  - Binds the packaged Codex desktop app to the same localhost router when enabled or repaired",
			"  - Use CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0 to disable the proxy for the current process without changing persistent settings",
			"  - reset-rate-limits clears stored rateLimitResetTimes and active coolingDownUntil entries; use when `fix --live` confirms quota is available but the proxy still returns 503 pool-exhausted",
		].join("\n"),
	);
}

interface ResetRateLimitsOptions {
	scope: "all" | "account";
	accountIndex: number | null;
	dryRun: boolean;
	json: boolean;
}

interface ResetRateLimitsAccountChange {
	index: number;
	label: string;
	clearedRateLimitKeys: string[];
	clearedCoolingDown: boolean;
}

type ParseResetRateLimitsResult =
	| { ok: true; help: false; options: ResetRateLimitsOptions }
	| { ok: true; help: true }
	| { ok: false; error: string };

/**
 * Parse argv tokens into a {@link ResetRateLimitsOptions} bag (or an error / help signal).
 *
 * Accepts `--all`, `--account <1-based-int>`, `--dry-run`, `--json` / `-j`, and `--help` /
 * `-h` / `help`. Rejects fractional or non-numeric account indexes and combinations of
 * `--all` with `--account`. Returns a discriminated union so callers can route help and
 * error paths without parsing twice.
 */
function parseResetRateLimitsArgs(args: string[]): ParseResetRateLimitsResult {
	let scope: ResetRateLimitsOptions["scope"] = "all";
	let scopeExplicit = false;
	let accountIndex: number | null = null;
	let dryRun = false;
	let json = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h" || arg === "help") {
			return { ok: true, help: true };
		}
		if (arg === "--all") {
			if (scopeExplicit && scope !== "all") {
				return { ok: false, error: "--all and --account are mutually exclusive" };
			}
			scope = "all";
			scopeExplicit = true;
			continue;
		}
		if (arg === "--account") {
			if (scopeExplicit && scope === "all") {
				return { ok: false, error: "--all and --account are mutually exclusive" };
			}
			const next = args[i + 1];
			if (!next) {
				return { ok: false, error: "--account requires a 1-based index" };
			}
			if (!/^[0-9]+$/.test(next)) {
				return {
					ok: false,
					error: `--account expects a positive 1-based integer, got: ${next}`,
				};
			}
			const parsed = Number.parseInt(next, 10);
			if (!Number.isInteger(parsed) || parsed < 1) {
				return {
					ok: false,
					error: `--account expects a positive 1-based integer, got: ${next}`,
				};
			}
			scope = "account";
			scopeExplicit = true;
			accountIndex = parsed - 1;
			i += 1;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			json = true;
			continue;
		}
		return { ok: false, error: `Unknown reset-rate-limits option: ${arg}` };
	}

	return { ok: true, help: false, options: { scope, accountIndex, dryRun, json } };
}

/**
 * Print the focused `codex auth rotation reset-rate-limits` help block, including the
 * proxy-restart guidance users need to run after a successful clear.
 */
function printResetRateLimitsUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex auth rotation reset-rate-limits [--all | --account <idx>] [--dry-run] [--json]",
			"",
			"Options:",
			"  --all              Clear timers for every account (default)",
			"  --account <idx>    Clear timers for a single 1-based account index",
			"  --dry-run          Report what would change without writing",
			"  --json, -j         Print machine-readable JSON output",
			"",
			"Notes:",
			"  - Clears stored rateLimitResetTimes entries with reset times still in the future",
			"    and any active coolingDownUntil entries.",
			"  - Use when `codex auth fix --live` confirms upstream quota is available but the",
			"    runtime rotation proxy still returns 503 pool-exhausted.",
			"  - If a runtime rotation proxy is currently running it may re-persist its in-memory",
			"    timers and revert these changes. After clearing, run `codex auth rotation disable`",
			"    then `codex auth rotation enable` (or restart the Codex app) to flush in-memory",
			"    state and reload from disk.",
		].join("\n"),
	);
}

const RESET_RATE_LIMITS_RESTART_HINT =
	"If a runtime rotation proxy is currently running it may re-persist its in-memory timers and revert these changes. Run `codex auth rotation disable` then `codex auth rotation enable` (or restart the Codex app) to flush in-memory state and reload from disk.";

/**
 * Implement `codex auth rotation reset-rate-limits`: load the shared (non-project-scoped)
 * account pool, scan for currently-blocking `rateLimitResetTimes` and `coolingDownUntil`
 * entries, optionally clear them, and persist via {@link saveAccountsWithRetry}.
 *
 * The shared-path scope is held across both load and save so the write lands on the
 * pool file even when the CLI was invoked from a project-scoped working directory.
 *
 * @returns 0 on success (including no-op runs and dry-runs), 1 on parse errors,
 *   missing accounts, out-of-range index, missing writable `saveAccounts` for a real
 *   write, or persistent save failures (e.g. Windows EBUSY exhaustion).
 */
async function runResetRateLimits(
	args: string[],
	deps: RotationCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const now = deps.getNow?.() ?? Date.now();

	const parsed = parseResetRateLimitsArgs(args);
	if (!parsed.ok) {
		logError(parsed.error);
		return 1;
	}
	if (parsed.help) {
		printResetRateLimitsUsage(logInfo);
		return 0;
	}
	const { scope, accountIndex, dryRun, json } = parsed.options;

	// Defer the saveAccounts check to the actual write branch so a non-dry-run scan that
	// finds nothing to clear can still succeed without writable storage.

	// Keep the shared (non-project-scoped) path scope active across both load AND save so that
	// `saveAccounts` writes to the same file we loaded from, even when the CLI was invoked from
	// a project directory with a non-null project-scoped path. Restoring the previous path
	// between load and save would silently route the write to the project storage file.
	const previousStoragePath = deps.getStoragePath();
	deps.setStoragePath(null);
	try {
		const storage = await deps.loadAccounts();
		const storagePath = deps.getStoragePath();

		if (!storage || storage.accounts.length === 0) {
			const payload = {
				ok: false,
				error: "no accounts configured",
				storagePath,
			};
			if (json) logInfo(JSON.stringify(payload));
			else logError("No accounts configured.");
			return 1;
		}

		if (scope === "account") {
			if (accountIndex === null) {
				logError("internal: account scope without index");
				return 1;
			}
			if (accountIndex < 0 || accountIndex >= storage.accounts.length) {
				const message = `Account index out of range (1..${storage.accounts.length}): ${accountIndex + 1}`;
				if (json) {
					logInfo(JSON.stringify({ ok: false, error: message, storagePath }));
				} else {
					logError(message);
				}
				return 1;
			}
		}

		const targetIndexes =
			scope === "all"
				? storage.accounts.map((_, i) => i)
				: accountIndex !== null
					? [accountIndex]
					: [];
		const changes: ResetRateLimitsAccountChange[] = [];

		for (const index of targetIndexes) {
			const account = storage.accounts[index];
			if (!account) continue;
			const clearedRateLimitKeys: string[] = [];
			if (account.rateLimitResetTimes) {
				for (const [key, value] of Object.entries(account.rateLimitResetTimes)) {
					if (typeof value === "number" && value > now) {
						clearedRateLimitKeys.push(key);
					}
				}
			}
			const clearedCoolingDown =
				typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now;
			if (clearedRateLimitKeys.length === 0 && !clearedCoolingDown) continue;
			changes.push({
				index,
				label: redactedResetRateLimitsLabel(account, index),
				clearedRateLimitKeys,
				clearedCoolingDown,
			});
			if (!dryRun) {
				// Only delete the keys we reported (future-active resets) so callers who inspect
				// the JSON output can trust the report matches the action exactly. Past entries are
				// no-ops for `getMinWaitTimeForFamily` and are pruned naturally by
				// `clearExpiredRateLimits`.
				if (account.rateLimitResetTimes) {
					for (const key of clearedRateLimitKeys) {
						delete account.rateLimitResetTimes[key];
					}
				}
				if (clearedCoolingDown) {
					delete account.coolingDownUntil;
				}
			}
		}

		if (!dryRun && changes.length > 0) {
			if (!deps.saveAccounts) {
				const message =
					"reset-rate-limits requires writable account storage but saveAccounts dep was not provided";
				if (json) {
					logInfo(JSON.stringify({ ok: false, error: message, storagePath }));
				} else {
					logError(message);
				}
				return 1;
			}
			try {
				// Use saveAccountsWithRetry to absorb transient Windows EBUSY/EPERM contention,
				// matching every other saveAccounts call site in the codebase.
				await saveAccountsWithRetry(storage, deps.saveAccounts);
			} catch (error) {
				const code =
					error && typeof error === "object" && "code" in error
						? String((error as { code?: unknown }).code ?? "")
						: "";
				const message = code
					? `Failed to persist reset-rate-limits (${code}); rate-limit timers were not cleared.`
					: `Failed to persist reset-rate-limits: ${
							error instanceof Error ? error.message : String(error)
						}`;
				if (json) {
					logInfo(JSON.stringify({ ok: false, error: message, storagePath }));
				} else {
					logError(message);
				}
				return 1;
			}
		}

		if (json) {
			logInfo(
				JSON.stringify({
					ok: true,
					dryRun,
					scope,
					storagePath,
					accountsScanned: targetIndexes.length,
					accountsChanged: changes.length,
					changes,
					...(changes.length > 0 && !dryRun
						? { restartHint: RESET_RATE_LIMITS_RESTART_HINT }
						: {}),
				}),
			);
			return 0;
		}

		if (changes.length === 0) {
			logInfo(
				scope === "all"
					? "No accounts had active rate-limit or cooldown timers to clear."
					: `Account ${(accountIndex ?? 0) + 1} had no active rate-limit or cooldown timers to clear.`,
			);
			return 0;
		}

		logInfo(
			`${dryRun ? "Would clear" : "Cleared"} ${changes.length}/${targetIndexes.length} account(s):`,
		);
		for (const change of changes) {
			const parts: string[] = [];
			if (change.clearedRateLimitKeys.length > 0) {
				parts.push(`rate-limit keys: ${change.clearedRateLimitKeys.join(", ")}`);
			}
			if (change.clearedCoolingDown) parts.push("cooldown");
			logInfo(`  ${change.index + 1}. ${change.label} | ${parts.join(" | ")}`);
		}
		if (dryRun) {
			logInfo("(dry-run; no changes written)");
		} else {
			logInfo(`Note: ${RESET_RATE_LIMITS_RESTART_HINT}`);
		}
		return 0;
	} finally {
		deps.setStoragePath(previousStoragePath);
	}
}

function formatEnvOverride(): string {
	const raw = process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY;
	if (raw === undefined || raw.trim().length === 0) return "none";
	const parsed = parseBooleanEnv(raw);
	if (parsed === undefined) return `invalid (${raw})`;
	return parsed ? "enabled" : "disabled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function readAppRuntimeHelperStatus(): AppRuntimeHelperStatus | null {
	const statusPath = join(getCodexMultiAuthDir(), APP_RUNTIME_HELPER_STATUS_FILE);
	if (!existsSync(statusPath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as unknown;
		if (!isRecord(parsed)) return null;
		return {
			state: readOptionalString(parsed, "state"),
			kind: readOptionalString(parsed, "kind"),
			pid: readOptionalNumber(parsed, "pid"),
			idleExpiresAt: readOptionalNumber(parsed, "idleExpiresAt"),
			totalRequests: readOptionalNumber(parsed, "totalRequests"),
			rotations: readOptionalNumber(parsed, "rotations"),
			lastAccountIndex: readOptionalNumber(parsed, "lastAccountIndex"),
			lastAccountLabel: readOptionalString(parsed, "lastAccountLabel"),
			lastAccountEmail: null,
			lastAccountId: readOptionalString(parsed, "lastAccountId"),
			lastAccountUpdatedAt: readOptionalNumber(parsed, "lastAccountUpdatedAt"),
			updatedAt: readOptionalNumber(parsed, "updatedAt"),
		};
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number | null): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		return code === "EPERM";
	}
}

function formatHelperLastAccount(status: AppRuntimeHelperStatus): string | null {
	if (status.lastAccountLabel && !status.lastAccountLabel.includes("@")) {
		return status.lastAccountLabel;
	}
	if (status.lastAccountId) {
		return status.lastAccountIndex !== null
			? `Account ${status.lastAccountIndex + 1} (${status.lastAccountId})`
			: status.lastAccountId;
	}
	if (status.lastAccountIndex !== null) {
		return `Account ${status.lastAccountIndex + 1}`;
	}
	return null;
}

function formatAppRuntimeHelperStatus(
	now: number,
	status = readAppRuntimeHelperStatus(),
): string {
	if (!status) return "Codex app helper: not running";
	if (status.kind !== "codex-app-runtime-rotation-helper") {
		return "Codex app helper: not running";
	}
	const alive = isProcessAlive(status.pid);
	if (!alive || status.state === "stopped" || status.state === "idle-timeout") {
		return "Codex app helper: not running";
	}
	const parts = [`running${status.pid ? ` pid=${status.pid}` : ""}`];
	if (status.totalRequests !== null) parts.push(`requests=${status.totalRequests}`);
	if (status.rotations !== null) parts.push(`rotations=${status.rotations}`);
	const lastAccount = formatHelperLastAccount(status);
	if (lastAccount) parts.push(`lastAccount=${lastAccount}`);
	if (status.idleExpiresAt !== null && status.idleExpiresAt > now) {
		parts.push(`idle-expires=${formatWaitTime(status.idleExpiresAt - now)}`);
	}
	return `Codex app helper: ${parts.join(", ")}`;
}

function shouldAutoBindCodexApp(env: NodeJS.ProcessEnv = process.env): boolean {
	const override = (env.CODEX_MULTI_AUTH_APP_BIND_INSTALL ?? "1")
		.trim()
		.toLowerCase();
	return !new Set(["0", "false", "no"]).has(override);
}

async function printCodexAppBindStatus(
	deps: RotationCommandDeps,
): Promise<AppBindStatus | null> {
	const logInfo = deps.logInfo ?? console.log;
	if (!deps.getCodexAppBindStatus) {
		logInfo("Codex app bind: unavailable");
		return null;
	}
	try {
		const status = await deps.getCodexAppBindStatus();
		logInfo(formatAppBindStatus(status));
		return status;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logInfo(`Codex app bind: unavailable (${message})`);
		return null;
	}
}

async function printRotationStatus(deps: RotationCommandDeps): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const previousStoragePath = deps.getStoragePath();
	let config!: PluginConfig;
	let enabled!: boolean;
	let storage!: LoadedStorage;
	let storagePath!: string | null;
	const now = deps.getNow?.() ?? Date.now();
	try {
		// Rotation status reports the shared Codex account pool, not a project-scoped override.
		deps.setStoragePath(null);
		config = deps.loadPluginConfig();
		const envOverride = parseBooleanEnv(process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY);
		enabled = envOverride ?? deps.getCodexRuntimeRotationProxy(config);
		storage = await deps.loadAccounts();
		storagePath = deps.getStoragePath();
	} finally {
		deps.setStoragePath(previousStoragePath);
	}

	logInfo(`Runtime rotation proxy: ${enabled ? "enabled" : "disabled"}`);
	logInfo(
		`Stored setting: ${config.codexRuntimeRotationProxy === true ? "enabled" : "disabled"}`,
	);
	logInfo(`Env override: ${formatEnvOverride()}`);
	const helperStatus = readAppRuntimeHelperStatus();
	logInfo(formatAppRuntimeHelperStatus(now, helperStatus));
	const appBindStatus = await printCodexAppBindStatus(deps);
	logInfo(`Storage: ${storagePath}`);

	if (!storage || storage.accounts.length === 0) {
		logInfo("Accounts: none configured");
		return 0;
	}

	const activeIndex = deps.resolveActiveIndex(storage);
	const [runtimeSnapshot, quotaCache] = await Promise.all([
		deps.loadRuntimeObservabilitySnapshot
			? deps.loadRuntimeObservabilitySnapshot().catch(() => null)
			: Promise.resolve(null),
		deps.loadQuotaCache
			? deps.loadQuotaCache().catch(() => null)
			: Promise.resolve(null),
	]);
	const runtimeCurrent = resolveRuntimeCurrentAccount(
		storage,
		{
			runtimeSnapshot,
			appBindStatus: appBindStatus?.running ? appBindStatus.router : null,
			appHelperStatus: appRuntimeHelperStatusToRuntimeSignal(helperStatus),
		},
		{ now },
	);
	logInfo(`Accounts: ${storage.accounts.length}`);
	for (let index = 0; index < storage.accounts.length; index += 1) {
		const account = storage.accounts[index];
		if (!account) continue;
		const markers: string[] = [];
		markers.push(...resolveAccountCurrentMarkers(index, activeIndex, runtimeCurrent));
		if (account.enabled === false) markers.push("disabled");
		const cooldown = formatCooldown(account, now);
		if (cooldown) markers.push(`cooldown:${cooldown}`);
		const rateLimitResetTimes = Object.values(account.rateLimitResetTimes ?? {})
			.filter((value): value is number => typeof value === "number")
			.filter((value) => value > now);
		if (rateLimitResetTimes.length > 0) {
			const waitMs = Math.min(...rateLimitResetTimes) - now;
			markers.push(`rate-limited:${formatWaitTime(waitMs)}`);
		}
		const quotaEntry = findQuotaCacheEntryForAccount(
			quotaCache,
			account,
			storage.accounts,
		);
		if (
			quotaEntry?.status === 429 &&
			!markers.some((marker) => isRateLimitedMarker(marker))
		) {
			markers.push("rate-limited");
		}
		if (isQuotaCacheEntryExhausted(quotaEntry, now)) {
			markers.push("quota-exhausted");
		}
		const markerLabel = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
		logInfo(`${index + 1}. ${formatAccountLabel(account, index)}${markerLabel}`);
	}

	return 0;
}

export async function runRotationCommand(
	args: string[],
	deps: RotationCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const [subcommand, ...rest] = args;
	if (!subcommand || subcommand === "status") {
		if (rest.length > 0) {
			logError(`Unknown rotation status option: ${rest[0]}`);
			return 1;
		}
		return printRotationStatus(deps);
	}
	if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
		printRotationUsage(logInfo);
		return 0;
	}
	if (subcommand === "reset-rate-limits") {
		return runResetRateLimits(rest, deps);
	}
	if (rest.length > 0) {
		logError(`Unknown rotation option: ${rest[0]}`);
		return 1;
	}
	if (subcommand === "enable") {
		await deps.savePluginConfig({ codexRuntimeRotationProxy: true });
		logInfo("Runtime rotation proxy enabled.");
		logInfo("New Codex sessions will route Responses traffic through the localhost proxy.");
		if (deps.bindCodexApp && shouldAutoBindCodexApp()) {
			try {
				const result = await deps.bindCodexApp();
				logInfo(result.message);
				logInfo(formatAppBindStatus(result.status));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logError(`Codex app bind failed: ${message}`);
				logInfo("Wrapper-launched CLI and app sessions still use runtime rotation.");
			}
		}
		return 0;
	}
	if (subcommand === "disable") {
		await deps.savePluginConfig({ codexRuntimeRotationProxy: false });
		logInfo("Runtime rotation proxy disabled.");
		if (deps.unbindCodexApp) {
			try {
				const result = await deps.unbindCodexApp();
				logInfo(result.message);
				logInfo(formatAppBindStatus(result.status));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logError(`Codex app unbind failed: ${message}`);
				return 1;
			}
		}
		return 0;
	}
	if (subcommand === "bind-app") {
		if (!deps.bindCodexApp) {
			logError("Codex app bind is unavailable in this build.");
			return 1;
		}
		const result = await deps.bindCodexApp();
		logInfo(result.message);
		logInfo(formatAppBindStatus(result.status));
		return 0;
	}
	if (subcommand === "unbind-app") {
		if (!deps.unbindCodexApp) {
			logError("Codex app bind is unavailable in this build.");
			return 1;
		}
		const result = await deps.unbindCodexApp();
		logInfo(result.message);
		logInfo(formatAppBindStatus(result.status));
		return 0;
	}

	logError(`Unknown rotation command: ${subcommand}`);
	printRotationUsage(logInfo);
	return 1;
}
