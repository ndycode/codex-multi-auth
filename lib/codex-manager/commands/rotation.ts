import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatAccountLabel, formatCooldown, formatWaitTime } from "../../accounts.js";
import { getCodexMultiAuthDir } from "../../runtime-paths.js";
import type { PluginConfig } from "../../types.js";
import type { AccountStorageV3 } from "../../storage.js";

type LoadedStorage = AccountStorageV3 | null;
const APP_RUNTIME_HELPER_STATUS_FILE = "runtime-rotation-app-helper.json";

interface AppRuntimeHelperStatus {
	state: string | null;
	pid: number | null;
	idleExpiresAt: number | null;
	totalRequests: number | null;
	rotations: number | null;
	lastAccountIndex: number | null;
	updatedAt: number | null;
}

export interface RotationCommandDeps {
	loadPluginConfig: () => PluginConfig;
	savePluginConfig: (config: Partial<PluginConfig>) => Promise<void>;
	getCodexRuntimeRotationProxy: (config: PluginConfig) => boolean;
	loadAccounts: () => Promise<LoadedStorage>;
	resolveActiveIndex: (storage: AccountStorageV3) => number;
	getStoragePath: () => string | null;
	setStoragePath: (path: string | null) => void;
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
			"",
			"Behavior:",
			"  - Enables an opt-in localhost Responses proxy for live Codex runtime account rotation",
			"  - Env override: CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=1",
		].join("\n"),
	);
}

function parseBooleanEnv(value: string | undefined): boolean | null {
	if (value === undefined || value.trim().length === 0) return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes") {
		return true;
	}
	if (normalized === "0" || normalized === "false" || normalized === "no") {
		return false;
	}
	return null;
}

function formatEnvOverride(): string {
	const raw = process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY;
	if (raw === undefined || raw.trim().length === 0) return "none";
	const parsed = parseBooleanEnv(raw);
	if (parsed === null) return `invalid (${raw})`;
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
			pid: readOptionalNumber(parsed, "pid"),
			idleExpiresAt: readOptionalNumber(parsed, "idleExpiresAt"),
			totalRequests: readOptionalNumber(parsed, "totalRequests"),
			rotations: readOptionalNumber(parsed, "rotations"),
			lastAccountIndex: readOptionalNumber(parsed, "lastAccountIndex"),
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

function formatAppRuntimeHelperStatus(now: number): string {
	const status = readAppRuntimeHelperStatus();
	if (!status) return "Codex app helper: not running";
	const alive = isProcessAlive(status.pid);
	if (!alive || status.state === "stopped" || status.state === "idle-timeout") {
		return "Codex app helper: not running";
	}
	const parts = [`running${status.pid ? ` pid=${status.pid}` : ""}`];
	if (status.totalRequests !== null) parts.push(`requests=${status.totalRequests}`);
	if (status.rotations !== null) parts.push(`rotations=${status.rotations}`);
	if (status.lastAccountIndex !== null) {
		parts.push(`lastAccount=${status.lastAccountIndex + 1}`);
	}
	if (status.idleExpiresAt !== null && status.idleExpiresAt > now) {
		parts.push(`idle-expires=${formatWaitTime(status.idleExpiresAt - now)}`);
	}
	return `Codex app helper: ${parts.join(", ")}`;
}

async function printRotationStatus(deps: RotationCommandDeps): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	deps.setStoragePath(null);
	const config = deps.loadPluginConfig();
	const enabled = deps.getCodexRuntimeRotationProxy(config);
	const storage = await deps.loadAccounts();
	const now = deps.getNow?.() ?? Date.now();

	logInfo(`Runtime rotation proxy: ${enabled ? "enabled" : "disabled"}`);
	logInfo(
		`Stored setting: ${config.codexRuntimeRotationProxy === true ? "enabled" : "disabled"}`,
	);
	logInfo(`Env override: ${formatEnvOverride()}`);
	logInfo(formatAppRuntimeHelperStatus(now));
	logInfo(`Storage: ${deps.getStoragePath()}`);

	if (!storage || storage.accounts.length === 0) {
		logInfo("Accounts: none configured");
		return 0;
	}

	const activeIndex = deps.resolveActiveIndex(storage);
	logInfo(`Accounts: ${storage.accounts.length}`);
	for (let index = 0; index < storage.accounts.length; index += 1) {
		const account = storage.accounts[index];
		if (!account) continue;
		const markers: string[] = [];
		if (index === activeIndex) markers.push("current");
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
	if (rest.length > 0) {
		logError(`Unknown rotation option: ${rest[0]}`);
		return 1;
	}
	if (subcommand === "enable") {
		await deps.savePluginConfig({ codexRuntimeRotationProxy: true });
		logInfo("Runtime rotation proxy enabled.");
		logInfo("New Codex sessions will route Responses traffic through the localhost proxy.");
		return 0;
	}
	if (subcommand === "disable") {
		await deps.savePluginConfig({ codexRuntimeRotationProxy: false });
		logInfo("Runtime rotation proxy disabled.");
		return 0;
	}

	logError(`Unknown rotation command: ${subcommand}`);
	printRotationUsage(logInfo);
	return 1;
}
