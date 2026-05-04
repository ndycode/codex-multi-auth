import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { withFileOperationRetry } from "../fs-retry.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import {
	restoreConfigTomlFromRuntimeRotationProvider,
	rewriteConfigTomlForRuntimeRotationProvider,
} from "./config-toml.js";

const APP_BIND_DIR_NAME = "app-bind";
const APP_BIND_STATE_FILE = "runtime-rotation-app-bind.json";
const APP_BIND_BACKUP_FILE = "codex-config-backup.json";
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
	startupPath: string | null;
	launchAgentPath: string | null;
	boundConfigHash: string;
	updatedAt: number;
}

export interface AppBindRouterStatus {
	state: string | null;
	pid: number | null;
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
	state: AppBindState | null;
	router: AppBindRouterStatus | null;
	paths: AppBindPaths;
}

export interface AppBindResult {
	status: AppBindStatus;
	message: string;
}

export interface AppBindOptions {
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
}

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
): string {
	return rewriteConfigTomlForRuntimeRotationProvider(
		rawConfig,
		baseUrl,
		clientApiKey,
	);
}

export function restoreConfigTomlFromAppBind(currentConfig: string, originalConfig: string): string {
	return restoreConfigTomlFromRuntimeRotationProvider(
		currentConfig,
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
		`"${nodePath}" "${routerScriptPath}" --port ${state.port} --status "${statusPath}" --state "${statePath}" --log "${logPath}" --max-log-bytes ${APP_ROUTER_MAX_LOG_BYTES} >> "${logPath}" 2>&1`,
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

async function removeAppBindStartup(state: AppBindState): Promise<void> {
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

async function stopRouter(router: AppBindRouterStatus | null): Promise<void> {
	if (!router?.pid || !isProcessAlive(router.pid)) return;
	try {
		process.kill(router.pid, "SIGTERM");
	} catch {
		return;
	}
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (!isProcessAlive(router.pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
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
	return {
		bound: state !== null,
		running: router !== null && router.state === "running" && isProcessAlive(router.pid),
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
		bindCodexAppRuntimeRotationLocked(options, paths),
	);
}

async function bindCodexAppRuntimeRotationLocked(
	options: AppBindOptions,
	paths: AppBindPaths,
): Promise<AppBindResult> {
	const platform = options.platform ?? process.platform;
	const now = options.now?.() ?? Date.now();
	const existingState = await readAppBindState(paths.statePath);
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
	let boundConfig = rewriteConfigTomlForAppBind(content, baseUrl, clientApiKey);
	let state: AppBindState = {
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
		startupPath: paths.startupPath,
		launchAgentPath: paths.launchAgentPath,
		boundConfigHash: sha256(boundConfig),
		updatedAt: now,
	};

	await mkdir(paths.bindDir, { recursive: true });
	await mkdir(dirname(paths.configPath), { recursive: true });
	await atomicWriteFile(paths.backupPath, `${JSON.stringify(backup, null, 2)}\n`);
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
	} else if (existingState && existingState.port > 0) {
		port = existingState.port;
		baseUrl = existingState.baseUrl;
	}
	if (port <= 0) {
		throw new Error(
			"Codex app bind could not resolve a runtime router port; refusing to write config.toml with port=0.",
		);
	}
	boundConfig = rewriteConfigTomlForAppBind(content, baseUrl, clientApiKey);
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
		unbindCodexAppRuntimeRotationLocked(options, paths),
	);
}

async function unbindCodexAppRuntimeRotationLocked(
	options: AppBindOptions,
	paths: AppBindPaths,
): Promise<AppBindResult> {
	const state = await readAppBindState(paths.statePath);
	const router = await readRouterStatus(paths.statusPath);
	if (state) {
		await stopRouter(router);
		await removeAppBindStartup(state);
	}

	const backup = await readAppBindBackup(paths.backupPath);
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
	}

	for (const candidate of [
		paths.statePath,
		paths.backupPath,
		paths.statusPath,
	]) {
		try {
			await unlinkIfExists(candidate);
		} catch {
			// Best-effort cleanup.
		}
	}

	const status = await getAppBindStatus(options);
	return {
		status,
		message: backup
			? `Unbound Codex app config ${backup.configPath}`
			: "Codex app bind was not configured",
	};
}

export function formatAppBindStatus(status: AppBindStatus): string {
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
