import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getCodexMultiAuthDir } from "../runtime-paths.js";

const RUNTIME_ROTATION_PROXY_PROVIDER_ID = "codex-multi-auth-runtime-proxy";
const APP_BIND_DIR_NAME = "app-bind";
const APP_BIND_STATE_FILE = "runtime-rotation-app-bind.json";
const APP_BIND_BACKUP_FILE = "codex-config-backup.json";
const APP_BIND_STATUS_FILE = "runtime-rotation-app-bind-status.json";
const WINDOWS_STARTUP_FILE = "Codex Multi Auth Runtime Router.cmd";
const MACOS_LAUNCH_AGENT_ID = "com.ndycode.codex-multi-auth.runtime-router";

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
	spawnDetached?: boolean;
	log?: (message: string) => void;
}

function tomlStringLiteral(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function removeRuntimeRotationProviderBlock(rawConfig: string): string {
	const lines = rawConfig.split(/\r?\n/);
	const output: string[] = [];
	let skipping = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === `[model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}]`) {
			skipping = true;
			continue;
		}
		if (skipping && /^\s*\[[^\]]+\]\s*$/.test(line)) {
			skipping = false;
		}
		if (!skipping) output.push(line);
	}
	return output.join(rawConfig.includes("\r\n") ? "\r\n" : "\n");
}

function rewriteTopLevelModelProvider(rawConfig: string): string {
	const lineEnding = rawConfig.includes("\r\n") ? "\r\n" : "\n";
	const lines = rawConfig.length > 0 ? rawConfig.split(/\r?\n/) : [];
	const rewrittenLine = `model_provider = ${tomlStringLiteral(RUNTIME_ROTATION_PROXY_PROVIDER_ID)}`;
	let replaced = false;
	const output: string[] = [];

	for (const line of lines) {
		const isTable = /^\s*\[[^\]]+\]\s*$/.test(line);
		if (!replaced && isTable) {
			output.push(rewrittenLine);
			replaced = true;
		}
		if (!replaced && /^\s*model_provider\s*=/.test(line)) {
			output.push(rewrittenLine);
			replaced = true;
			continue;
		}
		output.push(line);
	}

	if (!replaced) output.push(rewrittenLine);
	return output.join(lineEnding);
}

function extractTopLevelModelProviderLine(rawConfig: string): string | null {
	for (const line of rawConfig.split(/\r?\n/)) {
		if (/^\s*\[[^\]]+\]\s*$/.test(line)) return null;
		if (/^\s*model_provider\s*=/.test(line)) return line;
	}
	return null;
}

function restoreTopLevelModelProvider(currentConfig: string, originalConfig: string): string {
	const lineEnding = currentConfig.includes("\r\n") ? "\r\n" : "\n";
	const originalLine = extractTopLevelModelProviderLine(originalConfig);
	const lines = currentConfig.length > 0 ? currentConfig.split(/\r?\n/) : [];
	const output: string[] = [];
	let handled = false;

	for (const line of lines) {
		const isRuntimeProviderLine =
			/^\s*model_provider\s*=/.test(line) &&
			line.includes(RUNTIME_ROTATION_PROXY_PROVIDER_ID);
		if (isRuntimeProviderLine && !handled) {
			if (originalLine) output.push(originalLine);
			handled = true;
			continue;
		}
		output.push(line);
	}

	return output.join(lineEnding);
}

function ensureTrailingNewline(value: string): string {
	return value.replace(/[\r\n]*$/, "\n");
}

function createRuntimeRotationProviderBlock(baseUrl: string): string[] {
	return [
		`[model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}]`,
		'name = "Codex Multi-Auth Runtime Proxy"',
		`base_url = ${tomlStringLiteral(baseUrl)}`,
		'wire_api = "responses"',
	];
}

export function rewriteConfigTomlForAppBind(rawConfig: string, baseUrl: string): string {
	const lineEnding = rawConfig.includes("\r\n") ? "\r\n" : "\n";
	const withoutOldProvider = removeRuntimeRotationProviderBlock(rawConfig).replace(
		/[\r\n]*$/,
		"",
	);
	const withModelProvider = rewriteTopLevelModelProvider(withoutOldProvider).replace(
		/[\r\n]*$/,
		"",
	);
	return `${withModelProvider}${lineEnding}${lineEnding}${createRuntimeRotationProviderBlock(baseUrl).join(lineEnding)}${lineEnding}`;
}

