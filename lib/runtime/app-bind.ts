import { withNativeBindingLock } from "./native-binding-lock.js";
import { isRecord } from "../utils.js";
import { hasNativeProviderConfig, rewriteNativeProviderConfig, restoreNativeProviderConfig } from "./native-provider-config.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { withFileOperationRetry } from "../fs-retry.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import {
	APP_RUNTIME_HELPER_OWNER_FILE,
	listRuntimeHelperOwnerPaths,
	listRuntimeHelperStatusPaths,
} from "../runtime-constants.js";
import {
	configHasRuntimeRotationProvider,
	restoreConfigTomlFromRuntimeRotationProvider,
	restoreConfigTomlFromRuntimeRotationProviderWithoutBackup,
	rewriteConfigTomlForRuntimeRotationProvider,
} from "./config-toml.js";

const APP_BIND_DIR_NAME = "app-bind";
const APP_BIND_STATE_FILE = "runtime-rotation-app-bind.json";
const APP_BIND_BACKUP_FILE = "codex-config-backup.json";
const RUNTIME_ROTATION_APP_HELPER_ARG =
	"--codex-multi-auth-runtime-app-helper";
const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 5_000;
const PROCESS_START_TIME_TOLERANCE_MS = 5_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const APP_BIND_STATUS_FILE = "runtime-rotation-app-bind-status.json";
const WINDOWS_STARTUP_FILE = "Codex Multi Auth Runtime Router.cmd";
const MACOS_LAUNCH_AGENT_ID = "com.ndycode.codex-multi-auth.runtime-router";
const DEFAULT_ROUTER_READY_TIMEOUT_MS = 15_000;
const ROUTER_STATUS_POLL_INTERVAL_MS = 100;
const APP_ROUTER_MAX_LOG_BYTES = 1024 * 1024;
const appBindLocks = new Map<string, Promise<void>>();

export interface AppBindPaths {
	codexHome: string;
	configPath: string;
	bindDir: string;
	statePath: string;
	backupPath: string;
	statusPath: string;
	logPath: string;
	routerScriptPath: string;
	startupPath: string | null;
	launchAgentPath: string | null;
}

interface AppBindBackup {
	version: 1;
	configPath: string;
	existed: boolean;
	content: string;
	createdAt: number;
}

export interface AppBindState {
	nativeOpenai?: boolean;
	catalogAccount?: { email: string; accountId: string; };
	version: 1;
	platform: NodeJS.Platform;
	host: string;
	port: number;
	baseUrl: string;
	configPath: string;
	statePath: string;
	backupPath: string;
	statusPath: string;
	logPath: string;
	nodePath: string;
	routerScriptPath: string;
	clientApiKey: string;
	/** Per-bind nonce passed to the router command line for PID ownership checks. */
	identityToken?: string;
	startupPath: string | null;
	launchAgentPath: string | null;
	boundConfigHash: string;
	updatedAt: number;
}

export interface AppBindRouterStatus {
	state: string | null;
	pid: number | null;
	startedAt?: number | null;
	/** Internal path of the status file used to verify the owning command line. */
	statusPath?: string | null;
	/** Full router script path persisted by newer router processes. */
	routerScriptPath?: string | null;
	/** Per-process nonce echoed by the router command line. */
	identityToken?: string | null;
	baseUrl: string | null;
	totalRequests: number | null;
	lastAccountIndex: number | null;
	lastAccountLabel: string | null;
	lastAccountEmail: string | null;
	lastAccountId: string | null;
	updatedAt: number | null;
	lastError: string | null;
}

export interface AppBindStatus {
	bound: boolean;
	running: boolean;
	/**
	 * True when config.toml is bound to the runtime proxy but the app-bind state
	 * file is gone (orphaned bind, #614). In this case `bound` is also true and
	 * `state` is null — the config needs `unbind-app` to recover even though the
	 * normal state-file tracking is missing.
	 */
	unmanagedBind: boolean;
	state: AppBindState | null;
	router: AppBindRouterStatus | null;
	paths: AppBindPaths;
}

export interface AppBindResult {
	status: AppBindStatus;
	message: string;
}

export type ProcessIdentityVerifier = (
	pid: number,
	startedAt: number,
	platform: NodeJS.Platform,
	identityToken?: string,
) => boolean | Promise<boolean>;

export interface AppBindOptions {
	nativeOpenai?: boolean;
	catalogAccount?: { email: string; accountId: string; };
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
	now?: () => number;
	nodePath?: string;
	routerScriptPath?: string;
	routerScriptCandidates?: string[];
	spawnDetached?: boolean;
	routerReadyTimeoutMs?: number;
	log?: (message: string) => void;
	/** Test/integration seam for deterministic ownership verification. */
	verifyProcessIdentity?: ProcessIdentityVerifier;
}

export interface DetachedProcessStopOptions {
	gracefulTimeoutMs?: number;
	pollIntervalMs?: number;
	isAlive?: (pid: number) => boolean;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	runWindowsTaskkill?: (pid: number) => Promise<boolean | void>;
	log?: (message: string) => void;
	/** Expected per-process nonce when verifying a persisted PID. */
	identityToken?: string;
	verifyProcessIdentity?: ProcessIdentityVerifier;
	/** Called once the recorded PID is verified as this router, before it is stopped. */
	onOwnershipVerified?: () => void;
}

export interface RuntimeRotationAppHelperStatus {
	state: string | null;
	kind: string | null;
	pid: number | null;
	startedAt: number | null;
	/** Full wrapper script path persisted by newer helper processes. */
	scriptPath?: string | null;
	/** Per-process nonce echoed by the helper command line. */
	identityToken?: string | null;
}

interface RuntimeRotationAppHelperOwner {
	kind: string;
	identityToken: string;
}

// Per-key mutex. `tail` resolves only after `current` resolves, so each
// caller waits for the previous holder to call releaseCurrent(). The map
// check and optional delete run synchronously after releaseCurrent() with no
// await between them — JS's single-threaded event loop guarantees no other
// caller can modify the map entry in that window. If a later caller has
// already replaced the entry, the identity check is false and the chain is
// preserved.
async function withAppBindLock<T>(
	key: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = appBindLocks.get(key) ?? Promise.resolve();
	let releaseCurrent: () => void = () => undefined;
	const current = new Promise<void>((resolve) => {
		releaseCurrent = resolve;
	});
	const tail = previous.catch(() => undefined).then(() => current);
	appBindLocks.set(key, tail);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		releaseCurrent();
		if (appBindLocks.get(key) === tail) {
			appBindLocks.delete(key);
		}
	}
}

export function rewriteConfigTomlForAppBind(
	rawConfig: string,
	baseUrl: string,
	clientApiKey = "",
	nativeOpenai = false,
): string {
	if (nativeOpenai) return rewriteNativeProviderConfig(rawConfig, baseUrl);
	return rewriteConfigTomlForRuntimeRotationProvider(
		rawConfig,
		baseUrl,
		clientApiKey,
	);
}

