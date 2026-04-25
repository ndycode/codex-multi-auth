import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";
import { getCodexCacheDir } from "./runtime-paths.js";

const log = createLogger("update-checker");

const PACKAGE_NAME = "codex-multi-auth";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_DIR = getCodexCacheDir();
const CACHE_FILE = join(CACHE_DIR, "update-check-cache.json");
const AUTO_UPDATE_LOCK_DIR = join(CACHE_DIR, "auto-update.lock");
const AUTO_UPDATE_LOCK_OWNER_FILE = join(AUTO_UPDATE_LOCK_DIR, "owner.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const AUTO_UPDATE_TIMEOUT_MS = 2 * 60 * 1000;
const AUTO_UPDATE_LOCK_STALE_MS = 10 * 60 * 1000;
const TASKKILL_TIMEOUT_MS = 5_000;
const AUTO_UPDATE_ENV_NAME = "CODEX_MULTI_AUTH_AUTO_UPDATE";
const TRUE_VALUES = new Set(["1", "true", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "no"]);
const SAFE_SUBPROCESS_ENV_KEYS = new Set([
	"APPDATA",
	"COMSPEC",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"WINDIR",
]);
const SENSITIVE_SUBPROCESS_ENV_KEY_PATTERN =
	/(?:AUTH|COOKIE|CREDENTIAL|OPENAI|CHATGPT|PASSWORD|SECRET|SESSION|TOKEN)/i;
const CI_ENV_KEYS = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"BUILDKITE",
	"TF_BUILD",
	"TEAMCITY_VERSION",
	"JENKINS_URL",
	"TRAVIS",
	"APPVEYOR",
	"BITBUCKET_BUILD_NUMBER",
	"VITEST",
];

interface UpdateCheckCache {
  lastCheck: number;
  latestVersion: string | null;
  currentVersion: string;
}

interface NpmPackageInfo {
  version: string;
  name: string;
}

interface ParsedSemver {
  core: [number, number, number];
  prerelease: string[];
}

const RETRYABLE_WRITE_ERRORS = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
let updateCacheWriteQueue: Promise<void> = Promise.resolve();
let cachedPackageRoot: string | undefined;

function enqueueUpdateCacheWrite(writeTask: () => void): Promise<void> {
	const queued = updateCacheWriteQueue.catch(() => undefined).then(writeTask);
	updateCacheWriteQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}

