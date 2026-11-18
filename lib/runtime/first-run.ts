// Lazy first-run setup (audit roadmap §4.5.4).
//
// The npm postinstall script used to detect the packaged Codex desktop app,
// auto-bind runtime rotation, and install OS launcher shortcuts. That work now
// runs here, on the first CLI invocation, so package installs stay
// side-effect-free. The hook is guarded by a marker file under the runtime
// root (~/.codex/multi-auth), claimed with an exclusive create so concurrent
// first invocations run the setup at most once, and every step is best-effort:
// a failure is debug-logged (messages only — never tokens or emails) and the
// command proceeds normally.

import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureCodexCliFileAuthStore } from "../codex-cli/writer.js";
import { getCodexRuntimeRotationProxy, loadPluginConfig } from "../config.js";
import { withFileOperationRetry } from "../fs-retry.js";
import { createLogger } from "../logger.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { bindCodexAppRuntimeRotation, getAppBindStatus } from "./app-bind.js";

const log = createLogger("first-run");

const FIRST_RUN_MARKER_FILE = "first-run-setup.json";
// v2 adds the `authStore` step to the marker payload.
export const FIRST_RUN_MARKER_VERSION = 2;

const TRUE_VALUES = new Set(["1", "true", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "no"]);
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
];

export type FirstRunStepStatus = "completed" | "skipped" | "failed";

interface FirstRunSetupOutcome {
	appBind: FirstRunStepStatus;
	launcher: FirstRunStepStatus;
	authStore: FirstRunStepStatus;
}

type FirstRunSkipReason =
	| "ci"
	| "not-installed"
	| "already-done"
	| "claim-race"
	| "error";

export type FirstRunResult =
	| { ran: false; reason: FirstRunSkipReason }
	| { ran: false; reason: "migrated"; authStore: FirstRunStepStatus }
	| ({ ran: true } & FirstRunSetupOutcome);

interface FirstRunMarker {
	version?: number;
	startedAt?: number;
	completedAt?: number;
	appBind?: FirstRunStepStatus;
	launcher?: FirstRunStepStatus;
	authStore?: FirstRunStepStatus;
}

export interface FirstRunSetupDeps {
	env?: NodeJS.ProcessEnv;
	markerPath?: string;
	installedContext?: boolean;
	detectDesktopApp?: () => boolean;
	resolveRotation?: () => boolean;
	bindCodexApp?: () => Promise<FirstRunStepStatus>;
	installLauncher?: () => Promise<FirstRunStepStatus>;
	enforceAuthStore?: () => Promise<FirstRunStepStatus>;
	notify?: (message: string) => void;
	now?: () => number;
}

function readOptionalBoolean(value: string | undefined): boolean | null {
	if (value === undefined || value.trim().length === 0) return null;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return null;
}

function isEnabledEnvFlag(env: NodeJS.ProcessEnv, key: string): boolean {
	const value = env[key];
	if (value === undefined || value.trim().length === 0) return false;
	return readOptionalBoolean(value) !== false;
}

export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
	if (readOptionalBoolean(env.npm_config_ignore_scripts) === true) return true;
	return CI_ENV_KEYS.some((key) => isEnabledEnvFlag(env, key));
}

function directoryContainsEntryWithPrefix(
	directory: string,
	prefix: string,
): boolean {
	try {
		return readdirSync(directory, { withFileTypes: true }).some((entry) =>
			entry.name.startsWith(prefix),
		);
	} catch {
		return false;
	}
}

export interface DesktopAppDetectionOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
}

export function hasCodexDesktopApp(
	options: DesktopAppDetectionOptions = {},
): boolean {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();

	if (platform === "win32") {
		const localAppData =
			(env.LOCALAPPDATA ?? "").trim() || join(home, "AppData", "Local");
		const programFiles =
			(env.ProgramFiles ?? env.ProgramW6432 ?? "").trim() || "C:\\Program Files";
		return (
			directoryContainsEntryWithPrefix(
				join(localAppData, "Packages"),
				"OpenAI.Codex_",
			) ||
			directoryContainsEntryWithPrefix(
				join(programFiles, "WindowsApps"),
				"OpenAI.Codex_",
			)
		);
	}

	if (platform === "darwin") {
		return (
			existsSync("/Applications/Codex.app") ||
			existsSync(join(home, "Applications", "Codex.app"))
		);
	}

	return false;
}

export function resolveRotationEnabled(
	env: NodeJS.ProcessEnv = process.env,
	readConfigRotation: () => boolean = () =>
		getCodexRuntimeRotationProxy(loadPluginConfig()) === true,
): boolean {
	const envOverride = readOptionalBoolean(
		env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY,
	);
	if (envOverride !== null) return envOverride;
	try {
		return readConfigRotation();
	} catch {
		// Rotation defaults on; a malformed config must not block first-run setup.
		return true;
	}
}