export function restoreConfigTomlFromAppBind(currentConfig: string, originalConfig: string): string {
	return restoreConfigTomlFromRuntimeRotationProvider(
		restoreNativeProviderConfig(currentConfig, originalConfig),
		originalConfig,
	);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function createAppBindClientApiKey(): string {
	return randomBytes(32).toString("hex");
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch {
		// Directory fsync is not portable; the file-level fsync still guards contents.
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function atomicWriteFile(
	target: string,
	content: string,
	mode = 0o600,
): Promise<void> {
	await withFileOperationRetry(async () => {
		await mkdir(dirname(target), { recursive: true });
		const tempPath = join(
			dirname(target),
			[
				`.${basename(target)}`,
				String(process.pid),
				String(Date.now()),
				randomBytes(4).toString("hex"),
				"tmp",
			].join("."),
		);
		let moved = false;
		let handle: Awaited<ReturnType<typeof open>> | null = null;
		try {
			handle = await open(tempPath, "w", mode);
			await handle.writeFile(content, "utf8");
			await handle.sync();
			await handle.close();
			handle = null;
			await rename(tempPath, target);
			moved = true;
			await syncDirectoryBestEffort(dirname(target));
		} finally {
			await handle?.close().catch(() => undefined);
			if (!moved) {
				await unlink(tempPath).catch(() => undefined);
			}
		}
	});
}

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await withFileOperationRetry(() => unlink(path));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
}

function readAppBindStateRecord(record: Record<string, unknown>): AppBindState | null {
	const port = readNumber(record, "port");
	const host = readString(record, "host");
	const baseUrl = readString(record, "baseUrl");
	const configPath = readString(record, "configPath");
	const backupPath = readString(record, "backupPath");
	const statePath = readString(record, "statePath");
	const statusPath = readString(record, "statusPath");
	const logPath = readString(record, "logPath");
	const nodePath = readString(record, "nodePath");
	const routerScriptPath = readString(record, "routerScriptPath");
	const clientApiKey = readString(record, "clientApiKey");
	const identityToken = readString(record, "identityToken");
	const boundConfigHash = readString(record, "boundConfigHash");
	const updatedAt = readNumber(record, "updatedAt");
	const platformValue = readString(record, "platform");
	if (
		port === null ||
		!host ||
		!baseUrl ||
		!configPath ||
		!statePath ||
		!backupPath ||
		!statusPath ||
		!logPath ||
		!nodePath ||
		!routerScriptPath ||
		!clientApiKey ||
		!boundConfigHash ||
		updatedAt === null
	) {
		return null;
	}
	return {
		version: 1,
		platform: platformValue ? (platformValue as NodeJS.Platform) : process.platform,
		host,
		port,
		baseUrl,
		configPath,
		statePath,
		backupPath,
		statusPath,
		logPath,
		nodePath,
		routerScriptPath,
		clientApiKey,
		nativeOpenai: record.nativeOpenai === true,
		catalogAccount: isRecord(record.catalogAccount) && typeof record.catalogAccount.email === "string" && typeof record.catalogAccount.accountId === "string" ? { email: record.catalogAccount.email, accountId: record.catalogAccount.accountId } : undefined,
		identityToken: identityToken ?? undefined,
		startupPath: readString(record, "startupPath"),
		launchAgentPath: readString(record, "launchAgentPath"),
		boundConfigHash,
		updatedAt,
	};
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await readFile(path, "utf8");
		return parseJsonRecord(raw);
	} catch {
		return null;
	}
}

async function readAppBindState(path: string): Promise<AppBindState | null> {
	const record = await readJsonFile(path);
	return record ? readAppBindStateRecord(record) : null;
}

async function readAppBindBackup(path: string): Promise<AppBindBackup | null> {
	const record = await readJsonFile(path);
	if (!record) return null;
	const configPath = readString(record, "configPath");
	const content = typeof record.content === "string" ? record.content : null;
	const createdAt = readNumber(record, "createdAt");
	if (!configPath || content === null || createdAt === null) return null;
	return {
		version: 1,
		configPath,
		existed: record.existed === true,
		content,
		createdAt,
	};
}

async function readRouterStatus(path: string): Promise<AppBindRouterStatus | null> {
	const record = await readJsonFile(path);
	if (!record) return null;
	return {
		state: readString(record, "state"),
		pid: readNumber(record, "pid"),
		startedAt: readNumber(record, "startedAt"),
		statusPath: path,
		routerScriptPath: readString(record, "routerScriptPath"),
		identityToken: readString(record, "identityToken"),
		baseUrl: readString(record, "baseUrl"),
		totalRequests: readNumber(record, "totalRequests"),
		lastAccountIndex: readNumber(record, "lastAccountIndex"),
		lastAccountLabel: readString(record, "lastAccountLabel"),
		lastAccountEmail: readString(record, "lastAccountEmail"),
		lastAccountId: readString(record, "lastAccountId"),
		updatedAt: readNumber(record, "updatedAt"),
		lastError: readString(record, "lastError"),
	};
}

function isProcessAlive(pid: number | null): boolean {
	if (!pid || !Number.isInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		return code === "EPERM";
	}
}

function resolveWindowsStartupPath(env: NodeJS.ProcessEnv, home: string): string {
	const appData = (env.APPDATA ?? "").trim() || join(home, "AppData", "Roaming");
	return join(
		appData,
		"Microsoft",
		"Windows",
		"Start Menu",
		"Programs",
		"Startup",
		WINDOWS_STARTUP_FILE,
	);
}

function resolveMacLaunchAgentPath(home: string): string {
	return join(home, "Library", "LaunchAgents", `${MACOS_LAUNCH_AGENT_ID}.plist`);
}

function resolveRouterScriptPath(
	override?: string,
	candidateOverride?: string[],
): string {
	if (override) return override;
	const candidates =
		candidateOverride ?? [
			fileURLToPath(new URL("../../../scripts/codex-app-router.js", import.meta.url)),
			fileURLToPath(new URL("../../scripts/codex-app-router.js", import.meta.url)),
		];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(
		`codex-app-router.js not found; checked: ${candidates.join(", ")}`,
	);
}

export function resolveAppBindPaths(options: AppBindOptions = {}): AppBindPaths {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const codexHome =
		(env.CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME ?? "").trim() || join(home, ".codex");
	const multiAuthDir = (env.CODEX_MULTI_AUTH_DIR ?? "").trim() || getCodexMultiAuthDir();
	const bindDir = join(multiAuthDir, APP_BIND_DIR_NAME);
	return {
		codexHome,
		configPath: join(codexHome, "config.toml"),
		bindDir,
		statePath: join(bindDir, APP_BIND_STATE_FILE),
		backupPath: join(bindDir, APP_BIND_BACKUP_FILE),
		statusPath: join(bindDir, APP_BIND_STATUS_FILE),
		logPath: join(bindDir, "runtime-rotation-app-router.log"),
		routerScriptPath: resolveRouterScriptPath(
			options.routerScriptPath,
			options.routerScriptCandidates,
		),
		startupPath:
			platform === "win32" ? resolveWindowsStartupPath(env, home) : null,
		launchAgentPath: platform === "darwin" ? resolveMacLaunchAgentPath(home) : null,
	};
}

function formatBaseUrl(host: string, port: number): string {
	const normalizedHost =
		host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	return `http://${normalizedHost}:${port}`;
}

function readPortFromBaseUrl(baseUrl: string | null, fallback: number): number {
	if (!baseUrl) return fallback;
	try {
		const port = Number.parseInt(new URL(baseUrl).port, 10);
		return Number.isFinite(port) && port > 0 ? port : fallback;
	} catch {
		return fallback;
	}
}

function escapeWindowsBatchPath(value: string): string {
	return value.replace(/%/g, "%%");
}

function createWindowsStartupCommand(state: AppBindState): string {
	const nodePath = escapeWindowsBatchPath(state.nodePath);
	const routerScriptPath = escapeWindowsBatchPath(state.routerScriptPath);
	const statusPath = escapeWindowsBatchPath(state.statusPath);
	const statePath = escapeWindowsBatchPath(state.statePath);
	const logPath = escapeWindowsBatchPath(state.logPath);
	return [
		"@echo off",
		`"${nodePath}" "${routerScriptPath}" --port ${state.port} --status "${statusPath}" --identity-token "${state.identityToken ?? ""}" --state "${statePath}" --log "${logPath}" --max-log-bytes ${APP_ROUTER_MAX_LOG_BYTES} >> "${logPath}" 2>&1`,
		"",
	].join("\r\n");
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function createMacLaunchAgentPlist(state: AppBindState): string {
	const args = [
		state.nodePath,
		state.routerScriptPath,
		"--port",
		String(state.port),
		"--status",
		state.statusPath,
		"--identity-token",
		state.identityToken ?? "",
		"--state",
		state.statePath,
		"--log",
		state.logPath,
		"--max-log-bytes",
		String(APP_ROUTER_MAX_LOG_BYTES),
	];
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"  <key>Label</key>",
		`  <string>${MACOS_LAUNCH_AGENT_ID}</string>`,
		"  <key>ProgramArguments</key>",
		"  <array>",
		...args.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
		"  </array>",
		"  <key>RunAtLoad</key>",
		"  <true/>",
		"  <key>KeepAlive</key>",
		"  <true/>",
		"  <key>StandardOutPath</key>",
		`  <string>${xmlEscape(state.logPath)}</string>`,
		"  <key>StandardErrorPath</key>",
		`  <string>${xmlEscape(state.logPath)}</string>`,
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

async function writeAppBindStartup(state: AppBindState): Promise<void> {
	if (state.platform === "win32" && state.startupPath) {
		await mkdir(dirname(state.startupPath), { recursive: true });
		await atomicWriteFile(state.startupPath, createWindowsStartupCommand(state));
		return;
	}
	if (state.platform === "darwin" && state.launchAgentPath) {
		await mkdir(dirname(state.launchAgentPath), { recursive: true });
		await atomicWriteFile(state.launchAgentPath, createMacLaunchAgentPlist(state));
	}
}

async function removeAppBindStartup(
	state: Pick<AppBindState, "startupPath" | "launchAgentPath">,
): Promise<void> {
	const candidates = [state.startupPath, state.launchAgentPath].filter(
		(path): path is string => typeof path === "string" && path.length > 0,
	);
	for (const candidate of candidates) {
		try {
			await unlinkIfExists(candidate);
		} catch {
			// Best-effort cleanup.
		}
	}
}

function spawnRouter(state: AppBindState): void {
	mkdirSync(dirname(state.logPath), { recursive: true });
	const logFd = openSync(state.logPath, "a", 0o600);
	try {
		const child = spawn(
			state.nodePath,
			[
				state.routerScriptPath,
				"--port",
				String(state.port),
				"--status",
				state.statusPath,
				"--identity-token",
				state.identityToken ?? "",
				"--state",
				state.statePath,
				"--log",
				state.logPath,
				"--max-log-bytes",
				String(APP_ROUTER_MAX_LOG_BYTES),
			],
			{
				detached: true,
				stdio: ["ignore", logFd, logFd],
				windowsHide: true,
			},
		);
		child.unref();
	} finally {
		closeSync(logFd);
	}
}

/**
 * Whether anything still accepts connections at a recorded router address.
 * Only "refused" is proof that no router serves it; a timeout or an unusable
 * address is "unknown".
 */
export async function probeRouterAddress(baseUrl: string | null | undefined, platform: NodeJS.Platform = process.platform, timeoutMs = platform === "win32" ? WINDOWS_PROCESS_IDENTITY_PROBE_TIMEOUT_MS : 1000): Promise<"refused" | "listening" | "unknown"> {
	let url: URL;
	try { url = new URL(baseUrl ?? ""); } catch { return "unknown"; }
	const port = Number(url.port);
	if (!Number.isInteger(port) || port <= 0) return "unknown";
	return new Promise((resolve) => {
		const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port });
		const done = (result: "refused" | "listening" | "unknown") => { clearTimeout(timer); socket.destroy(); resolve(result); };
		const timer = setTimeout(() => done("unknown"), timeoutMs);
		socket.once("connect", () => done("listening"));
		socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED" ? "refused" : "unknown"));
	});
}

async function maybeStartRouter(state: AppBindState, options: AppBindOptions): Promise<boolean> {
	if (options.spawnDetached === false) return false;
	const router = await readRouterStatus(state.statusPath);
	if (router && isProcessAlive(router.pid) && router.state === "running") return false;
	spawnRouter(state);
	return true;
}

function resolveRouterReadyTimeoutMs(options: AppBindOptions): number {
	const value = options.routerReadyTimeoutMs;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_ROUTER_READY_TIMEOUT_MS;
}

async function waitForRouterStatus(
	statusPath: string,
	timeoutMs: number,
): Promise<AppBindRouterStatus | null> {
	let latest: AppBindRouterStatus | null = null;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const router = await readRouterStatus(statusPath);
		latest = router ?? latest;
		if (router?.state === "error") {
			const suffix = router.lastError ? `: ${router.lastError}` : "";
			throw new Error(`Codex app runtime router failed to start${suffix}`);
		}
		if (router?.state === "running" && isProcessAlive(router.pid)) return router;
		await new Promise((resolve) => setTimeout(resolve, ROUTER_STATUS_POLL_INTERVAL_MS));
	}
	const suffix = latest?.lastError ? `: ${latest.lastError}` : "";
	throw new Error(`Codex app runtime router did not report ready${suffix}`);
}