function writeCacheContents(serialized: string): void {
	let tempPath: string | null = null;
	let wroteTemp = false;
	try {
		if (!existsSync(CACHE_DIR)) {
			mkdirSync(CACHE_DIR, { recursive: true });
		}
		tempPath = `${CACHE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		let lastError: Error | null = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				writeFileSync(tempPath, serialized, "utf8");
				renameSync(tempPath, CACHE_FILE);
				wroteTemp = false;
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "";
				lastError = error as Error;
				wroteTemp = true;
				if (!RETRYABLE_WRITE_ERRORS.has(code) || attempt >= 3) {
					throw error;
				}
				sleepSync(15 * (2 ** attempt));
			}
		}
		if (lastError) throw lastError;
	} finally {
		if (wroteTemp && tempPath) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Best effort temp cleanup.
			}
		}
	}
}

function sleepSync(ms: number): void {
  const delay = Math.max(0, Math.floor(ms));
  if (delay === 0) return;
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, delay);
}

function getCurrentVersion(): string {
  try {
    const packageJsonPath = join(getPackageRoot(), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
    return packageJson.version;
  } catch (error) {
    log.debug("Failed to read current package version", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "0.0.0";
  }
}

function loadCache(): UpdateCheckCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const content = readFileSync(CACHE_FILE, "utf8");
    return JSON.parse(content) as UpdateCheckCache;
  } catch (error) {
    log.debug("Failed to load update cache", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function saveCache(cache: UpdateCheckCache): Promise<void> {
	await enqueueUpdateCacheWrite(() => {
		try {
			writeCacheContents(JSON.stringify(cache, null, 2));
		} catch (error) {
			log.warn("Failed to save update cache", { error: (error as Error).message });
		}
	});
}

function parseSemver(version: string): ParsedSemver {
  const normalized = version.trim().replace(/^v/i, "");
  const [withoutBuild] = normalized.split("+");
  const [corePart = "0.0.0", prereleasePart] = (withoutBuild ?? "0.0.0").split("-", 2);
  const [majorRaw = "0", minorRaw = "0", patchRaw = "0"] = corePart.split(".");

  const toSafeInt = (value: string): number => {
    if (!/^\d+$/.test(value)) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    core: [toSafeInt(majorRaw), toSafeInt(minorRaw), toSafeInt(patchRaw)],
    prerelease:
      prereleasePart && prereleasePart.trim().length > 0
        ? prereleasePart.split(".").filter((segment) => segment.length > 0)
        : [],
  };
}

function comparePrerelease(current: string[], latest: string[]): number {
  const maxLen = Math.max(current.length, latest.length);

  for (let i = 0; i < maxLen; i++) {
    const currentPart = current[i];
    const latestPart = latest[i];

    if (currentPart === undefined && latestPart === undefined) return 0;
    if (currentPart === undefined) return 1;
    if (latestPart === undefined) return -1;

    if (currentPart === latestPart) continue;

    const currentIsNumeric = /^\d+$/.test(currentPart);
    const latestIsNumeric = /^\d+$/.test(latestPart);

    if (currentIsNumeric && latestIsNumeric) {
      const currentNum = Number.parseInt(currentPart, 10);
      const latestNum = Number.parseInt(latestPart, 10);
      if (latestNum > currentNum) return 1;
      if (latestNum < currentNum) return -1;
      continue;
    }

    if (currentIsNumeric && !latestIsNumeric) return 1;
    if (!currentIsNumeric && latestIsNumeric) return -1;

    const lexical = latestPart.localeCompare(currentPart, "en", { sensitivity: "case" });
    if (lexical > 0) return 1;
    if (lexical < 0) return -1;
  }

  return 0;
}

function compareVersions(current: string, latest: string): number {
  const parsedCurrent = parseSemver(current);
  const parsedLatest = parseSemver(latest);

  for (let i = 0; i < parsedCurrent.core.length; i++) {
    const currentPart = parsedCurrent.core[i] ?? 0;
    const latestPart = parsedLatest.core[i] ?? 0;
    if (latestPart > currentPart) return 1;
    if (latestPart < currentPart) return -1;
  }

  const currentHasPrerelease = parsedCurrent.prerelease.length > 0;
  const latestHasPrerelease = parsedLatest.prerelease.length > 0;

  if (!currentHasPrerelease && latestHasPrerelease) {
    return -1;
  }
  if (currentHasPrerelease && !latestHasPrerelease) {
    return 1;
  }

  return comparePrerelease(parsedCurrent.prerelease, parsedLatest.prerelease);
}

async function fetchLatestVersion(
	timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.debug("Failed to fetch npm registry", { status: response.status });
      return null;
    }

    const data = (await response.json()) as NpmPackageInfo;
    return data.version ?? null;
  } catch (error) {
    log.debug("Failed to check for updates", { error: (error as Error).message });
    return null;
  }
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateCommand: string;
}

export interface AutoUpdateResult extends UpdateCheckResult {
	checked: boolean;
	updated: boolean;
	reason:
		| "disabled"
		| "not-updateable-install"
		| "already-running"
		| "current"
		| "updated"
		| "update-failed";
	exitCode: number | null;
	error: string | null;
}

export interface AutoUpdateOptions {
	env?: NodeJS.ProcessEnv;
	forceCheck?: boolean;
	forceInstall?: boolean;
	npmCommand?: string;
	packageRoot?: string;
	platform?: NodeJS.Platform;
	fetchTimeoutMs?: number;
	timeoutMs?: number;
	onUpdateStart?: (result: UpdateCheckResult) => void;
}

function readOptionalBoolean(value: string | undefined): boolean | null {
	if (value === undefined || value.trim().length === 0) return null;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return null;
}

function isCiOrTestEnvironment(env: NodeJS.ProcessEnv): boolean {
	return CI_ENV_KEYS.some((key) => {
		const value = env[key];
		if (value === undefined || value.trim().length === 0) return false;
		const parsed = readOptionalBoolean(value);
		return parsed !== false;
	});
}

export function isAutoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const override = readOptionalBoolean(env[AUTO_UPDATE_ENV_NAME]);
	if (override !== null) return override;
	return !isCiOrTestEnvironment(env);
}

function getModuleDir(): string {
	const moduleDir =
		typeof import.meta.dirname === "string"
			? import.meta.dirname
			: dirname(fileURLToPath(import.meta.url));
	return moduleDir;
}

export function resolvePackageRootFromModuleDir(moduleDir: string): string {
	let current = moduleDir;
	for (let depth = 0; depth < 8; depth++) {
		const packageJsonPath = join(current, "package.json");
		try {
			if (existsSync(packageJsonPath)) {
				const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
					name?: string;
				};
				if (packageJson.name === PACKAGE_NAME) return current;
			}
		} catch {
			// Keep walking; malformed or unreadable package metadata should not break startup.
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return join(moduleDir, "..");
}

function getPackageRoot(): string {
	cachedPackageRoot ??= resolvePackageRootFromModuleDir(getModuleDir());
	return cachedPackageRoot;
}

export function isUpdateablePackageInstall(
	packageRoot = getPackageRoot(),
): boolean {
	const normalized = packageRoot.replace(/\\/g, "/").toLowerCase();
	return normalized.endsWith("/node_modules/codex-multi-auth");
}

function resolveNpmCommand(platform: NodeJS.Platform): string {
	return platform === "win32" ? "npm.cmd" : "npm";
}

function quoteCmdArg(value: string): string {
	if (!/[\s&|<>^"]/.test(value)) return value;
	return `"${value.replace(/"/g, '""')}"`;
}

