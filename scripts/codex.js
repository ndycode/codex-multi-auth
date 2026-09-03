#!/usr/bin/env node

import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { rm as rmAsync } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve as resolvePath, sep } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	resolveRealCodexBin as resolveRealCodexBinFromEnvironment,
	splitPathEntries,
} from "./codex-bin-resolver.js";
import { normalizeAuthAlias, shouldHandleMultiAuthAuth } from "./codex-routing.js";

const RETRYABLE_SHADOW_HOME_CLEANUP_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const SHADOW_HOME_CLEANUP_BACKOFF_MS = [20, 60, 120];
const SHADOW_HOME_ORPHAN_LOCK_STALE_AGE_MS = 2_000;
const SHADOW_HOME_SYNC_LOCK_WAIT_TIMEOUT_MS =
	SHADOW_HOME_ORPHAN_LOCK_STALE_AGE_MS +
	SHADOW_HOME_CLEANUP_BACKOFF_MS.reduce((total, value) => total + value, 0);
const SHADOW_HOME_STATE_FILES = ["auth.json", "accounts.json", ".codex-global-state.json"];
const RUNTIME_ROTATION_SHADOW_HOME_OMIT_STATE_FILES = new Set([
	"auth.json",
	"accounts.json",
]);
const RUNTIME_ROTATION_SHADOW_HOME_OMIT_ROOT_DIRS = new Set(["multi-auth"]);
const RUNTIME_ROTATION_SHADOW_HOME_LINK_ONLY_ROOT_DIRS = new Set([
	".sandbox",
	".sandbox-bin",
	".sandbox-secrets",
	".tmp",
	"ambient-suggestions",
	"archived_sessions",
	"backups",
	"cache",
	"generated_images",
	"log",
	"sqlite",
	"tmp",
	"understand-anything",
	"vendor_imports",
]);
const SHADOW_HOME_STATE_FILE_SET = new Set(SHADOW_HOME_STATE_FILES);
const SHADOW_HOME_CONFIG_FILE = "config.toml";
const SHADOW_HOME_SYNC_LOCK_DIR = ".codex-multi-auth-shadow-sync.lock";
const SHADOW_HOME_SYNC_STATE_FILE = ".codex-multi-auth-shadow-sync-state.json";
const APP_SERVER_ACCOUNT_DISPLAY_NAME = "codex-multi-auth";
const RUNTIME_CONSTANTS = await loadRuntimeConstants();
const RUNTIME_ROTATION_PROXY_PROVIDER_ID =
	RUNTIME_CONSTANTS.RUNTIME_ROTATION_PROXY_PROVIDER_ID;
const APP_SERVER_ACCOUNT_LABEL_ENV = "CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL";
const INTERNAL_RUNTIME_ROTATION_APP_HELPER_ARG =
	"--codex-multi-auth-runtime-app-helper";
const APP_RUNTIME_HELPER_OWNER_PID_ENV =
	"CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID";
const APP_RUNTIME_HELPER_REAL_CODEX_HOME_ENV =
	"CODEX_MULTI_AUTH_REAL_CODEX_HOME";
const APP_RUNTIME_HELPER_USE_CANONICAL_HOME_ENV =
	"CODEX_MULTI_AUTH_APP_ROTATION_USE_CANONICAL_HOME";
const APP_RUNTIME_HELPER_INSTALL_APP_SERVER_SHIM_ENV =
	"CODEX_MULTI_AUTH_APP_ROTATION_INSTALL_APP_SERVER_SHIM";
const APP_SERVER_CONFIG_ARGS_ENV =
	"CODEX_MULTI_AUTH_APP_SERVER_CONFIG_ARGS_JSON";
const APP_RUNTIME_HELPER_STATUS_FILE =
	RUNTIME_CONSTANTS.APP_RUNTIME_HELPER_STATUS_FILE;
const APP_RUNTIME_HELPER_OWNER_FILE =
	RUNTIME_CONSTANTS.APP_RUNTIME_HELPER_OWNER_FILE;
const DEFAULT_APP_RUNTIME_HELPER_IDLE_MS = 12 * 60 * 60 * 1000;
// Absolute ceiling on a helper's life, independent of the idle tracker. The
// idle reaper depends on activity accounting being correct; any bug there —
// PID reuse briefly reviving a dead owner is the observed one — previously
// produced an *unbounded* leak because nothing else bounded the process.
const DEFAULT_APP_RUNTIME_HELPER_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
// A helper whose launcher is gone is not idle in the same sense as one whose
// launcher is sitting at a prompt: nobody is coming back to it unless a
// detached consumer picked it up. The detach grace below hands helpers off
// optimistically — every launcher that exits cleanly within the window leaves
// its helper running — so short forwarded commands strand helpers that then
// hold the full idle timeout with no owner and no traffic. This window is the
// idle timeout that applies from the moment the owner is confirmed dead, and
// it only ever fires with zero open client connections, so a consumer that
// really did take the handoff is never reaped out from under.
const DEFAULT_APP_RUNTIME_HELPER_DETACHED_IDLE_MS = 15 * 60 * 1000;
const APP_RUNTIME_HELPER_OWNER_START_TIME_ENV =
	"CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS";
// Re-verify owner identity (not just PID liveness) at most this often; a
// process spawn per tick would cost more than the leak it prevents.
const APP_RUNTIME_HELPER_OWNER_IDENTITY_RECHECK_MS = 60_000;
// Status telemetry heartbeat: the tick's job is the timeout check, so status
// is republished only on change, plus a heartbeat so freshness readers work.
const APP_RUNTIME_HELPER_STATUS_HEARTBEAT_MS = 60_000;
const DEFAULT_APP_RUNTIME_HELPER_DETACH_GRACE_MS = 5_000;
const APP_RUNTIME_HELPER_LAUNCH_TIMEOUT_MS = 15_000;
const APP_SERVER_SHIM_DIR_NAME = "app-server-shims";
const APP_SERVER_SHIM_HELPER_PREFIX = "helper-";
const DEFAULT_STARTUP_UPDATE_NOTICE_BUDGET_MS = 3_000;
const DEFAULT_STATUS_QUOTA_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const STATUS_QUOTA_REFRESH_LOCK_STALE_MS = 10 * 60 * 1000;
const STATUS_QUOTA_REFRESH_LOCK_DIR = "status-quota-refresh.lock";
const STARTUP_UPDATE_NOTICE_TIMED_OUT = Symbol("startup-update-notice-timed-out");

// This wrapper is published (`package.json` ships `scripts/codex.js`), so every
// fault injector below runs in users' installs. Two guards keep them inert
// there. The first is an explicit opt-in: a single, greppable switch that must
// be set alongside any counter, so one stray counter in a shell profile or a CI
// environment cannot arm anything. The second is a strict parse — `parseInt`
// happily reads "2abc" as 2 and "1e3" as 1, which is how a value that was never
// meant to be a count arms an injector — so only a plain run of digits counts
// and everything else is zero. Zero means "never inject".
const TEST_FAULT_INJECTION_ENV = "CODEX_MULTI_AUTH_TEST_FAULT_INJECTION";

function resolveTestFaultInjectionCount(name, env = process.env) {
	if (env[TEST_FAULT_INJECTION_ENV] !== "1") return 0;
	const raw = (env[name] ?? "").trim();
	if (!/^\d+$/.test(raw)) return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

let shadowHomeCleanupBusyFailuresRemaining = resolveTestFaultInjectionCount(
	"CODEX_MULTI_AUTH_TEST_SHADOW_CLEANUP_BUSY_FAILURES",
);
let shadowHomeCleanupPreflightReadBusyFailuresRemaining =
	resolveTestFaultInjectionCount(
		"CODEX_MULTI_AUTH_TEST_SHADOW_PREFLIGHT_READ_BUSY_FAILURES",
	);
let shadowHomeSyncLockRecreateStaleCount = resolveTestFaultInjectionCount(
	"CODEX_MULTI_AUTH_TEST_SHADOW_LOCK_RECREATE_STALE_COUNT",
);
let shadowHomeSyncMetadataBusyFailuresRemaining = resolveTestFaultInjectionCount(
	"CODEX_MULTI_AUTH_TEST_SHADOW_SYNC_METADATA_BUSY_FAILURES",
);
let shadowHomeSyncLockOwnerWriteFailuresRemaining =
	resolveTestFaultInjectionCount(
		"CODEX_MULTI_AUTH_TEST_SHADOW_LOCK_OWNER_WRITE_FAILURES",
	);
let appServerShimFileCleanupBusyFailuresRemaining =
	resolveTestFaultInjectionCount(
		"CODEX_MULTI_AUTH_TEST_APP_SERVER_SHIM_FILE_CLEANUP_BUSY_FAILURES",
	);
let appServerShimCopyBusyFailuresRemaining = resolveTestFaultInjectionCount(
	"CODEX_MULTI_AUTH_TEST_APP_SERVER_SHIM_COPY_BUSY_FAILURES",
);
const shadowHomeCleanupRetryMarkerDir =
	(process.env.CODEX_MULTI_AUTH_TEST_SHADOW_RETRY_MARKER_DIR ?? "").trim();
let warnedInvalidRuntimeRotationProxyEnv = false;
let warnedPendingAccountReadIdOverflow = false;
let warnedShadowHomeSqliteLinkFailure = false;
const warnedShadowHomeLinkOnlyDirectoryFailures = new Set();
const warnedShadowHomeSqliteSidecarPlaceholderFailures = new Set();

async function loadRuntimeConstants() {
	const fallback = {
		RUNTIME_ROTATION_PROXY_PROVIDER_ID: `${APP_SERVER_ACCOUNT_DISPLAY_NAME}-runtime-proxy`,
		APP_RUNTIME_HELPER_STATUS_FILE: "runtime-rotation-app-helper.json",
		APP_RUNTIME_HELPER_OWNER_FILE: "runtime-rotation-app-helper-owner.json",
	};
	try {
		const mod = await import("../dist/lib/runtime-constants.js");
		return {
			RUNTIME_ROTATION_PROXY_PROVIDER_ID:
				typeof mod.RUNTIME_ROTATION_PROXY_PROVIDER_ID === "string"
					? mod.RUNTIME_ROTATION_PROXY_PROVIDER_ID
					: fallback.RUNTIME_ROTATION_PROXY_PROVIDER_ID,
			APP_RUNTIME_HELPER_STATUS_FILE:
				typeof mod.APP_RUNTIME_HELPER_STATUS_FILE === "string"
					? mod.APP_RUNTIME_HELPER_STATUS_FILE
					: fallback.APP_RUNTIME_HELPER_STATUS_FILE,
			APP_RUNTIME_HELPER_OWNER_FILE:
				typeof mod.APP_RUNTIME_HELPER_OWNER_FILE === "string"
					? mod.APP_RUNTIME_HELPER_OWNER_FILE
					: fallback.APP_RUNTIME_HELPER_OWNER_FILE,
		};
	} catch {
		// Keep wrapper startup resilient when dist has not been built yet.
	}
	return fallback;
}

function isRetryableShadowHomeCleanupError(error) {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return typeof code === "string" && RETRYABLE_SHADOW_HOME_CLEANUP_CODES.has(code);
}

function sleepSync(ms) {
	if (!Number.isFinite(ms) || ms <= 0) {
		return;
	}
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeDirectoryWithRetry(targetPath) {
	for (let attempt = 0; attempt <= SHADOW_HOME_CLEANUP_BACKOFF_MS.length; attempt += 1) {
		try {
			maybeThrowSimulatedShadowHomeBusyError();
			rmSync(targetPath, { recursive: true, force: true });
			return;
		} catch (error) {
			if (
				!isRetryableShadowHomeCleanupError(error) ||
				attempt === SHADOW_HOME_CLEANUP_BACKOFF_MS.length
			) {
				throw error;
			}
			sleepSync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
		}
	}
}

function withSynchronousFileOperationRetry(operation) {
	for (
		let attempt = 0;
		attempt <= SHADOW_HOME_CLEANUP_BACKOFF_MS.length;
		attempt += 1
	) {
		try {
			return operation();
		} catch (error) {
			if (
				!isRetryableShadowHomeCleanupError(error) ||
				attempt === SHADOW_HOME_CLEANUP_BACKOFF_MS.length
			) {
				throw error;
			}
			sleepSync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
		}
	}
}

function maybeThrowSimulatedAppServerShimFileError(kind) {
	const remaining =
		kind === "copy"
			? appServerShimCopyBusyFailuresRemaining
			: appServerShimFileCleanupBusyFailuresRemaining;
	if (remaining <= 0) return;
	if (kind === "copy") appServerShimCopyBusyFailuresRemaining -= 1;
	else appServerShimFileCleanupBusyFailuresRemaining -= 1;
	const error = new Error(`simulated app-server shim ${kind} EBUSY`);
	error.code = "EBUSY";
	throw error;
}

/**
 * Best-effort async directory removal for hot-path callbacks (e.g. the
 * status-refresh child's close/error handlers, which fire on the PARENT event
 * loop while Codex is running). Unlike removeDirectoryWithRetry this never calls
 * the Atomics.wait-backed sleepSync, so a retryable Windows lock (EBUSY/EPERM/
 * ENOTEMPTY) can't stall the event loop for up to ~200ms. fsPromises.rm has its
 * own internal retry (maxRetries) and yields between attempts. On persistent
 * failure we give up silently — the 10-minute stale-lock recovery reclaims it.
 */
async function removeDirectoryBestEffortAsync(targetPath) {
	try {
		await rmAsync(targetPath, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 20,
		});
	} catch {
		// Best-effort; stale-lock recovery handles any leftover.
	}
}

function hydrateCliVersionEnv() {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require("../package.json");
		const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
		if (version.length > 0) {
			process.env.CODEX_MULTI_AUTH_CLI_VERSION = version;
		}
	} catch {
		// Best effort only.
	}
}

function readJsonFileQuiet(path) {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function resolveMultiAuthDirFromEnv(env = process.env) {
	const configured = (env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (configured.length > 0) return configured;
	return join(resolveCodexHomeDir(env), "multi-auth");
}

function resolveAccountsPath(env = process.env, dir = resolveMultiAuthDirFromEnv(env)) {
	return join(dir, "openai-codex-accounts.json");
}

function resolveQuotaCachePath(env = process.env, dir = resolveMultiAuthDirFromEnv(env)) {
	return join(dir, "quota-cache.json");
}

function resolveRuntimeObservabilityPath(env = process.env, dir = resolveMultiAuthDirFromEnv(env)) {
	return join(dir, "runtime-observability.json");
}

/**
 * Resolve the multi-auth dir the status line should read ACCOUNTS from, mirroring
 * the runtime's own account scoping (lib/runtime/account-scope.ts):
 *   - when perProjectAccounts is enabled, Codex CLI sync is OFF, an explicit
 *     CODEX_MULTI_AUTH_DIR is NOT set, and the cwd resolves to a git/project root,
 *     accounts live in the per-project pool at
 *     <configDir>/projects/<project-key>/openai-codex-accounts.json;
 *   - otherwise the global dir is used.
 * Only the ACCOUNTS pool is per-project; quota-cache.json and
 * runtime-observability.json remain global (lib: getCodexMultiAuthDir). Reusing
 * the built dist helpers (never re-deriving project keys from raw paths, per
 * AGENTS.md) keeps the status line consistent with what Codex routes through.
 * Any failure falls back to the global dir so the launcher never breaks.
 */
async function resolveStatusAccountsDir(env = process.env) {
	const globalDir = resolveMultiAuthDirFromEnv(env);
	try {
		const [configMod, pathsMod, stateMod] = await Promise.all([
			import("../dist/lib/config.js"),
			import("../dist/lib/storage/paths.js"),
			import("../dist/lib/codex-cli/state.js"),
		]);
		if (
			typeof configMod.loadPluginConfig !== "function" ||
			typeof configMod.getPerProjectAccounts !== "function" ||
			typeof pathsMod.findProjectRoot !== "function" ||
			typeof pathsMod.resolveProjectStorageIdentityRoot !== "function" ||
			typeof pathsMod.getProjectGlobalConfigDir !== "function"
		) {
			return globalDir;
		}
		const pluginConfig = configMod.loadPluginConfig();
		if (configMod.getPerProjectAccounts(pluginConfig) !== true) return globalDir;
		// Codex CLI sync forces the global pool (account-scope.ts), so honor that.
		if (typeof stateMod.isCodexCliSyncEnabled === "function" && stateMod.isCodexCliSyncEnabled()) {
			return globalDir;
		}
		const projectRoot = pathsMod.findProjectRoot(process.cwd());
		if (!projectRoot) return globalDir;
		// getProjectGlobalConfigDir grounds the per-project pool in the dist config
		// dir, which itself honors CODEX_MULTI_AUTH_DIR / CODEX_HOME — so the pool is
		// nested under an explicit dir exactly as the runtime writes it. No special
		// casing of CODEX_MULTI_AUTH_DIR here, or the status line would diverge.
		const identityRoot = pathsMod.resolveProjectStorageIdentityRoot(projectRoot);
		return pathsMod.getProjectGlobalConfigDir(identityRoot);
	} catch {
		return globalDir;
	}
}

function normalizeAccountIdentifier(value) {
	return typeof value === "string" && value.trim().length > 0
		? value.trim().toLowerCase()
		: "";
}

function findAccountIndexByIdOrEmail(accounts, id, email) {
	const normalizedId = normalizeAccountIdentifier(id);
	const normalizedEmail = normalizeAccountIdentifier(email);
	for (let index = 0; index < accounts.length; index += 1) {
		const account = accounts[index];
		if (!account || typeof account !== "object") continue;
		if (
			normalizedId &&
			normalizeAccountIdentifier(account.accountId) === normalizedId
		) {
			return index;
		}
		if (
			normalizedEmail &&
			normalizeAccountIdentifier(account.email) === normalizedEmail
		) {
			return index;
		}
	}
	return -1;
}

// --- Forced-account selection (`--account`, issue #623) ---------------------
//
// `codex-multi-auth-codex --account <selector>` (or the CODEX_MULTI_AUTH_FORCE_ACCOUNT
// env var) pins ONE account for a single invocation. The selector is resolved to a
// 0-based index here in the launcher and published as CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX,
// which the runtime rotation proxy consumes as an ephemeral pin — never touching the
// persisted `switch` pin on disk. The flag wins over the env var.
const FORCE_ACCOUNT_ENV = "CODEX_MULTI_AUTH_FORCE_ACCOUNT";
const FORCE_ACCOUNT_INDEX_ENV = "CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX";

/**
 * Extract and strip `--account <sel>` / `--account=<sel>` from a forwarded arg
 * list. The flag is a launcher concept; real Codex has no `--account`, so it must
 * never be forwarded. Returns { selector, strippedArgs, error }; selector is null
 * when the flag is absent. The last occurrence wins if repeated.
 */
function extractForcedAccountFlag(args) {
	const strippedArgs = [];
	let selector = null;
	let sawFlag = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		// `--` ends option parsing: everything after it is Codex's root
		// `[PROMPT]` text. A `--account` spelled in there is the user's prompt,
		// not a launcher flag — stripping it would both mangle the prompt and
		// silently pin the run to an account nobody selected.
		if (arg === "--") {
			strippedArgs.push(...args.slice(index));
			break;
		}
		if (arg === "--account") {
			sawFlag = true;
			const next = args[index + 1];
			if (typeof next !== "string") {
				return {
					selector: null,
					strippedArgs: args,
					error:
						"codex-multi-auth: --account requires a value (account index, email, or account id).",
				};
			}
			selector = next;
			index += 1;
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--account=")) {
			sawFlag = true;
			selector = arg.slice("--account=".length);
			continue;
		}
		strippedArgs.push(arg);
	}
	return { selector, strippedArgs, error: null, sawFlag };
}

/**
 * Resolve the effective forced-account selector from args (flag) or environment,
 * with the flag taking precedence. Returns { selector, strippedArgs, error };
 * selector is null when neither source requests a forced account.
 */
function resolveForcedAccountSelector(rawArgs, env = process.env) {
	const { selector: flagSelector, strippedArgs, error, sawFlag } =
		extractForcedAccountFlag(rawArgs);
	if (error) {
		return { selector: null, strippedArgs, error };
	}
	if (sawFlag) {
		const trimmed = flagSelector.trim();
		if (trimmed.length === 0) {
			return {
				selector: null,
				strippedArgs,
				error:
					"codex-multi-auth: --account requires a non-empty value (account index, email, or account id).",
			};
		}
		return { selector: trimmed, strippedArgs, error: null };
	}
	const envSelector = (env[FORCE_ACCOUNT_ENV] ?? "").trim();
	if (envSelector.length > 0) {
		return { selector: envSelector, strippedArgs, error: null };
	}
	return { selector: null, strippedArgs, error: null };
}

function formatForcedAccountList(accounts) {
	const lines = accounts.map((account, index) => {
		const email =
			typeof account?.email === "string" && account.email.trim().length > 0
				? account.email.trim()
				: `account ${index + 1}`;
		return `  ${index + 1}. ${email}`;
	});
	return `Available accounts:\n${lines.join("\n")}`;
}

/**
 * Resolve a forced-account selector to a 0-based index against the same scoped
 * accounts pool the runtime rotation proxy will load. Selector forms: a 1-based
 * integer index, an email, or an account id. Returns { ok, index } or
 * { ok: false, error }.
 */
async function resolveForcedAccountIndex(selector, env = process.env) {
	const accountsDir = await resolveStatusAccountsDir(env);
	const storage = readJsonFileQuiet(resolveAccountsPath(env, accountsDir));
	const accounts = Array.isArray(storage?.accounts) ? storage.accounts : [];
	if (accounts.length === 0) {
		return {
			ok: false,
			error:
				"codex-multi-auth: --account was set but no Codex accounts are configured. Run `codex-multi-auth login` first.",
		};
	}
	if (/^\d+$/.test(selector)) {
		const oneBased = Number.parseInt(selector, 10);
		if (oneBased < 1 || oneBased > accounts.length) {
			return {
				ok: false,
				error: `codex-multi-auth: --account ${selector} is out of range (have ${accounts.length} account${
					accounts.length === 1 ? "" : "s"
				}).\n${formatForcedAccountList(accounts)}`,
			};
		}
		return { ok: true, index: oneBased - 1 };
	}
	const index = findAccountIndexByIdOrEmail(accounts, selector, selector);
	if (index < 0) {
		return {
			ok: false,
			error: `codex-multi-auth: --account "${selector}" did not match any configured account.\n${formatForcedAccountList(accounts)}`,
		};
	}
	return { ok: true, index };
}

/**
 * Preflight the `--account` flag / env var before forwarding to Codex. On success
 * returns { forwardArgs } with the flag stripped and (when a forced account was
 * requested) CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX published on the environment for
 * the proxy to consume. On failure returns { error } so the caller can exit
 * non-zero WITHOUT launching Codex — a forced account must never silently fall
 * back to a different one.
 */
async function applyForcedAccountSelection(rawArgs, env = process.env) {
	const forced = resolveForcedAccountSelector(rawArgs, env);
	if (forced.error) {
		return { error: forced.error };
	}
	if (forced.selector === null) {
		// Defensive: the resolved-index var is internal and only ever set below.
		// Clear any stray value from the ambient environment so a request without
		// --account can never inherit an unintended pin.
		delete env[FORCE_ACCOUNT_INDEX_ENV];
		return { forwardArgs: rawArgs };
	}
	// The pin can only be honored when the runtime rotation proxy is active for
	// this command; otherwise the run would silently use a non-forced account,
	// so fail hard instead of ignoring the flag.
	if (!(await isRuntimeRotationProxyEnabled(forced.strippedArgs, env))) {
		return {
			error: [
				"codex-multi-auth: --account requires the runtime rotation proxy, which is not active for this command.",
				"Enable it with `codex-multi-auth rotation enable`, and make sure CODEX_MULTI_AUTH_BYPASS is not set.",
			].join("\n"),
		};
	}
	const resolved = await resolveForcedAccountIndex(forced.selector, env);
	if (!resolved.ok) {
		return { error: resolved.error };
	}
	env[FORCE_ACCOUNT_INDEX_ENV] = String(resolved.index);
	return { forwardArgs: forced.strippedArgs };
}

function resolveModelFamilyForStatus(model) {
	// `resolveStatusModel` hands over the raw `--model` / `-m` value or the
	// config value verbatim, so a provider-qualified id arrives intact. Every
	// branch below is a `startsWith`, so `openai/gpt-6` used to match none of
	// them and return null, dropping status routing back to `activeIndex`
	// instead of the family index. Strip the prefix once, for all of them.
	const stripped =
		typeof model === "string" ? stripProviderPrefix(model.trim()) : "";
	const normalized = typeof stripped === "string" ? stripped.toLowerCase() : "";
	// GPT-6 Astra and the Daybreak cyber models share the gpt-5.2 prompt family
	// with the GPT-5.6 general tiers (see lib/request/helpers/model-map.ts
	// MODEL_PROFILES). Daybreak has to be checked explicitly: its slug matches
	// none of the branches below, so it used to fall through to `null` and get
	// bucketed against no family at all.
	if (
		(normalized.startsWith("gpt-6") || normalized.startsWith("astra")) &&
		!normalized.includes("codex")
	) {
		return "gpt-5.2";
	}
	if (normalized.includes("daybreak")) return "gpt-5.2";
	// GPT-5.6 general tiers share the gpt-5.2 prompt family (see
	// lib/request/helpers/model-map.ts MODEL_PROFILES). Check before the generic
	// gpt-5 catch-all, which would otherwise mis-bucket them as codex.
	if (normalized.startsWith("gpt-5.6")) return "gpt-5.2";
	if (normalized.startsWith("gpt-5.2")) return "gpt-5.2";
	if (normalized.startsWith("gpt-5.1")) return "gpt-5.1";
	if (normalized.includes("codex-max")) return "codex-max";
	if (normalized.includes("codex")) return "codex";
	if (normalized.startsWith("gpt-5")) return "gpt-5-codex";
	return null;
}

function resolveStatusAccountIndex(storage, runtime, model) {
	const accounts = Array.isArray(storage?.accounts) ? storage.accounts : [];
	if (accounts.length === 0) return -1;

	const runtimeUpdatedAt =
		typeof runtime?.lastAccountUpdatedAt === "number"
			? runtime.lastAccountUpdatedAt
			: typeof runtime?.updatedAt === "number"
				? runtime.updatedAt
				: 0;
	if (Date.now() - runtimeUpdatedAt <= 60 * 60 * 1000) {
		const runtimeIndex = findAccountIndexByIdOrEmail(
			accounts,
			runtime?.lastAccountId,
			runtime?.lastAccountEmail,
		);
		if (runtimeIndex >= 0) return runtimeIndex;
		if (
			typeof runtime?.lastAccountIndex === "number" &&
			runtime.lastAccountIndex >= 0 &&
			runtime.lastAccountIndex < accounts.length
		) {
			return runtime.lastAccountIndex;
		}
	}

	const family = resolveModelFamilyForStatus(model);
	const familyIndex =
		family && storage?.activeIndexByFamily && typeof storage.activeIndexByFamily[family] === "number"
			? storage.activeIndexByFamily[family]
			: undefined;
	if (
		typeof familyIndex === "number" &&
		familyIndex >= 0 &&
		familyIndex < accounts.length
	) {
		return familyIndex;
	}
	if (
		typeof storage?.activeIndex === "number" &&
		storage.activeIndex >= 0 &&
		storage.activeIndex < accounts.length
	) {
		return storage.activeIndex;
	}
	return 0;
}

function extractConfigAssignmentValue(rawConfig, key) {
	const pattern = new RegExp(`^\\s*${key}\\s*=\\s*([^\\n#]+)`, "m");
	const match = rawConfig.match(pattern);
	if (!match) return null;
	const rawValue = (match[1] ?? "").trim();
	const quoted = rawValue.match(/^["'](.*)["']$/);
	return (quoted ? quoted[1] : rawValue).trim() || null;
}

function readCodexConfigValue(env, key) {
	const configPath = join(resolveCodexHomeDir(env), "config.toml");
	try {
		if (!existsSync(configPath)) return null;
		return extractConfigAssignmentValue(readFileSync(configPath, "utf8"), key);
	} catch {
		return null;
	}
}

function extractArgValue(args, longName, shortName) {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === longName || (shortName && arg === shortName)) {
			const next = args[index + 1];
			return typeof next === "string" ? next : null;
		}
		if (arg.startsWith(`${longName}=`)) {
			return arg.slice(longName.length + 1);
		}
	}
	return null;
}

function extractConfigOverrideValue(args, key) {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		let assignment = null;
		if (arg === "-c" || arg === "--config") {
			assignment = args[index + 1] ?? null;
		} else if (arg.startsWith("-c=")) {
			assignment = arg.slice(3);
		} else if (arg.startsWith("--config=")) {
			assignment = arg.slice("--config=".length);
		}
		if (typeof assignment !== "string") continue;
		const separator = assignment.indexOf("=");
		if (separator <= 0) continue;
		if (assignment.slice(0, separator).trim() !== key) continue;
		return assignment
			.slice(separator + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
	}
	return null;
}

function resolveStatusModel(args, env = process.env) {
	return (
		extractArgValue(args, "--model", "-m") ??
		extractConfigOverrideValue(args, "model") ??
		readCodexConfigValue(env, "model") ??
		"unknown-model"
	);
}

function resolveStatusReasoningEffort(args, env = process.env) {
	return (
		extractConfigOverrideValue(args, "model_reasoning_effort") ??
		readCodexConfigValue(env, "model_reasoning_effort") ??
		"unknown"
	);
}

function formatStatusPath(cwd = process.cwd(), home = homedir()) {
	const resolvedCwd = resolvePath(cwd);
	const resolvedHome = resolvePath(home);
	if (resolvedCwd === resolvedHome) return "~";
	// Use the platform separator, not a hardcoded "/": on Windows resolvePath
	// returns backslash paths (C:\Users\user\project), so the old "/"-anchored
	// prefix check never matched and the cwd was never abbreviated to ~. `sep`
	// keeps the boundary check correct on both POSIX and Windows.
	const prefix = `${resolvedHome}${sep}`;
	if (resolvedCwd.startsWith(prefix)) {
		// Normalize the remainder to forward slashes for a stable, readable status
		// line regardless of the host separator.
		return `~/${resolvedCwd.slice(prefix.length).split(sep).join("/")}`;
	}
	return resolvedCwd;
}

function formatStatusResetTime(resetAtMs) {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs) || resetAtMs <= 0) {
		return null;
	}
	const date = new Date(resetAtMs);
	if (!Number.isFinite(date.getTime())) return null;
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatStatusResetDate(resetAtMs) {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs) || resetAtMs <= 0) {
		return null;
	}
	const date = new Date(resetAtMs);
	if (!Number.isFinite(date.getTime())) return null;
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatCacheAge(updatedAt) {
	if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) {
		return "stale";
	}
	const ageMs = Math.max(0, Date.now() - updatedAt);
	if (ageMs < 60_000) return "now";
	if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m`;
	return `${Math.floor(ageMs / (60 * 60_000))}h`;
}

function getQuotaEntryForAccount(quotaCache, account) {
	const byAccountId =
		quotaCache && typeof quotaCache === "object" && quotaCache.byAccountId
			? quotaCache.byAccountId
			: {};
	const byEmail =
		quotaCache && typeof quotaCache === "object" && quotaCache.byEmail
			? quotaCache.byEmail
			: {};
	const accountId = typeof account?.accountId === "string" ? account.accountId : "";
	const email = typeof account?.email === "string" ? account.email.toLowerCase() : "";
	return byAccountId?.[accountId] ?? byEmail?.[email] ?? null;
}

function formatUsageWindow(label, window, resetFormatter) {
	const used =
		typeof window?.usedPercent === "number" && Number.isFinite(window.usedPercent)
			? Math.max(0, Math.min(100, Math.round(window.usedPercent)))
			: null;
	const reset = resetFormatter(window?.resetAtMs);
	if (used === null && !reset) return null;
	if (used === null) return `${label} resets ${reset}`;
	if (!reset) return `${label} ${used}%`;
	return `${label} ${used}% ${reset}`;
}

function formatUsageSegment(entry) {
	const primary = formatUsageWindow("5h", entry?.primary, formatStatusResetTime);
	const secondary = formatUsageWindow("week", entry?.secondary, formatStatusResetDate);
	const parts = [primary, secondary].filter(Boolean);
	return parts.length > 0 ? parts.join(" | ") : "usage cached";
}

function formatPlan(planType) {
	if (typeof planType !== "string" || planType.trim().length === 0) return "Plan?";
	const normalized = planType.trim();
	if (normalized.length <= 1) return normalized.toUpperCase();
	return `${normalized[0].toUpperCase()}${normalized.slice(1).toLowerCase()}`;
}

function shouldShowForwardStatus(args, env = process.env) {
	const override = (env.CODEX_MULTI_AUTH_STATUSLINE ?? "").trim().toLowerCase();
	if (new Set(["0", "false", "no", "off"]).has(override)) return false;
	if (new Set(["1", "true", "yes", "on"]).has(override)) return true;
	if ((env.CODEX_MULTI_AUTH_STATUS_REFRESH_CHILD ?? "").trim() === "1") return false;
	if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V")) {
		return false;
	}
	return process.stderr.isTTY === true;
}

function formatForwardStatusLine(rawArgs, env = process.env, accountsDir = resolveMultiAuthDirFromEnv(env)) {
	// Only the accounts pool is per-project; quota-cache.json and
	// runtime-observability.json are global (lib: getCodexMultiAuthDir), so read
	// accounts from the (possibly project-scoped) dir and the rest from global.
	const storage = readJsonFileQuiet(resolveAccountsPath(env, accountsDir));
	const accounts = Array.isArray(storage?.accounts) ? storage.accounts : [];
	if (accounts.length === 0) return null;

	const runtime = readJsonFileQuiet(resolveRuntimeObservabilityPath(env));
	const quotaCache = readJsonFileQuiet(resolveQuotaCachePath(env));
	const model = resolveStatusModel(rawArgs, env);
	const effort = resolveStatusReasoningEffort(rawArgs, env);
	const accountIndex = resolveStatusAccountIndex(storage, runtime, model);
	const account = accounts[accountIndex];
	if (!account || typeof account !== "object") return null;

	const quotaEntry = getQuotaEntryForAccount(quotaCache, account);
	const email = typeof account.email === "string" && account.email.trim()
		? account.email.trim()
		: `Account ${accountIndex + 1}`;
	const plan = formatPlan(quotaEntry?.planType);
	const usage = formatUsageSegment(quotaEntry);
	const cacheAge = formatCacheAge(quotaEntry?.updatedAt);
	const parts = [
		"codex-multi-auth",
		`${model} ${effort}`,
		formatStatusPath(),
		`Account ${accountIndex + 1}`,
		usage,
		`${email}(${plan})`,
		`cache ${cacheAge}`,
	];
	return parts.join(" | ");
}

async function maybePrintForwardStatusLine(rawArgs, env = process.env) {
	if (!shouldShowForwardStatus(rawArgs, env)) return;
	const accountsDir = await resolveStatusAccountsDir(env);
	const line = formatForwardStatusLine(rawArgs, env, accountsDir);
	if (!line) return;
	process.stderr.write(`${line}\n`);
}

function parseDurationMs(value, fallback) {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (trimmed.length === 0) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}

function quotaCacheNeedsRefresh(env = process.env) {
	const intervalMs = parseDurationMs(
		env.CODEX_MULTI_AUTH_STATUS_QUOTA_REFRESH_INTERVAL_MS,
		DEFAULT_STATUS_QUOTA_REFRESH_INTERVAL_MS,
	);
	if (intervalMs <= 0) return false;
	const cache = readJsonFileQuiet(resolveQuotaCachePath(env));
	const entries = [
		...Object.values(cache?.byAccountId ?? {}),
		...Object.values(cache?.byEmail ?? {}),
	].filter((entry) => entry && typeof entry === "object");
	if (entries.length === 0) return true;
	const newest = Math.max(
		...entries.map((entry) =>
			typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
				? entry.updatedAt
				: 0,
		),
	);
	return newest <= 0 || Date.now() - newest >= intervalMs;
}

function acquireStatusRefreshLock(env = process.env) {
	const lockPath = join(resolveMultiAuthDirFromEnv(env), STATUS_QUOTA_REFRESH_LOCK_DIR);
	try {
		mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "owner.json"),
			`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
			{ mode: 0o600 },
		);
		return { lockPath, acquired: true };
	} catch {
		try {
			const stat = statSync(lockPath);
			if (Date.now() - stat.mtimeMs > STATUS_QUOTA_REFRESH_LOCK_STALE_MS) {
				// Known, bounded TOCTOU: two processes that both observe a stale lock
				// will both rmSync({force:true}) (both succeed) then race on mkdirSync;
				// only one wins, so dual lock acquisition is still prevented. The
				// residual risk is evicting a refresh owner that is merely SLOW (alive,
				// holding the lock past the stale threshold) rather than dead, which can
				// briefly yield two `forecast --live --json` children. That is benign
				// here — the refresh is idempotent, read-mostly, and rate-limited by the
				// cache TTL — so we accept it rather than add a heavier liveness probe.
				removeDirectoryWithRetry(lockPath);
				mkdirSync(lockPath);
				writeFileSync(
					join(lockPath, "owner.json"),
					`${JSON.stringify({ pid: process.pid, createdAt: Date.now(), recovered: true })}\n`,
					{ mode: 0o600 },
				);
				return { lockPath, acquired: true };
			}
		} catch {
			// Another process can win the race; skip refresh.
		}
	}
	return { lockPath, acquired: false };
}