export async function stopRuntimeRotationRouterProcess(
	router: Pick<
		AppBindRouterStatus,
		| "state"
		| "pid"
		| "startedAt"
		| "updatedAt"
		| "statusPath"
		| "routerScriptPath"
		| "identityToken"
	> | null,
	platform: NodeJS.Platform,
	routerScriptPath: string,
	options: DetachedProcessStopOptions = {},
): Promise<boolean> {
	if (router?.state !== "running" || router.pid === null) {
		return false;
	}
	if (
		router.routerScriptPath &&
		normalizeProcessIdentityPath(router.routerScriptPath, platform) !==
			normalizeProcessIdentityPath(routerScriptPath, platform)
	) {
		return false;
	}
	const startedAt =
		typeof router.startedAt === "number" &&
		Number.isFinite(router.startedAt) &&
		router.startedAt > 0
			? router.startedAt
			: null;
	const updatedAt =
		typeof router.updatedAt === "number" &&
		Number.isFinite(router.updatedAt) &&
		router.updatedAt > 0
			? router.updatedAt
			: null;
	const identityTimestamp = startedAt ?? updatedAt;
	if (identityTimestamp === null) return false;
	const expectedIdentityToken = options.identityToken;
	if (router.identityToken && !expectedIdentityToken) {
		// A tokenized status record must be paired with the trusted token from
		// bind state. The status file alone is mutable by any replacement process.
		return false;
	}
	const verifyProcessIdentity = options.verifyProcessIdentity;
	let verified: boolean;
	if (verifyProcessIdentity) {
		verified = expectedIdentityToken
			? await verifyProcessIdentity(
					router.pid,
				identityTimestamp,
				platform,
				expectedIdentityToken,
			)
			: await verifyProcessIdentity(router.pid, identityTimestamp, platform);
	} else if (startedAt !== null) {
		verified = await verifyRuntimeProcessIdentity(
			router.pid,
			startedAt,
			platform,
			routerScriptPath,
			router.statusPath,
			options.log,
			expectedIdentityToken,
		);
	} else {
		verified = await verifyLegacyRuntimeProcessIdentity(
			router.pid,
			updatedAt as number,
			platform,
			routerScriptPath,
			router.statusPath,
			options.log,
			expectedIdentityToken,
		);
	}
	if (!verified) {
		return false;
	}
	options.onOwnershipVerified?.();
	return stopDetachedProcess(router.pid, platform, options);
}