function isSensitiveSubprocessEnvKey(key: string): boolean {
	return SENSITIVE_SUBPROCESS_ENV_KEY_PATTERN.test(key);
}

function isSafeSubprocessEnvKey(key: string): boolean {
	const normalized = key.toUpperCase();
	if (SAFE_SUBPROCESS_ENV_KEYS.has(normalized)) return true;
	return normalized.startsWith("NPM_CONFIG_");
}

function buildAutoUpdateSubprocessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const mergedEnv = { ...process.env, ...env };
	const subprocessEnv: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(mergedEnv)) {
		if (value === undefined) continue;
		if (isSensitiveSubprocessEnvKey(key)) continue;
		if (!isSafeSubprocessEnvKey(key)) continue;
		subprocessEnv[key] = value;
	}
	subprocessEnv[AUTO_UPDATE_ENV_NAME] = "0";
	return subprocessEnv;
}

function resolveUpdateSpawn(options: {
	command: string;
	platform: NodeJS.Platform;
}): { command: string; args: string[] } {
	const args = ["update", "-g", PACKAGE_NAME];
	if (options.platform !== "win32") {
		return { command: options.command, args };
	}
	return {
		command: process.env.ComSpec || "cmd.exe",
		args: [
			"/d",
			"/s",
			"/c",
			[options.command, ...args].map(quoteCmdArg).join(" "),
		],
	};
}