function maybeRefreshQuotaCacheInBackground(env = process.env) {
	if ((env.CODEX_MULTI_AUTH_STATUS_REFRESH_CHILD ?? "").trim() === "1") return;
	if (!quotaCacheNeedsRefresh(env)) return;
	const { lockPath, acquired } = acquireStatusRefreshLock(env);
	if (!acquired) return;

	const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "codex-multi-auth.js");
	// Note: the child is detached + unref'd so it outlives this short-lived launcher
	// process. The close/error handlers below remove the lock dir, but if the parent
	// exits before the child settles they will NOT fire — in that case the lock is
	// reclaimed by the 10-minute stale-lock recovery in acquireStatusRefreshLock.
	const refreshChildEnv = {
		...env,
		CODEX_MULTI_AUTH_STATUS_REFRESH_CHILD: "1",
		CODEX_MULTI_AUTH_STATUSLINE: "0",
	};
	// A forced-account pin is scoped to a single forwarded Codex run; this
	// management child (`forecast`) must never inherit it, so it can never be
	// coupled to a specific account if a future change routes it through the proxy.
	delete refreshChildEnv[FORCE_ACCOUNT_INDEX_ENV];
	const child = spawn(
		process.execPath,
		[scriptPath, "forecast", "--live", "--json"],
		{
			env: refreshChildEnv,
			stdio: "ignore",
			detached: true,
		},
	);
	child.once("close", () => {
		// Async, non-blocking: these handlers fire on the parent event loop while
		// Codex is running, so the cleanup must never block it on a Windows lock.
		void removeDirectoryBestEffortAsync(lockPath);
	});
	child.once("error", () => {
		void removeDirectoryBestEffortAsync(lockPath);
	});
	child.unref();
}

function isRotationEnableCommand(args) {
	return args[0] === "auth" && args[1] === "rotation" && args[2] === "enable";
}

function shouldAutoInstallCodexAppLauncher(env = process.env) {
	const override = (env.CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL ?? "1").trim().toLowerCase();
	return !new Set(["0", "false", "no"]).has(override);
}

async function maybeInstallCodexAppLauncherAfterRotationEnable(args, exitCode) {
	if (exitCode !== 0 || !isRotationEnableCommand(args)) {
		return;
	}
	if (!shouldAutoInstallCodexAppLauncher()) {
		return;
	}
	try {
		const mod = await import("./codex-app-launcher.js");
		if (typeof mod.installCodexAppLauncher !== "function") {
			return;
		}
		await mod.installCodexAppLauncher({
			log: (message) => console.error(`codex-multi-auth: ${message}`),
		});
	} catch (error) {
		console.error(
			`codex-multi-auth: could not route Codex app launchers: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function loadRunCodexMultiAuthCli() {
	try {
		const mod = await import("../dist/lib/codex-manager.js");
		if (typeof mod.runCodexMultiAuthCli !== "function") {
			console.error(
				"dist/lib/codex-manager.js is missing required export: runCodexMultiAuthCli",
			);
			return null;
		}
		return mod.runCodexMultiAuthCli;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			console.error(
				[
					"codex-multi-auth auth commands require built runtime files, but dist output is missing.",
					"Run: npm run build",
				].join("\n"),
			);
			return null;
		}
		throw error;
	}
}

async function loadRuntimeRotationProxyModule() {
	try {
		const mod = await import("../dist/lib/runtime-rotation-proxy.js");
		if (typeof mod.startRuntimeRotationProxy !== "function") {
			console.error(
				"dist/lib/runtime-rotation-proxy.js is missing required export: startRuntimeRotationProxy",
			);
			return null;
		}
		return mod;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			console.error(
				[
					"codex-multi-auth runtime rotation proxy requires built runtime files, but dist output is missing.",
					"Run: npm run build",
				].join("\n"),
			);
			return null;
		}
		throw error;
	}
}

async function loadRuntimeRotationConfigModule() {
	try {
		const mod = await import("../dist/lib/config.js");
		if (
			typeof mod.loadPluginConfig !== "function" ||
			typeof mod.getCodexRuntimeRotationProxy !== "function"
		) {
			return null;
		}
		return mod;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			return null;
		}
		throw error;
	}
}

function readBooleanEnvFlag(name) {
	const normalized = (process.env[name] ?? "").trim().toLowerCase();
	if (["1", "true", "yes"].includes(normalized)) return true;
	if (["0", "false", "no"].includes(normalized)) return false;
	return null;
}

function isStartupUpdateNoticeDebugEnabled() {
	return readBooleanEnvFlag("CODEX_MULTI_AUTH_DEBUG") === true;
}

function shouldLogStartupUpdateNotice() {
	return process.stderr.isTTY === true || isStartupUpdateNoticeDebugEnabled();
}

function readStartupUpdateNoticeBudgetMs() {
	const raw =
		process.env.CODEX_MULTI_AUTH_UPDATE_NOTICE_STARTUP_BUDGET_MS ??
		process.env.CODEX_MULTI_AUTH_TEST_STARTUP_UPDATE_NOTICE_BUDGET_MS;
	if (!raw) return DEFAULT_STARTUP_UPDATE_NOTICE_BUDGET_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_STARTUP_UPDATE_NOTICE_BUDGET_MS;
}

function resolveStartupUpdateNoticeTimeoutMs(budgetMs) {
	return Math.max(1, Math.floor(budgetMs * 0.8));
}

function isModuleNotFoundError(error) {
	return (
		error &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ERR_MODULE_NOT_FOUND"
	);
}

function shouldRunStartupUpdateNotice(rawArgs, normalizedArgs) {
	if ((process.env.CODEX_MULTI_AUTH_BYPASS ?? "").trim() === "1") {
		return false;
	}
	if (isPureHelpOrVersionArgs(rawArgs)) {
		return false;
	}
	if (shouldHandleMultiAuthAuth(normalizedArgs)) {
		return false;
	}
	return true;
}

async function withStartupUpdateNoticeBudget(promise, budgetMs) {
	let timeout = null;
	try {
		return await Promise.race([
			promise,
			new Promise((resolve) => {
				timeout = setTimeout(
					() => {
						timeout?.unref?.();
						resolve(STARTUP_UPDATE_NOTICE_TIMED_OUT);
					},
					budgetMs,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function logStartupUpdateNoticeDebug(message) {
	if (isStartupUpdateNoticeDebugEnabled()) {
		console.error(`codex-multi-auth: ${message}`);
	}
}

async function showUpdateNoticeIfAvailable(rawArgs, normalizedArgs) {
	if (!shouldRunStartupUpdateNotice(rawArgs, normalizedArgs)) return;
	const budgetMs = readStartupUpdateNoticeBudgetMs();
	const fetchTimeoutMs = resolveStartupUpdateNoticeTimeoutMs(budgetMs);
	try {
		const mod = await import("../dist/lib/update-notice.js");
		if (typeof mod.checkForUpdates !== "function") {
			return;
		}
		const checkPromise = mod.checkForUpdates(false, fetchTimeoutMs);
		const result = await withStartupUpdateNoticeBudget(checkPromise, budgetMs);
		if (result === STARTUP_UPDATE_NOTICE_TIMED_OUT) {
			logStartupUpdateNoticeDebug(
				`update notice skipped: startup budget exceeded after ${budgetMs}ms`,
			);
			return;
		}
		if (result?.hasUpdate && result.latestVersion && shouldLogStartupUpdateNotice()) {
			if (typeof mod.formatManualUpdateNotice === "function") {
				console.error(mod.formatManualUpdateNotice(result));
			} else {
				console.error(
					`codex-multi-auth update available: v${result.latestVersion}; current: v${result.currentVersion}; run: ${result.updateCommand}`,
				);
			}
		}
	} catch (error) {
		if (isModuleNotFoundError(error)) return;
		logStartupUpdateNoticeDebug(
			`update notice skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function loadRuntimeConfigTomlModule() {
	try {
		const mod = await import("../dist/lib/runtime/config-toml.js");
		if (
			typeof mod.rewriteConfigTomlForRuntimeRotationProvider !== "function" ||
			typeof mod.tomlStringLiteral !== "function"
		) {
			return null;
		}
		return mod;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			return null;
		}
		throw error;
	}
}

// Reconciles the persisted `cli_auth_credentials_store` in ~/.codex/config.toml
// to "file" before forwarding.
//
// `buildForwardArgs` already appends `-c cli_auth_credentials_store="file"`, but
// that only covers the process this wrapper spawns. Third-party front-ends
// (CodexBar and friends) exec the official binary directly and read config.toml
// instead, so a config still pointing at "keychain" keeps producing macOS login
// keychain prompts (issue #641). Running the reconcile here self-heals a config
// that something else flipped back — e.g. a fresh official `codex login`.
//
// Idempotent: the lib helper returns without writing when the value is already
// "file", so this adds no write amplification on the common path.
async function ensurePersistedCodexFileAuthStore() {
	const forceFileAuthStore = (process.env.CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE ?? "1").trim() !== "0";
	if (!forceFileAuthStore) return;

	try {
		const mod = await import("../dist/lib/codex-cli/writer.js");
		if (typeof mod.ensureCodexCliFileAuthStore !== "function") return;
		await mod.ensureCodexCliFileAuthStore();
	} catch (error) {
		if (isModuleNotFoundError(error)) return;
		// Best effort only. A read-only or locked config.toml (Windows
		// EPERM/EBUSY) must never block the wrapped command: the per-invocation
		// `-c` override still protects this run.
	}
}

async function autoSyncManagerActiveSelectionIfEnabled() {
	const enabled = (process.env.CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP ?? "1").trim() !== "0";
	if (!enabled) return;

	try {
		const mod = await import("../dist/lib/codex-manager.js");
		if (typeof mod.autoSyncActiveAccountToCodex !== "function") {
			return;
		}
		await mod.autoSyncActiveAccountToCodex();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			// Non-auth command path should keep forwarding even if dist is missing.
			return;
		}
		// Best effort only: never block official Codex startup on sync failure.
	}
}

function resolveRealCodexBin() {
	const override = (process.env.CODEX_MULTI_AUTH_REAL_CODEX_BIN ?? "").trim();
	if (override.length > 0) {
		if (!existsSync(override)) {
			console.error(
				`CODEX_MULTI_AUTH_REAL_CODEX_BIN is set but missing: ${override}`,
			);
			return null;
		}
		return resolveRealCodexBinFromEnvironment({
			moduleUrl: import.meta.url,
			env: process.env,
			existsSyncImpl: existsSync,
		});
	}

	return resolveRealCodexBinFromEnvironment({ moduleUrl: import.meta.url });
}

const CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN =
	/model is not supported when using codex with a chatgpt account/i;
const NORMALIZED_UNSUPPORTED_MODEL_PATTERN =
	/model ['"]([^'"]+)['"] is not currently available for this chatgpt account when using codex oauth/i;
const MODEL_ACCESS_DENIED_PATTERN =
	/the model [`'"]([^`'"]+)[`'"] does not exist or you do not have access to it/i;
const DIRECT_UNSUPPORTED_MODEL_PATTERN =
	/['"]([^'"]+)['"]\s+model is not supported when using codex with a chatgpt account/i;
const CURRENT_CODEX_MODEL = "gpt-5.3-codex";
const LEGACY_CODEX_MODEL = "gpt-5-codex";
const WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN = {
	"gpt-5": ["gpt-5.5"],
	"gpt-5-pro": ["gpt-5.5-pro"],
	"gpt-5-chat-latest": ["gpt-5.5"],
	"gpt-5.5": ["gpt-5.4"],
	"gpt-5.5-pro": ["gpt-5.4"],
	"gpt-5.5-2026-04-23": ["gpt-5.4"],
	"gpt-5.5-pro-2026-04-23": ["gpt-5.4"],
	"gpt-5.5-20260423": ["gpt-5.4"],
	"gpt-5.5-pro-20260423": ["gpt-5.4"],
	"gpt-5.3-codex-spark": [CURRENT_CODEX_MODEL],
	"codex-max": [CURRENT_CODEX_MODEL],
	"gpt-5.1-codex-max": [CURRENT_CODEX_MODEL],
	"codex-mini-latest": [CURRENT_CODEX_MODEL],
	"gpt-5-codex-mini": [CURRENT_CODEX_MODEL],
	"gpt-5.1-codex-mini": [CURRENT_CODEX_MODEL],
	[LEGACY_CODEX_MODEL]: [CURRENT_CODEX_MODEL],
	"gpt-5.2-codex": [CURRENT_CODEX_MODEL],
	"gpt-5.1-codex": [CURRENT_CODEX_MODEL],
};

function canonicalizeRequestedModelName(model) {
	if (typeof model !== "string") return "";
	const normalizedModel = normalizeRequestedModel(model);
	if (normalizedModel) {
		return normalizedModel;
	}

	const stripped = stripProviderPrefix(model).trim().toLowerCase();
	if (!stripped) {
		return "";
	}

	return stripped.replace(/-(none|minimal|low|medium|high|xhigh|max|ultra)$/i, "");
}

function canonicalizeUnsupportedModelKey(model) {
	if (typeof model !== "string") return "";
	const stripped = stripProviderPrefix(model).trim().toLowerCase();
	if (!stripped) {
		return "";
	}
	return stripped.replace(/-(none|minimal|low|medium|high|xhigh|max|ultra)$/i, "");
}

function extractUnsupportedModelFromOutput(output) {
	if (typeof output !== "string" || output.length === 0) {
		return undefined;
	}

	const directMatch = output.match(DIRECT_UNSUPPORTED_MODEL_PATTERN);
	if (directMatch?.[1]) {
		return canonicalizeUnsupportedModelKey(directMatch[1]);
	}

	const normalizedMatch = output.match(NORMALIZED_UNSUPPORTED_MODEL_PATTERN);
	if (normalizedMatch?.[1]) {
		return canonicalizeUnsupportedModelKey(normalizedMatch[1]);
	}
	const accessDeniedMatch = output.match(MODEL_ACCESS_DENIED_PATTERN);
	if (accessDeniedMatch?.[1]) {
		return canonicalizeUnsupportedModelKey(accessDeniedMatch[1]);
	}

	return undefined;
}

function resolveUnsupportedModelRetryTarget(
	requestedModel,
	output,
	attemptedModels = [],
) {
	if (
		typeof output !== "string" ||
		output.length === 0 ||
		(!CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(output) &&
			!NORMALIZED_UNSUPPORTED_MODEL_PATTERN.test(output) &&
			!MODEL_ACCESS_DENIED_PATTERN.test(output))
	) {
		return undefined;
	}

	const attempted = new Set(
		attemptedModels
			.map((model) => canonicalizeUnsupportedModelKey(model))
			.filter(Boolean),
	);
	const normalizedRequestedModel = canonicalizeUnsupportedModelKey(requestedModel);
	const blockedModel =
		extractUnsupportedModelFromOutput(output) ?? normalizedRequestedModel;
	const fallbackChain =
		WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN[blockedModel] ??
		(normalizedRequestedModel
			? WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN[normalizedRequestedModel]
			: undefined) ??
		[];

	for (const fallbackModel of fallbackChain) {
		if (fallbackModel !== blockedModel && !attempted.has(fallbackModel)) {
			return fallbackModel;
		}
	}

	return undefined;
}

function replaceRequestedModel(args, nextModel) {
	if (!nextModel) {
		return [...args];
	}

	const nextArgs = [...args];
	for (let i = 0; i < nextArgs.length; i += 1) {
		const arg = nextArgs[i];
		// Past `--` the tokens are the user's prompt. Rewriting one in place
		// would edit the prompt text itself before re-forwarding it.
		if (arg === "--") break;
		if ((arg === "--model" || arg === "-m") && typeof nextArgs[i + 1] === "string") {
			nextArgs[i + 1] = nextModel;
			return nextArgs;
		}
		if (typeof arg === "string" && arg.startsWith("--model=")) {
			nextArgs[i] = `--model=${nextModel}`;
			return nextArgs;
		}
	}

	return nextArgs;
}

function shouldCaptureForwardedCodexOutput(env = process.env) {
	const override = (env.CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT ?? "").trim();
	if (override === "1") {
		return true;
	}
	if (override === "0") {
		return false;
	}
	if ((env.CODEX_CI ?? "").trim() === "1") {
		return true;
	}
	// Windows child processes can report undefined isTTY; treat that as non-TTY so retry capture remains available.
	return process.stdout.isTTY !== true || process.stderr.isTTY !== true;
}

function jsonRpcIdKey(id) {
	if (
		typeof id === "string" ||
		typeof id === "number" ||
		typeof id === "boolean" ||
		id === null
	) {
		return `${typeof id}:${JSON.stringify(id)}`;
	}
	return null;
}

function parseJsonObjectLine(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) {
		return null;
	}
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: null;
	} catch {
		return null;
	}
}

function splitProtocolLineEnding(line) {
	if (line.endsWith("\r\n")) {
		return { body: line.slice(0, -2), lineEnding: "\r\n" };
	}
	if (line.endsWith("\n")) {
		return { body: line.slice(0, -1), lineEnding: "\n" };
	}
	return { body: line, lineEnding: "" };
}

function createProtocolLineAccumulator(onLine) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const drain = () => {
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = buffer.slice(0, newlineIndex + 1);
			buffer = buffer.slice(newlineIndex + 1);
			onLine(line);
			newlineIndex = buffer.indexOf("\n");
		}
	};

	return {
		write(chunk) {
			buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
			drain();
		},
		end() {
			buffer += decoder.end();
			if (buffer.length > 0) {
				onLine(buffer);
				buffer = "";
			}
		},
	};
}