async function stopRouter(
	router: AppBindRouterStatus | null,
	platform: NodeJS.Platform,
	routerScriptPath: string,
	options: DetachedProcessStopOptions = {},
): Promise<boolean> {
	return stopRuntimeRotationRouterProcess(router, platform, routerScriptPath, options);
}

async function runWindowsTaskkill(pid: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let child: ReturnType<typeof spawn> | null = null;
		let timeout: ReturnType<typeof setTimeout> | null = null;
		const finish = (succeeded: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolve(succeeded);
		};
		try {
			child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			timeout = setTimeout(() => {
				try {
					child?.kill();
				} catch {
					// The taskkill child may already have exited at the timeout boundary.
				}
				finish(false);
			}, WINDOWS_TASKKILL_TIMEOUT_MS);
			child.once("error", () => finish(false));
			child.once("close", (code) => finish(code === 0));
		} catch {
			finish(false);
		}
	});
}

interface ProcessIdentitySnapshot {
	startedAt: number | null;
	commandLine: string;
}

async function runProcessIdentityProbe(
	command: string,
	args: string[],
	options: { timeoutMs?: number; log?: (message: string) => void } = {},
): Promise<string | null> {
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		let child: ReturnType<typeof spawn> | null = null;
		const timeoutMs =
			typeof options.timeoutMs === "number" &&
			Number.isFinite(options.timeoutMs) &&
			options.timeoutMs > 0
				? options.timeoutMs
				: PROCESS_IDENTITY_PROBE_TIMEOUT_MS;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(value);
		};
		const timeout = setTimeout(() => {
			options.log?.(`Process identity probe timed out while running ${command}`);
			try {
				child?.kill();
			} catch {
				// The probe may have exited at the timeout boundary.
			}
			finish(null);
		}, timeoutMs);
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				output += chunk;
			});
			child.once("error", (error) => {
				options.log?.(
					`Process identity probe ${command} was unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				finish(null);
			});
			child.once("close", (code) => {
				if (code !== 0) {
					options.log?.(
						`Process identity probe ${command} exited with status ${code ?? "unknown"}`,
					);
				}
				finish(code === 0 ? output : null);
			});
		} catch (error) {
			options.log?.(
				`Process identity probe ${command} was unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
			finish(null);
		}
	});
}