export interface FirstRunBindGateOptions {
	env?: NodeJS.ProcessEnv;
	rotationEnabled: boolean;
	appDetected: boolean;
}

export function shouldBindCodexAppOnFirstRun(
	options: FirstRunBindGateOptions,
): boolean {
	const env = options.env ?? process.env;
	if (isCiEnvironment(env)) return false;

	const bindOverride = readOptionalBoolean(env.CODEX_MULTI_AUTH_APP_BIND);
	if (bindOverride !== null) return bindOverride;

	const installOverride = readOptionalBoolean(
		env.CODEX_MULTI_AUTH_APP_BIND_INSTALL,
	);
	if (installOverride !== null) return installOverride;

	if (!options.rotationEnabled) return false;
	return options.appDetected;
}

export interface FirstRunLauncherGateOptions {
	env?: NodeJS.ProcessEnv;
	rotationEnabled: boolean;
}

export function shouldInstallCodexAppLauncherOnFirstRun(
	options: FirstRunLauncherGateOptions,
): boolean {
	const env = options.env ?? process.env;
	if (isCiEnvironment(env)) return false;

	const installOverride = readOptionalBoolean(
		env.CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL,
	);
	if (installOverride !== null) return installOverride;

	return options.rotationEnabled;
}

/**
 * First-run setup only fires for a durable, global-style install. The old
 * postinstall gate was `npm_config_global`, which does not exist at CLI
 * runtime, so this approximates it from the module location instead:
 *
 * - must live under a `node_modules` segment (a dev checkout or the test
 *   suite runs straight from the repository tree and stays side-effect-free)
 * - must NOT be an npx cache run (`.../_npx/<hash>/node_modules/...`):
 *   someone trying the tool once must not get app bind/launcher mutations,
 *   and must not burn the once-only marker before a real install
 * - must NOT be a project-local install (module path inside the invoking
 *   working directory): `npm install` into an app's node_modules is not a
 *   machine-level install either
 */
export function isInstalledPackageContext(
	modulePath: string = fileURLToPath(import.meta.url),
	cwd: string = process.cwd(),
): boolean {
	const segments = modulePath.split(sep);
	if (!segments.includes("node_modules")) return false;
	if (segments.includes("_npx")) return false;
	const fromCwd = relative(cwd, modulePath);
	if (fromCwd && !fromCwd.startsWith("..") && !isAbsolute(fromCwd)) {
		return false;
	}
	return true;
}

function getFirstRunMarkerPath(): string {
	return join(getCodexMultiAuthDir(), FIRST_RUN_MARKER_FILE);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === code
	);
}

/**
 * Claims the marker with an exclusive create so that, across processes, at
 * most one first invocation runs the setup. Returns false when another
 * process already holds (or completed) the claim.
 */
function claimFirstRunMarker(markerPath: string, startedAt: number): boolean {
	mkdirSync(dirname(markerPath), { recursive: true });
	const payload = `${JSON.stringify(
		{ version: FIRST_RUN_MARKER_VERSION, startedAt },
		null,
		"\t",
	)}\n`;
	try {
		writeFileSync(markerPath, payload, { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if (isErrnoCode(error, "EEXIST")) return false;
		throw error;
	}
}

async function atomicWriteMarker(target: string, content: string): Promise<void> {
	await withFileOperationRetry(async () => {
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
			handle = await open(tempPath, "w", 0o600);
			await handle.writeFile(content, "utf8");
			await handle.sync();
			await handle.close();
			handle = null;
			await rename(tempPath, target);
			moved = true;
		} finally {
			await handle?.close().catch(() => undefined);
			if (!moved) {
				await unlink(tempPath).catch(() => undefined);
			}
		}
	});
}

async function finalizeFirstRunMarker(
	markerPath: string,
	startedAt: number,
	outcome: FirstRunSetupOutcome,
	now: () => number,
): Promise<void> {
	// A failed auth-store step records a pre-v2 version so the next invocation
	// replays it through the migration path — which reruns only that step, never
	// app bind or launcher install.
	const payload = `${JSON.stringify(
		{
			version: markerVersionFor(outcome.authStore, undefined),
			startedAt,
			completedAt: now(),
			appBind: outcome.appBind,
			launcher: outcome.launcher,
			authStore: outcome.authStore,
		},
		null,
		"\t",
	)}\n`;
	try {
		await atomicWriteMarker(markerPath, payload);
	} catch (error) {
		// The claim file already guarantees once-only behavior; losing the
		// completion details is acceptable.
		log.debug("first-run marker finalize failed", {
			error: errorMessage(error),
		});
	}
}

type LauncherInstallFn = (options: {
	log: (message: string) => void;
}) => Promise<unknown>;

/**
 * Resolves the launcher installer from the packaged scripts/ directory,
 * trying the dist layout first and the source layout second.
 *
 * @internal `candidateOverride` exists only so tests can exercise the
 * fallback order and failure modes with real temp files.
 */
export async function loadLauncherInstall(
	candidateOverride?: readonly string[],
): Promise<LauncherInstallFn | null> {
	const candidates = candidateOverride ?? [
		fileURLToPath(new URL("../../../scripts/codex-app-launcher.js", import.meta.url)),
		fileURLToPath(new URL("../../scripts/codex-app-launcher.js", import.meta.url)),
	];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const launcherModule = (await import(
			pathToFileURL(candidate).href
		)) as Record<string, unknown>;
		return typeof launcherModule.installCodexAppLauncher === "function"
			? (launcherModule.installCodexAppLauncher as LauncherInstallFn)
			: null;
	}
	return null;
}