function createSyntheticAppServerAccountReadResult() {
	return {
		account: {
			type: "chatgpt",
			email: APP_SERVER_ACCOUNT_DISPLAY_NAME,
			planType: "unknown",
		},
		requiresOpenaiAuth: false,
	};
}

function createSyntheticAppServerAuthStatusResult() {
	return {
		authMethod: "apikey",
		authToken: null,
		requiresOpenaiAuth: false,
	};
}

function createSyntheticAppServerRateLimitsResult() {
	return {
		rateLimits: {
			limitId: null,
			limitName: null,
			primary: null,
			secondary: null,
			credits: null,
			planType: null,
			rateLimitReachedType: null,
		},
		rateLimitsByLimitId: null,
	};
}

function createAppServerAccountReadProtocolProxy() {
	const maxPendingAuthRequestIds = 4096;
	const pendingAuthRequestMethodsById = new Map();
	const inputLines = createProtocolLineAccumulator((line) => {
		const { body } = splitProtocolLineEnding(line);
		const message = parseJsonObjectLine(body);
		if (
			![
				"account/read",
				"account/rateLimits/read",
				"getAuthStatus",
			].includes(message?.method) ||
			!Object.hasOwn(message, "id")
		) {
			return;
		}
		const key = jsonRpcIdKey(message.id);
		if (key) {
			if (pendingAuthRequestMethodsById.size >= maxPendingAuthRequestIds) {
				pendingAuthRequestMethodsById.clear();
				if (!warnedPendingAccountReadIdOverflow) {
					warnedPendingAccountReadIdOverflow = true;
					console.error(
						"codex-multi-auth: cleared pending app-server auth request ids after exceeding the safety cap.",
					);
				}
			}
			pendingAuthRequestMethodsById.set(key, message.method);
		}
	});
	const outputLines = createProtocolLineAccumulator((line) => {
		process.stdout.write(
			rewriteAppServerAccountReadResponseLine(line, pendingAuthRequestMethodsById),
		);
	});

	return {
		observeInput(chunk) {
			inputLines.write(chunk);
		},
		flushInput() {
			inputLines.end();
		},
		writeOutput(chunk) {
			outputLines.write(chunk);
		},
		flushOutput() {
			outputLines.end();
		},
	};
}

function rewriteAppServerAccountReadResponseLine(line, pendingAuthRequestMethodsById) {
	const { body, lineEnding } = splitProtocolLineEnding(line);
	const message = parseJsonObjectLine(body);
	if (!message || !Object.hasOwn(message, "id")) {
		return line;
	}
	const key = jsonRpcIdKey(message.id);
	if (!key || !pendingAuthRequestMethodsById.has(key)) {
		return line;
	}
	const method = pendingAuthRequestMethodsById.get(key);
	pendingAuthRequestMethodsById.delete(key);
	const result =
		method === "account/read"
			? createSyntheticAppServerAccountReadResult()
			: method === "account/rateLimits/read"
				? createSyntheticAppServerRateLimitsResult()
				: method === "getAuthStatus"
					? createSyntheticAppServerAuthStatusResult()
					: null;
	if (!result) {
		return line;
	}
	return `${JSON.stringify({
		jsonrpc: typeof message.jsonrpc === "string" ? message.jsonrpc : "2.0",
		id: message.id,
		result,
	})}${lineEnding}`;
}

function filterKnownForwardedCodexStderr(text) {
	if (typeof text !== "string" || text.length === 0) {
		return "";
	}
	const lines = text.split(/\r?\n/);
	const filtered = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (
			/ERROR codex_core::session: failed to record rollout items: thread\s*$/.test(
				line,
			) &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} not found$/i.test(
				lines[index + 1] ?? "",
			)
		) {
			index += 1;
			continue;
		}
		if (
			/ERROR rmcp::transport::streamable_http_client: fail to delete session:\s*$/.test(
				line,
			) &&
			/^unexpected server response: DELETE returned HTTP 404 session_id="/.test(
				lines[index + 1] ?? "",
			)
		) {
			index += 1;
			while (index + 1 < lines.length && !/"\s*$/.test(lines[index])) {
				index += 1;
			}
			continue;
		}
		filtered.push(line);
	}
	return filtered.join("\n");
}

function withCiKnownForwardedCodexLogSilencers(env) {
	if ((env.CODEX_CI ?? "").trim() !== "1") {
		return env;
	}
	if ((env.RUST_LOG ?? "").trim().length > 0) {
		return env;
	}
	return {
		...env,
		RUST_LOG: "codex_core::session=off",
	};
}

function forwardToRealCodexOnce(
	codexBin,
	args,
	env = process.env,
	cleanup,
	options = {},
) {
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		const captureOutput = options.captureOutput === true;
		const proxyAppServerAccountRead =
			options.proxyAppServerAccountRead === true;
		const protocolProxy = proxyAppServerAccountRead
			? createAppServerAccountReadProtocolProxy()
			: null;
		let cleanupProtocolProxy = () => {};
		const finalize = async (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanupProtocolProxy();
			protocolProxy?.flushOutput();
			try {
				await cleanup?.({ exitCode });
			} catch {
				// Best-effort cleanup only.
			}
			if (captureOutput && stdout.length > 0) {
				const filteredStdout = filterKnownForwardedCodexStderr(stdout);
				if (filteredStdout.length > 0) {
					process.stdout.write(filteredStdout);
				}
			}
			if (captureOutput && stderr.length > 0) {
				const filteredStderr = filterKnownForwardedCodexStderr(stderr);
				if (filteredStderr.trim().length > 0) {
					process.stderr.write(filteredStderr);
					if (!filteredStderr.endsWith("\n")) {
						process.stderr.write("\n");
					}
				}
			}
			resolve({
				exitCode,
				// No-capture output stays empty by design so retry parsing cannot
				// reintroduce pipes that break terminal passthrough.
				output: `${stdout}\n${stderr}`.trim(),
			});
		};

		const command = codexBin.launchWithNode ? process.execPath : codexBin.path;
		const commandArgs = codexBin.launchWithNode ? [codexBin.path, ...args] : args;
		let child;
		const failLaunch = (error) => {
			const message = `Failed to launch real Codex CLI: ${String(error)}`;
			stderr += `${stderr ? "\n" : ""}${message}`;
			console.error(message);
			finalize(1);
		};
		try {
			const childEnv = captureOutput
				? withCiKnownForwardedCodexLogSilencers(env)
				: env;
			child = spawn(command, commandArgs, {
				stdio: proxyAppServerAccountRead
					? ["pipe", "pipe", "pipe"]
					: captureOutput
						? ["inherit", "pipe", "pipe"]
						: "inherit",
				env: childEnv,
			});
		} catch (error) {
			failLaunch(error);
			return;
		}

		if (proxyAppServerAccountRead && protocolProxy) {
			let stdinClosed = false;
			let stdoutClosed = false;
			const closeChildStdin = () => {
				if (stdinClosed) return;
				stdinClosed = true;
				protocolProxy.flushInput();
				child.stdin?.end();
			};
			const onProcessStdinData = (chunk) => {
				protocolProxy.observeInput(chunk);
				if (child.stdin && !child.stdin.destroyed && !child.stdin.write(chunk)) {
					process.stdin.pause();
				}
			};
			const onProcessStdinEnd = () => {
				closeChildStdin();
			};
			const onProcessStdinError = () => {
				closeChildStdin();
			};
			const onChildStdinDrain = () => {
				process.stdin.resume();
			};
			const onChildStdoutData = (chunk) => {
				protocolProxy.writeOutput(chunk);
			};
			const onChildStdoutEnd = () => {
				if (stdoutClosed) return;
				stdoutClosed = true;
				protocolProxy.flushOutput();
			};
			const onChildStderrData = (chunk) => {
				process.stderr.write(chunk);
			};
			cleanupProtocolProxy = () => {
				process.stdin.removeListener("data", onProcessStdinData);
				process.stdin.removeListener("end", onProcessStdinEnd);
				process.stdin.removeListener("close", onProcessStdinEnd);
				process.stdin.removeListener("error", onProcessStdinError);
				child.stdin?.removeListener("drain", onChildStdinDrain);
				child.stdout?.removeListener("data", onChildStdoutData);
				child.stdout?.removeListener("end", onChildStdoutEnd);
				child.stderr?.removeListener("data", onChildStderrData);
				process.stdin.resume();
			};
			process.stdin.on("data", onProcessStdinData);
			process.stdin.once("end", onProcessStdinEnd);
			process.stdin.once("close", onProcessStdinEnd);
			process.stdin.once("error", onProcessStdinError);
			child.stdin?.on("drain", onChildStdinDrain);
			child.stdout?.on("data", onChildStdoutData);
			child.stdout?.on("end", onChildStdoutEnd);
			child.stderr?.on("data", onChildStderrData);
		} else if (captureOutput) {
			child.stdout?.on("data", (chunk) => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				stdout += text;
			});
			child.stderr?.on("data", (chunk) => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				stderr += text;
			});
		}

		child.once("error", (error) => {
			failLaunch(error);
		});

		child.once("close", (code, signal) => {
			if (signal) {
				const signalNumber = signal === "SIGINT" ? 130 : 1;
				finalize(signalNumber);
				return;
			}
			finalize(typeof code === "number" ? code : 1);
		});
	});
}

async function forwardToRealCodex(codexBin, rawArgs, baseEnv = process.env) {
	let currentArgs = [...rawArgs];
	let lastExitCode = 1;
	const attemptedModels = new Set();

	for (let attempt = 0; attempt < 4; attempt += 1) {
		const requestedModel = extractRequestedModel(currentArgs);
		if (requestedModel) {
			attemptedModels.add(requestedModel);
		}

		const { args: forwardArgs, requestedModel: compatibilityRequestedModel } =
			buildForwardArgs(currentArgs);
		const compatibility = createCompatibilityCodexHome(
			forwardArgs,
			compatibilityRequestedModel,
			baseEnv,
		);
		const runtimeProxyContext = await createRuntimeRotationProxyContextIfEnabled(
			compatibility,
			rawArgs,
		);
		if (runtimeProxyContext.startupError) {
			console.error(runtimeProxyContext.startupError);
			return 1;
		}
		const result = await forwardToRealCodexOnce(
			codexBin,
			runtimeProxyContext.args,
			runtimeProxyContext.env,
			runtimeProxyContext.cleanup,
			{
				captureOutput: shouldCaptureForwardedOutputForArgs(
					rawArgs,
					runtimeProxyContext.env,
				),
				proxyAppServerAccountRead:
					isCodexAppServerCommand(rawArgs) &&
					(runtimeProxyContext.proxyAppServerAccountRead === true ||
						(runtimeProxyContext.env[APP_SERVER_ACCOUNT_LABEL_ENV] ?? "").trim() ===
							"1"),
			},
		);
		lastExitCode = result.exitCode;
		if (result.exitCode === 0) {
			repairCodexSessionIndex(resolveCodexHomeDir(baseEnv));
			return result.exitCode;
		}

		const fallbackModel = resolveUnsupportedModelRetryTarget(
			requestedModel,
			result.output,
			[...attemptedModels],
		);
		if (!fallbackModel) {
			return result.exitCode;
		}

		console.error(
			`codex-multi-auth: model ${requestedModel ?? "requested model"} is unsupported on this ChatGPT Codex surface. Retrying with ${fallbackModel}.`,
		);
		attemptedModels.add(fallbackModel);
		const nextArgs = replaceRequestedModel(currentArgs, fallbackModel);
		if (JSON.stringify(nextArgs) === JSON.stringify(currentArgs)) {
			return result.exitCode;
		}
		currentArgs = nextArgs;
	}

	return lastExitCode;
}

function hasCliAuthCredentialsStoreOverride(args) {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		// Everything after `--` is the root `[PROMPT]` positional, not options:
		// a prompt whose text spells `--config=cli_auth_credentials_store=...` is
		// not a caller override, and treating it as one would silently drop the
		// file auth store this wrapper depends on.
		if (arg === "--") break;
		if (arg === "-c" || arg === "--config") {
			const next = args[i + 1];
			if (!next || !next.includes("=")) continue;
			const [key] = next.split("=", 1);
			if ((key ?? "").trim() === "cli_auth_credentials_store") {
				return true;
			}
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--config=")) {
			const assignment = arg.slice("--config=".length);
			const [key] = assignment.split("=", 1);
			if ((key ?? "").trim() === "cli_auth_credentials_store") {
				return true;
			}
		}
	}
	return false;
}

// IMPORTANT: Keep this mapping in sync with
// `lib/request/helpers/model-map.ts` `MODEL_PROFILES`
// and its GPT-5 normalization helpers.
// This wrapper runs before the TypeScript build, so it cannot import that source.
const SUPPORTED_REASONING_EFFORTS_BY_MODEL = {
	[CURRENT_CODEX_MODEL]: ["low", "medium", "high", "xhigh"],
	"gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
	"gpt-6-astra-aeon": ["low", "medium", "high", "xhigh", "max", "ultra"],
	"gpt-daybreak-blue-latest": ["low", "medium", "high", "xhigh", "max", "ultra"],
	"gpt-daybreak-red-latest": ["low", "medium", "high", "xhigh", "max", "ultra"],
	"gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
	"gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
	"gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
	"gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.5-pro": ["medium", "high", "xhigh"],
	"gpt-5.4": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.4-pro": ["medium", "high", "xhigh"],
	"gpt-5.4-mini": ["medium"],
	"gpt-5.4-nano": ["medium"],
	"gpt-5.2-pro": ["medium", "high", "xhigh"],
	"gpt-5.2": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.1": ["none", "low", "medium", "high"],
	"gpt-5-mini": ["medium"],
	"gpt-5-nano": ["medium"],
};

const REASONING_FALLBACKS = {
	none: ["none", "low", "minimal", "medium", "high", "xhigh"],
	minimal: ["minimal", "low", "none", "medium", "high", "xhigh"],
	low: ["low", "minimal", "none", "medium", "high", "xhigh"],
	medium: ["medium", "low", "high", "minimal", "none", "xhigh"],
	high: ["high", "medium", "xhigh", "low", "minimal", "none"],
	xhigh: ["xhigh", "high", "medium", "low", "minimal", "none"],
	// `max` and `ultra` arrived with GPT-5.6. Step down one rung at a time so a
	// request against a pre-5.6 model lands on that model's strongest tier.
	max: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
	ultra: ["ultra", "max", "xhigh", "high", "medium", "low", "minimal", "none"],
};

const KNOWN_REASONING_EFFORTS = new Set(Object.keys(REASONING_FALLBACKS));

// Effort suffixes generated as model aliases (e.g. `gpt-5.5-high`). This is the
// pre-5.6 set only: `max`/`ultra` are NOT auto-aliased onto general models,
// matching lib/request/helpers/model-map.ts `REASONING_VARIANTS`. GPT-5.6 tiers
// register their own effort aliases explicitly via `addRequestedModelEffortAliases`.
const REASONING_ALIAS_VARIANTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];
const REQUESTED_MODEL_ALIASES = new Map();
const DEFAULT_GENERAL_GPT5_MODEL = "gpt-5.5";
const GPT_5_5_CANONICAL_MODEL = "gpt-5.5";
const GPT_5_5_PRO_CANONICAL_MODEL = "gpt-5.5-pro";
const GPT_5_5_RELEASE_MODEL = "gpt-5.5-2026-04-23";
const GPT_5_5_PRO_RELEASE_MODEL = "gpt-5.5-pro-2026-04-23";
const GPT_5_5_RELEASE_COMPAT_MODEL = "gpt-5.5-20260423";
const GPT_5_5_PRO_RELEASE_COMPAT_MODEL = "gpt-5.5-pro-20260423";
// GPT-5.6 tiers. Sol and Terra expose `ultra`; Luna stops at `max`. No tier
// accepts `none`/`minimal`. Bare `gpt-5.6` aliases to the flagship (Sol).
const GPT_5_6_SOL_MODEL = "gpt-5.6-sol";
const GPT_5_6_TERRA_MODEL = "gpt-5.6-terra";
const GPT_5_6_LUNA_MODEL = "gpt-5.6-luna";
const GPT_5_6_FLAGSHIP_ALIAS = "gpt-5.6";
const GPT_5_6_SOL_TERRA_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const GPT_5_6_LUNA_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// GPT-6 Astra (2026-09-03). No Sol/Terra/Luna split this generation: the
// flagship plus `aeon`, a long-horizon variant. Same frontier effort ladder as
// 5.6 (no `none`/`minimal`, `ultra` at the top). Bare `gpt-6` -> flagship.
const GPT_6_ASTRA_MODEL = "gpt-6-astra";
const GPT_6_ASTRA_AEON_MODEL = "gpt-6-astra-aeon";
const GPT_6_FLAGSHIP_ALIAS = "gpt-6";
const GPT_6_ASTRA_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
// Daybreak cyber models from the upstream Codex catalog. `red` is the
// cyber-permissive variant, `blue` the defensive one.
const DAYBREAK_BLUE_MODEL = "gpt-daybreak-blue-latest";
const DAYBREAK_RED_MODEL = "gpt-daybreak-red-latest";
const DAYBREAK_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const GENERAL_GPT5_VERSION_CATALOG = {
	1: {
		base: "gpt-5.1",
	},
	2: {
		base: "gpt-5.2",
		pro: "gpt-5.2-pro",
	},
	4: {
		base: DEFAULT_GENERAL_GPT5_MODEL,
		pro: "gpt-5.4-pro",
		mini: "gpt-5.4-mini",
		nano: "gpt-5.4-nano",
	},
	5: {
		base: GPT_5_5_CANONICAL_MODEL,
		pro: GPT_5_5_PRO_CANONICAL_MODEL,
		mini: "gpt-5-mini",
		nano: "gpt-5-nano",
	},
};
const GENERAL_GPT5_STABLE_VARIANTS = GENERAL_GPT5_VERSION_CATALOG[5];
const GENERAL_GPT5_GENERIC_VARIANTS = {
	base: DEFAULT_GENERAL_GPT5_MODEL,
	pro: GPT_5_5_PRO_CANONICAL_MODEL,
	mini: "gpt-5-mini",
	nano: "gpt-5-nano",
};

function addRequestedModelAlias(alias, normalizedModel) {
	REQUESTED_MODEL_ALIASES.set(alias, normalizedModel);
}

function addRequestedModelReasoningAliases(alias, normalizedModel) {
	addRequestedModelAlias(alias, normalizedModel);
	for (const effort of REASONING_ALIAS_VARIANTS) {
		addRequestedModelAlias(`${alias}-${effort}`, normalizedModel);
	}
}

// Register a model plus one alias per effort it actually supports. Unlike
// `addRequestedModelReasoningAliases`, this does not assume the pre-5.6 variant
// list: GPT-5.6 rejects `none`/`minimal` and only Sol/Terra accept `ultra`.
function addRequestedModelEffortAliases(alias, normalizedModel, efforts) {
	addRequestedModelAlias(alias, normalizedModel);
	for (const effort of efforts) {
		addRequestedModelAlias(`${alias}-${effort}`, normalizedModel);
	}
}

function maybeThrowSimulatedShadowHomeBusyError() {
	if (shadowHomeCleanupBusyFailuresRemaining > 0) {
		shadowHomeCleanupBusyFailuresRemaining -= 1;
		const error = new Error("simulated busy shadow-home operation");
		error.code = "EBUSY";
		throw error;
	}
}

function maybeThrowSimulatedShadowHomePreflightReadBusyError() {
	if (shadowHomeCleanupPreflightReadBusyFailuresRemaining > 0) {
		shadowHomeCleanupPreflightReadBusyFailuresRemaining -= 1;
		const error = new Error("simulated busy shadow-home preflight read");
		error.code = "EBUSY";
		throw error;
	}
}

function maybeThrowSimulatedShadowHomeSyncMetadataBusyError(targetPath) {
	if (
		basename(targetPath) === SHADOW_HOME_SYNC_STATE_FILE &&
		shadowHomeSyncMetadataBusyFailuresRemaining > 0
	) {
		shadowHomeSyncMetadataBusyFailuresRemaining -= 1;
		const error = new Error("simulated busy shadow-home sync metadata write");
		error.code = "EBUSY";
		throw error;
	}
}

function maybeThrowSimulatedShadowHomeSyncLockOwnerWriteError() {
	if (shadowHomeSyncLockOwnerWriteFailuresRemaining > 0) {
		shadowHomeSyncLockOwnerWriteFailuresRemaining -= 1;
		const error = new Error("simulated shadow sync lock owner write failure");
		error.code = "EPERM";
		throw error;
	}
}

function writeShadowHomeCleanupRetryMarker(destinationPath, attempt) {
	if (shadowHomeCleanupRetryMarkerDir.length === 0) {
		return;
	}
	try {
		mkdirSync(shadowHomeCleanupRetryMarkerDir, { recursive: true });
		writeFileSync(
			join(
				shadowHomeCleanupRetryMarkerDir,
				`${basename(destinationPath)}.retry-${attempt + 1}`,
			),
			`${attempt + 1}\n`,
			"utf8",
		);
	} catch {
		// Best-effort test hook only.
	}
}

function ensureShadowHomeDestinationMatchesSnapshot(destinationPath, expectedState) {
	if (!expectedState) {
		return;
	}
	const currentState = captureShadowHomeState(destinationPath, {
		rethrowRetryableReadErrors: true,
	});
	if (!shadowHomeStateMatches(currentState, expectedState)) {
		const error = new Error("shadow-home destination changed during sync-back retry");
		error.code = "EEXIST";
		throw error;
	}
}

function renameFileWithRetry(sourcePath, destinationPath, expectedDestinationState) {
	for (let attempt = 0; attempt <= SHADOW_HOME_CLEANUP_BACKOFF_MS.length; attempt += 1) {
		try {
			ensureShadowHomeDestinationMatchesSnapshot(
				destinationPath,
				expectedDestinationState,
			);
			maybeThrowSimulatedShadowHomeBusyError();
			renameSync(sourcePath, destinationPath);
			return;
		} catch (error) {
			if (
				!isRetryableShadowHomeCleanupError(error) ||
				attempt === SHADOW_HOME_CLEANUP_BACKOFF_MS.length
			) {
				throw error;
			}
			writeShadowHomeCleanupRetryMarker(destinationPath, attempt);
			sleepSync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
		}
	}
}