async function readProcessIdentity(
	pid: number,
	platform: NodeJS.Platform,
	log?: (message: string) => void,
): Promise<ProcessIdentitySnapshot | null> {
	if (platform === "win32") {
		const script = [
			`$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
			"if ($null -ne $process) {",
			"[Console]::WriteLine($process.CreationDate.ToUniversalTime().ToString('o'))",
			"[Console]::WriteLine($process.CommandLine)",
			"}",
		].join("; ");
		const output = await runProcessIdentityProbe(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ timeoutMs: WINDOWS_PROCESS_IDENTITY_PROBE_TIMEOUT_MS, log },
		);
		if (!output) {
			log?.(`Process identity probe returned no Windows record for PID ${pid}`);
			return null;
		}
		const [startedAtRaw, ...commandLines] = output.trim().split(/\r?\n/);
		const startedAt = startedAtRaw ? Date.parse(startedAtRaw.trim()) : NaN;
		const commandLine = commandLines.join(" ").trim();
		if (!Number.isFinite(startedAt) || commandLine.length === 0) {
			log?.(`Process identity probe returned an invalid Windows record for PID ${pid}`);
		}
		return {
			startedAt: Number.isFinite(startedAt) ? startedAt : null,
			commandLine,
		};
	}

	const [startedAtRaw, commandLineRaw] = await Promise.all([
		runProcessIdentityProbe(
			"ps",
			["-p", String(pid), "-o", "lstart="],
			{ log },
		),
		runProcessIdentityProbe(
			"ps",
			["-p", String(pid), "-o", "command="],
			{ log },
		),
	]);
	if (!startedAtRaw || !commandLineRaw) {
		log?.(`Process identity probe returned no POSIX record for PID ${pid}`);
		return null;
	}
	const startedAt = parsePosixProcessStartTime(startedAtRaw);
	if (startedAt === null) {
		log?.(`Process identity probe returned an invalid POSIX start time for PID ${pid}`);
	}
	return {
		startedAt,
		commandLine: commandLineRaw.trim(),
	};
}

const POSIX_LSTART_MONTHS = new Map([
	["Jan", 0],
	["Feb", 1],
	["Mar", 2],
	["Apr", 3],
	["May", 4],
	["Jun", 5],
	["Jul", 6],
	["Aug", 7],
	["Sep", 8],
	["Oct", 9],
	["Nov", 10],
	["Dec", 11],
]);

/** Parse the documented local-time format emitted by `ps -o lstart=`. */
export function parsePosixProcessStartTime(value: string): number | null {
	const match =
		/^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(
			value,
		);
	if (!match) return null;
	const month = POSIX_LSTART_MONTHS.get(match[1] ?? "");
	const day = Number(match[2]);
	const hour = Number(match[3]);
	const minute = Number(match[4]);
	const second = Number(match[5]);
	const year = Number(match[6]);
	if (
		month === undefined ||
		!Number.isInteger(day) ||
		!Number.isInteger(hour) ||
		!Number.isInteger(minute) ||
		!Number.isInteger(second) ||
		!Number.isInteger(year) ||
		day < 1 ||
		day > 31 ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return null;
	}
	const date = new Date(year, month, day, hour, minute, second, 0);
	if (
		!Number.isFinite(date.getTime()) ||
		date.getFullYear() !== year ||
		date.getMonth() !== month ||
		date.getDate() !== day ||
		date.getHours() !== hour ||
		date.getMinutes() !== minute ||
		date.getSeconds() !== second
	) {
		return null;
	}
	return date.getTime();
}

function normalizeProcessIdentityPath(value: string, platform: NodeJS.Platform): string {
	const normalized = value.trim().replace(/["']/g, "").replace(/\\/g, "/");
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function commandLineContainsProcessPath(
	commandLine: string,
	path: string,
	platform: NodeJS.Platform,
): boolean {
	const normalizedPath = normalizeProcessIdentityPath(path, platform);
	if (normalizedPath.length === 0) return false;
	const normalizedCommandLine = normalizeProcessIdentityPath(commandLine, platform);
	let offset = normalizedCommandLine.indexOf(normalizedPath);
	while (offset >= 0) {
		const before = normalizedCommandLine[offset - 1] ?? "";
		const after =
			normalizedCommandLine[offset + normalizedPath.length] ?? "";
		if ((before === "" || /\s/.test(before)) && (after === "" || /\s/.test(after))) {
			return true;
		}
		offset = normalizedCommandLine.indexOf(normalizedPath, offset + 1);
	}
	return false;
}

async function verifyRuntimeProcessIdentity(
	pid: number,
	startedAt: number,
	platform: NodeJS.Platform,
	expectedScriptPath: string,
	expectedStatusPath?: string | null,
	log?: (message: string) => void,
	expectedIdentityToken?: string,
): Promise<boolean> {
	const identity = await readProcessIdentity(pid, platform, log);
	if (!identity || identity.startedAt === null) return false;
	if (
		!commandLineContainsProcessPath(
			identity.commandLine,
			expectedScriptPath,
			platform,
		) ||
		(expectedStatusPath !== undefined &&
			expectedStatusPath !== null &&
			!commandLineContainsProcessPath(
				identity.commandLine,
				expectedStatusPath,
				platform,
			))
	) {
		return false;
	}
	if (
		expectedIdentityToken &&
		!commandLineContainsProcessPath(
			identity.commandLine,
			expectedIdentityToken,
			platform,
		)
	) {
		log?.("Process identity probe rejected a mismatched ownership token");
		return false;
	}
	return Math.abs(identity.startedAt - startedAt) <= PROCESS_START_TIME_TOLERANCE_MS;
}

async function verifyLegacyRuntimeProcessIdentity(
	pid: number,
	lastObservedAt: number,
	platform: NodeJS.Platform,
	expectedScriptPath: string,
	expectedStatusPath?: string | null,
	log?: (message: string) => void,
	expectedIdentityToken?: string,
): Promise<boolean> {
	if (lastObservedAt > Date.now() + PROCESS_START_TIME_TOLERANCE_MS) {
		return false;
	}
	const identity = await readProcessIdentity(pid, platform, log);
	if (!identity || identity.startedAt === null) return false;
	if (
		!commandLineContainsProcessPath(
			identity.commandLine,
			expectedScriptPath,
			platform,
		) ||
		(expectedStatusPath !== undefined &&
			expectedStatusPath !== null &&
			!commandLineContainsProcessPath(
				identity.commandLine,
				expectedStatusPath,
				platform,
			))
	) {
		return false;
	}
	if (
		expectedIdentityToken &&
		!commandLineContainsProcessPath(
			identity.commandLine,
			expectedIdentityToken,
			platform,
		)
	) {
		log?.("Process identity probe rejected a mismatched ownership token");
		return false;
	}
	// Legacy router status did not persist its own start time. A status update
	// is still written after the router process starts, so a process with a
	// later creation time indicates a stale/reused PID and must not be signalled.
	return identity.startedAt <= lastObservedAt + PROCESS_START_TIME_TOLERANCE_MS;
}

function isIgnorableProcessSignalError(error: unknown): boolean {
	const code =
		error && typeof error === "object" && "code" in error
			? error.code
			: undefined;
	return code === "ESRCH" || code === "EPERM";
}

function reportProcessStopError(
	options: DetachedProcessStopOptions,
	operation: string,
	error: unknown,
): void {
	options.log?.(
		`Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`,
	);
}

function resolveStopTimeout(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;
}

async function waitForDetachedProcessExit(
	pid: number,
	options: DetachedProcessStopOptions,
): Promise<boolean> {
	const isAlive = options.isAlive ?? isProcessAlive;
	const timeoutMs = resolveStopTimeout(options.gracefulTimeoutMs, 2_000);
	const pollIntervalMs = Math.max(
		1,
		resolveStopTimeout(options.pollIntervalMs, 100),
	);
	const deadline = Date.now() + timeoutMs;
	while (isAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) =>
			setTimeout(
				resolve,
				Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
			),
		);
	}
	return true;
}

export async function stopDetachedProcess(
	pid: number | null,
	platform: NodeJS.Platform,
	options: DetachedProcessStopOptions = {},
): Promise<boolean> {
	if (!pid || !Number.isInteger(pid) || pid < 1) return false;
	const isAlive = options.isAlive ?? isProcessAlive;
	const kill =
		options.kill ??
		((target: number, signal: NodeJS.Signals) => {
			process.kill(target, signal);
		});
	const taskkill = options.runWindowsTaskkill ?? runWindowsTaskkill;
	if (!isAlive(pid)) return true;

	if (platform === "win32") {
		// Node's SIGTERM emulation can let a target exit before the tree-kill
		// fallback runs. Kill the exact PID tree directly so detached descendants
		// cannot survive a graceful wait and so no unrelated process is touched.
		try {
			const result = await taskkill(pid);
			if (result !== false || !isAlive(pid)) return true;
			reportProcessStopError(
				options,
				"terminate the Windows process tree",
				new Error("taskkill reported failure while the process is still alive"),
			);
			return false;
		} catch (error) {
			if (!isAlive(pid)) return true;
			reportProcessStopError(options, "terminate the Windows process tree", error);
			return false;
		}
	}

	try {
		kill(pid, "SIGTERM");
	} catch (error) {
		// ESRCH means the process exited between the liveness probe and signal;
		// EPERM means it is not ours or cannot be signalled. Do not escalate an
		// unexpected signal error or silently claim that cleanup succeeded.
		if (isIgnorableProcessSignalError(error)) return !isAlive(pid);
		reportProcessStopError(options, "send SIGTERM", error);
		return false;
	}

	if (await waitForDetachedProcessExit(pid, options)) return true;

	// A detached POSIX helper/router may ignore SIGTERM. Escalate once after the
	// bounded graceful window; a second bounded wait prevents unbind from racing
	// the process while it is still unwinding.
	try {
		kill(pid, "SIGKILL");
	} catch (error) {
		if (isIgnorableProcessSignalError(error)) return !isAlive(pid);
		reportProcessStopError(options, "send SIGKILL", error);
		return false;
	}
	return waitForDetachedProcessExit(pid, {
		...options,
		gracefulTimeoutMs: Math.min(
			resolveStopTimeout(options.gracefulTimeoutMs, 2_000),
			500,
		),
	});
}

async function readRuntimeHelperStatus(
	path: string,
): Promise<
	| { kind: "missing" | "malformed" | "unreadable"; status: null }
	| { kind: "valid"; status: RuntimeRotationAppHelperStatus }
> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
		return {
			kind: code === "ENOENT" ? "missing" : "unreadable",
			status: null,
		};
	}
	const record = parseJsonRecord(raw);
	if (!record) return { kind: "malformed", status: null };
	const pid = record ? readNumber(record, "pid") : null;
	const startedAt = record ? readNumber(record, "startedAt") : null;
	return {
		kind: "valid",
		status: {
			state: readString(record, "state"),
			kind: readString(record, "kind"),
			pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null,
			startedAt:
				startedAt !== null && Number.isFinite(startedAt) && startedAt > 0
					? startedAt
					: null,
			scriptPath: readString(record, "scriptPath"),
			identityToken: readString(record, "identityToken"),
		},
	};
}

async function readRuntimeHelperOwner(
	path: string,
): Promise<RuntimeRotationAppHelperOwner | null> {
	try {
		const record = parseJsonRecord(await readFile(path, "utf8"));
		const kind = record ? readString(record, "kind") : null;
		const identityToken = record ? readString(record, "identityToken") : null;
		return kind === "codex-app-runtime-rotation-helper-owner" && identityToken
			? { kind, identityToken }
			: null;
	} catch {
		return null;
	}
}

function resolveRuntimeHelperOwnerPath(
	baseDir: string,
	pid: number | null,
): string | null {
	if (pid === null || !Number.isInteger(pid) || pid < 1) return null;
	return join(
		baseDir,
		APP_RUNTIME_HELPER_OWNER_FILE.replace(/\.json$/i, `.${pid}.json`),
	);
}

/**
 * How many helper records unbind processes at once. Exported so a regression
 * test can observe the bound rather than only its effects — with a handful of
 * records any width behaves identically, so an edit to `Infinity` would
 * otherwise ship green.
 */
export const UNBIND_HELPER_CONCURRENCY = 8;

interface HelperCleanupDecision {
	statusPath: string;
	ownerPath: string | null;
	removeHelperStatus: boolean;
	removeHelperOwner: boolean;
}

/**
 * `Promise.all` over `items` with at most `limit` in flight, preserving input
 * order in the result. Used where the per-item work is independent but not
 * free — a helper stop pays a SIGTERM, a graceful wait and possibly a SIGKILL —
 * so serialising it multiplies a single stop window by the number of stale
 * helpers, and unbounded parallelism signals every one of them at once.
 */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const runners = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			for (;;) {
				const index = next;
				next += 1;
				// Only running past the end retires a runner. Folding the
				// `undefined` check into the same `return` would make a sparse
				// array or a `(T | undefined)[]` silently drop every item after
				// the first hole — on a cleanup path whose failure mode is
				// "helpers left running while the user is told the app was
				// unbound".
				if (index >= items.length) return;
				const item = items[index];
				if (item === undefined) continue;
				results[index] = await worker(item, index);
			}
		},
	);
	await Promise.all(runners);
	return results;
}

export async function stopRuntimeRotationAppHelperProcess(
	helper: RuntimeRotationAppHelperStatus,
	options: DetachedProcessStopOptions & { platform?: NodeJS.Platform } = {},
): Promise<boolean> {
	if (
		helper.kind !== "codex-app-runtime-rotation-helper" ||
		helper.state !== "running" ||
		helper.pid === null ||
		helper.startedAt === null
	) {
		return false;
	}
	const platform = options.platform ?? process.platform;
	const expectedIdentityToken = options.identityToken;
	if (helper.identityToken && !expectedIdentityToken) {
		// Do not trust a token that was read from the same mutable status file
		// whose PID is about to be signalled.
		return false;
	}
	const verifyProcessIdentity =
		options.verifyProcessIdentity ??
		((pid, startedAt, processPlatform) =>
			verifyRuntimeProcessIdentity(
				pid,
				startedAt,
				processPlatform,
				RUNTIME_ROTATION_APP_HELPER_ARG,
				helper.scriptPath,
				options.log,
				expectedIdentityToken,
			));
	const verified = expectedIdentityToken
		? await verifyProcessIdentity(
				helper.pid,
			helper.startedAt,
			platform,
			expectedIdentityToken,
		)
		: await verifyProcessIdentity(helper.pid, helper.startedAt, platform);
	if (!verified) {
		return false;
	}
	return stopDetachedProcess(helper.pid, platform, options);
}

async function readConfigIfExists(configPath: string): Promise<{ existed: boolean; content: string }> {
	try {
		return { existed: true, content: await readFile(configPath, "utf8") };
	} catch {
		return { existed: false, content: "" };
	}
}

export async function getAppBindStatus(options: AppBindOptions = {}): Promise<AppBindStatus> {
	const paths = resolveAppBindPaths(options);
	const state = await readAppBindState(paths.statePath);
	const router = await readRouterStatus(paths.statusPath);
	// When no state file is present, the bind may still be live in config.toml
	// (orphaned bind, #614). Detect that from the config directly so status and
	// downstream callers don't report a bound config as "not configured".
	let unmanagedBind = false;
	if (state === null) {
		const current = await readConfigIfExists(paths.configPath);
		unmanagedBind =
			current.existed && (configHasRuntimeRotationProvider(current.content) || hasNativeProviderConfig(current.content));
	}
	return {
		bound: state !== null || unmanagedBind,
		running: router !== null && router.state === "running" && isProcessAlive(router.pid),
		unmanagedBind,
		state,
		router,
		paths,
	};
}

export async function bindCodexAppRuntimeRotation(
	options: AppBindOptions = {},
): Promise<AppBindResult> {
	const paths = resolveAppBindPaths(options);
	return withAppBindLock(paths.bindDir, () =>
		withNativeBindingLock(paths.configPath, () => bindCodexAppRuntimeRotationLocked(options, paths)),
	);
}

async function bindCodexAppRuntimeRotationLocked(
	options: AppBindOptions,
	paths: AppBindPaths,
): Promise<AppBindResult> {
	const platform = options.platform ?? process.platform;
	const now = options.now?.() ?? Date.now();
	const existingState = await readAppBindState(paths.statePath);
	const nativeOpenai = options.nativeOpenai ?? existingState?.nativeOpenai ??
		((options.env ?? process.env).CODEX_MULTI_AUTH_NATIVE_OPENAI === "1");
	const catalogAccount = options.nativeOpenai === false ? undefined : options.catalogAccount ?? existingState?.catalogAccount;
	if (existingState && (!!existingState.nativeOpenai !== nativeOpenai || JSON.stringify(catalogAccount) !== JSON.stringify(existingState.catalogAccount))) {
		const router = await readRouterStatus(paths.statusPath);
		let ownRouter = false;
		await stopRouter(router, platform, existingState.routerScriptPath, {
			log: options.log, identityToken: existingState.identityToken, verifyProcessIdentity: options.verifyProcessIdentity,
			onOwnershipVerified: () => { ownRouter = true; },
		});
		// Refuse only when the recorded PID is verifiably our router and it survived
		// the stop. A recycled PID now owned by another process must not block
		// mode changes forever (unbind treats the same case as a warning).
		if (router?.pid && isProcessAlive(router.pid)) {
			if (ownRouter) throw new Error("Stop the existing app router before changing provider mode");
			// A failed identity check is not proof: a slow or failing process probe
			// (common on Windows) also returns false for a live router. Treat the pid
			// as recycled only when nothing answers at the recorded router address.
			const address = await probeRouterAddress(router.baseUrl ?? existingState.baseUrl, options.platform ?? process.platform);
			if (address !== "refused") {
				throw new Error(
					`Could not confirm that the app router recorded as pid ${router.pid} has stopped (its address ${address === "listening" ? "still accepts connections" : "could not be checked"}). Stop it before changing provider mode.`,
				);
			}
			options.log?.(`Warning: recorded router pid ${router.pid} is not the app router; continuing`);
			// The record describes a router that no longer exists. Drop it so
			// maybeStartRouter starts a replacement instead of trusting the live
			// (recycled) pid and leaving the new mode pointed at a dead address.
			await unlinkIfExists(paths.statusPath);
		}
	}

	const host = existingState?.host ?? "127.0.0.1";
	let port = existingState && existingState.port > 0 ? existingState.port : 0;
	let baseUrl = existingState?.baseUrl ?? formatBaseUrl(host, port);
	const clientApiKey =
		existingState && existingState.clientApiKey.length > 0
			? existingState.clientApiKey
			: createAppBindClientApiKey();
	const { existed, content } = await readConfigIfExists(paths.configPath);
	const backup = (await readAppBindBackup(paths.backupPath)) ?? {
		version: 1,
		configPath: paths.configPath,
		existed,
		content,
		createdAt: now,
	};
	const bindingContent = nativeOpenai
		? restoreConfigTomlFromAppBind(content, backup.content)
		: restoreNativeProviderConfig(content, backup.content);
	let boundConfig = rewriteConfigTomlForAppBind(bindingContent, baseUrl, clientApiKey, nativeOpenai);
	let state: AppBindState = {
		nativeOpenai,
		catalogAccount,
		version: 1,
		platform,
		host,
		port,
		baseUrl,
		configPath: paths.configPath,
		statePath: paths.statePath,
		backupPath: paths.backupPath,
		statusPath: paths.statusPath,
		logPath: paths.logPath,
		nodePath: options.nodePath ?? process.execPath,
		routerScriptPath: paths.routerScriptPath,
		clientApiKey,
		identityToken: existingState?.identityToken ?? randomBytes(24).toString("hex"),
		startupPath: paths.startupPath,
		launchAgentPath: paths.launchAgentPath,
		boundConfigHash: sha256(boundConfig),
		updatedAt: now,
	};

	await mkdir(paths.bindDir, { recursive: true });
	await mkdir(dirname(paths.configPath), { recursive: true });
	await atomicWriteFile(paths.backupPath, `${JSON.stringify(backup, null, 2)}\n`);
	// Write bootstrap state before spawning so router can read --state on startup
	await atomicWriteFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
	const startedRouter = await maybeStartRouter(state, options);
	const router = startedRouter
		? await waitForRouterStatus(
				state.statusPath,
				resolveRouterReadyTimeoutMs(options),
			)
		: await readRouterStatus(state.statusPath);
	const routerBaseUrl = router?.baseUrl ?? null;
	const routerIsUsable =
		!!routerBaseUrl &&
		router !== null &&
		(startedRouter || (router.state === "running" && isProcessAlive(router.pid)));
	if (routerIsUsable) {
		port = readPortFromBaseUrl(routerBaseUrl, port);
		baseUrl = routerBaseUrl;
	} else if (
		!startedRouter &&
		existingState &&
		existingState.port > 0 &&
		router !== null &&
		router.state === "running" &&
		isProcessAlive(router.pid)
	) {
		// Only reuse existingState.port when the router process is verifiably
		// alive — `router !== null` alone passes for stale status JSON left by
		// a dead router, which would have us write a config.toml pointing at a
		// port nothing is listening on.
		port = existingState.port;
		baseUrl = existingState.baseUrl;
	}
	if (port <= 0) {
		if (startedRouter) {
			// Best-effort stop of the router we just spawned
			const orphan = await readRouterStatus(state.statusPath).catch(() => null);
			await stopRouter(orphan, platform, state.routerScriptPath, {
				log: options.log,
				identityToken: state.identityToken,
				verifyProcessIdentity: options.verifyProcessIdentity,
			}).catch(
				() => undefined,
			);
		}
		throw new Error(
			"Codex app bind could not resolve a runtime router port; refusing to write config.toml with port=0.",
		);
	}
	boundConfig = rewriteConfigTomlForAppBind(bindingContent, baseUrl, clientApiKey, nativeOpenai);
	state = {
		...state,
		port,
		baseUrl,
		boundConfigHash: sha256(boundConfig),
		updatedAt: options.now?.() ?? Date.now(),
	};
	if (startedRouter) {
		options.log?.(`Codex app runtime router started on ${baseUrl}`);
	}
	await atomicWriteFile(paths.configPath, boundConfig);
	await atomicWriteFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
	await writeAppBindStartup(state);
	const status = await getAppBindStatus(options);
	return {
		status,
		message: `Bound Codex app config ${paths.configPath} to ${baseUrl}`,
	};
}

export async function unbindCodexAppRuntimeRotation(
	options: AppBindOptions = {},
): Promise<AppBindResult> {
	const paths = resolveAppBindPaths(options);
	return withAppBindLock(paths.bindDir, () =>
		withNativeBindingLock(paths.configPath, () => unbindCodexAppRuntimeRotationLocked(options, paths)),
	);
}

async function unbindCodexAppRuntimeRotationLocked(
	options: AppBindOptions,
	paths: AppBindPaths,
): Promise<AppBindResult> {
	const state = await readAppBindState(paths.statePath);
	const router = await readRouterStatus(paths.statusPath);
	const platform = options.platform ?? process.platform;
	const routerStopped = await stopRouter(
		router,
		platform,
		state?.routerScriptPath ?? paths.routerScriptPath,
		{
			log: options.log,
			identityToken: state?.identityToken,
			verifyProcessIdentity: options.verifyProcessIdentity,
		},
	);
	if (router?.pid && (!routerStopped || isProcessAlive(router.pid))) {
		options.log?.(
			`Warning: runtime router (pid ${router.pid}) did not stop; continuing cleanup`,
		);
	}

	// Helpers publish per-PID status files (`runtime-rotation-app-helper.<pid>.json`);
	// the un-suffixed name is the legacy shared path from before that change,
	// still checked so a pre-upgrade helper is torn down too. Every candidate
	// walks the same per-helper logic the single file used to get: stopping is
	// gated on ownership verification (status/owner identity-token agreement
	// plus process identity), so unbind reaps each helper it can prove is one
	// of ours and preserves — with a warning — anything it cannot.
	const helperBaseDir = dirname(paths.bindDir);
	let helperDirEntries: string[] = [];
	try {
		helperDirEntries = await withFileOperationRetry(() =>
			readdir(helperBaseDir),
		);
	} catch (error) {
		// Degrading to legacy-only cleanup while reporting success would leave
		// every per-PID helper running with the user told the app was unbound —
		// say so. ENOENT just means no helper ever ran.
		const code =
			error && typeof error === "object" && "code" in error
				? String((error as { code?: unknown }).code)
				: "unknown";
		if (code !== "ENOENT") {
			options.log?.(
				`Warning: could not enumerate runtime app helper status files (${code}); only the legacy helper path is checked`,
			);
		}
		helperDirEntries = [];
	}
	const helperStatusPaths = listRuntimeHelperStatusPaths(
		helperBaseDir,
		helperDirEntries,
	);
	// Each candidate is independent — a read, a liveness check, and at most one
	// SIGTERM/graceful-wait/SIGKILL sequence — and on the machine from #663 there
	// were 183 of them. Run them in a bounded pool rather than one after another,
	// so unbind costs roughly one stop window instead of N of them; the bound
	// keeps a machine full of stale helpers from being hit with 183 concurrent
	// signal sequences.
	const helperResults = await mapWithConcurrency(
		helperStatusPaths,
		UNBIND_HELPER_CONCURRENCY,
		async (helperStatusPath): Promise<HelperCleanupDecision | null> => {
			const helperRead = await readRuntimeHelperStatus(helperStatusPath);
			if (helperRead.kind !== "valid") return null;
			const helper = helperRead.status;
			if (helper.kind !== "codex-app-runtime-rotation-helper") return null;
			let removeHelperStatus = false;
			let removeHelperOwner = false;
			const helperOwnerPath = resolveRuntimeHelperOwnerPath(
				helperBaseDir,
				helper.pid,
			);
			const helperOwner = helperOwnerPath
				? await readRuntimeHelperOwner(helperOwnerPath)
				: null;
			const helperOwnershipMatches =
				!helper.identityToken ||
				(helperOwner !== null &&
					helper.identityToken === helperOwner.identityToken);
			if (helper.state === "running") {
				if (helper.pid === null) {
					options.log?.(
						"Warning: runtime app helper status has no valid PID; preserving status",
					);
				} else {
					const wasAlive = isProcessAlive(helper.pid);
					if (!wasAlive) {
						// Decisive, and deliberately not gated on ownership (#666): a
						// dead PID means both files describe a process that no longer
						// exists, so keeping the owner file preserves nothing. It used
						// to be gated, which deleted the status file and stranded the
						// owner file — and because unbind then enumerated status paths
						// only, nothing ever rediscovered it. This matches what the
						// launcher-side sweep already does with a dead PID.
						removeHelperStatus = true;
						removeHelperOwner = helperOwnerPath !== null;
					} else if (!helperOwnershipMatches) {
						options.log?.(
							"Warning: runtime app helper ownership metadata does not match; preserving status",
						);
					} else {
						const stopped = await stopRuntimeRotationAppHelperProcess(helper, {
							platform,
							log: options.log,
							identityToken: helper.identityToken
								? helperOwner?.identityToken
								: undefined,
							verifyProcessIdentity: options.verifyProcessIdentity,
						});
						const stillAlive = isProcessAlive(helper.pid);
						removeHelperStatus = stopped && !stillAlive;
						removeHelperOwner = removeHelperStatus && helperOwnerPath !== null;
						if (!removeHelperStatus) {
							options.log?.(
								`Warning: runtime app helper (pid ${helper.pid}) did not stop; preserving status`,
							);
						}
					}
				}
			} else {
				// A non-running, owned record is removable only when its PID is
				// absent or no longer alive. This avoids deleting a status file
				// while a helper is still serving despite a stale state value.
				// Ownership does not gate the owner file here either, for the same
				// reason as above: the PID is gone, so neither file describes
				// anything that can still be running.
				removeHelperStatus = helper.pid === null || !isProcessAlive(helper.pid);
				removeHelperOwner = removeHelperStatus && helperOwnerPath !== null;
			}
			return {
				statusPath: helperStatusPath,
				ownerPath: helperOwnerPath,
				removeHelperStatus,
				removeHelperOwner,
			};
		},
	);
	const helperCleanupPaths: string[] = [];
	// Owner paths this pass already reasoned about, whether or not it decided to
	// remove them — a preserved live helper's owner file must not then be swept
	// by the orphan pass below.
	const consideredOwnerPaths = new Set<string>();
	for (const result of helperResults) {
		if (!result) continue;
		if (result.ownerPath !== null) consideredOwnerPaths.add(result.ownerPath);
		if (result.removeHelperStatus) helperCleanupPaths.push(result.statusPath);
		if (result.removeHelperOwner && result.ownerPath !== null) {
			helperCleanupPaths.push(result.ownerPath);
		}
	}
	// Owner files with no status record left to pair them with. Before #666 these
	// were unreachable: every earlier pass walked status paths only, so an owner
	// file that outlived its status file was never looked at again. A dead PID is
	// the whole test — a live PID's owner file belongs to a helper that is still
	// running, and was already considered above.
	for (const owner of listRuntimeHelperOwnerPaths(
		helperBaseDir,
		helperDirEntries,
	)) {
		if (consideredOwnerPaths.has(owner.path)) continue;
		if (isProcessAlive(owner.pid)) {
			// An owner file with no status record whose PID is nonetheless live
			// is the one shape this pass cannot reclaim. Either a helper is
			// starting right now and has not published yet, or — the case that
			// accumulates — the PID was recycled by an unrelated process after
			// the status file was already gone. Telling those apart needs the
			// recorded-start-time comparison the launcher-side sweep does, which
			// unbind has no equivalent of; that is a scope decision, but it
			// should not be a silent one. Every other preserve in this function
			// warns, so this one does too.
			options.log?.(
				`Warning: runtime app helper owner metadata (pid ${owner.pid}) has no status record but its PID is live; preserving`,
			);
			continue;
		}
		helperCleanupPaths.push(owner.path);
	}
	await removeAppBindStartup(state ?? paths);

	const backup = await readAppBindBackup(paths.backupPath);
	let selfHealed = false;
	if (backup) {
		const current = await readConfigIfExists(backup.configPath);
		if (state && current.existed && sha256(current.content) !== state.boundConfigHash) {
			await atomicWriteFile(
				backup.configPath,
				restoreConfigTomlFromAppBind(current.content, backup.content),
			);
		} else if (backup.existed) {
			await mkdir(dirname(backup.configPath), { recursive: true });
			await atomicWriteFile(backup.configPath, backup.content);
		} else {
			await unlinkIfExists(backup.configPath);
		}
	} else if (state) {
		const current = await readConfigIfExists(state.configPath);
		if (current.existed) {
			await atomicWriteFile(
				state.configPath,
				restoreConfigTomlFromAppBind(current.content, ""),
			);
		}
	} else {
		// Orphaned-bind recovery (#614): no backup and no state file, but the
		// config may still be bound to the runtime proxy (e.g. the state/backup
		// were lost while config.toml stayed rewritten). The state-file checks
		// above can't see this, so consult the config directly and self-heal it
		// back to a working provider when it is bound.
		const current = await readConfigIfExists(paths.configPath);
		if (current.existed && (configHasRuntimeRotationProvider(current.content) || hasNativeProviderConfig(current.content))) {
			await atomicWriteFile(
				paths.configPath,
				restoreConfigTomlFromRuntimeRotationProviderWithoutBackup(
					restoreNativeProviderConfig(current.content, ""),
				),
			);
			selfHealed = true;
		}
	}

	const cleanupCandidates = [
		paths.statePath,
		paths.backupPath,
		paths.statusPath,
		state?.logPath ?? paths.logPath,
		...helperCleanupPaths,
	];
	for (const candidate of cleanupCandidates) {
		try {
			await unlinkIfExists(candidate);
		} catch {
			// Best-effort cleanup.
		}
	}
	try {
		await withFileOperationRetry(() =>
			rm(paths.bindDir, { force: true, recursive: true }),
		);
	} catch {
		// The bind directory may still contain unrelated or locked files.
	}

	const status = await getAppBindStatus(options);
	let message: string;
	if (backup) {
		message = `Unbound Codex app config ${backup.configPath}`;
	} else if (selfHealed) {
		message = `Restored Codex app config ${paths.configPath} from an orphaned runtime-proxy bind (no backup was present)`;
	} else {
		message = "Codex app bind was not configured";
	}
	return {
		status,
		message,
	};
}

export function formatAppBindStatus(status: AppBindStatus): string {
	if (status.unmanagedBind && !status.state) {
		return [
			`Codex app bind: bound but unmanaged (config=${status.paths.configPath} points at the runtime proxy, but no app-bind state/backup is present)`,
			[
				"Run `codex-multi-auth rotation unbind-app` to restore the original",
				"Codex provider/config. This recovers the orphaned bind even though no",
				"backup was saved (#614).",
			].join(" "),
		].join("\n");
	}
	if (!status.bound || !status.state) return "Codex app bind: not configured";
	const parts = [
		status.running ? "running" : "configured but router not running",
		`port=${status.state.port}`,
		`config=${status.state.configPath}`,
	];
	if (status.router?.lastAccountLabel && !status.router.lastAccountLabel.includes("@")) {
		parts.push(`lastAccount=${status.router.lastAccountLabel}`);
	} else if (status.router?.lastAccountIndex !== null && status.router?.lastAccountIndex !== undefined) {
		parts.push(`lastAccount=Account ${status.router.lastAccountIndex + 1}`);
	}
	if (status.state.nativeOpenai) return `Codex app bind: ${parts.join(", ")}, native OpenAI, live account catalogs`;
	return [
		`Codex app bind: ${parts.join(", ")}`,
		[
			"Note: Codex Desktop may hide history while the app bind selects the",
			"codex-multi-auth-runtime-proxy provider; use `codex-multi-auth rotation",
			"unbind-app` or `codex-multi-auth rotation disable` to restore the original",
			"Codex provider/config.",
		].join(" "),
		[
			"Model speed/reasoning controls stay in Codex config/CLI flags; set",
			"`model_reasoning_effort` in",
			status.state.configPath,
			"or pass",
			"`-c model_reasoning_effort=<level>` for wrapper-launched CLI sessions.",
		].join(" "),
	].join("\n");
}