async function defaultBindCodexApp(
	env: NodeJS.ProcessEnv,
	rotationEnabled: boolean,
	detectDesktopApp: () => boolean,
	notify: (message: string) => void,
): Promise<FirstRunStepStatus> {
	const currentStatus = await getAppBindStatus().catch(() => null);
	const appDetected = detectDesktopApp() || currentStatus?.bound === true;
	if (!shouldBindCodexAppOnFirstRun({ env, rotationEnabled, appDetected })) {
		return "skipped";
	}
	const result = await bindCodexAppRuntimeRotation();
	if (result?.message) {
		notify(result.message);
	}
	return "completed";
}

/**
 * Pins the official Codex CLI to the file-backed credential store.
 *
 * Enforcement used to be lazy — it only happened when something called
 * `setCodexCliActiveSelection` (switch, login, health check, repair). A user who
 * installed the package and drove Codex through a third-party front-end could
 * therefore stay on `cli_auth_credentials_store = "keychain"` indefinitely and
 * keep getting macOS login-keychain prompts (issue #641). Doing it at first run
 * closes that window before the official CLI ever reads its store.
 *
 * Deliberately not gated on `isCodexCliSyncEnabled()`: turning CLI sync off is a
 * statement about account mirroring, not a request to re-enable keychain
 * prompts. The `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0` opt-out is
 * honored inside `ensureCodexCliFileAuthStore` itself.
 */
async function defaultEnforceAuthStore(): Promise<FirstRunStepStatus> {
	return (await ensureCodexCliFileAuthStore()) ? "completed" : "skipped";
}

/**
 * Decides the version to persist after an auth-store attempt.
 *
 * Recording the current version after a *failed* step would strand the user:
 * `ensureFirstRunSetup` short-circuits on version alone, so a single transient
 * Windows `EPERM`/`EBUSY` on a locked `config.toml` would leave the CLI on
 * keychain mode permanently — the exact symptom this whole change exists to
 * remove. Staying pre-v2 costs one extra marker read per invocation and
 * self-heals as soon as the write succeeds, because the step is idempotent.
 *
 * `"skipped"` deliberately does bump. It is the normal outcome for a config
 * already pinned to `"file"`, so treating it as unfinished would mean the
 * marker never reaches the current version for healthy installs. It also covers
 * an explicit `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0` opt-out — a user
 * choice, not a failure — and if that opt-out is later removed, the
 * wrapper-startup guard and `doctor --fix` both still reconcile the config.
 */
function markerVersionFor(
	authStore: FirstRunStepStatus,
	previousVersion: number | undefined,
): number {
	if (authStore === "failed") return previousVersion ?? 1;
	return FIRST_RUN_MARKER_VERSION;
}

function readFirstRunMarker(markerPath: string): FirstRunMarker | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
		return typeof parsed === "object" && parsed !== null
			? (parsed as FirstRunMarker)
			: null;
	} catch {
		// An unreadable or truncated marker is treated as pre-v2 and migrated;
		// the migration only replays the idempotent auth-store step.
		return null;
	}
}

/**
 * Brings a marker written before the auth-store step existed up to the current
 * version.
 *
 * `ensureFirstRunSetup` short-circuits on marker existence, so bumping
 * `FIRST_RUN_MARKER_VERSION` on its own would leave every already-installed
 * user — precisely the population reporting repeated keychain prompts — without
 * the enforcement step forever.
 *
 * Only the auth-store step is replayed. Rerunning app bind or launcher install
 * would reinstall shortcuts and rebind the desktop app, which the user may have
 * deliberately removed since.
 *
 * No exclusive claim is taken, unlike the initial setup. Both operations here
 * are idempotent and atomic — `ensureCodexCliFileAuthStore` skips a config
 * already on `"file"`, and `atomicWriteMarker` renames into place — so
 * concurrent invocations converge on the same result instead of racing.
 */