export function restoreConfigTomlFromAppBind(currentConfig: string, originalConfig: string): string {
	const withoutProvider = removeRuntimeRotationProviderBlock(currentConfig);
	return ensureTrailingNewline(
		restoreTopLevelModelProvider(withoutProvider, originalConfig).replace(/[\r\n]*$/, ""),
	);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
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

function resolveRouterScriptPath(override?: string): string {
	if (override) return override;
	const candidates = [
		fileURLToPath(new URL("../../../scripts/codex-app-router.js", import.meta.url)),
		fileURLToPath(new URL("../../scripts/codex-app-router.js", import.meta.url)),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0] ?? "codex-app-router.js";
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
		routerScriptPath: resolveRouterScriptPath(options.routerScriptPath),
		startupPath:
			platform === "win32" ? resolveWindowsStartupPath(env, home) : null,
		launchAgentPath: platform === "darwin" ? resolveMacLaunchAgentPath(home) : null,
	};
}

async function findAvailablePort(host = "127.0.0.1"): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, host, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => {
				if (error) reject(error);
				else resolve(port);
			});
		});
	});
}

function createWindowsStartupCommand(state: AppBindState): string {
	return [
		"@echo off",
		`"${state.nodePath}" "${state.routerScriptPath}" --port ${state.port} --status "${state.statusPath}" --state "${state.statePath}" >> "${state.logPath}" 2>&1`,
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
		await writeFile(state.startupPath, createWindowsStartupCommand(state), "utf8");
		return;
	}
	if (state.platform === "darwin" && state.launchAgentPath) {
		await mkdir(dirname(state.launchAgentPath), { recursive: true });
		await writeFile(state.launchAgentPath, createMacLaunchAgentPlist(state), "utf8");
	}
}

async function removeAppBindStartup(state: AppBindState): Promise<void> {
	const candidates = [state.startupPath, state.launchAgentPath].filter(
		(path): path is string => typeof path === "string" && path.length > 0,
	);
	for (const candidate of candidates) {
		try {
			await unlink(candidate);
		} catch {
			// Best-effort cleanup.
		}
	}
}

function spawnRouter(state: AppBindState): void {
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
		],
		{
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		},
	);
	child.unref();
}

async function maybeStartRouter(state: AppBindState, options: AppBindOptions): Promise<boolean> {
	if (options.spawnDetached === false) return false;
	const router = await readRouterStatus(state.statusPath);
	if (router && isProcessAlive(router.pid) && router.state === "running") return false;
	spawnRouter(state);
	return true;
}

async function waitForRouterStatus(statusPath: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const router = await readRouterStatus(statusPath);
		if (router?.state === "running" && isProcessAlive(router.pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
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
	const platform = options.platform ?? process.platform;
	const now = options.now?.() ?? Date.now();
	const paths = resolveAppBindPaths(options);
	const existingState = await readAppBindState(paths.statePath);
	const port = existingState?.port ?? (await findAvailablePort());
	const host = existingState?.host ?? "127.0.0.1";
	const baseUrl = `http://${host}:${port}`;
	const { existed, content } = await readConfigIfExists(paths.configPath);
	const backup = (await readAppBindBackup(paths.backupPath)) ?? {
		version: 1,
		configPath: paths.configPath,
		existed,
		content,
		createdAt: now,
	};
	const boundConfig = rewriteConfigTomlForAppBind(content, baseUrl);
	const state: AppBindState = {
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
		startupPath: paths.startupPath,
		launchAgentPath: paths.launchAgentPath,
		boundConfigHash: sha256(boundConfig),
		updatedAt: now,
	};

	await mkdir(paths.bindDir, { recursive: true });
	await mkdir(dirname(paths.configPath), { recursive: true });
	await writeFile(paths.backupPath, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
	await writeFile(paths.configPath, boundConfig, "utf8");
	await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await writeAppBindStartup(state);
	const startedRouter = await maybeStartRouter(state, options);
	if (startedRouter) {
		await waitForRouterStatus(state.statusPath);
	}
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
			await writeFile(
				backup.configPath,
				restoreConfigTomlFromAppBind(current.content, backup.content),
				"utf8",
			);
		} else if (backup.existed) {
			await mkdir(dirname(backup.configPath), { recursive: true });
			await writeFile(backup.configPath, backup.content, "utf8");
		} else {
			try {
				await unlink(backup.configPath);
			} catch {
				// Missing config is already restored.
			}
		}
	} else if (state) {
		const current = await readConfigIfExists(state.configPath);
		if (current.existed) {
			await writeFile(
				state.configPath,
				restoreConfigTomlFromAppBind(current.content, ""),
				"utf8",
			);
		}
	}

	for (const candidate of [
		paths.statePath,
		paths.backupPath,
		paths.statusPath,
	]) {
		try {
			await unlink(candidate);
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
	if (status.router?.lastAccountLabel) {
		parts.push(`lastAccount=${status.router.lastAccountLabel}`);
	} else if (status.router?.lastAccountIndex !== null && status.router?.lastAccountIndex !== undefined) {
		parts.push(`lastAccount=Account ${status.router.lastAccountIndex + 1}`);
	}
	return `Codex app bind: ${parts.join(", ")}`;
}