function seedRequestedModelAliases() {
	addRequestedModelReasoningAliases(
		GPT_5_5_CANONICAL_MODEL,
		GPT_5_5_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases(
		GPT_5_5_RELEASE_MODEL,
		GPT_5_5_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases(
		GPT_5_5_RELEASE_COMPAT_MODEL,
		GPT_5_5_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases(
		GPT_5_5_PRO_CANONICAL_MODEL,
		GPT_5_5_PRO_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases(
		GPT_5_5_PRO_RELEASE_MODEL,
		GPT_5_5_PRO_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases(
		GPT_5_5_PRO_RELEASE_COMPAT_MODEL,
		GPT_5_5_PRO_CANONICAL_MODEL,
	);
	addRequestedModelReasoningAliases("gpt-5.4", "gpt-5.4");
	addRequestedModelReasoningAliases("gpt-5.4-pro", "gpt-5.4-pro");
	addRequestedModelReasoningAliases("gpt-5.4-mini", "gpt-5.4-mini");
	addRequestedModelReasoningAliases("gpt-5.4-nano", "gpt-5.4-nano");
	addRequestedModelReasoningAliases("gpt-5.2-pro", "gpt-5.2-pro");
	addRequestedModelReasoningAliases("gpt-5-pro", GPT_5_5_PRO_CANONICAL_MODEL);
	addRequestedModelReasoningAliases("gpt-5.2", "gpt-5.2");
	addRequestedModelReasoningAliases("gpt-5.1", "gpt-5.1");
	addRequestedModelReasoningAliases("gpt-5", DEFAULT_GENERAL_GPT5_MODEL);
	addRequestedModelReasoningAliases("gpt-5-mini", "gpt-5-mini");
	addRequestedModelReasoningAliases("gpt-5-nano", "gpt-5-nano");
	addRequestedModelReasoningAliases("gpt-5.1-chat-latest", "gpt-5.1");
	addRequestedModelReasoningAliases("gpt-5-chat-latest", DEFAULT_GENERAL_GPT5_MODEL);
	addRequestedModelEffortAliases(
		GPT_5_6_SOL_MODEL,
		GPT_5_6_SOL_MODEL,
		GPT_5_6_SOL_TERRA_EFFORTS,
	);
	addRequestedModelEffortAliases(
		GPT_5_6_TERRA_MODEL,
		GPT_5_6_TERRA_MODEL,
		GPT_5_6_SOL_TERRA_EFFORTS,
	);
	addRequestedModelEffortAliases(
		GPT_5_6_LUNA_MODEL,
		GPT_5_6_LUNA_MODEL,
		GPT_5_6_LUNA_EFFORTS,
	);
	addRequestedModelEffortAliases(
		GPT_5_6_FLAGSHIP_ALIAS,
		GPT_5_6_SOL_MODEL,
		GPT_5_6_SOL_TERRA_EFFORTS,
	);
	addRequestedModelEffortAliases(
		GPT_6_ASTRA_MODEL,
		GPT_6_ASTRA_MODEL,
		GPT_6_ASTRA_EFFORTS,
	);
	addRequestedModelEffortAliases(
		GPT_6_ASTRA_AEON_MODEL,
		GPT_6_ASTRA_AEON_MODEL,
		GPT_6_ASTRA_EFFORTS,
	);
	addRequestedModelEffortAliases(
		GPT_6_FLAGSHIP_ALIAS,
		GPT_6_ASTRA_MODEL,
		GPT_6_ASTRA_EFFORTS,
	);
	addRequestedModelEffortAliases("astra", GPT_6_ASTRA_MODEL, GPT_6_ASTRA_EFFORTS);
	addRequestedModelEffortAliases(
		"astra-aeon",
		GPT_6_ASTRA_AEON_MODEL,
		GPT_6_ASTRA_EFFORTS,
	);
	addRequestedModelEffortAliases(
		DAYBREAK_BLUE_MODEL,
		DAYBREAK_BLUE_MODEL,
		DAYBREAK_EFFORTS,
	);
	addRequestedModelEffortAliases(
		DAYBREAK_RED_MODEL,
		DAYBREAK_RED_MODEL,
		DAYBREAK_EFFORTS,
	);
	addRequestedModelEffortAliases(
		"daybreak-blue",
		DAYBREAK_BLUE_MODEL,
		DAYBREAK_EFFORTS,
	);
	addRequestedModelEffortAliases(
		"daybreak-red",
		DAYBREAK_RED_MODEL,
		DAYBREAK_EFFORTS,
	);
	addRequestedModelReasoningAliases(CURRENT_CODEX_MODEL, CURRENT_CODEX_MODEL);
	addRequestedModelReasoningAliases("gpt-5.3-codex-spark", CURRENT_CODEX_MODEL);
	addRequestedModelReasoningAliases(LEGACY_CODEX_MODEL, CURRENT_CODEX_MODEL);
	addRequestedModelReasoningAliases("gpt-5.2-codex", CURRENT_CODEX_MODEL);
	addRequestedModelReasoningAliases("gpt-5.1-codex", CURRENT_CODEX_MODEL);
	addRequestedModelAlias("gpt_5_codex", CURRENT_CODEX_MODEL);
	addRequestedModelReasoningAliases("codex-max", CURRENT_CODEX_MODEL);
	addRequestedModelReasoningAliases("gpt-5.1-codex-max", CURRENT_CODEX_MODEL);
	addRequestedModelAlias("codex-mini-latest", CURRENT_CODEX_MODEL);
	addRequestedModelReasoningAliases("gpt-5-codex-mini", CURRENT_CODEX_MODEL);
	addRequestedModelReasoningAliases("gpt-5.1-codex-mini", CURRENT_CODEX_MODEL);
}

seedRequestedModelAliases();

function stripProviderPrefix(model) {
	return typeof model === "string" && model.includes("/")
		? model.split("/").pop() ?? model
		: model;
}

function tokenizeRequestedModel(model) {
	return String(model ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function getGeneralGpt5CatalogForMinor(minor) {
	switch (minor) {
		case 1:
		case 2:
		case 4:
		case 5:
			return GENERAL_GPT5_VERSION_CATALOG[minor];
		default:
			return undefined;
	}
}

function resolveGeneralGpt5CatalogVariant(catalog, variant) {
	return catalog?.[variant] ?? catalog?.base;
}

function resolveStableGeneralGpt5Variant(variant) {
	const fallback = (
		GENERAL_GPT5_STABLE_VARIANTS[variant] ??
		GENERAL_GPT5_STABLE_VARIANTS.base
	);
	if (!fallback) {
		throw new Error(`Stable GPT-5 fallback is missing for variant ${variant}`);
	}
	return fallback;
}

// The final clause is a catch-all on the `codex` substring, matching
// `resolveCodexCatalogModel` in lib/request/helpers/model-map.ts. It used to be
// an exact `normalized === "codex"` check, so any codex id the explicit list
// above did not name (`gpt-6-codex`, `gpt-5.7-codex`, …) resolved to nothing in
// the wrapper while lib resolved it to the current codex model — a silent drift
// between the two, which is exactly what test/codex-model-resolution.test.ts
// exists to prevent.
function resolveCodexRequestedModel(normalized) {
	if (
		normalized.includes("gpt-5.1-codex-max") ||
		normalized.includes("gpt 5.1 codex max") ||
		normalized.includes("codex-max")
	) {
		return CURRENT_CODEX_MODEL;
	}
	if (
		normalized.includes("gpt-5.1-codex-mini") ||
		normalized.includes("gpt 5.1 codex mini") ||
		normalized.includes("gpt-5-codex-mini") ||
		normalized.includes("gpt 5 codex mini") ||
		normalized.includes("codex-mini-latest")
	) {
		return CURRENT_CODEX_MODEL;
	}
	if (
		normalized.includes("gpt-5.3-codex-spark") ||
		normalized.includes("gpt 5.3 codex spark") ||
		normalized.includes("gpt-5.3-codex") ||
		normalized.includes("gpt 5.3 codex") ||
		normalized.includes("gpt-5.2-codex") ||
		normalized.includes("gpt 5.2 codex") ||
		normalized.includes("gpt-5.1-codex") ||
		normalized.includes("gpt 5.1 codex") ||
		normalized.includes("gpt-5-codex") ||
		normalized.includes("gpt 5 codex") ||
		normalized.includes("codex")
	) {
		return CURRENT_CODEX_MODEL;
	}

	return "";
}

// Resolve GPT-5.6 identifiers, including ones that are not exact aliases (e.g. a
// future `gpt-5.6-terra-fast`). Without this the general GPT-5 resolver sees
// minor `6`, finds no catalog entry, and silently falls back to 5.5. Unknown
// tiers resolve to Sol, matching OpenAI's bare `gpt-5.6` alias.
// Resolve GPT-6 identifiers that are not exact aliases (a dated snapshot, the
// `gpt-6-astra-pro` plan tier, or a tier OpenAI adds later). Without this the
// general GPT-5 resolver never matches (it needs a `gpt 5` token pair) and the
// id falls through to 5.5 — running GPT-5.5 for a caller who asked for the
// frontier model. `aeon` keeps its own id because it is a behaviourally
// different model, not a rename. Mirrors lib/request/helpers/model-map.ts.
function resolveGpt6RequestedModel(stripped) {
	const tokens = tokenizeRequestedModel(stripped);
	const gptIndex = tokens.indexOf("gpt");
	const isGpt6 = gptIndex !== -1 && tokens[gptIndex + 1] === "6";
	// A bare `astra` token counts too: picker labels and OpenAI's own material
	// say "Astra" with no `gpt-6` prefix, so `Astra Pro` arrives with no version
	// tokens and would otherwise miss every branch and land on 5.5.
	if ((!isGpt6 && !tokens.includes("astra")) || tokens.includes("codex")) {
		return "";
	}
	if (tokens.includes("aeon")) return GPT_6_ASTRA_AEON_MODEL;
	return GPT_6_ASTRA_MODEL;
}

// Daybreak slugs carry neither a `codex` nor a `gpt 5` token, so every other
// resolver declines them and they would reach the 5.5 default. An unrecognised
// Daybreak id resolves to `blue`, the more restricted of the two, so a typo
// cannot silently upgrade a caller into the cyber-permissive model.
function resolveDaybreakRequestedModel(stripped) {
	const tokens = tokenizeRequestedModel(stripped);
	if (!tokens.includes("daybreak")) {
		return "";
	}
	if (tokens.includes("red")) return DAYBREAK_RED_MODEL;
	return DAYBREAK_BLUE_MODEL;
}

function resolveGpt56RequestedModel(stripped) {
	const tokens = tokenizeRequestedModel(stripped);
	const gptIndex = tokens.indexOf("gpt");
	const isGpt56 =
		gptIndex !== -1 &&
		tokens[gptIndex + 1] === "5" &&
		tokens[gptIndex + 2] === "6";
	if (!isGpt56 || tokens.includes("codex")) {
		return "";
	}
	if (tokens.includes("terra")) return GPT_5_6_TERRA_MODEL;
	if (tokens.includes("luna")) return GPT_5_6_LUNA_MODEL;
	return GPT_5_6_SOL_MODEL;
}

function resolveGeneralGpt5RequestedModel(stripped) {
	const tokens = tokenizeRequestedModel(stripped);
	const gptIndex = tokens.indexOf("gpt");
	const isGpt5 = gptIndex !== -1 && tokens[gptIndex + 1] === "5";
	if (!isGpt5 || tokens.includes("codex")) {
		return "";
	}

	const rawMinor = tokens[gptIndex + 2];
	const minor =
		typeof rawMinor === "string" && /^\d+$/.test(rawMinor)
			? Number(rawMinor)
			: undefined;
	const variant = tokens.includes("mini")
		? "mini"
		: tokens.includes("nano")
			? "nano"
			: tokens.includes("pro")
				? "pro"
				: "base";

	if (minor === undefined) {
		return GENERAL_GPT5_GENERIC_VARIANTS[variant];
	}

	const exactCatalog = getGeneralGpt5CatalogForMinor(minor);
	const exactMatch = resolveGeneralGpt5CatalogVariant(exactCatalog, variant);
	if (exactMatch) {
		return exactMatch;
	}

	return resolveStableGeneralGpt5Variant(variant);
}

function normalizeRequestedModel(model) {
	const stripped = stripProviderPrefix(model ?? "");
	const normalized = stripped.trim().toLowerCase();
	if (normalized.length === 0) return "";
	const exactMatch = REQUESTED_MODEL_ALIASES.get(normalized);
	if (exactMatch) {
		return exactMatch;
	}

	const daybreakModel = resolveDaybreakRequestedModel(stripped);
	if (daybreakModel) {
		return daybreakModel;
	}

	const codexModel = resolveCodexRequestedModel(normalized);
	if (codexModel) {
		return codexModel;
	}

	const gpt6Model = resolveGpt6RequestedModel(stripped);
	if (gpt6Model) {
		return gpt6Model;
	}

	const gpt56Model = resolveGpt56RequestedModel(stripped);
	if (gpt56Model) {
		return gpt56Model;
	}

	const generalModel = resolveGeneralGpt5RequestedModel(stripped);
	if (generalModel) {
		return generalModel;
	}

	return "";
}

function resolveSupportedReasoningEffort(normalizedEffort, supportedEfforts) {
	if (!supportedEfforts || supportedEfforts.includes(normalizedEffort)) {
		return normalizedEffort;
	}

	const fallbackOrder = REASONING_FALLBACKS[normalizedEffort] ?? [normalizedEffort];
	for (const candidate of fallbackOrder) {
		if (supportedEfforts.includes(candidate)) {
			return candidate;
		}
	}

	return normalizedEffort;
}

function coerceReasoningEffortForModel(model, effort) {
	if (typeof effort !== "string") return effort;
	const normalizedEffort = effort.trim().toLowerCase();
	if (!KNOWN_REASONING_EFFORTS.has(normalizedEffort)) {
		return effort;
	}

	const normalizedModel = normalizeRequestedModel(model);
	const supportedEfforts =
		SUPPORTED_REASONING_EFFORTS_BY_MODEL[normalizedModel] ?? null;
	const resolved = resolveSupportedReasoningEffort(
		normalizedEffort,
		supportedEfforts,
	);

	// `ultra` is a client-side tier: Codex rewrites it to `max` before the
	// request leaves the client, so it must never reach the wire. Mirror
	// lib/request/helpers/model-map.ts / request-transformer's getReasoningConfig.
	return resolved === "ultra" ? "max" : resolved;
}

function extractRequestedModel(args) {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		// Past `--` every token is root `[PROMPT]` text; a `-m` in there names
		// no model, and reading one would coerce reasoning config for a model
		// the user never requested.
		if (arg === "--") break;
		if (arg === "--model" || arg === "-m") {
			const next = args[i + 1];
			if (typeof next === "string" && next.trim().length > 0) {
				return next.trim();
			}
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (value.length > 0) {
				return value;
			}
		}
	}
	return null;
}

function parseConfigAssignment(value) {
	if (typeof value !== "string") return null;
	const separatorIndex = value.indexOf("=");
	if (separatorIndex < 0) return null;
	return {
		key: value.slice(0, separatorIndex).trim(),
		value: value.slice(separatorIndex + 1).trim(),
	};
}

function parseQuotedValue(value) {
	if (typeof value !== "string") {
		return { quote: '"', inner: "" };
	}
	const trimmed = value.trim();
	const first = trimmed[0];
	const last = trimmed.at(-1);
	if ((first === '"' || first === "'") && last === first) {
		return {
			quote: first,
			inner: trimmed.slice(1, -1),
		};
	}
	return { quote: '"', inner: trimmed };
}

function rewriteReasoningConfigAssignment(assignment, requestedModel) {
	const parsed = parseConfigAssignment(assignment);
	if (!parsed || parsed.key !== "model_reasoning_effort") {
		return assignment;
	}

	const { quote, inner } = parseQuotedValue(parsed.value);
	const coercedEffort = coerceReasoningEffortForModel(requestedModel, inner);
	if (coercedEffort === inner) {
		return assignment;
	}

	return `${parsed.key}=${quote}${coercedEffort}${quote}`;
}

function rewriteReasoningConfigArgs(rawArgs) {
	const requestedModel = extractRequestedModel(rawArgs);
	if (!requestedModel) {
		return {
			args: [...rawArgs],
			requestedModel: null,
		};
	}

	const nextArgs = [...rawArgs];
	for (let i = 0; i < nextArgs.length; i += 1) {
		const arg = nextArgs[i];
		// Past `--` a `-c key=value` pair is prompt text, not a config override.
		if (arg === "--") break;
		if ((arg === "-c" || arg === "--config") && typeof nextArgs[i + 1] === "string") {
			nextArgs[i + 1] = rewriteReasoningConfigAssignment(
				nextArgs[i + 1],
				requestedModel,
			);
			i += 1;
			continue;
		}
		if (typeof arg === "string" && arg.startsWith("--config=")) {
			const assignment = arg.slice("--config=".length);
			nextArgs[i] = `--config=${rewriteReasoningConfigAssignment(
				assignment,
				requestedModel,
			)}`;
		}
	}

	return {
		args: nextArgs,
		requestedModel,
	};
}

function resolveCodexHomeDir(env = process.env) {
	const override = (env.CODEX_HOME ?? "").trim();
	if (override.length > 0) return override;
	if (process.platform === "win32") {
		const homeDir = resolveWindowsUserHomeDir();
		if (homeDir) {
			return join(homeDir, ".codex");
		}
	}
	return join(env.HOME ?? homedir(), ".codex");
}

function ensureTrailingNewline(value) {
	return value.endsWith("\n") ? value : `${value}\n`;
}

function captureShadowHomeState(filePath, options = {}) {
	try {
		if (!existsSync(filePath)) {
			return { exists: false, content: null };
		}
		if (options.rethrowRetryableReadErrors) {
			maybeThrowSimulatedShadowHomePreflightReadBusyError();
		}
		return {
			exists: true,
			content: readFileSync(filePath, "utf8"),
		};
	} catch (error) {
		if (options.rethrowRetryableReadErrors && isRetryableShadowHomeCleanupError(error)) {
			throw error;
		}
		return { exists: true, content: null, unreadable: true };
	}
}

function shadowHomeStateMatches(left, right) {
	return (
		left.exists === right.exists &&
		left.content === right.content &&
		Boolean(left.unreadable) === Boolean(right.unreadable)
	);
}

function hashShadowHomeState(state) {
	if (state.unreadable) {
		return null;
	}
	if (!state.exists) {
		return "missing";
	}
	if (typeof state.content !== "string") {
		return null;
	}
	return `sha256:${createHash("sha256").update(state.content).digest("hex")}`;
}

function readShadowHomeSyncState(originalCodexHome) {
	try {
		const parsed = JSON.parse(
			readFileSync(join(originalCodexHome, SHADOW_HOME_SYNC_STATE_FILE), "utf8"),
		);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			parsed.version !== 1 ||
			!parsed.files ||
			typeof parsed.files !== "object"
		) {
			return { version: 1, files: {} };
		}
		return parsed;
	} catch {
		return { version: 1, files: {} };
	}
}

function rememberShadowHomeSyncState(
	originalCodexHome,
	syncState,
	name,
	baseState,
	syncedState,
) {
	const baseHash = hashShadowHomeState(baseState);
	const syncedHash = hashShadowHomeState(syncedState);
	if (!baseHash || !syncedHash) {
		return;
	}
	syncState.files[name] = {
		baseHash,
		syncedHash,
		updatedAt: Date.now(),
	};
	try {
		writeOwnerOnlyJsonFileAtomicSync(
			join(originalCodexHome, SHADOW_HOME_SYNC_STATE_FILE),
			syncState,
		);
	} catch {
		// Best-effort metadata; failed metadata must not fail auth cleanup.
	}
}

function canRebaseShadowHomeSyncState(syncState, name, baseState, currentState) {
	const entry = syncState.files?.[name];
	if (!entry || typeof entry !== "object") {
		return false;
	}
	// Permit a later shadow session to write over an earlier shadow sync from
	// the same launch snapshot, while still refusing unrelated external edits.
	return (
		entry.baseHash === hashShadowHomeState(baseState) &&
		entry.syncedHash === hashShadowHomeState(currentState)
	);
}

function readShadowHomeSyncLockOwnerPid(lockPath) {
	try {
		const rawOwner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
		const pid = Number(rawOwner?.pid);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isShadowHomeSyncLockOldEnoughToSteal(lockPath) {
	try {
		const stats = statSync(lockPath);
		const newestTimestamp = Math.max(stats.mtimeMs, stats.ctimeMs);
		return Date.now() - newestTimestamp >= SHADOW_HOME_ORPHAN_LOCK_STALE_AGE_MS;
	} catch {
		return true;
	}
}

function removeStaleShadowHomeSyncLock(lockPath) {
	const ownerPid = readShadowHomeSyncLockOwnerPid(lockPath);
	if (ownerPid !== null && isProcessAlive(ownerPid)) {
		return false;
	}
	if (ownerPid === null && !isShadowHomeSyncLockOldEnoughToSteal(lockPath)) {
		return false;
	}
	try {
		removeDirectoryWithRetry(lockPath);
		if (shadowHomeSyncLockRecreateStaleCount > 0) {
			shadowHomeSyncLockRecreateStaleCount -= 1;
			mkdirSync(lockPath, { recursive: true });
			writeShadowHomeSyncLockOwner(lockPath, {
				pid: 2_147_483_647,
				createdAt: 1,
			});
		}
		return true;
	} catch {
		return false;
	}
}

function writeShadowHomeSyncLockOwner(lockPath, owner) {
	const ownerPath = join(lockPath, "owner.json");
	maybeThrowSimulatedShadowHomeSyncLockOwnerWriteError();
	writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		chmodSync(ownerPath, 0o600);
	} catch {
		// Best-effort only; permission semantics vary by platform.
	}
}

function writeShadowHomeSyncLockOwnerWithRetry(lockPath, owner) {
	for (let attempt = 0; attempt <= SHADOW_HOME_CLEANUP_BACKOFF_MS.length; attempt += 1) {
		try {
			writeShadowHomeSyncLockOwner(lockPath, owner);
			return;
		} catch (error) {
			if (
				!isRetryableShadowHomeCleanupError(error) ||
				attempt === SHADOW_HOME_CLEANUP_BACKOFF_MS.length
			) {
				throw error;
			}
			sleepSync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
		}
	}
}

function acquireShadowHomeSyncLock(originalCodexHome) {
	const lockPath = join(originalCodexHome, SHADOW_HOME_SYNC_LOCK_DIR);
	mkdirSync(originalCodexHome, { recursive: true });
	const maxStaleRecoveries = SHADOW_HOME_CLEANUP_BACKOFF_MS.length + 1;
	let staleRecoveries = 0;
	let attempt = 0;
	const deadline = Date.now() + SHADOW_HOME_SYNC_LOCK_WAIT_TIMEOUT_MS;
	while (true) {
		try {
			mkdirSync(lockPath);
			try {
				writeShadowHomeSyncLockOwnerWithRetry(lockPath, {
					pid: process.pid,
					createdAt: Date.now(),
				});
			} catch (error) {
				try {
					removeDirectoryWithRetry(lockPath);
				} catch {
					// Preserve the owner write failure while avoiding orphaned locks when possible.
				}
				throw error;
			}
			return () => {
				try {
					removeDirectoryWithRetry(lockPath);
				} catch {
					// Best-effort lock cleanup only.
				}
			};
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? error.code
					: undefined;
			if (code !== "EEXIST") {
				throw error;
			}
			if (
				staleRecoveries < maxStaleRecoveries &&
				removeStaleShadowHomeSyncLock(lockPath)
			) {
				staleRecoveries += 1;
				attempt = 0;
				continue;
			}
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				throw error;
			}
			const backoffMs =
				SHADOW_HOME_CLEANUP_BACKOFF_MS[
					Math.min(attempt, SHADOW_HOME_CLEANUP_BACKOFF_MS.length - 1)
				] ?? SHADOW_HOME_CLEANUP_BACKOFF_MS[0];
			sleepSync(Math.min(backoffMs, remainingMs));
			attempt += 1;
		}
	}
}

function syncShadowHomeStateFile(
	sourcePath,
	destinationPath,
	expectedDestinationState,
) {
	const tempPath = join(
		dirname(destinationPath),
		`.${basename(destinationPath)}.codex-multi-auth-sync-${process.pid}.tmp`,
	);
	try {
		mkdirSync(dirname(destinationPath), { recursive: true });
		copyFileSync(sourcePath, tempPath);
		renameFileWithRetry(tempPath, destinationPath, expectedDestinationState);
	} catch (error) {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Best-effort cleanup only.
		}
		throw error;
	}
}

function syncShadowHomeStateFileBestEffort(
	sourcePath,
	destinationPath,
	expectedDestinationState,
	tightenFile,
) {
	try {
		syncShadowHomeStateFile(
			sourcePath,
			destinationPath,
			expectedDestinationState,
		);
		tightenFile(destinationPath);
		return true;
	} catch {
		// Best-effort sync-back: keep attempting sibling files after Windows locks.
		return false;
	}
}

function isDirectoryLike(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFileLike(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function mirrorDirectoryIntoShadowHome(sourcePath, destinationPath) {
	try {
		if ((process.env.CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_DIR_COPY ?? "").trim() === "1") {
			throw new Error("simulated directory link failure");
		}
		symlinkSync(
			sourcePath,
			destinationPath,
			process.platform === "win32" ? "junction" : "dir",
		);
		return "linked";
	} catch {
		// Fall back to a copy when links are unavailable. Directory links are
		// preferred because they keep sessions, plugins, and skills live.
	}
	cpSync(sourcePath, destinationPath, {
		recursive: true,
		dereference: false,
	});
	return "copied";
}

function linkDirectoryIntoShadowHome(sourcePath, destinationPath) {
	try {
		if ((process.env.CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_DIR_COPY ?? "").trim() === "1") {
			throw new Error("simulated directory link failure");
		}
		symlinkSync(
			sourcePath,
			destinationPath,
			process.platform === "win32" ? "junction" : "dir",
		);
		return true;
	} catch {
		return false;
	}
}

function warnSkippedLinkOnlyShadowHomeDirectory(name) {
	if (warnedShadowHomeLinkOnlyDirectoryFailures.has(name)) {
		return;
	}
	warnedShadowHomeLinkOnlyDirectoryFailures.add(name);
	console.error(
		`codex-multi-auth: skipped optional shadow-home directory ${name} because linking failed; refusing to copy generated runtime data.`,
	);
}

function shouldCopyRuntimeGeneratedShadowHomeDirectoryFallback() {
	const normalized = (
		process.env.CODEX_MULTI_AUTH_RUNTIME_SHADOW_COPY_GENERATED_DIRS ?? ""
	)
		.trim()
		.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function linkFileIntoShadowHome(sourcePath, destinationPath) {
	try {
		symlinkSync(sourcePath, destinationPath, "file");
		return true;
	} catch {
		// File symlinks keep SQLite/cache-style root files realtime when allowed.
	}
	try {
		linkSync(sourcePath, destinationPath);
		return true;
	} catch {
		// Hard links cover platforms where file symlinks require extra privileges.
	}
	return false;
}

function mirrorFileIntoShadowHome(sourcePath, destinationPath, tightenFile) {
	if (linkFileIntoShadowHome(sourcePath, destinationPath)) {
		return;
	}
	copyFileSync(sourcePath, destinationPath);
	tightenFile(destinationPath);
}

function isSqliteMainFile(name) {
	return /\.sqlite$/i.test(name);
}

function isSqliteSidecarFile(name) {
	return /\.sqlite-(?:shm|wal)$/i.test(name);
}

function normalizeRuntimeShadowHomeEntryName(name) {
	return process.platform === "win32" || process.platform === "darwin"
		? name.toLowerCase()
		: name;
}

function isCodexRuntimeLocalSqliteFile(name) {
	const normalizedName = normalizeRuntimeShadowHomeEntryName(name);
	return /^(?:state|logs)_\d+\.sqlite(?:-(?:shm|wal))?$/.test(normalizedName);
}

function isCodexRuntimeTransientStateFile(name) {
	const normalizedName = normalizeRuntimeShadowHomeEntryName(name);
	return (
		/^(?:auth|accounts)\.json\.\d+\.[a-z0-9]+\.tmp$/.test(
			normalizedName,
		) ||
		/^\.codex-global-state\.json\.tmp-[a-z0-9-]+$/.test(normalizedName)
	);
}

function isRuntimeRotationShadowHomeOmittedEntry(name) {
	const normalizedName = normalizeRuntimeShadowHomeEntryName(name);
	return (
		RUNTIME_ROTATION_SHADOW_HOME_OMIT_ROOT_DIRS.has(normalizedName) ||
		isCodexRuntimeLocalSqliteFile(name) ||
		isCodexRuntimeTransientStateFile(name)
	);
}

function isRuntimeRotationShadowHomeLinkOnlyDirectory(name) {
	const normalizedName = normalizeRuntimeShadowHomeEntryName(name);
	return RUNTIME_ROTATION_SHADOW_HOME_LINK_ONLY_ROOT_DIRS.has(normalizedName);
}

function shouldMaterializeFileIntoShadowHome(name) {
	return isSqliteMainFile(name) || isSqliteSidecarFile(name);
}

function warnSkippedSqliteShadowHomeMaterialization() {
	if (!warnedShadowHomeSqliteLinkFailure) {
		warnedShadowHomeSqliteLinkFailure = true;
		console.error(
			"codex-multi-auth: skipped SQLite shadow-home materialization because linking failed; refusing to copy active SQLite state.",
		);
	}
}

function warnSkippedSqliteShadowHomeSidecarPlaceholder(error, destinationPath) {
	if (!warnedShadowHomeSqliteSidecarPlaceholderFailures.has(destinationPath)) {
		warnedShadowHomeSqliteSidecarPlaceholderFailures.add(destinationPath);
		console.error(
			`codex-multi-auth: skipped SQLite shadow-home sidecar placeholder for ${destinationPath} because linking failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function materializeSqliteSidecarPlaceholder(sourceSidecarPath, destinationSidecarPath) {
	try {
		if (
			(process.env.CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_SIDECAR_PLACEHOLDER_FAILURE ??
				""
			).trim() === "1"
		) {
			const error = new Error("simulated SQLite sidecar placeholder failure");
			error.code = "EPERM";
			throw error;
		}
		symlinkSync(sourceSidecarPath, destinationSidecarPath, "file");
		return true;
	} catch (error) {
		if (error?.code === "EEXIST") {
			return true;
		}
		warnSkippedSqliteShadowHomeSidecarPlaceholder(error, destinationSidecarPath);
		return false;
	}
}

function materializeFileIntoShadowHome(sourcePath, destinationPath) {
	try {
		if (
			(process.env.CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_SQLITE_SIDECAR_LINK_FAILURE ??
				""
			).trim() === "1" &&
			isSqliteSidecarFile(basename(sourcePath))
		) {
			throw new Error("simulated SQLite sidecar link failure");
		}
		if (linkFileIntoShadowHome(sourcePath, destinationPath)) {
			return true;
		}
		warnSkippedSqliteShadowHomeMaterialization();
	} catch {
		warnSkippedSqliteShadowHomeMaterialization();
	}
	return false;
}

function materializeSqliteSidecarsIntoShadowHome(sourcePath, destinationPath) {
	for (const suffix of ["-wal", "-shm"]) {
		const sourceSidecarPath = `${sourcePath}${suffix}`;
		const destinationSidecarPath = `${destinationPath}${suffix}`;
		if (existsSync(destinationSidecarPath)) {
			continue;
		}
		if (existsSync(sourceSidecarPath)) {
			if (!materializeFileIntoShadowHome(sourceSidecarPath, destinationSidecarPath)) {
				if (!materializeSqliteSidecarPlaceholder(
					sourceSidecarPath,
					destinationSidecarPath,
				)) {
					return false;
				}
			}
			continue;
		}
		if (!materializeSqliteSidecarPlaceholder(sourceSidecarPath, destinationSidecarPath)) {
			return false;
		}
	}
	return true;
}

function removeSqliteShadowHomeMaterialization(destinationPath) {
	for (const path of [destinationPath, `${destinationPath}-wal`, `${destinationPath}-shm`]) {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best-effort cleanup; keep removing the remaining SQLite siblings.
		}
	}
}

function collectShadowHomeSyncFileNames(shadowCodexHome, syncFileNames) {
	try {
		for (const entry of readdirSync(shadowCodexHome, { withFileTypes: true })) {
			const name = entry.name;
			if (
				name === SHADOW_HOME_CONFIG_FILE ||
				name === SHADOW_HOME_SYNC_STATE_FILE ||
				syncFileNames.has(name)
			) {
				continue;
			}
			const shadowPath = join(shadowCodexHome, name);
			let fileLike = entry.isFile();
			if (entry.isSymbolicLink()) {
				fileLike = isFileLike(shadowPath);
			}
			if (fileLike) {
				syncFileNames.add(name);
			}
		}
	} catch {
		// Best-effort; cleanup still syncs the known state files.
	}
	return syncFileNames;
}

function syncCopiedShadowHomeDirectories(originalCodexHome, shadowCodexHome, names) {
	for (const name of names) {
		const shadowPath = join(shadowCodexHome, name);
		if (!isDirectoryLike(shadowPath)) {
			continue;
		}
		try {
			cpSync(shadowPath, join(originalCodexHome, name), {
				recursive: true,
				dereference: false,
				force: true,
			});
		} catch {
			// Best-effort sync-back; sibling directories and state files still run.
		}
	}
}

function syncShadowHomeAuthBundle(
	originalCodexHome,
	shadowCodexHome,
	originalFileStates,
	tightenFile,
	skipSyncBackNames = new Set(),
) {
	const syncState = readShadowHomeSyncState(originalCodexHome);
	for (const name of SHADOW_HOME_STATE_FILES) {
		if (skipSyncBackNames.has(name)) {
			continue;
		}
		const shadowPath = join(shadowCodexHome, name);
		const shadowState = captureShadowHomeState(shadowPath);
		if (!shadowState.exists || shadowState.unreadable) {
			continue;
		}
		const originalPath = join(originalCodexHome, name);
		const originalSnapshot =
			originalFileStates.get(name) ?? { exists: false, content: null };
		const currentOriginalState = captureShadowHomeState(originalPath);
		let expectedDestinationState = originalSnapshot;
		if (!shadowHomeStateMatches(currentOriginalState, originalSnapshot)) {
			if (
				!canRebaseShadowHomeSyncState(
					syncState,
					name,
					originalSnapshot,
					currentOriginalState,
				)
			) {
				continue;
			}
			expectedDestinationState = currentOriginalState;
		}
		if (
			expectedDestinationState.unreadable ||
			shadowHomeStateMatches(shadowState, expectedDestinationState)
		) {
			continue;
		}
		if (syncShadowHomeStateFileBestEffort(
			shadowPath,
			originalPath,
			expectedDestinationState,
			tightenFile,
		)) {
			rememberShadowHomeSyncState(
				originalCodexHome,
				syncState,
				name,
				originalSnapshot,
				shadowState,
			);
		}
	}
}

function syncAdditionalShadowHomeFiles(
	originalCodexHome,
	shadowCodexHome,
	names,
	originalFileStates,
	tightenFile,
	skipSyncBackNames = new Set(),
	skipSyncBackPredicate = () => false,
) {
	for (const name of names) {
		if (
			SHADOW_HOME_STATE_FILE_SET.has(name) ||
			skipSyncBackNames.has(name) ||
			skipSyncBackPredicate(name)
		) {
			continue;
		}
		const shadowPath = join(shadowCodexHome, name);
		const shadowState = captureShadowHomeState(shadowPath);
		if (!shadowState.exists || shadowState.unreadable) {
			continue;
		}

		const originalPath = join(originalCodexHome, name);
		const originalSnapshot =
			originalFileStates.get(name) ?? { exists: false, content: null };
		const currentOriginalState = captureShadowHomeState(originalPath);
		if (!shadowHomeStateMatches(currentOriginalState, originalSnapshot)) {
			continue;
		}
		if (shadowHomeStateMatches(shadowState, originalSnapshot)) {
			continue;
		}
		syncShadowHomeStateFileBestEffort(
			shadowPath,
			originalPath,
			originalSnapshot,
			tightenFile,
		);
	}
}

function createShadowHomeMirror(
	originalCodexHome,
	shadowCodexHome,
	tightenFile,
	options = {},
) {
	const syncFileNames = new Set(SHADOW_HOME_STATE_FILES);
	const skipSyncBackNames = new Set(options.skipSyncBackNames ?? []);
	const skipMirrorPredicate = options.skipMirrorPredicate ?? (() => false);
	const skipSyncBackPredicate = options.skipSyncBackPredicate ?? (() => false);
	const linkOnlyDirectoryPredicate =
		options.linkOnlyDirectoryPredicate ?? (() => false);
	const originalFileStates = new Map();
	const copiedDirectoryNames = new Set();
	const rememberSyncFile = (name) => {
		if (!originalFileStates.has(name)) {
			originalFileStates.set(
				name,
				captureShadowHomeState(join(originalCodexHome, name)),
			);
		}
		syncFileNames.add(name);
	};
	for (const name of SHADOW_HOME_STATE_FILES) {
		rememberSyncFile(name);
	}

	if (existsSync(originalCodexHome)) {
		for (const entry of readdirSync(originalCodexHome, { withFileTypes: true })) {
			const name = entry.name;
			if (
				name === SHADOW_HOME_CONFIG_FILE ||
				name === SHADOW_HOME_SYNC_STATE_FILE ||
				name === SHADOW_HOME_SYNC_LOCK_DIR ||
				skipMirrorPredicate(name)
			) {
				continue;
			}
			const isKnownStateFile = SHADOW_HOME_STATE_FILE_SET.has(name);
			const shouldMaterializeFile = shouldMaterializeFileIntoShadowHome(name);
			const sourcePath = join(originalCodexHome, name);
			const destinationPath = join(shadowCodexHome, name);
			if (existsSync(destinationPath)) {
				continue;
			}

			let directoryLike = entry.isDirectory();
			let fileLike = entry.isFile();
			if (entry.isSymbolicLink()) {
				directoryLike = isDirectoryLike(sourcePath);
				fileLike = !directoryLike && isFileLike(sourcePath);
			}

			try {
				if (isKnownStateFile && !fileLike) {
					throw new Error(`Expected ${name} to be a file`);
				}
				if (directoryLike) {
					if (
						linkOnlyDirectoryPredicate(name) &&
						!shouldCopyRuntimeGeneratedShadowHomeDirectoryFallback()
					) {
						if (!linkDirectoryIntoShadowHome(sourcePath, destinationPath)) {
							warnSkippedLinkOnlyShadowHomeDirectory(name);
						}
						continue;
					}
					if (mirrorDirectoryIntoShadowHome(sourcePath, destinationPath) === "copied") {
						copiedDirectoryNames.add(name);
					}
					continue;
				}
				if (fileLike) {
					rememberSyncFile(name);
					if (isKnownStateFile) {
						copyFileSync(sourcePath, destinationPath);
						tightenFile(destinationPath);
					} else if (shouldMaterializeFile) {
						if (isSqliteSidecarFile(name)) {
							continue;
						}
						if (materializeFileIntoShadowHome(sourcePath, destinationPath) && isSqliteMainFile(name)) {
							if (!materializeSqliteSidecarsIntoShadowHome(sourcePath, destinationPath)) {
								removeSqliteShadowHomeMaterialization(destinationPath);
							}
						}
					} else {
						mirrorFileIntoShadowHome(sourcePath, destinationPath, tightenFile);
					}
				}
			} catch (error) {
				if (isKnownStateFile) {
					throw error;
				}
				// A missing or locked optional home entry should not block runtime
				// launch; auth/config files still get handled explicitly.
			}
		}
	}

	return () => {
		let releaseLock = () => {};
		try {
			const names = collectShadowHomeSyncFileNames(shadowCodexHome, syncFileNames);
			releaseLock = acquireShadowHomeSyncLock(originalCodexHome);
			syncShadowHomeAuthBundle(
				originalCodexHome,
				shadowCodexHome,
				originalFileStates,
				tightenFile,
				skipSyncBackNames,
			);
			syncCopiedShadowHomeDirectories(
				originalCodexHome,
				shadowCodexHome,
				copiedDirectoryNames,
			);
			syncAdditionalShadowHomeFiles(
				originalCodexHome,
				shadowCodexHome,
				names,
				originalFileStates,
				tightenFile,
				skipSyncBackNames,
				skipSyncBackPredicate,
			);
		} catch {
			// Best-effort only; runtime auth refreshes should not fail cleanup.
		} finally {
			releaseLock();
		}
	};
}

function rewriteConfigTomlReasoningEffort(rawConfig, requestedModel) {
	const lineEnding = rawConfig.includes("\r\n") ? "\r\n" : "\n";
	let changed = false;
	const nextLines = rawConfig.split(/\r?\n/).map((line) => {
		const quotedMatch = line.match(
			/^(\s*model_reasoning_effort\s*=\s*)(["'])([^"']+)(\2.*)$/,
		);
		const bareMatch = quotedMatch
			? null
			: line.match(
					/^(\s*model_reasoning_effort\s*=\s*)([^\s#]+)(\s*(?:#.*)?)$/,
				);
		if (!quotedMatch && !bareMatch) return line;

		const prefix = quotedMatch?.[1] ?? bareMatch?.[1] ?? "";
		const openingQuote = quotedMatch?.[2] ?? "";
		const currentEffort = quotedMatch?.[3] ?? bareMatch?.[2] ?? "";
		const suffix = quotedMatch?.[4] ?? bareMatch?.[3] ?? "";
		const coercedEffort = coerceReasoningEffortForModel(
			requestedModel,
			currentEffort,
		);
		if (coercedEffort === currentEffort) {
			return line;
		}

		changed = true;
		return quotedMatch
			? `${prefix}${openingQuote}${coercedEffort}${suffix}`
			: `${prefix}${coercedEffort}${suffix}`;
	});

	if (!changed) {
		return rawConfig;
	}

	return ensureTrailingNewline(nextLines.join(lineEnding));
}

function resolveOriginalMultiAuthDir(env) {
	const explicit = (env.CODEX_MULTI_AUTH_DIR ?? "").trim();
	if (explicit.length > 0) {
		return explicit;
	}
	return undefined;
}

function resolveRuntimeRotationOriginalMultiAuthDir(originalCodexHome, env) {
	return resolveOriginalMultiAuthDir(env) ?? join(originalCodexHome, "multi-auth");
}

function parseRuntimeRotationProxyEnv(value) {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized.length === 0) return undefined;
	if (normalized === "1" || normalized === "true" || normalized === "yes") {
		return true;
	}
	if (normalized === "0" || normalized === "false" || normalized === "no") {
		return false;
	}
	if (!warnedInvalidRuntimeRotationProxyEnv) {
		warnedInvalidRuntimeRotationProxyEnv = true;
		console.error(
			"codex-multi-auth: ignoring invalid CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY value. Expected 0/1, true/false, or yes/no.",
		);
	}
	return undefined;
}

async function isRuntimeRotationProxyEnabled(rawArgs, baseEnv = process.env) {
	if ((baseEnv.CODEX_MULTI_AUTH_BYPASS ?? "").trim() === "1") {
		return false;
	}
	if (!shouldUseRuntimeRoutingForForwardedArgs(rawArgs)) {
		return false;
	}

	const envOverride = parseRuntimeRotationProxyEnv(
		baseEnv.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY,
	);
	if (envOverride !== undefined) {
		return envOverride;
	}

	const configModule = await loadRuntimeRotationConfigModule();
	if (!configModule) {
		return false;
	}
	const pluginConfig = configModule.loadPluginConfig();
	return configModule.getCodexRuntimeRotationProxy(pluginConfig) === true;
}

function createRuntimeRotationProxyClientApiKey() {
	return randomBytes(32).toString("hex");
}

function omitRuntimeRotationShadowHomeStateFiles(shadowCodexHome) {
	for (const name of RUNTIME_ROTATION_SHADOW_HOME_OMIT_STATE_FILES) {
		const targetPath = join(shadowCodexHome, name);
		try {
			if (!existsSync(targetPath)) {
				continue;
			}
			if (isDirectoryLike(targetPath)) {
				removeDirectoryWithRetry(targetPath);
			} else {
				rmSync(targetPath, { force: true });
			}
		} catch {
			// Best-effort: stale official auth state should not block runtime rotation.
		}
	}
}

function resolveRuntimeRotationProxyOriginalCodexHome(baseEnv) {
	const override = (baseEnv[APP_RUNTIME_HELPER_REAL_CODEX_HOME_ENV] ?? "").trim();
	return override || resolveCodexHomeDir(baseEnv);
}

function createRuntimeRotationShadowHome(originalCodexHome) {
	const shadowRoot = join(
		originalCodexHome,
		"multi-auth",
		"runtime-shadow-homes",
	);
	mkdirSync(shadowRoot, { recursive: true });
	return mkdtempSync(join(shadowRoot, "codex-multi-auth-runtime-home-"));
}

function parseHookStateTableKey(line) {
	const basicStringMatch =
		/^\s*\[\s*hooks\.state\.("(?:[^"\\]|\\.)*")\s*\]\s*$/.exec(line);
	if (basicStringMatch) {
		try {
			const parsed = JSON.parse(basicStringMatch[1]);
			return typeof parsed === "string" ? parsed : null;
		} catch {
			return null;
		}
	}

	const literalStringMatch = /^\s*\[\s*hooks\.state\.'([^']*)'\s*\]\s*$/.exec(
		line,
	);
	return literalStringMatch ? literalStringMatch[1] : null;
}

function isTomlTableLine(line) {
	return /^\s*\[\[?\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.|\s*\]\]?\s*(?:#.*)?$)/.test(
		line,
	);
}

// Keep these TOML block scan helpers aligned with test/codex-bin-wrapper.test.ts.
function createTomlBlockScanState() {
	return {
		arrayDepth: 0,
		multilineStringDelimiter: null,
	};
}

function isTopLevelTomlBlockScanState(state) {
	return state.arrayDepth === 0 && state.multilineStringDelimiter === null;
}

function updateTomlBlockScanState(line, state) {
	for (let index = 0; index < line.length; index += 1) {
		if (state.multilineStringDelimiter) {
			const closeIndex = line.indexOf(state.multilineStringDelimiter, index);
			if (closeIndex < 0) {
				return;
			}
			index = closeIndex + state.multilineStringDelimiter.length - 1;
			state.multilineStringDelimiter = null;
			continue;
		}

		if (line[index] === "#") {
			return;
		}
		if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
			state.multilineStringDelimiter = line.slice(index, index + 3);
			index += 2;
			continue;
		}
		if (line[index] === '"') {
			index += 1;
			for (; index < line.length; index += 1) {
				if (line[index] === "\\") {
					index += 1;
				} else if (line[index] === '"') {
					break;
				}
			}
			continue;
		}
		if (line[index] === "'") {
			const closeIndex = line.indexOf("'", index + 1);
			if (closeIndex < 0) return;
			index = closeIndex;
			continue;
		}
		if (line[index] === "[") {
			state.arrayDepth += 1;
		} else if (line[index] === "]" && state.arrayDepth > 0) {
			state.arrayDepth -= 1;
		}
	}
}

function mirrorRuntimeShadowHookTrustState(
	rawConfig,
	originalCodexHome,
	shadowCodexHome,
	tomlStringLiteral,
) {
	const sourceHooksPath = join(originalCodexHome, "hooks.json");
	const shadowHooksPath = join(shadowCodexHome, "hooks.json");
	if (sourceHooksPath === shadowHooksPath) {
		return rawConfig;
	}

	const lineEnding = rawConfig.includes("\r\n") ? "\r\n" : "\n";
	const lines = rawConfig.length > 0 ? rawConfig.split(/\r?\n/) : [];
	const sourcePrefix = `${sourceHooksPath}:`;
	const existingHookStateKeys = new Set();
	for (const line of lines) {
		const key = parseHookStateTableKey(line);
		if (key) {
			existingHookStateKeys.add(key);
		}
	}

	const output = [];
	let changed = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const key = parseHookStateTableKey(line);
		output.push(line);
		if (!key || !key.startsWith(sourcePrefix)) {
			continue;
		}

		const blockLines = [];
		let nextIndex = index + 1;
		const blockState = createTomlBlockScanState();
		for (; nextIndex < lines.length; nextIndex += 1) {
			const nextLine = lines[nextIndex];
			if (
				isTopLevelTomlBlockScanState(blockState) &&
				isTomlTableLine(nextLine)
			) {
				break;
			}
			blockLines.push(nextLine);
			updateTomlBlockScanState(nextLine, blockState);
		}
		output.push(...blockLines);
		index = nextIndex - 1;
		const shadowKey = `${shadowHooksPath}:${key.slice(sourcePrefix.length)}`;
		if (existingHookStateKeys.has(shadowKey)) {
			continue;
		}
		output.push("");
		output.push(`[hooks.state.${tomlStringLiteral(shadowKey)}]`);
		output.push(...blockLines);
		existingHookStateKeys.add(shadowKey);
		changed = true;
	}

	return changed ? output.join(lineEnding) : rawConfig;
}

function createRuntimeRotationProxyCodexHome(
	baseEnv,
	proxyBaseUrl,
	clientApiKey,
	configTomlModule,
) {
	const originalCodexHome = resolveRuntimeRotationProxyOriginalCodexHome(baseEnv);
	const shadowCodexHome = createRuntimeRotationShadowHome(originalCodexHome);
	let syncShadowHomeStateBack = () => {};
	const cleanup = () => {
		try {
			removeDirectoryWithRetry(shadowCodexHome);
		} catch {
			// Best-effort cleanup only.
		}
	};
	const tightenShadowHomePermissions = (path) => {
		try {
			chmodSync(path, 0o600);
		} catch {
			// Best-effort only; permission semantics vary by platform.
		}
	};

	try {
		syncShadowHomeStateBack = createShadowHomeMirror(
			originalCodexHome,
			shadowCodexHome,
			tightenShadowHomePermissions,
			{
				skipMirrorPredicate: isRuntimeRotationShadowHomeOmittedEntry,
				skipSyncBackNames: RUNTIME_ROTATION_SHADOW_HOME_OMIT_STATE_FILES,
				skipSyncBackPredicate: isRuntimeRotationShadowHomeOmittedEntry,
				linkOnlyDirectoryPredicate: isRuntimeRotationShadowHomeLinkOnlyDirectory,
			},
		);
		omitRuntimeRotationShadowHomeStateFiles(shadowCodexHome);
		const originalConfigPath = join(originalCodexHome, "config.toml");
		const rawConfig = existsSync(originalConfigPath)
			? readFileSync(originalConfigPath, "utf8")
			: "";
		const runtimeConfig = mirrorRuntimeShadowHookTrustState(
			configTomlModule.rewriteConfigTomlForRuntimeRotationProvider(
				rawConfig,
				proxyBaseUrl,
				clientApiKey,
			),
			originalCodexHome,
			shadowCodexHome,
			configTomlModule.tomlStringLiteral,
		);
		const runtimeConfigPath = join(shadowCodexHome, "config.toml");
		writeFileSync(runtimeConfigPath, runtimeConfig, "utf8");
		tightenShadowHomePermissions(runtimeConfigPath);
	} catch (error) {
		cleanup();
		throw error;
	}

	const forwardedEnv = {
		...baseEnv,
		CODEX_HOME: shadowCodexHome,
		OPENAI_API_KEY: clientApiKey,
		CODEX_MULTI_AUTH_DIR: resolveRuntimeRotationOriginalMultiAuthDir(
			originalCodexHome,
			baseEnv,
		),
	};

	return {
		env: forwardedEnv,
		cleanup: () => {
			syncShadowHomeStateBack();
			cleanup();
		},
	};
}

function createRuntimeRotationProxyCanonicalCodexHome(
	baseEnv,
	proxyBaseUrl,
	clientApiKey,
	configTomlModule,
) {
	const originalCodexHome = resolveRuntimeRotationProxyOriginalCodexHome(baseEnv);
	const providerTable = `model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}`;
	const configArgs = [
		`${providerTable}.name=${configTomlModule.tomlStringLiteral(APP_SERVER_ACCOUNT_DISPLAY_NAME)}`,
		`${providerTable}.base_url=${configTomlModule.tomlStringLiteral(proxyBaseUrl)}`,
		`${providerTable}.env_key=${configTomlModule.tomlStringLiteral("OPENAI_API_KEY")}`,
		`${providerTable}.requires_openai_auth=false`,
		`${providerTable}.wire_api=${configTomlModule.tomlStringLiteral("responses")}`,
		"disable_response_storage=false",
	].flatMap((assignment) => ["-c", assignment]);

	return {
		args: configArgs,
		env: {
			...baseEnv,
			CODEX_HOME: originalCodexHome,
			OPENAI_API_KEY: clientApiKey,
			CODEX_MULTI_AUTH_DIR: resolveRuntimeRotationOriginalMultiAuthDir(
				originalCodexHome,
				baseEnv,
			),
		},
		cleanup: () => {},
	};
}

function appendNodeImportOption(nodeOptions, preloadPath) {
	const importOption = `--import=${pathToFileURL(preloadPath).href}`;
	const trimmed = (nodeOptions ?? "").trim();
	return trimmed.length > 0 ? `${trimmed} ${importOption}` : importOption;
}

function createRuntimeRotationAppServerPreloadSource(wrapperScriptPath) {
	return [
		'import { spawn } from "node:child_process";',
		'import { basename } from "node:path";',
		'import process from "node:process";',
		"",
		`const wrapperScriptPath = ${JSON.stringify(wrapperScriptPath)};`,
		`const accountLabelEnv = ${JSON.stringify(APP_SERVER_ACCOUNT_LABEL_ENV)};`,
		`const configArgsEnv = ${JSON.stringify(APP_SERVER_CONFIG_ARGS_ENV)};`,
		"let configArgs = [];",
		"try {",
		'  const parsed = JSON.parse(process.env[configArgsEnv] ?? "[]");',
		"  if (Array.isArray(parsed)) {",
		'    configArgs = parsed.filter((arg) => typeof arg === "string");',
		"  }",
		"} catch {",
		"  // Ignore malformed internal metadata and preserve app-server startup.",
		"}",
		"const rawArgs = process.argv.slice(1);",
		"const firstArg = rawArgs[0] ?? \"\";",
		'if (basename(firstArg).toLowerCase() === "app-server") {',
		'  const args = ["app-server", ...rawArgs.slice(1), ...configArgs];',
		"  const env = {",
		"    ...process.env,",
		'    CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",',
		"    [accountLabelEnv]: \"1\",",
		"  };",
		"  delete env[configArgsEnv];",
		"  const child = spawn(process.execPath, [wrapperScriptPath, ...args], {",
		"    stdio: \"inherit\",",
		"    env,",
		"  });",
		"  child.once(\"error\", (error) => {",
		'    console.error(`codex-multi-auth app-server shim failed: ${error instanceof Error ? error.message : String(error)}`);',
		"    process.exit(1);",
		"  });",
		"  child.once(\"exit\", (code, signal) => {",
		"    if (signal) {",
		'      process.exit(signal === "SIGINT" ? 130 : 1);',
		"      return;",
		"    }",
		"    process.exit(typeof code === \"number\" ? code : 1);",
		"  });",
		"  await new Promise(() => undefined);",
		"}",
		"",
	].join("\n");
}

function sweepStaleRuntimeRotationAppServerShimDirs(shimRootDir) {
	let entries = [];
	try {
		entries = readdirSync(shimRootDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(APP_SERVER_SHIM_HELPER_PREFIX)) {
			continue;
		}
		const pidText = entry.name.slice(APP_SERVER_SHIM_HELPER_PREFIX.length);
		const pid = Number.parseInt(pidText, 10);
		if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || isProcessAlive(pid)) {
			continue;
		}
		try {
			removeDirectoryWithRetry(join(shimRootDir, entry.name));
		} catch {
			// Best-effort stale shim cleanup only.
		}
	}
}

function installRuntimeRotationAppServerCliShim(forwardedEnv, configArgs = []) {
	const shadowCodexHome = forwardedEnv.CODEX_HOME;
	if (!shadowCodexHome) {
		throw new Error("runtime app-server shim requires CODEX_HOME");
	}
	const multiAuthDir =
		resolveOriginalMultiAuthDir(forwardedEnv) ??
		join(resolveRuntimeRotationProxyOriginalCodexHome(forwardedEnv), "multi-auth");
	const shimRootDir = join(multiAuthDir, APP_SERVER_SHIM_DIR_NAME);
	sweepStaleRuntimeRotationAppServerShimDirs(shimRootDir);
	const shimDir = join(
		shimRootDir,
		`${APP_SERVER_SHIM_HELPER_PREFIX}${process.pid}`,
	);
	mkdirSync(shimDir, { recursive: true });
	const executableName = process.platform === "win32" ? "codex.exe" : "codex";
	const executablePath = join(shimDir, executableName);
	const preloadPath = join(shimDir, "codex-multi-auth-app-server-preload.mjs");
	try {
		try {
			withSynchronousFileOperationRetry(() => {
				maybeThrowSimulatedAppServerShimFileError("cleanup");
				rmSync(executablePath, { force: true });
			});
		} catch {
			// Best-effort stale shim cleanup only; the copy below will report a
			// persistent failure without leaving a partially-created helper.
		}
		if (
			process.platform === "win32" ||
			(process.env.CODEX_MULTI_AUTH_TEST_FORCE_APP_SERVER_SHIM_COPY ?? "") === "1"
		) {
			// A Windows hard link to the running node.exe remains locked by the
			// helper process itself, which prevents the shim directory from being
			// removed during graceful helper shutdown. Use an independent image so
			// the helper can clean up its app-server shim before exiting.
			withSynchronousFileOperationRetry(() => {
				maybeThrowSimulatedAppServerShimFileError("copy");
				copyFileSync(process.execPath, executablePath);
			});
		} else {
			try {
				linkSync(process.execPath, executablePath);
			} catch {
				withSynchronousFileOperationRetry(() => {
					maybeThrowSimulatedAppServerShimFileError("copy");
					copyFileSync(process.execPath, executablePath);
				});
			}
		}
		if (process.platform !== "win32") {
			chmodSync(executablePath, 0o755);
		}
		writeFileSync(
			preloadPath,
			createRuntimeRotationAppServerPreloadSource(fileURLToPath(import.meta.url)),
			{ encoding: "utf8", mode: 0o600 },
		);
		try {
			chmodSync(preloadPath, 0o600);
		} catch {
			// Best-effort only; permission semantics vary by platform.
		}
	} catch (error) {
		try {
			removeDirectoryWithRetry(shimDir);
		} catch {
			// Preserve the original installation failure.
		}
		throw error;
	}
	forwardedEnv.CODEX_CLI_PATH = shimDir;
	forwardedEnv.NODE_OPTIONS = appendNodeImportOption(
		forwardedEnv.NODE_OPTIONS,
		preloadPath,
	);
	forwardedEnv.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY = "0";
	forwardedEnv[APP_SERVER_ACCOUNT_LABEL_ENV] = "1";
	if (configArgs.length > 0) {
		forwardedEnv[APP_SERVER_CONFIG_ARGS_ENV] = JSON.stringify(configArgs);
	} else {
		delete forwardedEnv[APP_SERVER_CONFIG_ARGS_ENV];
	}
	return shimDir;
}

// With a helper PID the path is per-helper, mirroring the owner files below —
// N concurrent helpers each publish their own status instead of last-writer-
// winning one shared file. Without a PID it is the legacy shared path, kept
// only so readers can still see a helper from before this change.
function resolveRuntimeRotationAppHelperStatusPath(env = process.env, helperPid) {
	const multiAuthDir =
		resolveOriginalMultiAuthDir(env) ?? join(resolveCodexHomeDir(env), "multi-auth");
	const statusFileName =
		typeof helperPid === "number" && Number.isInteger(helperPid) && helperPid > 0
			? APP_RUNTIME_HELPER_STATUS_FILE.replace(
					/\.json$/i,
					`.${helperPid}.json`,
				)
			: APP_RUNTIME_HELPER_STATUS_FILE;
	return join(multiAuthDir, statusFileName);
}

function resolveRuntimeRotationAppHelperOwnerPath(env = process.env, helperPid) {
	const multiAuthDir =
		resolveOriginalMultiAuthDir(env) ?? join(resolveCodexHomeDir(env), "multi-auth");
	const ownerFileName =
		typeof helperPid === "number" && Number.isInteger(helperPid) && helperPid > 0
			? APP_RUNTIME_HELPER_OWNER_FILE.replace(
					/\.json$/i,
					`.${helperPid}.json`,
				)
			: APP_RUNTIME_HELPER_OWNER_FILE;
	return join(multiAuthDir, ownerFileName);
}

function writeOwnerOnlyJsonFileAtomicSync(targetPath, payload) {
	const targetDir = dirname(targetPath);
	mkdirSync(targetDir, { recursive: true });
	for (let attempt = 0; attempt <= SHADOW_HOME_CLEANUP_BACKOFF_MS.length; attempt += 1) {
		const tempPath = join(
			targetDir,
			[
				`.${basename(targetPath)}`,
				String(process.pid),
				String(Date.now()),
				randomBytes(4).toString("hex"),
				"tmp",
			].join("."),
		);
		try {
			writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			chmodSync(tempPath, 0o600);
			maybeThrowSimulatedShadowHomeSyncMetadataBusyError(targetPath);
			renameSync(tempPath, targetPath);
			chmodSync(targetPath, 0o600);
			return;
		} catch (error) {
			try {
				rmSync(tempPath, { force: true });
			} catch {
				// Preserve the original write failure.
			}
			if (
				isRetryableShadowHomeCleanupError(error) &&
				attempt < SHADOW_HOME_CLEANUP_BACKOFF_MS.length
			) {
				sleepSync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
				continue;
			}
			throw error;
		}
	}
}

function resolveRuntimeRotationAppHelperIdleMs(env = process.env) {
	const parsed = Number.parseInt(
		env.CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS ?? "",
		10,
	);
	return Number.isFinite(parsed) && parsed > 0
		? Math.max(50, parsed)
		: DEFAULT_APP_RUNTIME_HELPER_IDLE_MS;
}

function resolveRuntimeRotationAppHelperOwnerPid(env = process.env) {
	const parsed = Number.parseInt(env[APP_RUNTIME_HELPER_OWNER_PID_ENV] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRuntimeRotationAppHelperMaxLifetimeMs(env = process.env) {
	const parsed = Number.parseInt(
		env.CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS ?? "",
		10,
	);
	// 0 disables the ceiling explicitly; anything unset or invalid gets the
	// default rather than unbounded life.
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: DEFAULT_APP_RUNTIME_HELPER_MAX_LIFETIME_MS;
}

function resolveRuntimeRotationAppHelperOwnerStartTimeMs(env = process.env) {
	const parsed = Number.parseInt(
		env[APP_RUNTIME_HELPER_OWNER_START_TIME_ENV] ?? "",
		10,
	);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// `lstart` is strftime-formatted and locale-sensitive; Date.parse on a
// localized string is implementation-defined and can yield NaN, which would
// silently disable the identity check. Both readers pin the C locale so both
// sides of every comparison parse the same shape.
function parseProcessStartTimeOutput(out) {
	const trimmed = (out ?? "").trim();
	if (!trimmed) return null;
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

// The kernel's start time for a PID, in epoch ms — the identity that survives
// PID reuse. Null on platforms without `ps` (Windows) or for a PID that is
// already gone; callers must treat null as "identity unknown" and fall back
// to bare liveness rather than declaring the process dead. Synchronous —
// launcher/sweep use only; the helper's tick uses the async variant below.
//
// Windows short-circuits rather than spawning: there is no `ps` there, so the
// probe could only ever fail, and it is not called once — the launcher probes
// itself on every launch and the sweep probes up to `probeBudget` candidates.
// Paying a process spawn per probe to learn nothing is the whole cost. Windows
// therefore runs on bare liveness, and the 24h lifetime ceiling is what bounds
// a leak there.
function readProcessStartTimeMs(pid) {
	if (process.platform === "win32") return null;
	try {
		return parseProcessStartTimeOutput(
			execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, LC_ALL: "C" },
				timeout: 2_000,
			}),
		);
	} catch {
		return null;
	}
}

// Async variant for the helper's status tick, which runs on the live rotation
// proxy's event loop: a wedged `ps` must stall a background probe, never an
// in-flight Responses stream. Same parse, same C locale, same null contract,
// and the same Windows short-circuit.
function readProcessStartTimeMsAsync(pid, onResult) {
	if (process.platform === "win32") {
		onResult(null);
		return;
	}
	let child;
	try {
		child = execFile(
			"ps",
			["-o", "lstart=", "-p", String(pid)],
			{
				encoding: "utf8",
				env: { ...process.env, LC_ALL: "C" },
				timeout: 2_000,
			},
			(error, stdout) => {
				onResult(error ? null : parseProcessStartTimeOutput(stdout));
			},
		);
	} catch {
		onResult(null);
		return;
	}
	// The probe must not keep the helper's event loop referenced on shutdown.
	child.unref?.();
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && typeof error === "object" && error.code === "EPERM";
	}
}

// `kill(pid, 0)` answers "does *a* process hold this integer", never "is this
// still my owner". PIDs recycle, and a helper that mistakes a recycled PID for
// its owner pushes its idle deadline forward — a ratchet, because one false
// "alive" is never corrected by later true "dead"s, which is how helpers were
// observed running 33 hours past a 12-hour timeout. Identity is the owner's
// process start time, captured by the launcher at spawn: a recycled PID
// necessarily has a later start time, so the match fails and the helper
// correctly sees a dead owner. When the start time is unknown (no `ps`, or a
// pre-upgrade launcher), behavior degrades to the bare liveness check.
//
// The verdict is deliberately three-valued. "No owner PID was recorded" and
// "the owner is confirmed dead" are different facts, and collapsing them into
// one `false` makes a helper launched without an owner — invoked directly, or
// spawned by a pre-upgrade launcher that sets no owner PID — start the
// detached clock on its very first tick and reap itself while it is still
// serving. `unknown` means neither branch fires, which is exactly what the
// pre-#664 `if (ownerPid && isAlive(ownerPid))` guard did.
const OWNER_ALIVE = "alive";
const OWNER_DEAD = "dead";
const OWNER_UNKNOWN = "unknown";

function createRuntimeRotationAppHelperOwnerLivenessCheck(
	ownerPid,
	expectedStartTimeMs,
	recheckIntervalMs = APP_RUNTIME_HELPER_OWNER_IDENTITY_RECHECK_MS,
) {
	let lastIdentityCheckedAt = 0;
	let lastIdentityVerdict = true;
	let probeInFlight = false;
	return (currentTime) => {
		if (!ownerPid) {
			return OWNER_UNKNOWN;
		}
		if (!isProcessAlive(ownerPid)) {
			return OWNER_DEAD;
		}
		if (expectedStartTimeMs === null) {
			return OWNER_ALIVE;
		}
		// The probe is asynchronous and single-flight: the tick runs on the live
		// proxy's event loop, so it always answers from the last verdict and the
		// probe updates it in the background — a stale verdict is tolerated by
		// design (one recheck window against a 12h timeout), and single-flight
		// means a wedged `ps` holds one child, not one per tick.
		if (
			!probeInFlight &&
			currentTime - lastIdentityCheckedAt >= recheckIntervalMs
		) {
			lastIdentityCheckedAt = currentTime;
			probeInFlight = true;
			readProcessStartTimeMsAsync(ownerPid, (actualStartTimeMs) => {
				probeInFlight = false;
				// A failed read is "identity unknown", not "owner dead": under the
				// process-table pressure this fix exists for, fork itself can fail,
				// and declaring a live owner dead would kill the proxy out from
				// under an active session. Keep the verdict and retry next window.
				if (actualStartTimeMs !== null) {
					lastIdentityVerdict = actualStartTimeMs === expectedStartTimeMs;
				}
			});
		}
		return lastIdentityVerdict ? OWNER_ALIVE : OWNER_DEAD;
	};
}

function resolveRuntimeRotationAppHelperTickMs(idleTimeoutMs, detachedIdleMs) {
	const shortestWindowMs =
		detachedIdleMs > 0 ? Math.min(idleTimeoutMs, detachedIdleMs) : idleTimeoutMs;
	return Math.min(1_000, Math.max(50, Math.floor(shortestWindowMs / 2)));
}

// `lastIdentityVerdict` starts optimistic, so the first tick reports the owner
// alive while the async `ps` probe is still in flight, and a helper adopted by
// a recycled owner PID keeps refreshing its activity clock until the first
// recheck lands. Against the 12h default that is deliberate and harmless. It
// stops being harmless the moment the windows are compressed: a 60s recheck
// pinned against a 250ms idle override — how the lifecycle tests run — is
// longer than the entire window under test, so whether the verdict ever flips
// comes down to probe timing. Scaling the recheck to the shortest window that
// can fire makes the flip a property of the code rather than a race, and
// production is untouched because both defaults are hours.
function resolveRuntimeRotationAppHelperOwnerRecheckMs(
	idleTimeoutMs,
	detachedIdleMs,
) {
	const shortestWindowMs =
		detachedIdleMs > 0 ? Math.min(idleTimeoutMs, detachedIdleMs) : idleTimeoutMs;
	return Math.min(
		APP_RUNTIME_HELPER_OWNER_IDENTITY_RECHECK_MS,
		Math.max(50, Math.floor(shortestWindowMs / 4)),
	);
}

function resolveRuntimeRotationAppHelperDetachedIdleMs(env = process.env) {
	const parsed = Number.parseInt(
		env.CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS ?? "",
		10,
	);
	// 0 disables the detached window explicitly, leaving a stranded helper on
	// the full idle timeout — the pre-fix behavior, for anyone who depends on it.
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: DEFAULT_APP_RUNTIME_HELPER_DETACHED_IDLE_MS;
}

function resolveRuntimeRotationAppHelperDetachGraceMs(env = process.env) {
	const parsed = Number.parseInt(
		env.CODEX_MULTI_AUTH_APP_ROTATION_DETACH_GRACE_MS ?? "",
		10,
	);
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: DEFAULT_APP_RUNTIME_HELPER_DETACH_GRACE_MS;
}

function pickRuntimeRotationAppHelperEnv(env) {
	const picked = {
		CODEX_HOME: env.CODEX_HOME,
		OPENAI_API_KEY: env.OPENAI_API_KEY,
	};
	for (const name of [
		"CODEX_CLI_PATH",
		"NODE_OPTIONS",
		"CODEX_MULTI_AUTH_REAL_CODEX_BIN",
		"CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY",
		APP_SERVER_ACCOUNT_LABEL_ENV,
		APP_SERVER_CONFIG_ARGS_ENV,
	]) {
		if (env[name]) {
			picked[name] = env[name];
		}
	}
	if (env.CODEX_MULTI_AUTH_DIR) {
		picked.CODEX_MULTI_AUTH_DIR = env.CODEX_MULTI_AUTH_DIR;
	}
	return picked;
}

function writeRuntimeRotationAppHelperStatus(payload, env = process.env) {
	try {
		const statusPath = resolveRuntimeRotationAppHelperStatusPath(
			env,
			payload?.pid,
		);
		writeOwnerOnlyJsonFileAtomicSync(statusPath, payload);
	} catch {
		// Best-effort status only; the helper must not fail because telemetry is unavailable.
	}
}

let helperMetadataCleanupBusyFailuresRemaining = resolveTestFaultInjectionCount(
	"CODEX_MULTI_AUTH_TEST_HELPER_METADATA_CLEANUP_BUSY_FAILURES",
);

function maybeThrowSimulatedHelperMetadataFileError() {
	if (
		Number.isFinite(helperMetadataCleanupBusyFailuresRemaining) &&
		helperMetadataCleanupBusyFailuresRemaining > 0
	) {
		helperMetadataCleanupBusyFailuresRemaining -= 1;
		const error = new Error("simulated EBUSY");
		error.code = "EBUSY";
		throw error;
	}
}

// Windows can hold a transient lock on a file another process just closed, so
// every metadata deletion goes through the shared retry rather than a bare
// rmSync — a swallowed EBUSY here is how stale files outlive their sweep.
function removeHelperMetadataFileWithRetry(targetPath) {
	try {
		withSynchronousFileOperationRetry(() => {
			maybeThrowSimulatedHelperMetadataFileError();
			rmSync(targetPath, { force: true });
		});
	} catch {
		// Best-effort metadata cleanup only; the next sweep retries.
	}
}

function removeRuntimeRotationAppHelperOwnerFile(env = process.env, helperPid) {
	removeHelperMetadataFileWithRetry(
		resolveRuntimeRotationAppHelperOwnerPath(env, helperPid),
	);
}

// Owner and status files are written per helper PID and removed on clean
// helper exit; a killed helper leaves its files behind. This sweep runs when a
// launcher starts the next helper, mirroring the app-server shim-dir sweep:
// any per-PID metadata whose helper is no longer alive is stale, as is the
// legacy shared status file once the PID recorded inside it is dead. Terminal
// status stamps ("idle-timeout", "stopped") therefore survive until the next
// helper launch — long enough to be read, without accumulating forever.
function sweepStaleRuntimeRotationAppHelperMetadata(env = process.env) {
	const multiAuthDir =
		resolveOriginalMultiAuthDir(env) ?? join(resolveCodexHomeDir(env), "multi-auth");
	let entries = [];
	try {
		entries = readdirSync(multiAuthDir, { withFileTypes: true });
	} catch {
		return;
	}
	// The same filename contract as `runtimeHelperPerPidPattern` in
	// lib/runtime-constants.ts, re-derived here from the same two constants
	// rather than imported: this wrapper has to keep working before `dist/` is
	// built (see `loadRuntimeConstants`), and a sweep that silently matched
	// nothing because an import failed would delete nothing and report success.
	// A change to the shape there is a change here.
	const perPidPattern = (baseName) =>
		new RegExp(
			`^${baseName.replace(/\.json$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\.json$`,
			"i",
		);
	const statusPattern = perPidPattern(APP_RUNTIME_HELPER_STATUS_FILE);
	const ownerPattern = perPidPattern(APP_RUNTIME_HELPER_OWNER_FILE);
	// A live kill(pid, 0) is not proof the helper is alive — the PID may have
	// been recycled since a SIGKILLed helper left its files behind, and a
	// recycled PID would otherwise shield the stale file from every future
	// sweep. When the file records when its helper started, a current process
	// whose kernel start time is meaningfully later cannot be that helper.
	// Identity probes are bounded: results are memoized per PID for the sweep
	// (the same PID backs both a status and an owner file), and at most a
	// handful of `ps` spawns run per launch — candidates past the cap are
	// treated as not-dead and the next launch finishes the work. Dead-PID
	// files, the overwhelming majority after a leak, never probe at all.
	const probedStartTimes = new Map();
	let probeBudget = 20;
	const probeStartTime = (pid) => {
		if (probedStartTimes.has(pid)) return probedStartTimes.get(pid);
		if (probeBudget <= 0) return undefined;
		probeBudget -= 1;
		const startTime = readProcessStartTimeMs(pid);
		probedStartTimes.set(pid, startTime);
		return startTime;
	};
	const isSweepCandidateDead = (pid, filePath) => {
		if (!isProcessAlive(pid)) return true;
		let recordedAt = null;
		try {
			const parsed = JSON.parse(readFileSync(filePath, "utf8"));
			if (parsed && typeof parsed === "object") {
				recordedAt =
					typeof parsed.startedAt === "number"
						? parsed.startedAt
						: typeof parsed.createdAt === "number"
							? parsed.createdAt
							: null;
			}
		} catch {
			return false;
		}
		if (recordedAt === null) return false;
		const actualStartTimeMs = probeStartTime(pid);
		if (actualStartTimeMs === null || actualStartTimeMs === undefined) {
			return false;
		}
		return actualStartTimeMs > recordedAt + 60_000;
	};
	// Classifying a file as stale and deleting it are two moments, and a PID
	// freed between them can be handed to a helper starting right now — which
	// then republishes this exact path before the delete lands, and the sweep
	// erases a live helper's metadata: invisible to `rotation status`, to
	// runtime account resolution, and to `unbind-app`, reapable only by its own
	// timers. Deleting only a file whose mtime still matches what was
	// classified closes that window; a file rewritten underneath us is by
	// definition not the one judged dead.
	const removeIfUnchanged = (entryPath, classifiedMtimeMs) => {
		if (classifiedMtimeMs !== null) {
			let currentMtimeMs = null;
			try {
				currentMtimeMs = statSync(entryPath).mtimeMs;
			} catch {
				return;
			}
			if (currentMtimeMs !== classifiedMtimeMs) return;
		}
		removeHelperMetadataFileWithRetry(entryPath);
	};
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const match =
			statusPattern.exec(entry.name) ?? ownerPattern.exec(entry.name);
		if (!match) continue;
		const pid = Number.parseInt(match[1], 10);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const entryPath = join(multiAuthDir, entry.name);
		let classifiedMtimeMs = null;
		try {
			classifiedMtimeMs = statSync(entryPath).mtimeMs;
		} catch {
			continue;
		}
		if (!isSweepCandidateDead(pid, entryPath)) continue;
		removeIfUnchanged(entryPath, classifiedMtimeMs);
	}
	const legacyStatusPath = join(multiAuthDir, APP_RUNTIME_HELPER_STATUS_FILE);
	try {
		const legacyMtimeMs = statSync(legacyStatusPath).mtimeMs;
		const parsed = JSON.parse(readFileSync(legacyStatusPath, "utf8"));
		const legacyPid =
			parsed && typeof parsed === "object" && Number.isInteger(parsed.pid)
				? parsed.pid
				: null;
		if (
			legacyPid === null ||
			legacyPid <= 0 ||
			isSweepCandidateDead(legacyPid, legacyStatusPath)
		) {
			removeIfUnchanged(legacyStatusPath, legacyMtimeMs);
		}
	} catch {
		// Missing or unreadable legacy status; nothing to sweep.
	}
}

function writeRuntimeRotationAppHelperOwner(
	identityToken,
	helperPid,
	env = process.env,
) {
	if (
		typeof helperPid !== "number" ||
		!Number.isInteger(helperPid) ||
		helperPid < 1
	) {
		return;
	}
	try {
		writeOwnerOnlyJsonFileAtomicSync(
			resolveRuntimeRotationAppHelperOwnerPath(env, helperPid),
			{
				version: 1,
				kind: "codex-app-runtime-rotation-helper-owner",
				identityToken,
				launcherPid: process.pid,
				createdAt: Date.now(),
			},
		);
	} catch {
		// Best-effort metadata; an unavailable owner file must never stop the helper.
	}
}

function createRuntimeRotationAppHelperStatus({
	proxyServer,
	startedAt,
	identityToken,
	idleTimeoutMs,
	lastActivityAt,
	idleExpiresAt,
	state,
}) {
	const proxyStatus =
		typeof proxyServer?.getStatus === "function" ? proxyServer.getStatus() : {};
	const lastAccountIndex = proxyStatus.lastAccountIndex ?? null;
	const lastAccountLabel =
		typeof proxyStatus.lastAccountLabel === "string" &&
		!proxyStatus.lastAccountLabel.includes("@")
			? proxyStatus.lastAccountLabel
			: typeof lastAccountIndex === "number"
				? `Account ${lastAccountIndex + 1}`
				: null;
	return {
		version: 1,
		kind: "codex-app-runtime-rotation-helper",
		state,
		pid: process.pid,
		scriptPath: process.argv[1] ?? null,
		identityToken: identityToken || null,
		startedAt,
		updatedAt: Date.now(),
		baseUrl: proxyServer?.baseUrl ?? null,
		idleTimeoutMs,
		// The reaper's real deadline, which is the detached window once the owner
		// is gone. Reporting the raw idle timeout there would tell `rotation
		// status` a helper has 12h left when it has minutes.
		idleExpiresAt:
			typeof idleExpiresAt === "number"
				? idleExpiresAt
				: lastActivityAt + idleTimeoutMs,
		totalRequests: proxyStatus.totalRequests ?? 0,
		upstreamRequests: proxyStatus.upstreamRequests ?? 0,
		retries: proxyStatus.retries ?? 0,
		rotations: proxyStatus.rotations ?? 0,
		lastAccountIndex,
		lastAccountLabel,
		lastAccountId: proxyStatus.lastAccountId ?? null,
		lastAccountUpdatedAt: proxyStatus.lastAccountUpdatedAt ?? null,
		lastError: proxyStatus.lastError ?? null,
	};
}

async function runRuntimeRotationAppHelper(identityToken = "") {
	let proxyServer = null;
	let runtimeContext = null;
	let appServerShimDir = null;
	let statusTimer = null;
	let closing = false;
	const startedAt = Date.now();
	const idleTimeoutMs = resolveRuntimeRotationAppHelperIdleMs();
	const maxLifetimeMs = resolveRuntimeRotationAppHelperMaxLifetimeMs();
	const detachedIdleMs = resolveRuntimeRotationAppHelperDetachedIdleMs();
	const ownerPid = resolveRuntimeRotationAppHelperOwnerPid();
	const isOwnerAlive = createRuntimeRotationAppHelperOwnerLivenessCheck(
		ownerPid,
		resolveRuntimeRotationAppHelperOwnerStartTimeMs(),
		resolveRuntimeRotationAppHelperOwnerRecheckMs(idleTimeoutMs, detachedIdleMs),
	);
	let lastActivityAt = startedAt;
	let lastRequestCount = 0;
	let lastPublishedToken = null;
	let lastPublishedAt = 0;
	// When the owner was first confirmed dead. Null while it is alive, and reset
	// to null if a later probe revives the verdict, so a transient "dead" cannot
	// ratchet the detached deadline the way the old liveness check ratcheted the
	// idle one.
	let ownerGoneSince = null;
	// A detached consumer holding a socket is evidence the handoff was real,
	// so it blocks the detached reap even with no requests in flight. The
	// absence of that evidence is not evidence of absence, and this fails
	// open on purpose: a proxy that cannot report connections reads as zero,
	// so the detached window still reaps it on activity alone. Erring the
	// other way — treating "unknown" as "someone is attached" — would restore
	// the leak for any shape that stopped answering.
	const countOpenConnections = () => {
		if (typeof proxyServer?.getOpenConnectionCount !== "function") return 0;
		const open = proxyServer.getOpenConnectionCount();
		// Only a positive count of sockets is evidence of a consumer. Anything
		// else — negative, fractional, NaN, Infinity — is "unknown", and unknown
		// degrades exactly the way a missing method does. Comparing a garbage
		// reading against 0 directly would block the reap forever and silently
		// restore the leak this exists to close, which is the one direction the
		// fix cannot afford to fail in.
		return Number.isSafeInteger(open) && open > 0 ? open : 0;
	};
	// The deadline the reaper will actually enforce, which is the earlier of the
	// idle timeout and — once the owner is gone — the detached window.
	const resolveIdleDeadline = () =>
		ownerGoneSince !== null && detachedIdleMs > 0
			? Math.min(
					lastActivityAt + idleTimeoutMs,
					Math.max(lastActivityAt, ownerGoneSince) + detachedIdleMs,
				)
			: lastActivityAt + idleTimeoutMs;
	// Freshness readers tolerate hours of staleness, but tests run the whole
	// lifecycle in milliseconds — heartbeat at least once per idle window.
	//
	// The detached window counts too. `publishToken` deliberately zeroes
	// `idleExpiresAt` so a deadline that moves every tick is not a reason to
	// rewrite the file, which means the published deadline only catches up on a
	// heartbeat. Once the owner dies the real deadline collapses from the idle
	// timeout to the detached window, so a heartbeat pinned to the idle window
	// alone would leave `rotation status` advertising a 12-hour deadline for a
	// helper that is seconds from exiting — worse under a short
	// CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS override, where the helper
	// can vanish before the file is ever corrected.
	const statusHeartbeatMs = Math.min(
		APP_RUNTIME_HELPER_STATUS_HEARTBEAT_MS,
		idleTimeoutMs,
		detachedIdleMs > 0 ? detachedIdleMs : Number.POSITIVE_INFINITY,
	);

	const publishStatus = (state, { force = false } = {}) => {
		const payload = createRuntimeRotationAppHelperStatus({
			proxyServer,
			startedAt,
			identityToken,
			idleTimeoutMs,
			lastActivityAt,
			idleExpiresAt: resolveIdleDeadline(),
			state,
		});
		// `updatedAt` moves every call and `idleExpiresAt` moves every tick the
		// owner is alive; neither is a reason to rewrite the file. Everything
		// else changing — state, traffic counters, account fields — is.
		const publishToken = JSON.stringify({
			...payload,
			updatedAt: 0,
			idleExpiresAt: 0,
		});
		const now = Date.now();
		if (
			!force &&
			publishToken === lastPublishedToken &&
			now - lastPublishedAt < statusHeartbeatMs
		) {
			return;
		}
		lastPublishedToken = publishToken;
		lastPublishedAt = now;
		writeRuntimeRotationAppHelperStatus(payload);
	};

	const cleanup = async (state = "stopped") => {
		if (closing) return;
		closing = true;
		if (statusTimer) {
			clearInterval(statusTimer);
		}
		try {
			if (appServerShimDir) {
				try {
					removeDirectoryWithRetry(appServerShimDir);
				} catch {
					// Best-effort shim cleanup only.
				}
				appServerShimDir = null;
			}
			runtimeContext?.cleanup?.();
		} finally {
			try {
				await proxyServer?.close?.();
			} finally {
				// The terminal stamp is always written; the next launcher's sweep
				// removes it once this PID is dead. The owner file has no
				// post-mortem value, so it goes now.
				publishStatus(state, { force: true });
				removeRuntimeRotationAppHelperOwnerFile(process.env, process.pid);
			}
		}
	};

	const exitAfterCleanup = (state, exitCode) => {
		void cleanup(state).finally(() => {
			process.exit(exitCode);
		});
	};

	process.once("SIGINT", () => exitAfterCleanup("stopped", 130));
	process.once("SIGTERM", () => exitAfterCleanup("stopped", 0));
	process.once("SIGHUP", () => exitAfterCleanup("stopped", 0));

	try {
		const proxyModule = await loadRuntimeRotationProxyModule();
		if (!proxyModule) {
			throw new Error("runtime rotation proxy module is unavailable");
		}
		const configTomlModule = await loadRuntimeConfigTomlModule();
		if (!configTomlModule) {
			throw new Error("runtime rotation config helpers are unavailable");
		}
		const clientApiKey = createRuntimeRotationProxyClientApiKey();
		proxyServer = await proxyModule.startRuntimeRotationProxy({ clientApiKey });
		const useCanonicalHome =
			(process.env[APP_RUNTIME_HELPER_USE_CANONICAL_HOME_ENV] ?? "").trim() ===
			"1";
		runtimeContext = useCanonicalHome
			? createRuntimeRotationProxyCanonicalCodexHome(
					process.env,
					proxyServer.baseUrl,
					clientApiKey,
					configTomlModule,
				)
			: createRuntimeRotationProxyCodexHome(
					process.env,
					proxyServer.baseUrl,
					clientApiKey,
					configTomlModule,
				);
		// The shim only exists so a Codex process that spawns its own
		// `codex app-server` through `CODEX_CLI_PATH` — the desktop app — gets that
		// spawn routed back through the wrapper. Installing it is not free and not
		// inert: it copies the node image into a per-pid directory and stamps
		// `CODEX_CLI_PATH`, `NODE_OPTIONS` and `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0`
		// onto the environment every forwarded child inherits. A wrapper-invoked
		// `app-server` is already launched with the rotation overrides on its own
		// command line, so it must not pay for or inherit any of that (#659).
		const installAppServerShim =
			(process.env[APP_RUNTIME_HELPER_INSTALL_APP_SERVER_SHIM_ENV] ?? "1").trim() !==
			"0";
		if (installAppServerShim) {
			const appServerConfigArgs = useCanonicalHome
				? [
						...(runtimeContext.args ?? []),
						"-c",
						`model_provider=${configTomlModule.tomlStringLiteral(RUNTIME_ROTATION_PROXY_PROVIDER_ID)}`,
					]
				: [];
			appServerShimDir = installRuntimeRotationAppServerCliShim(
				runtimeContext.env,
				appServerConfigArgs,
			);
		}
		lastRequestCount = proxyServer.getStatus?.().totalRequests ?? 0;
		publishStatus("running");
		process.stdout.write(
			`${JSON.stringify({
				type: "ready",
				pid: process.pid,
				baseUrl: proxyServer.baseUrl,
				statusPath: resolveRuntimeRotationAppHelperStatusPath(
					process.env,
					process.pid,
				),
				args: runtimeContext.args ?? [],
				env: pickRuntimeRotationAppHelperEnv(runtimeContext.env),
			})}\n`,
		);

		statusTimer = setInterval(() => {
			const currentTime = Date.now();
			const requestCount = proxyServer?.getStatus?.().totalRequests ?? 0;
			if (requestCount !== lastRequestCount) {
				lastRequestCount = requestCount;
				lastActivityAt = currentTime;
			}
			const ownerVerdict = isOwnerAlive(currentTime);
			if (ownerVerdict === OWNER_ALIVE) {
				lastActivityAt = currentTime;
				ownerGoneSince = null;
			} else if (ownerVerdict === OWNER_DEAD && ownerGoneSince === null) {
				ownerGoneSince = currentTime;
			}
			publishStatus("running");
			if (currentTime - lastActivityAt >= idleTimeoutMs) {
				exitAfterCleanup("idle-timeout", 0);
			} else if (
				ownerGoneSince !== null &&
				detachedIdleMs > 0 &&
				currentTime >= resolveIdleDeadline() &&
				requestCount === 0 &&
				countOpenConnections() === 0
			) {
				// The launcher is gone, nothing is connected, nothing has been
				// proxied for the detached window, and nothing has *ever* been
				// proxied: this helper was stranded by a launcher that exited, not
				// handed to a consumer that wants it.
				//
				// The never-served gate is what separates the two. An open socket
				// is not a durable signal — the proxy leaves `keepAliveTimeout` at
				// Node's 5s default, so a `codex app` session that is merely idle
				// between turns has zero sockets within seconds, and the socket
				// check alone would reap the live proxy out from under the desktop
				// app after the detached window. A helper that has served even one
				// request was genuinely handed off; from then on the idle timeout
				// and the lifetime ceiling bound it, exactly as they did before the
				// detached reap existed.
				exitAfterCleanup("owner-gone", 0);
			} else if (
				maxLifetimeMs > 0 &&
				currentTime - startedAt >= maxLifetimeMs
			) {
				// The ceiling is deliberately unconditional on activity: it exists
				// for exactly the case where activity accounting is wrong.
				exitAfterCleanup("max-lifetime", 0);
			}
			// Tick against the shortest window that can fire, so a short detached
			// window is enforced at its own resolution rather than the idle
			// timeout's. Both defaults are far above 2s, so production still ticks
			// once a second.
		}, resolveRuntimeRotationAppHelperTickMs(idleTimeoutMs, detachedIdleMs));
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			})}\n`,
		);
		await cleanup("error");
		return 1;
	}

	await new Promise(() => undefined);
	return 0;
}

function waitForRuntimeRotationAppHelperExit(helper, timeoutMs = 2_000) {
	return new Promise((resolve) => {
		let settled = false;
		let timer = null;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			// Drop the listener when the timeout wins, so a helper that outlives the
			// graceful window does not keep a live reference back into this process.
			helper.off?.("close", finish);
			resolve();
		};
		timer = setTimeout(finish, timeoutMs);
		helper.once("close", finish);
	});
}

function hasRuntimeRotationAppHelperExited(helper) {
	return helper.exitCode !== null || helper.signalCode !== null;
}

// Releases every handle the helper still holds in this process. The helper is
// spawned with piped stdio, so those pipes keep the parent event loop alive on
// their own — destroying and unref-ing them is what actually lets `mcodex` return
// to the shell when the child ignores or outlives SIGTERM (#647).
function releaseRuntimeRotationAppHelperResources(helper) {
	helper.stdout?.destroy();
	helper.stderr?.destroy();
	try {
		helper.unref();
	} catch {
		// Best-effort only.
	}
}

async function stopRuntimeRotationAppHelper(helper) {
	if (!helper) {
		return;
	}
	if (hasRuntimeRotationAppHelperExited(helper)) {
		releaseRuntimeRotationAppHelperResources(helper);
		return;
	}
	if (!helper.killed) {
		try {
			helper.kill("SIGTERM");
		} catch {
			releaseRuntimeRotationAppHelperResources(helper);
			return;
		}
	}
	await waitForRuntimeRotationAppHelperExit(helper);
	if (!hasRuntimeRotationAppHelperExited(helper)) {
		try {
			helper.kill("SIGKILL");
		} catch {
			// Best-effort force-stop once the graceful shutdown window has elapsed.
		}
	}
	releaseRuntimeRotationAppHelperResources(helper);
}

function startRuntimeRotationAppHelper(baseContext, options = {}) {
	const realCodexHome =
		baseContext.originalCodexHome ??
		resolveRuntimeRotationProxyOriginalCodexHome(baseContext.env);
	return new Promise((resolve, reject) => {
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let settled = false;
		const identityToken = randomBytes(24).toString("hex");
		// The launcher states its own identity — PID plus kernel start time — so
		// the helper's owner-liveness check can tell "my launcher" from a later
		// process that recycled the PID. An empty value (no `ps` on this
		// platform) leaves the helper on the bare liveness check.
		const launcherStartTimeMs = readProcessStartTimeMs(process.pid);
		const helperEnv = {
			...baseContext.env,
			CODEX_MULTI_AUTH_DIR: resolveRuntimeRotationOriginalMultiAuthDir(
				realCodexHome,
				baseContext.env,
			),
			// PID and start time are two halves of one identity and must describe
			// the same process: both always come from this launcher's own capture,
			// never from an inherited environment value, which would marry this
			// PID to another process's start time and make the helper declare its
			// live owner dead at the first recheck.
			[APP_RUNTIME_HELPER_OWNER_PID_ENV]: String(process.pid),
			[APP_RUNTIME_HELPER_OWNER_START_TIME_ENV]:
				launcherStartTimeMs !== null ? String(launcherStartTimeMs) : "",
			[APP_RUNTIME_HELPER_REAL_CODEX_HOME_ENV]: realCodexHome,
			[APP_RUNTIME_HELPER_USE_CANONICAL_HOME_ENV]:
				options.useCanonicalHome === true ? "1" : "0",
			[APP_RUNTIME_HELPER_INSTALL_APP_SERVER_SHIM_ENV]:
				options.installAppServerShim === false ? "0" : "1",
		};
		const helper = spawn(
			process.execPath,
			[
				fileURLToPath(import.meta.url),
				INTERNAL_RUNTIME_ROTATION_APP_HELPER_ARG,
				identityToken,
			],
			{
				env: helperEnv,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			},
		);
		writeRuntimeRotationAppHelperOwner(identityToken, helper.pid, helperEnv);
		// Swept after the spawn, never before it. The sweep is synchronous and
		// unbounded — a readdir, a readFileSync and an rmSync per candidate, plus
		// bounded `ps` probes — and the state it exists to clean up (hundreds of
		// stale files, a loaded process table) is exactly the state that makes it
		// slow. Running it first put all of that latency in front of `codex app`
		// and TUI startup; running it here lets the helper boot in parallel with
		// it. Nothing about spawning depends on the sweep having finished.
		sweepStaleRuntimeRotationAppHelperMetadata(helperEnv);
		let timeout = null;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolve(result);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			void stopRuntimeRotationAppHelper(helper).finally(() => reject(error));
		};
		timeout = setTimeout(() => {
			fail(new Error("timed out waiting for runtime rotation app helper"));
		}, APP_RUNTIME_HELPER_LAUNCH_TIMEOUT_MS);
		helper.stdout?.setEncoding("utf8");
		helper.stdout?.on("data", (chunk) => {
			// Keep consuming after startup settles so the helper never blocks on a
			// full pipe, but stop accumulating: `app-server` holds this parent open
			// for the resident server's whole life, so a buffer that only ever grows
			// is a leak, and re-parsing the retained ready line on every later chunk
			// is pure waste.
			if (settled) return;
			stdoutBuffer += chunk;
			const newlineIndex = stdoutBuffer.indexOf("\n");
			if (newlineIndex < 0) return;
			const line = stdoutBuffer.slice(0, newlineIndex).trim();
			try {
				const message = JSON.parse(line);
				if (message?.type === "ready" && message.env && message.pid) {
					finish({ helper, message });
					return;
				}
				fail(
					new Error(
						message?.message ??
							"runtime rotation app helper returned an invalid startup response",
					),
				);
			} catch (error) {
				fail(error);
			}
		});
		helper.stderr?.setEncoding("utf8");
		helper.stderr?.on("data", (chunk) => {
			if (settled) return;
			stderrBuffer += chunk;
		});
		helper.once("error", fail);
		helper.once("close", (code) => {
			if (settled) return;
			fail(
				new Error(
					`runtime rotation app helper exited before startup (code ${code ?? "unknown"}): ${stderrBuffer.trim()}`,
				),
			);
		});
	});
}

async function createRuntimeRotationAppHelperContext(
	baseContext,
	configTomlModule,
	options = {},
) {
	const { helper, message } = await startRuntimeRotationAppHelper(
		baseContext,
		options,
	);
	// Start the grace clock once the helper is ready, not before it is launched.
	// Launching is bounded by APP_RUNTIME_HELPER_LAUNCH_TIMEOUT_MS (15s), so a
	// cold or loaded machine could otherwise burn the whole 5s window before the
	// forwarded command had run at all, and `codex app` — which relies on the
	// window rather than an explicit `detachOnExit` — would kill the helper it
	// had just handed the desktop app off to.
	const startedAt = Date.now();
	const helperEnv = message.env ?? {};
	const helperShimDir =
		typeof helperEnv.CODEX_CLI_PATH === "string" &&
		helperEnv.CODEX_CLI_PATH.length > 0
			? helperEnv.CODEX_CLI_PATH
			: null;
	const helperArgs = Array.isArray(message.args)
		? message.args.filter((arg) => typeof arg === "string")
		: [];
	const detachGraceMs = resolveRuntimeRotationAppHelperDetachGraceMs(baseContext.env);

	// An explicit `detachOnExit: false` is a decision, not a default: a resident
	// server owns its proxy for its whole lifetime, and leaving the helper behind
	// on a short-lived run — a client attaches, runs one query, disconnects —
	// strands it for the full idle timeout with nobody left to refresh its
	// activity clock. Only an unset `detachOnExit` falls back to the grace window.
	const cleanup = async ({ exitCode } = {}) => {
		const livedMs = Date.now() - startedAt;
		const detachWithinGrace =
			options.detachOnExit !== false && livedMs < detachGraceMs;
		if (exitCode === 0 && (options.detachOnExit === true || detachWithinGrace)) {
			helper.stdout?.destroy();
			helper.stderr?.destroy();
			helper.unref();
			return;
		}
		try {
			await stopRuntimeRotationAppHelper(helper);
		} finally {
			// The helper normally removes its app-server shim before exiting. On
			// Windows, a descendant may still hold the copied codex.exe briefly
			// after the helper closes, so retry the parent-owned cleanup once the
			// helper shutdown path has completed as well.
			if (helperShimDir) {
				try {
					removeDirectoryWithRetry(helperShimDir);
				} catch {
					// Best-effort cleanup; stale helper directories are swept on the
					// next runtime app launch.
				}
			}
		}
	};

	const injectedArgs = [
		...helperArgs,
		"-c",
		`model_provider=${configTomlModule.tomlStringLiteral(RUNTIME_ROTATION_PROXY_PROVIDER_ID)}`,
	];
	return {
		// Root TUI argv can end in the optional `[PROMPT]` positional, and `--`
		// binds everything after it to that positional — overrides appended
		// there would become prompt text, so the interactive branch asks for
		// them to be injected ahead of the prompt instead.
		args:
			options.injectArgsBeforeRootPrompt === true
				? insertArgsBeforeRootPrompt(baseContext.args, injectedArgs)
				: insertArgsBeforeForwardedSeparator(baseContext.args, injectedArgs),
		env: {
			...baseContext.env,
			...helperEnv,
		},
		// Without the app-server shim there is no `CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL`
		// in the forwarded environment, so the caller has to ask for the
		// `account/read` / `getAuthStatus` / `account/rateLimits/read` rewriting
		// explicitly. Only the shadow branch used to set it.
		proxyAppServerAccountRead: options.proxyAppServerAccountRead === true,
		cleanup: async (details) => {
			try {
				await cleanup(details);
			} finally {
				baseContext.cleanup?.();
			}
		},
	};
}

async function createRuntimeRotationProxyContextIfEnabled(
	baseContext,
	rawArgs,
) {
	const enabled = await isRuntimeRotationProxyEnabled(rawArgs, baseContext.env);
	if (!enabled) {
		return baseContext;
	}

	const configTomlModule = await loadRuntimeConfigTomlModule();
	if (!configTomlModule) {
		console.error(
			"codex-multi-auth runtime rotation config helpers are unavailable; continuing without runtime rotation.",
		);
		return baseContext;
	}

	// A helper that cannot start is a hard failure for these branches — unlike the
	// shadow path below, there is no rotation-off shape left to degrade into. Turn
	// it into a diagnostic and a nonzero exit rather than an unhandled rejection,
	// and release the compatibility shadow home the caller already built.
	const startAppHelperContext = async (options) => {
		try {
			return await createRuntimeRotationAppHelperContext(
				baseContext,
				configTomlModule,
				options,
			);
		} catch (error) {
			try {
				baseContext.cleanup?.();
			} catch {
				// Best-effort cleanup only; report the original failure.
			}
			return {
				startupError: `codex-multi-auth runtime rotation helper failed to start: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	};

	// `app-server` is a resident process, and the shadow home cannot host one: the
	// mirror links directories, so Codex's lstat-strict check on
	// `<CODEX_HOME>/app-server-control` refuses to start, and a server that does
	// start serves every attached client a frozen snapshot of the thread index for
	// its whole life. Same reasoning that moved `resume`/`fork` in #648 (#659).
	if (isCodexAppServerCommand(rawArgs)) {
		return startAppHelperContext({
			// A resident server owns its proxy for its whole lifetime.
			detachOnExit: false,
			useCanonicalHome: true,
			// Nothing here spawns `codex app-server` through `CODEX_CLI_PATH`; the
			// server is launched with the rotation overrides already on its command
			// line. See the shim gate in `runRuntimeRotationAppHelper`.
			installAppServerShim: false,
			proxyAppServerAccountRead: true,
		});
	}
	if (isCodexAppCommand(rawArgs)) {
		return startAppHelperContext();
	}
	// Classify once: each predicate re-walks the whole argv, and the root-TUI
	// answer is needed twice below.
	const isRootTuiLaunch = isCodexInteractiveTuiCommand(rawArgs);
	if (isRootTuiLaunch || isCodexInteractiveResumeCommand(rawArgs)) {
		return startAppHelperContext({
			detachOnExit: true,
			useCanonicalHome: true,
			// Root TUI launches may carry the optional `[PROMPT]` positional
			// (possibly forced by `--`); the provider overrides must stay on the
			// option side of it. `resume`/`fork` keep the appended ordering their
			// argv has always forwarded with — their tokens are subcommand args,
			// not the root prompt.
			injectArgsBeforeRootPrompt: isRootTuiLaunch,
		});
	}

	const proxyModule = await loadRuntimeRotationProxyModule();
	if (!proxyModule) {
		console.error(
			"codex-multi-auth runtime rotation proxy is unavailable; continuing without runtime rotation.",
		);
		return baseContext;
	}

	let proxyServer;
	let shadowContext;
	try {
		const clientApiKey = createRuntimeRotationProxyClientApiKey();
		proxyServer = await proxyModule.startRuntimeRotationProxy({ clientApiKey });
		shadowContext = createRuntimeRotationProxyCodexHome(
			baseContext.env,
			proxyServer.baseUrl,
			clientApiKey,
			configTomlModule,
		);
	} catch (error) {
		try {
			await proxyServer?.close?.();
		} catch {
			// Best-effort cleanup only.
		}
		console.error(
			`codex-multi-auth runtime rotation proxy failed to start; continuing without runtime rotation: ${error instanceof Error ? error.message : String(error)}`,
		);
		return baseContext;
	}

	const cleanup = async () => {
		try {
			shadowContext.cleanup?.();
		} finally {
			try {
				await proxyServer.close();
			} finally {
				baseContext.cleanup?.();
			}
		}
	};

	return {
		args: [
			...baseContext.args,
			"-c",
			`model_provider=${configTomlModule.tomlStringLiteral(RUNTIME_ROTATION_PROXY_PROVIDER_ID)}`,
		],
		env: shadowContext.env,
		cleanup,
		proxyAppServerAccountRead: isCodexAppServerCommand(rawArgs),
	};
}

async function loadRuntimeObservabilityModule() {
	try {
		const mod = await import("../dist/lib/runtime/runtime-observability.js");
		if (
			typeof mod.loadPersistedRuntimeObservabilitySnapshot !== "function" ||
			typeof mod.mutateRuntimeObservabilitySnapshot !== "function"
		) {
			return null;
		}
		return mod;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ERR_MODULE_NOT_FOUND"
		) {
			return null;
		}
		throw error;
	}
}

function isPureHelpOrVersionArgs(rawArgs) {
	if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
		return false;
	}
	return rawArgs.every((arg) =>
		typeof arg === "string" && ["--help", "-h", "--version", "-V"].includes(arg),
	);
}

// Hoisted: every argv walk calls consumesNextArg once per token, and a Set
// rebuilt per call allocated this list on every one of them.
const OPTIONS_CONSUMING_NEXT_ARG = new Set([
	"-c",
	"--config",
	"--enable",
	"--disable",
	"--listen",
	"--remote",
	"--remote-auth-token-env",
	"--ws-auth",
	"--ws-token-file",
	"--ws-token-sha256",
	"--ws-shared-secret-file",
	"--ws-issuer",
	"--ws-audience",
	"--ws-max-clock-skew-seconds",
	"--download-url",
	"-i",
	"--image",
	"-m",
	"--model",
	"--local-provider",
	"-p",
	"--profile",
	"-s",
	"--sandbox",
	"-a",
	"--ask-for-approval",
	"-C",
	"--cd",
	"--add-dir",
	"--output-schema",
	"--color",
	"-o",
	"--output-last-message",
]);

function consumesNextArg(arg) {
	return OPTIONS_CONSUMING_NEXT_ARG.has(arg);
}

// Codex's root grammar is `codex [OPTIONS] [PROMPT]` / `codex [OPTIONS]
// <COMMAND> [ARGS]`, so the first positional is only a command when it names a
// real root subcommand — otherwise it is the optional initial prompt of an
// interactive TUI launch. The allowlist mirrors `codex --help`; treating an
// unknown positional as a prompt matches native Codex, where an unrecognized
// token also falls through to the prompt positional rather than erroring as a
// bad subcommand. Routing predicates all resolve through this map so aliases
// classify like their canonical command.
//
// A real root subcommand missing from this set is misrouted, not merely
// misnamed: it classifies as an interactive prompt and takes the app-helper
// branch with `detachOnExit: true`, so a short-lived command leaves a detached
// helper and its loopback proxy idling until the rotation idle timeout. Keep
// the set in sync with the upstream grammar — clap publishes the authoritative
// root list in its own completions, so
//   codex completion bash | grep -oE 'opts="[^"]*"' | grep ' exec '
// prints every root command (and alias) for the installed codex-cli.

const CODEX_ROOT_COMMAND_ALIASES = new Map([
	["e", "exec"],
	["a", "apply"],
]);
const CODEX_ROOT_COMMANDS = new Set([
	"exec",
	"review",
	"login",
	"logout",
	"mcp",
	"plugin",
	"mcp-server",
	"app-server",
	"remote-control",
	"app",
	"completion",
	"update",
	"doctor",
	"sandbox",
	"debug",
	"apply",
	"resume",
	"archive",
	"delete",
	"migrate-rollouts",
	"unarchive",
	"fork",
	"cloud",
	"exec-server",
	"features",
	"help",
	"auth",
	// Hidden root subcommands: absent from `codex --help`, but real — each is
	// documented by `codex help <name>`.
	"responses-api-proxy",
	"cloud-tasks",
	"execpolicy",
	// Internal stdio/UDS relay. Hidden like the three above, and short-lived:
	// omitting it classified `codex stdio-to-uds <socket>` as a root prompt,
	// which took the detached app-helper branch and leaked a helper per call.
	"stdio-to-uds",
]);

function resolveCodexRootCommand(token) {
	const command = CODEX_ROOT_COMMAND_ALIASES.get(token) ?? token;
	return CODEX_ROOT_COMMANDS.has(command) ? command : null;
}

// `-i/--image` is greedy (`<FILE>...`): native Codex consumes every following
// free token up to the next option-like token, so a prompt can only follow the
// image list after another option or a `--`. Every argv walker below skips the
// same span, or the wrapper would disagree with native Codex about where the
// positional side starts.
function consumesRemainingFreeArgs(arg) {
	return arg === "-i" || arg === "--image";
}

function skipOptionValueSpan(args, i) {
	const arg = args[i];
	if (consumesRemainingFreeArgs(arg)) {
		let end = i;
		while (
			end + 1 < args.length &&
			typeof args[end + 1] === "string" &&
			args[end + 1].length > 0 &&
			(args[end + 1] === "-" || !args[end + 1].startsWith("-"))
		) {
			end += 1;
		}
		return end;
	}
	return consumesNextArg(arg) ? i + 1 : i;
}

/**
 * The single definition of where an argv's option side ends. Walking from
 * `startIndex`, skips option flags and the values they consume — including a
 * greedy `-i a.png b.png` span — and reports what stopped the walk:
 *
 * - `index`: the first free (positional) token, or null when there is none.
 * - `terminatorIndex`: the bare `--` that ended option parsing, or null.
 * - `boundary`: where option-side content ends, i.e. the positional, the
 *   `--`, or `args.length`. This is where injected overrides belong.
 *
 * Callers keep their own policy for `--` (the root grammar binds everything
 * after it to `[PROMPT]`; a subcommand's does not), but they must not keep
 * their own copy of the walk: a classifier and an injector that disagree by
 * one token put a `-c` override into prompt text or read prompt text as a
 * subcommand.
 */
function findRootPositional(args, startIndex = 0) {
	if (!Array.isArray(args)) {
		return { index: null, terminatorIndex: null, boundary: 0 };
	}
	for (let i = startIndex; i < args.length; i += 1) {
		const arg = args[i];
		if (typeof arg !== "string" || arg.length === 0) continue;
		if (arg === "--") {
			return { index: null, terminatorIndex: i, boundary: i };
		}
		if (arg.startsWith("--config=")) {
			continue;
		}
		if (arg.startsWith("--") || (arg.startsWith("-") && arg !== "-")) {
			i = skipOptionValueSpan(args, i);
			continue;
		}
		return { index: i, terminatorIndex: null, boundary: i };
	}
	return { index: null, terminatorIndex: null, boundary: args.length };
}

function findForwardedCommand(rawArgs) {
	if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
		return null;
	}
	// `--` ends option parsing: everything after it binds to the root
	// `[PROMPT]` positional, never to a subcommand, even when the text happens
	// to spell a command name. `findRootPositional` reports it as a terminator
	// and yields no positional, which settles the launch as interactive.
	//
	// Native Codex fills the root `[PROMPT]` slot with the first free token and
	// still tries a later one as a subcommand (`codex hello exec …` runs exec),
	// so an unknown positional keeps the scan going.
	for (
		let cursor = findRootPositional(rawArgs, 0);
		cursor.index !== null;
		cursor = findRootPositional(rawArgs, cursor.index + 1)
	) {
		const command = resolveCodexRootCommand(rawArgs[cursor.index]);
		if (command !== null) {
			return { command, index: cursor.index };
		}
	}

	return null;
}

// Inserts option-side args ahead of the root `[PROMPT]` positional (or the
// `--` that forces one), so injected overrides cannot be read as prompt text.
// With no positional at all this is a plain append, which keeps bare-TUI argv
// byte-identical to the pre-insertion shape.
function insertArgsBeforeRootPrompt(baseArgs, injectedArgs) {
	const { boundary } = findRootPositional(baseArgs);
	return [
		...baseArgs.slice(0, boundary),
		...injectedArgs,
		...baseArgs.slice(boundary),
	];
}

// Inserts args before a `--` separator when one is present, else appends.
// Subcommand argv keeps its leading subcommand token — `resume`/`fork` argv is
// pinned to it — but anything appended past a `--` lands in the subcommand's
// own positional list: Codex rejects that outright for `exec`/`review`
// ("unexpected argument '-c' found"), and worse, silently forwards it as
// arguments for `sandbox` and into the stored config for `mcp add`. The
// separator bounds the append.
function insertArgsBeforeForwardedSeparator(baseArgs, injectedArgs) {
	// Deliberately not `findRootPositional`: that reports where the option side
	// ends, stopping at the first positional, and a subcommand's own arguments
	// are positionals — it would answer `exec` for `exec -- hi`. The question
	// here is only where the separator sits, and a bare `indexOf` answers it
	// exactly: clap never consumes `--` as an option value (`codex --cd -- hi`
	// is "a value is required for '--cd'"), so the first `--` is always the
	// separator, and it always follows the subcommand token because
	// `findForwardedCommand` returns null the moment it sees one.
	const separatorIndex = baseArgs.indexOf("--");
	if (separatorIndex === -1) {
		return [...baseArgs, ...injectedArgs];
	}
	return [
		...baseArgs.slice(0, separatorIndex),
		...injectedArgs,
		...baseArgs.slice(separatorIndex),
	];
}

function findForwardedSubcommand(rawArgs, commandIndex) {
	const { index, terminatorIndex } = findRootPositional(
		rawArgs,
		commandIndex + 1,
	);
	// Unlike the root grammar, a subcommand's `--` still precedes its own
	// positional args, so the token after it is the nested subcommand.
	if (terminatorIndex !== null) {
		return terminatorIndex + 1 < rawArgs.length
			? rawArgs[terminatorIndex + 1]
			: null;
	}
	return index === null ? null : rawArgs[index];
}

function hasHelpFlagAfterCommand(rawArgs, commandIndex) {
	for (let i = commandIndex + 1; i < rawArgs.length; i += 1) {
		const arg = rawArgs[i];
		if (arg === "--") return false;
		if (arg === "--help" || arg === "-h" || arg === "help") return true;
		if (typeof arg === "string") {
			i = skipOptionValueSpan(rawArgs, i);
		}
	}
	return false;
}

function isCodexAppCommand(rawArgs) {
	return findForwardedCommand(rawArgs)?.command === "app";
}

function isCodexAppServerCommand(rawArgs) {
	return findForwardedCommand(rawArgs)?.command === "app-server";
}

// True for every root TUI launch: bare `codex [OPTIONS]`, and `codex
// [OPTIONS] [PROMPT]` with the optional initial prompt — including a prompt
// forced by `--`. Both shapes start the same interactive session and need the
// canonical home, or Codex stalls rebuilding the omitted thread index inside
// the shadow mirror before it can submit the already-delivered prompt.
function isCodexInteractiveTuiCommand(rawArgs) {
	return findForwardedCommand(rawArgs) === null;
}

// `resume` and `fork` are interactive TUI entry points that happen to carry a
// forwarded subcommand, so the bare-invocation predicate above misses them. They
// must not take the shadow-home transport: the shadow mirror deliberately omits the
// runtime SQLite state (`isRuntimeRotationShadowHomeOmittedEntry`), so the requested
// thread is absent from the shadow session index and the resumed TUI hangs on a
// blank screen (#647).
function isCodexInteractiveResumeCommand(rawArgs) {
	const command = findForwardedCommand(rawArgs)?.command;
	return command === "resume" || command === "fork";
}

function shouldUseRuntimeRoutingForForwardedArgs(rawArgs) {
	if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
		return true;
	}
	if (isPureHelpOrVersionArgs(rawArgs)) {
		return false;
	}

	const command = findForwardedCommand(rawArgs);
	if (!command) {
		// A help flag alongside a root prompt (`codex "prompt" --help`) prints
		// help and exits clean, so it must skip the transport for the same
		// reason as the request-command help forms below: the interactive
		// branch detaches its helper on a clean exit, and a helper started
		// just to print help would idle until its detached timeout. The scan
		// stops at `--`, so help-looking text inside a forced prompt still
		// routes normally.
		return !hasHelpFlagAfterCommand(rawArgs, -1);
	}

	const requestCommands = new Set(["exec", "review", "resume", "fork", "app"]);
	const nonRequestCommands = new Set([
		"help",
		"completion",
		"login",
		"logout",
		"mcp",
		"mcp-server",
		"sandbox",
		"debug",
		"apply",
		"cloud",
		"features",
		"auth",
	]);

	if (command.command === "app-server") {
		if (hasHelpFlagAfterCommand(rawArgs, command.index)) {
			return false;
		}
		const subcommand = findForwardedSubcommand(rawArgs, command.index);
		return !new Set(["help", "generate-ts", "generate-json-schema"]).has(
			subcommand ?? "",
		);
	}

	// Request commands still print their help without making a single model
	// request, so the help form skips the transport entirely: no proxy, no shadow
	// home, no detached helper. This matters most for the interactive commands,
	// which detach their helper on a clean exit — help always exits clean, so
	// `resume --help` would otherwise strand a helper until its idle timeout. It is
	// keyed off the help flag rather than the command, so a real run still routes
	// through rotation, and it matches how `app-server` help is handled above (#647).
	if (
		requestCommands.has(command.command) &&
		hasHelpFlagAfterCommand(rawArgs, command.index)
	) {
		return false;
	}
	if (requestCommands.has(command.command)) {
		return true;
	}
	if (nonRequestCommands.has(command.command)) {
		return false;
	}
	return true;
}

function shouldTrackForwardedRuntimeObservability(rawArgs) {
	return shouldUseRuntimeRoutingForForwardedArgs(rawArgs);
}

function shouldCaptureForwardedOutputForArgs(rawArgs, env) {
	if (isCodexAppServerCommand(rawArgs)) {
		return false;
	}
	return shouldCaptureForwardedCodexOutput(env);
}

function createRuntimeSnapshotChangeToken(snapshot) {
	return JSON.stringify({
		responsesRequests: snapshot?.responsesRequests ?? null,
		authRefreshRequests: snapshot?.authRefreshRequests ?? null,
		diagnosticProbeRequests: snapshot?.diagnosticProbeRequests ?? null,
		totalRequests: snapshot?.runtimeMetrics?.totalRequests ?? null,
		successfulRequests: snapshot?.runtimeMetrics?.successfulRequests ?? null,
		failedRequests: snapshot?.runtimeMetrics?.failedRequests ?? null,
		lastRequestAt: snapshot?.runtimeMetrics?.lastRequestAt ?? null,
	});
}

async function loadRuntimeSnapshotWithRetry(runtimeObservabilityModule) {
	let snapshot = null;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		snapshot =
			(await runtimeObservabilityModule.loadPersistedRuntimeObservabilitySnapshot()) ??
			null;
		if (snapshot) {
			return snapshot;
		}
		if (attempt < 4) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	return snapshot;
}

async function withForwardedRuntimeObservability(rawArgs, runForwardedCommand) {
	if (!shouldTrackForwardedRuntimeObservability(rawArgs)) {
		return runForwardedCommand();
	}

	const runtimeObservabilityModule = await loadRuntimeObservabilityModule();
	if (!runtimeObservabilityModule) {
		return runForwardedCommand();
	}

	const beforeSnapshot = await loadRuntimeSnapshotWithRetry(runtimeObservabilityModule);
	const beforeToken = createRuntimeSnapshotChangeToken(beforeSnapshot);
	const startedAt = Date.now();
	const exitCode = await runForwardedCommand();
	const afterSnapshot = await loadRuntimeSnapshotWithRetry(runtimeObservabilityModule);
	const afterToken = createRuntimeSnapshotChangeToken(afterSnapshot);
	if (afterToken !== beforeToken) {
		return exitCode;
	}

	runtimeObservabilityModule.mutateRuntimeObservabilitySnapshot((snapshot) => {
		snapshot.currentRequestId = null;
		snapshot.responsesRequests += 1;
		snapshot.runtimeMetrics.totalRequests += 1;
		snapshot.runtimeMetrics.responsesRequests += 1;
		snapshot.runtimeMetrics.cumulativeLatencyMs += Math.max(0, Date.now() - startedAt);
		snapshot.runtimeMetrics.lastRequestAt = Date.now();
		if (!snapshot.runtimeMetrics.startedAt) {
			snapshot.runtimeMetrics.startedAt = startedAt;
		}
		if (exitCode === 0) {
			snapshot.runtimeMetrics.successfulRequests += 1;
			snapshot.runtimeMetrics.lastError = null;
		} else {
			snapshot.runtimeMetrics.failedRequests += 1;
			snapshot.runtimeMetrics.lastError = `forwarded-codex-exit:${exitCode}`;
		}
	});
	return exitCode;
}

function createCompatibilityCodexHome(
	processedArgs,
	requestedModel,
	baseEnv = process.env,
) {
	const originalCodexHome = resolveCodexHomeDir(baseEnv);
	if (!requestedModel) {
		return {
			args: processedArgs,
			env: baseEnv,
			cleanup: undefined,
			originalCodexHome,
		};
	}

	const configPath = join(originalCodexHome, "config.toml");
	if (!existsSync(configPath)) {
		return {
			args: processedArgs,
			env: baseEnv,
			cleanup: undefined,
			originalCodexHome,
		};
	}

	const rawConfig = readFileSync(configPath, "utf8");
	const compatConfig = rewriteConfigTomlReasoningEffort(
		rawConfig,
		requestedModel,
	);
	if (compatConfig === rawConfig) {
		return {
			args: processedArgs,
			env: baseEnv,
			cleanup: undefined,
			originalCodexHome,
		};
	}

	const shadowCodexHome = mkdtempSync(join(tmpdir(), "codex-multi-auth-home-"));
	let syncShadowHomeStateBack = () => {};
	const cleanup = () => {
		try {
			removeDirectoryWithRetry(shadowCodexHome);
		} catch {
			// Best-effort cleanup only.
		}
	};
	const tightenShadowHomePermissions = (path) => {
		try {
			chmodSync(path, 0o600);
		} catch {
			// Best-effort only; permission semantics vary by platform.
		}
	};
	try {
		syncShadowHomeStateBack = createShadowHomeMirror(
			originalCodexHome,
			shadowCodexHome,
			tightenShadowHomePermissions,
		);
		const compatConfigPath = join(shadowCodexHome, "config.toml");
		writeFileSync(compatConfigPath, compatConfig, "utf8");
		tightenShadowHomePermissions(compatConfigPath);
	} catch (error) {
		cleanup();
		throw error;
	}
	const cleanupWithSync = () => {
		syncShadowHomeStateBack();
		cleanup();
	};

	const forwardedEnv = {
		...baseEnv,
		CODEX_HOME: shadowCodexHome,
	};
	const originalMultiAuthDir = resolveOriginalMultiAuthDir(baseEnv);
	if (originalMultiAuthDir) {
		forwardedEnv.CODEX_MULTI_AUTH_DIR = originalMultiAuthDir;
	}

	return {
		args: processedArgs,
		env: forwardedEnv,
		cleanup: cleanupWithSync,
		originalCodexHome,
	};
}

function buildForwardArgs(rawArgs) {
	const { args: compatibilityArgs, requestedModel } = rewriteReasoningConfigArgs(rawArgs);
	const forceFileAuthStore = (process.env.CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE ?? "1").trim() !== "0";
	if (!forceFileAuthStore) {
		return { args: compatibilityArgs, requestedModel };
	}
	if (hasCliAuthCredentialsStoreOverride(compatibilityArgs)) {
		return { args: compatibilityArgs, requestedModel };
	}

	const authStoreArgs = ["-c", 'cli_auth_credentials_store="file"'];
	return {
		// A root launch may end in the `[PROMPT]` positional — possibly forced
		// by `--`, where an appended `-c` pair would be read as prompt text —
		// so the override is inserted on the option side of the prompt there.
		// Subcommand argv keeps the appended ordering it has always forwarded.
		args:
			findForwardedCommand(compatibilityArgs) === null
				? insertArgsBeforeRootPrompt(compatibilityArgs, authStoreArgs)
				: insertArgsBeforeForwardedSeparator(compatibilityArgs, authStoreArgs),
		requestedModel,
	};
}

function normalizeExitCode(value) {
	if (typeof value === "number" && Number.isInteger(value)) {
		return value;
	}
	const parsed = Number(value);
	if (Number.isInteger(parsed)) {
		return parsed;
	}
	return 1;
}

function extractRolloutIdFromFilename(fileName) {
	const match = fileName.match(
		/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
	);
	return match?.[1] ?? null;
}

function collectRolloutFiles(rootDir, results = []) {
	let entries = [];
	try {
		entries = readdirSync(rootDir, { withFileTypes: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		const entryPath = join(rootDir, entry.name);
		if (entry.isDirectory()) {
			collectRolloutFiles(entryPath, results);
			continue;
		}
		if (entry.isFile() && extractRolloutIdFromFilename(entry.name)) {
			results.push(entryPath);
		}
	}
	return results;
}

function parseRolloutIndexEntry(rolloutPath) {
	const fileName = basename(rolloutPath);
	const idFromName = extractRolloutIdFromFilename(fileName);
	if (!idFromName) return null;
	let content = "";
	try {
		content = readFileSync(rolloutPath, "utf8");
	} catch {
		return null;
	}
	const lines = content.split(/\r?\n/).filter(Boolean);
	let id = idFromName;
	let threadName = "";
	let updatedAt = null;
	let hasSessionMeta = false;
	for (const line of lines) {
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof record?.timestamp === "string") {
			updatedAt = record.timestamp;
		}
		if (record?.type === "session_meta" && typeof record.payload?.id === "string") {
			id = record.payload.id;
			hasSessionMeta = true;
		}
		if (!threadName && record?.type === "event_msg") {
			const message = record.payload?.message;
			if (typeof message === "string" && message.trim().length > 0) {
				threadName = message.trim();
			}
		}
	}
	if (!updatedAt) {
		try {
			updatedAt = statSync(rolloutPath).mtime.toISOString();
		} catch {
			updatedAt = new Date().toISOString();
		}
	}
	if (!threadName) {
		threadName = "Codex session";
	}
	if (!hasSessionMeta) {
		return null;
	}
	if (threadName.length > 80) {
		threadName = `${threadName.slice(0, 77)}...`;
	}
	return { id, thread_name: threadName, updated_at: updatedAt };
}

function writeSessionIndexAtomicSync(indexPath, lines) {
	const indexDir = dirname(indexPath);
	mkdirSync(indexDir, { recursive: true });
	for (let attempt = 0; attempt <= SHADOW_HOME_CLEANUP_BACKOFF_MS.length; attempt += 1) {
		const tempPath = join(
			indexDir,
			[
				`.${basename(indexPath)}`,
				String(process.pid),
				String(Date.now()),
				randomBytes(4).toString("hex"),
				"tmp",
			].join("."),
		);
		try {
			writeFileSync(tempPath, `${lines.join("\n")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			chmodSync(tempPath, 0o600);
			renameSync(tempPath, indexPath);
			chmodSync(indexPath, 0o600);
			return;
		} catch (error) {
			try {
				rmSync(tempPath, { force: true });
			} catch {
				// Preserve the original write failure.
			}
			if (
				isRetryableShadowHomeCleanupError(error) &&
				attempt < SHADOW_HOME_CLEANUP_BACKOFF_MS.length
			) {
				sleepSync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
				continue;
			}
			throw error;
		}
	}
}

function repairCodexSessionIndex(codexHome) {
	if (!codexHome || typeof codexHome !== "string") return;
	const sessionsDir = join(codexHome, "sessions");
	if (!existsSync(sessionsDir)) return;
	const indexPath = join(codexHome, "session_index.jsonl");
	let releaseLock = null;
	try {
		releaseLock = acquireShadowHomeSyncLock(codexHome);
		const seen = new Set();
		let existingLines = [];
		if (existsSync(indexPath)) {
			existingLines = readFileSync(indexPath, "utf8")
				.split(/\r?\n/)
				.filter(Boolean);
			for (const line of existingLines) {
				try {
					const entry = JSON.parse(line);
					if (typeof entry?.id === "string") {
						seen.add(entry.id);
					}
				} catch {
					// Preserve unparsable existing lines.
				}
			}
		}

		const additions = [];
		for (const rolloutPath of collectRolloutFiles(sessionsDir)) {
			const idFromName = extractRolloutIdFromFilename(basename(rolloutPath));
			if (idFromName && seen.has(idFromName)) continue;
			const entry = parseRolloutIndexEntry(rolloutPath);
			if (!entry || seen.has(entry.id)) continue;
			seen.add(entry.id);
			additions.push(entry);
		}
		if (additions.length === 0) return;
		additions.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
		writeSessionIndexAtomicSync(indexPath, [
			...existingLines,
			...additions.map((entry) => JSON.stringify(entry)),
		]);
	} catch {
		// Best-effort repair only; forwarding must not fail because indexing did.
	} finally {
		releaseLock?.();
	}
}

const WINDOWS_SHIM_MARKER = "codex-multi-auth windows shim guardian v1";
const POWERSHELL_PROFILE_MARKER_START = "# >>> codex-multi-auth shell guard >>>";
const POWERSHELL_PROFILE_MARKER_END = "# <<< codex-multi-auth shell guard <<<";

function shouldInstallWindowsBatchShimGuard() {
	if (process.platform !== "win32") return false;
	const override = (process.env.CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD ?? "0").trim();
	return override !== "0";
}

function resolveWindowsShimDirectoryFromInvocation() {
	const invokedScript = (process.argv[1] ?? "").trim();
	if (invokedScript.length === 0) return null;
	const resolvedScript = resolvePath(invokedScript);
	const scriptDir = dirname(resolvedScript);
	const packageRoot = dirname(scriptDir);
	const nodeModulesDir = dirname(packageRoot);
	if (basename(nodeModulesDir).toLowerCase() !== "node_modules") {
		return null;
	}
	const shimDir = dirname(nodeModulesDir);
	if (existsSync(join(shimDir, "codex-multi-auth.cmd"))) {
		return shimDir;
	}
	return null;
}

function resolveWindowsShimDirectoryFromPath() {
	const fromInvocation = resolveWindowsShimDirectoryFromInvocation();
	if (fromInvocation) {
		return fromInvocation;
	}
	const pathEntries = splitPathEntries(process.env.PATH ?? process.env.Path ?? "");
	for (const entry of pathEntries) {
		if (existsSync(join(entry, "codex-multi-auth.cmd"))) {
			return entry;
		}
	}
	return null;
}

function buildWindowsBatchShimContent() {
	return [
		"@ECHO off",
		`:: ${WINDOWS_SHIM_MARKER}`,
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		'  SET PATHEXT=%PATHEXT:;.JS;=%',
		")",
		"",
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\codex-multi-auth\\scripts\\codex.js" %*',
	].join("\r\n");
}

function buildWindowsCmdShimContent() {
	return [
		"@ECHO off",
		`:: ${WINDOWS_SHIM_MARKER}`,
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		'  SET PATHEXT=%PATHEXT:;.JS;=%',
		")",
		"",
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\codex-multi-auth\\scripts\\codex.js" %*',
	].join("\r\n");
}

function buildWindowsPowerShellShimContent() {
	return [
		`# ${WINDOWS_SHIM_MARKER}`,
		"$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
		"",
		'$exe=""',
		'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
		'  $exe=".exe"',
		"}",
		"$ret=0",
		'if (Test-Path "$basedir/node$exe") {',
		"  if ($MyInvocation.ExpectingInput) {",
		'    $input | & "$basedir/node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  } else {",
		'    & "$basedir/node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  }",
		"  $ret=$LASTEXITCODE",
		"} else {",
		"  if ($MyInvocation.ExpectingInput) {",
		'    $input | & "node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  } else {",
		'    & "node$exe"  "$basedir/node_modules/codex-multi-auth/scripts/codex.js" $args',
		"  }",
		"  $ret=$LASTEXITCODE",
		"}",
		"if ($null -eq $ret) {",
		"  exit 0",
		"}",
		"exit $ret",
	].join("\r\n");
}

function ensureWindowsShellShim(filePath, desiredContent, options = {}) {
	const {
		overwriteCustomShim = false,
		shimMarker = WINDOWS_SHIM_MARKER,
	} = options;

	let currentContent = "";
	if (existsSync(filePath)) {
		try {
			currentContent = readFileSync(filePath, "utf8");
		} catch {
			return false;
		}
		if (currentContent === desiredContent || currentContent.includes(shimMarker)) {
			if (currentContent !== desiredContent) {
				try {
					writeFileSync(filePath, desiredContent, { encoding: "utf8", mode: 0o755 });
					return true;
				} catch {
					return false;
				}
			}
			return false;
		}
		const looksLikeStockOpenAiShim =
			currentContent.includes("node_modules\\@openai\\codex\\bin\\codex.js") ||
			currentContent.includes("node_modules/@openai/codex/bin/codex.js") ||
			currentContent.includes("@openai\\codex-win32-") ||
			currentContent.includes("@openai/codex-win32-") ||
			currentContent.includes("vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe") ||
			currentContent.includes("vendor\\aarch64-pc-windows-msvc\\codex\\codex.exe") ||
			currentContent.includes("vendor/x86_64-pc-windows-msvc/codex/codex.exe") ||
			currentContent.includes("vendor/aarch64-pc-windows-msvc/codex/codex.exe");
		if (looksLikeStockOpenAiShim) {
			try {
				writeFileSync(filePath, desiredContent, { encoding: "utf8", mode: 0o755 });
				return true;
			} catch {
				return false;
			}
		}
		if (!overwriteCustomShim) {
			return false;
		}
	}

	try {
		writeFileSync(filePath, desiredContent, { encoding: "utf8", mode: 0o755 });
		return true;
	} catch {
		return false;
	}
}

function shouldInstallPowerShellProfileGuard() {
	if (process.platform !== "win32") return false;
	const override = (process.env.CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD ?? "0").trim();
	return override !== "0";
}

function resolveWindowsUserHomeDir() {
	const userProfile = (process.env.USERPROFILE ?? "").trim();
	if (userProfile.length > 0) return userProfile;
	const homeDrive = (process.env.HOMEDRIVE ?? "").trim();
	const homePath = (process.env.HOMEPATH ?? "").trim();
	if (homeDrive.length > 0 && homePath.length > 0) {
		return `${homeDrive}${homePath}`;
	}
	const home = (process.env.HOME ?? "").trim();
	return home;
}

function buildPowerShellProfileGuardBlock(shimDirectory) {
	const codexBatchPath = join(shimDirectory, "codex.bat").replace(/\\/g, "\\\\");
	return [
		POWERSHELL_PROFILE_MARKER_START,
		`$CodexMultiAuthShim = "${codexBatchPath}"`,
		"if (Test-Path $CodexMultiAuthShim) {",
		"  function global:codex {",
		"    & $CodexMultiAuthShim @args",
		"  }",
		"}",
		POWERSHELL_PROFILE_MARKER_END,
	].join("\r\n");
}

function upsertPowerShellProfileGuard(profilePath, guardBlock) {
	let content = "";
	if (existsSync(profilePath)) {
		try {
			content = readFileSync(profilePath, "utf8");
		} catch {
			return false;
		}
	}
	const normalizedCurrentContent = content.replace(/\r?\n$/, "");

	const startIndex = content.indexOf(POWERSHELL_PROFILE_MARKER_START);
	const endIndex = content.indexOf(POWERSHELL_PROFILE_MARKER_END);
	let nextContent;
	if (startIndex >= 0 && endIndex >= startIndex) {
		const endWithMarker = endIndex + POWERSHELL_PROFILE_MARKER_END.length;
		const prefix = content.slice(0, startIndex).replace(/\s*$/, "");
		const suffix = content.slice(endWithMarker).replace(/^\s*/, "");
		nextContent = `${prefix}\r\n\r\n${guardBlock}\r\n\r\n${suffix}`.trimEnd();
	} else if (normalizedCurrentContent.trim().length === 0) {
		nextContent = guardBlock;
	} else {
		nextContent = `${normalizedCurrentContent.replace(/\s*$/, "")}\r\n\r\n${guardBlock}`;
	}

	if (nextContent === normalizedCurrentContent) {
		return false;
	}

	try {
		mkdirSync(dirname(profilePath), { recursive: true });
		writeFileSync(profilePath, `${nextContent}\r\n`, { encoding: "utf8", mode: 0o644 });
		return true;
	} catch {
		return false;
	}
}

function ensurePowerShellProfileGuard(shimDirectory) {
	if (!shouldInstallPowerShellProfileGuard()) return false;
	const homeDir = resolveWindowsUserHomeDir();
	if (!homeDir) return false;
	const guardBlock = buildPowerShellProfileGuardBlock(shimDirectory);
	const profilePaths = [
		join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
		join(homeDir, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
	];
	let changed = false;
	for (const profilePath of profilePaths) {
		changed = upsertPowerShellProfileGuard(profilePath, guardBlock) || changed;
	}
	return changed;
}

function ensureWindowsShellShimGuards() {
	const shouldInstallBatchGuard = shouldInstallWindowsBatchShimGuard();
	const shouldInstallProfileGuard = shouldInstallPowerShellProfileGuard();
	if (!shouldInstallBatchGuard && !shouldInstallProfileGuard) return;
	const shimDirectory = resolveWindowsShimDirectoryFromPath();
	if (!shimDirectory) return;

	const codexMultiAuthShimPath = join(shimDirectory, "codex-multi-auth.cmd");
	if (!existsSync(codexMultiAuthShimPath)) return;

	const overwriteCustomShim =
		(process.env.CODEX_MULTI_AUTH_OVERWRITE_CUSTOM_BATCH_SHIM ?? "0").trim() === "1";
	const installedBatch = shouldInstallBatchGuard
		? ensureWindowsShellShim(
				join(shimDirectory, "codex.bat"),
				buildWindowsBatchShimContent(),
				{ overwriteCustomShim },
			)
		: false;
	const installedCmd = shouldInstallBatchGuard
		? ensureWindowsShellShim(
				join(shimDirectory, "codex.cmd"),
				buildWindowsCmdShimContent(),
				{ overwriteCustomShim },
			)
		: false;
	const installedPs1 = shouldInstallBatchGuard
		? ensureWindowsShellShim(
				join(shimDirectory, "codex.ps1"),
				buildWindowsPowerShellShimContent(),
				{ overwriteCustomShim },
			)
		: false;
	const installedAny = installedBatch || installedCmd || installedPs1;
	const installedProfileGuard = shouldInstallProfileGuard
		? ensurePowerShellProfileGuard(shimDirectory)
		: false;
	if (installedAny || installedProfileGuard) {
		console.error(
			"codex-multi-auth: installed Windows shell guards to keep multi-auth routing after codex npm updates.",
		);
	}
}

async function main() {
	hydrateCliVersionEnv();

	const rawArgs = process.argv.slice(2);
	if (rawArgs[0] === INTERNAL_RUNTIME_ROTATION_APP_HELPER_ARG) {
		return runRuntimeRotationAppHelper(rawArgs[1] ?? "");
	}

	const normalizedArgs = normalizeAuthAlias(rawArgs);
	await showUpdateNoticeIfAvailable(rawArgs, normalizedArgs);
	ensureWindowsShellShimGuards();

	const bypass = (process.env.CODEX_MULTI_AUTH_BYPASS ?? "").trim() === "1";

	if (!bypass && shouldHandleMultiAuthAuth(normalizedArgs)) {
		try {
			const runCodexMultiAuthCli = await loadRunCodexMultiAuthCli();
			if (!runCodexMultiAuthCli) {
				return 1;
			}
			const exitCode = await runCodexMultiAuthCli(normalizedArgs);
			await maybeInstallCodexAppLauncherAfterRotationEnable(
				normalizedArgs,
				normalizeExitCode(exitCode),
			);
			return normalizeExitCode(exitCode);
		} catch (error) {
			console.error(
				`codex-multi-auth runner failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
		}
	}

	const realCodexBin = resolveRealCodexBin();
	if (!realCodexBin) {
		console.error(
			[
				"Could not locate the official Codex CLI.",
				"Install it with npm, Homebrew, or an official native release so `codex` is on PATH.",
				"Or set CODEX_MULTI_AUTH_REAL_CODEX_BIN to the full path of either codex or @openai/codex/bin/codex.js.",
			].join("\n"),
		);
		return 1;
	}

	// Resolve `--account` / CODEX_MULTI_AUTH_FORCE_ACCOUNT before forwarding: strip
	// the launcher-only flag from the Codex args and publish the resolved pin, or
	// fail hard so a forced account can never silently fall back to another one.
	const forcedAccount = await applyForcedAccountSelection(rawArgs, process.env);
	if (forcedAccount.error) {
		console.error(forcedAccount.error);
		return 1;
	}
	const forwardArgs = forcedAccount.forwardArgs;

	await ensurePersistedCodexFileAuthStore();
	await autoSyncManagerActiveSelectionIfEnabled();
	await maybePrintForwardStatusLine(forwardArgs);
	maybeRefreshQuotaCacheInBackground();
	try {
		return await withForwardedRuntimeObservability(forwardArgs, () =>
			forwardToRealCodex(realCodexBin, forwardArgs),
		);
	} finally {
		await autoSyncManagerActiveSelectionIfEnabled();
	}
}

// Model-resolution internals, exported for unit tests. Kept in sync with
// lib/request/helpers/model-map.ts (see test/codex-model-resolution.test.ts,
// which asserts wrapper<->lib parity).
export {
	normalizeRequestedModel,
	coerceReasoningEffortForModel,
	resolveModelFamilyForStatus,
	canonicalizeRequestedModelName,
};

// Run the wrapper only when actually launched (as the `codex-multi-auth-codex`
// bin). Tests set CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY to import the module for
// its exported helpers without forwarding to the real Codex CLI. The flag is
// never set in production, so bin launches are unaffected.
if (!process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY) {
	const exitCode = await main();
	process.exitCode = normalizeExitCode(exitCode);
}