async function migrateFirstRunMarker(
	markerPath: string,
	marker: FirstRunMarker,
	deps: FirstRunSetupDeps,
	now: () => number,
): Promise<FirstRunStepStatus> {
	let authStore: FirstRunStepStatus;
	try {
		authStore = await (deps.enforceAuthStore
			? deps.enforceAuthStore()
			: defaultEnforceAuthStore());
	} catch (error) {
		authStore = "failed";
		log.debug("first-run marker migration auth store step skipped", {
			error: errorMessage(error),
		});
	}

	const payload = `${JSON.stringify(
		{
			version: markerVersionFor(authStore, marker.version),
			startedAt: marker.startedAt ?? now(),
			completedAt: marker.completedAt ?? now(),
			appBind: marker.appBind ?? "skipped",
			launcher: marker.launcher ?? "skipped",
			authStore,
		},
		null,
		"\t",
	)}\n`;
	try {
		await atomicWriteMarker(markerPath, payload);
	} catch (error) {
		// Leaving the marker at v1 just means the idempotent step runs again on
		// the next invocation, so this is safe to swallow.
		log.debug("first-run marker migration write failed", {
			error: errorMessage(error),
		});
	}
	return authStore;
}

async function defaultInstallLauncher(
	env: NodeJS.ProcessEnv,
	rotationEnabled: boolean,
	notify: (message: string) => void,
): Promise<FirstRunStepStatus> {
	if (!shouldInstallCodexAppLauncherOnFirstRun({ env, rotationEnabled })) {
		return "skipped";
	}
	const installLauncher = await loadLauncherInstall();
	if (!installLauncher) return "skipped";
	await installLauncher({ log: notify });
	return "completed";
}

/**
 * Runs the lazily deferred install setup (Codex auth-store enforcement + app
 * bind + launcher routing) exactly once per runtime root. Never throws and
 * never blocks a command on failure: every error path resolves with a
 * skip/failed status and only debug-logs sanitized messages.
 */
export async function ensureFirstRunSetup(
	deps: FirstRunSetupDeps = {},
): Promise<FirstRunResult> {
	try {
		const env = deps.env ?? process.env;
		if (isCiEnvironment(env)) return { ran: false, reason: "ci" };
		const installed = deps.installedContext ?? isInstalledPackageContext();
		if (!installed) return { ran: false, reason: "not-installed" };
		const markerPath = deps.markerPath ?? getFirstRunMarkerPath();
		const now = deps.now ?? Date.now;
		if (existsSync(markerPath)) {
			const marker = readFirstRunMarker(markerPath);
			if ((marker?.version ?? 1) >= FIRST_RUN_MARKER_VERSION) {
				return { ran: false, reason: "already-done" };
			}
			return {
				ran: false,
				reason: "migrated",
				authStore: await migrateFirstRunMarker(
					markerPath,
					marker ?? {},
					deps,
					now,
				),
			};
		}
		const startedAt = now();
		if (!claimFirstRunMarker(markerPath, startedAt)) {
			return { ran: false, reason: "claim-race" };
		}

		// Library default goes through the structured logger; the CLI entrypoint
		// passes a stderr notify so interactive users still see bind messages.
		const notify = deps.notify ?? ((message: string) => log.info(message));
		const detectDesktopApp =
			deps.detectDesktopApp ?? (() => hasCodexDesktopApp({ env }));
		const rotationEnabled = deps.resolveRotation
			? deps.resolveRotation()
			: resolveRotationEnabled(env);

		const outcome: FirstRunSetupOutcome = {
			appBind: "skipped",
			launcher: "skipped",
			authStore: "skipped",
		};
		try {
			outcome.authStore = await (deps.enforceAuthStore
				? deps.enforceAuthStore()
				: defaultEnforceAuthStore());
		} catch (error) {
			outcome.authStore = "failed";
			log.debug("first-run codex auth store enforcement skipped", {
				error: errorMessage(error),
			});
		}
		try {
			outcome.appBind = await (deps.bindCodexApp
				? deps.bindCodexApp()
				: defaultBindCodexApp(env, rotationEnabled, detectDesktopApp, notify));
		} catch (error) {
			outcome.appBind = "failed";
			log.debug("first-run app bind skipped", { error: errorMessage(error) });
		}
		try {
			outcome.launcher = await (deps.installLauncher
				? deps.installLauncher()
				: defaultInstallLauncher(env, rotationEnabled, notify));
		} catch (error) {
			outcome.launcher = "failed";
			log.debug("first-run launcher install skipped", {
				error: errorMessage(error),
			});
		}

		await finalizeFirstRunMarker(markerPath, startedAt, outcome, now);
		return { ran: true, ...outcome };
	} catch (error) {
		log.debug("first-run setup skipped", { error: errorMessage(error) });
		return { ran: false, reason: "error" };
	}
}