async function runUpdateCommand(options: {
	command: string;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	timeoutMs: number;
}): Promise<{ ok: boolean; exitCode: number | null; error: string | null }> {
	return new Promise((resolve) => {
		let settled = false;
		let child: ReturnType<typeof spawn> | null = null;
		const updateSpawn = resolveUpdateSpawn({
			command: options.command,
			platform: options.platform,
		});
		function finish(result: {
			ok: boolean;
			exitCode: number | null;
			error: string | null;
		}) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		}
		let timeoutStarted = false;
		const timeout = setTimeout(() => {
			timeoutStarted = true;
			void killUpdateProcessTree(child, options.platform)
				.catch(() => undefined)
				.finally(() => {
					finish({
						ok: false,
						exitCode: null,
						error: `Auto-update timed out after ${options.timeoutMs}ms`,
					});
				});
		}, options.timeoutMs);
		timeout.unref?.();
		try {
			child = spawn(updateSpawn.command, updateSpawn.args, {
				env: buildAutoUpdateSubprocessEnv(options.env),
				stdio: "ignore",
				windowsHide: options.platform === "win32",
			});
			child.unref?.();
		} catch (error) {
			finish({
				ok: false,
				exitCode: null,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		child.once("error", (error) => {
			finish({
				ok: false,
				exitCode: null,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		child.once("exit", (code, signal) => {
			if (timeoutStarted) return;
			finish({
				ok: code === 0,
				exitCode: code,
				error:
					code === 0
						? null
						: `npm update exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
			});
		});
	});
}

async function killUpdateProcessTree(
	child: ReturnType<typeof spawn> | null,
	platform: NodeJS.Platform,
): Promise<void> {
	if (!child) return;
	if (platform === "win32" && child.pid) {
		const killed = await taskkillProcessTree(child.pid);
		if (!killed) {
			child.kill();
		}
		return;
	}
	child.kill();
}

function taskkillProcessTree(pid: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		function finish(killed: boolean): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(killed);
		}

		const timeout = setTimeout(() => finish(false), TASKKILL_TIMEOUT_MS);
		timeout.unref?.();
		try {
			const killer = spawn(
				"taskkill",
				["/PID", String(pid), "/T", "/F"],
				{
					stdio: "ignore",
					windowsHide: true,
				},
			);
			killer.once("error", () => finish(false));
			killer.once("exit", (code) => finish(code === 0));
		} catch {
			finish(false);
			return;
		}
	});
}

function removeAutoUpdateLockDirectory(): void {
	try {
		unlinkSync(AUTO_UPDATE_LOCK_OWNER_FILE);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "";
		if (code !== "ENOENT") {
			log.debug("Failed to remove auto-update lock owner", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	let lastError: Error | null = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			rmdirSync(AUTO_UPDATE_LOCK_DIR);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			lastError = error as Error;
			if (!RETRYABLE_WRITE_ERRORS.has(code) || attempt >= 3) {
				break;
			}
			sleepSync(15 * (2 ** attempt));
		}
	}
	if (lastError) {
		log.debug("Failed to remove auto-update lock", { error: lastError.message });
	}
}

function isAutoUpdateLockStale(now = Date.now()): boolean {
	try {
		const stats = statSync(AUTO_UPDATE_LOCK_DIR);
		const ownerPid = readAutoUpdateLockOwnerPid();
		if (ownerPid !== null) {
			return !isProcessAlive(ownerPid);
		}
		return now - stats.mtimeMs > AUTO_UPDATE_LOCK_STALE_MS;
	} catch {
		return true;
	}
}

function readAutoUpdateLockOwnerPid(): number | null {
	try {
		const parsed = JSON.parse(
			readFileSync(AUTO_UPDATE_LOCK_OWNER_FILE, "utf8"),
		) as unknown;
		if (!parsed || typeof parsed !== "object" || !("pid" in parsed)) {
			return null;
		}
		const pid = (parsed as { pid?: unknown }).pid;
		return typeof pid === "number" && Number.isInteger(pid) && pid > 0
			? pid
			: null;
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		return code === "EPERM";
	}
}

function writeAutoUpdateLockOwner(): void {
	writeFileSync(
		AUTO_UPDATE_LOCK_OWNER_FILE,
		`${JSON.stringify({
			pid: process.pid,
			startedAt: new Date().toISOString(),
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	try {
		chmodSync(AUTO_UPDATE_LOCK_OWNER_FILE, 0o600);
	} catch {
		// Best-effort only; permissions vary by platform and filesystem.
	}
}

function acquireAutoUpdateLock(): (() => void) | null {
	try {
		if (!existsSync(CACHE_DIR)) {
			mkdirSync(CACHE_DIR, { recursive: true });
		}
	} catch (error) {
		log.debug("Failed to prepare auto-update lock directory", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(AUTO_UPDATE_LOCK_DIR);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (code === "EEXIST" && isAutoUpdateLockStale()) {
				removeAutoUpdateLockDirectory();
				continue;
			}
			if (code !== "EEXIST") {
				log.debug("Failed to acquire auto-update lock", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return null;
		}

		try {
			writeAutoUpdateLockOwner();
			return removeAutoUpdateLockDirectory;
		} catch (error) {
			removeAutoUpdateLockDirectory();
			log.debug("Failed to write auto-update lock owner", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	return null;
}

function notifyUpdateStart(
	callback: AutoUpdateOptions["onUpdateStart"],
	result: UpdateCheckResult,
): void {
	if (!callback) return;
	try {
		callback(result);
	} catch (error) {
		log.debug("Auto-update start callback failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function checkForUpdates(
	force = false,
	fetchTimeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion();
  const cache = loadCache();
  const now = Date.now();

  if (!force && cache && now - cache.lastCheck < CHECK_INTERVAL_MS) {
    const hasUpdate = cache.latestVersion ? compareVersions(currentVersion, cache.latestVersion) > 0 : false;
    return {
      hasUpdate,
      currentVersion,
      latestVersion: cache.latestVersion,
      updateCommand: `npm update -g ${PACKAGE_NAME}`,
    };
  }

  const latestVersion = await fetchLatestVersion(fetchTimeoutMs);

	await saveCache({
		lastCheck: now,
		latestVersion,
		currentVersion,
	});

  const hasUpdate = latestVersion ? compareVersions(currentVersion, latestVersion) > 0 : false;

  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    updateCommand: `npm update -g ${PACKAGE_NAME}`,
  };
}

export async function autoUpdateIfAvailable(
	options: AutoUpdateOptions = {},
): Promise<AutoUpdateResult> {
	const env = options.env ?? process.env;
	const currentVersion = getCurrentVersion();
	const npmCommand =
		options.npmCommand ?? resolveNpmCommand(options.platform ?? process.platform);
	const skipped = (
		reason: AutoUpdateResult["reason"],
	): AutoUpdateResult => ({
		checked: false,
		updated: false,
		reason,
		exitCode: null,
		error: null,
		hasUpdate: false,
		currentVersion,
		latestVersion: null,
		updateCommand: `npm update -g ${PACKAGE_NAME}`,
	});

	if (!isAutoUpdateEnabled(env)) {
		return skipped("disabled");
	}

	if (
		!options.forceInstall &&
		!isUpdateablePackageInstall(options.packageRoot ?? getPackageRoot())
	) {
		return skipped("not-updateable-install");
	}

	const result = await checkForUpdates(
		options.forceCheck ?? false,
		options.fetchTimeoutMs,
	);
	if (!result.hasUpdate || !result.latestVersion) {
		return {
			...result,
			checked: true,
			updated: false,
			reason: "current",
			exitCode: null,
			error: null,
		};
	}

	const releaseLock = acquireAutoUpdateLock();
	if (!releaseLock) {
		return {
			...result,
			checked: true,
			updated: false,
			reason: "already-running",
			exitCode: null,
			error: null,
		};
	}

	try {
		notifyUpdateStart(options.onUpdateStart, result);
		const updateResult = await runUpdateCommand({
			command: npmCommand,
			env,
			platform: options.platform ?? process.platform,
			timeoutMs: options.timeoutMs ?? AUTO_UPDATE_TIMEOUT_MS,
		});
		if (!updateResult.ok) {
			log.warn("Auto-update failed", { error: updateResult.error });
			return {
				...result,
				checked: true,
				updated: false,
				reason: "update-failed",
				exitCode: updateResult.exitCode,
				error: updateResult.error,
			};
		}

		log.info(`Auto-updated ${PACKAGE_NAME} to v${result.latestVersion}`);
		return {
			...result,
			checked: true,
			updated: true,
			reason: "updated",
			exitCode: updateResult.exitCode,
			error: null,
		};
	} finally {
		releaseLock();
	}
}

export async function checkAndNotify(
  showToast?: (message: string, variant: "info" | "warning") => Promise<void>,
): Promise<void> {
  try {
    const result = await checkForUpdates();

    if (result.hasUpdate && result.latestVersion) {
      const message = `Update available: ${PACKAGE_NAME} v${result.latestVersion} (current: v${result.currentVersion})`;
      log.info(message);

      if (showToast) {
        await showToast(
          `Plugin update available: v${result.latestVersion}. Run: ${result.updateCommand}`,
          "info",
        );
      }
    }
  } catch (error) {
    log.debug("Update check failed", { error: (error as Error).message });
  }
}

export function clearUpdateCache(): void {
	void enqueueUpdateCacheWrite(() => {
		try {
			if (existsSync(CACHE_FILE)) {
				writeCacheContents("{}");
			}
		} catch {
			// Ignore errors
		}
	});
}
