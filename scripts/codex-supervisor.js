import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import {
	findPrimaryCodexCommand,
	hasTopLevelHelpOrVersionFlag,
	splitCodexCommandArgs,
} from "./codex-routing.js";

const DEFAULT_POLL_MS = 300;
const DEFAULT_IDLE_MS = 250;
const DEFAULT_SESSION_CAPTURE_TIMEOUT_MS = 1_500;
const DEFAULT_SIGNAL_TIMEOUT_MS = process.platform === "win32" ? 75 : 350;
const DEFAULT_QUOTA_PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_MONITOR_PROBE_TIMEOUT_MS = 1_250;
const DEFAULT_SELECTION_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_SELECTION_PROBE_BATCH_SIZE = 4;
const DEFAULT_SNAPSHOT_CACHE_TTL_MS = 1_500;
const DEFAULT_PREWARM_MARGIN_PERCENT_5H = 5;
const DEFAULT_PREWARM_MARGIN_PERCENT_7D = 3;
const DEFAULT_SESSION_BINDING_POLL_MS = 50;
const DEFAULT_STORAGE_LOCK_WAIT_MS = 10_000;
const DEFAULT_STORAGE_LOCK_POLL_MS = 100;
const DEFAULT_STORAGE_LOCK_TTL_MS = 30_000;
const DEFAULT_UNLINK_RETRY_ATTEMPTS = 4;
const DEFAULT_UNLINK_RETRY_BASE_DELAY_MS = 25;
const INTERNAL_RECOVERABLE_COOLDOWN_MS = 60_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
const SESSION_META_SCAN_LINE_LIMIT = 200;
const CODEX_FAMILY = "codex";
const snapshotProbeCache = new Map();
const sessionRolloutPathById = new Map();

function sleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(false);
			return;
		}

		let settled = false;
		const finish = (completed) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(completed);
		};
		const onAbort = () => finish(false);
		const timer = setTimeout(() => finish(true), ms);
		if (typeof timer.unref === "function") {
			timer.unref();
		}

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function createAbortError(message = "Operation aborted") {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function createProbeUnavailableError(error) {
	const wrapped = new Error(
		error instanceof Error ? error.message : String(error),
		{ cause: error },
	);
	wrapped.name = "QuotaProbeUnavailableError";
	return wrapped;
}

function throwIfAborted(signal, message = "Operation aborted") {
	if (signal?.aborted) {
		throw createAbortError(message);
	}
}

function abortablePromise(promise, signal, message = "Operation aborted") {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(createAbortError(message));
	}

	let onAbort;
	const cleanup = () => {
		if (onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	};
	return Promise.race([
		Promise.resolve(promise).finally(cleanup),
		new Promise((_, reject) => {
			onAbort = () => {
				cleanup();
				reject(createAbortError(message));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}),
	]);
}

function parseBooleanEnv(name, fallback) {
	const raw = (process.env[name] ?? "").trim().toLowerCase();
	if (raw === "1" || raw === "true") return true;
	if (raw === "0" || raw === "false") return false;
	return fallback;
}

function parseNumberEnv(name, fallback, min = 0) {
	const raw = Number(process.env[name]);
	if (!Number.isFinite(raw)) return fallback;
	return Math.max(min, Math.trunc(raw));
}

function getMaxAccountSelectionAttempts() {
	return parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_MAX_ACCOUNT_SELECTION_ATTEMPTS",
		32,
		1,
	);
}

function getMaxSessionRestarts() {
	return parseNumberEnv("CODEX_AUTH_CLI_SESSION_MAX_RESTARTS", 16, 1);
}

function resolveProbeTimeoutMs(name, fallback) {
	const globalFallback = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_PROBE_TIMEOUT_MS",
		fallback,
		1_000,
	);
	return parseNumberEnv(name, globalFallback, 1_000);
}

function resolveCodexHomeDir() {
	const fromEnv = (process.env.CODEX_HOME ?? "").trim();
	if (fromEnv.length > 0) return fromEnv;
	return join(homedir(), ".codex");
}

function getSessionsRootDir() {
	const override = (process.env.CODEX_MULTI_AUTH_CLI_SESSIONS_DIR ?? "").trim();
	if (override.length > 0) return override;
	return join(resolveCodexHomeDir(), "sessions");
}

export function isInteractiveCommand(rawArgs) {
	const command = findPrimaryCodexCommand(rawArgs)?.command;
	return !command || command === "resume" || command === "fork";
}

function isNonInteractiveCommand(rawArgs) {
	return !isInteractiveCommand(rawArgs);
}

function isSupervisorAccountGateBypassCommand(rawArgs) {
	if (hasTopLevelHelpOrVersionFlag(rawArgs)) {
		return true;
	}

	const primaryCommand = findPrimaryCodexCommand(rawArgs)?.command;
	return (
		primaryCommand === "auth" ||
		primaryCommand === "help" ||
		primaryCommand === "version"
	);
}

function readResumeSessionId(rawArgs) {
	const primaryCommand = findPrimaryCodexCommand(rawArgs);
	if (primaryCommand?.command !== "resume") return null;
	const sessionId = `${rawArgs[primaryCommand.index + 1] ?? ""}`.trim();
	return isValidSessionId(sessionId) ? sessionId : null;
}

function rememberSessionBinding(binding) {
	if (!binding?.sessionId || !binding?.rolloutPath) return;
	sessionRolloutPathById.set(binding.sessionId, binding.rolloutPath);
}

function clearSessionBindingPathCache() {
	sessionRolloutPathById.clear();
}

function createLinkedAbortController(parentSignal) {
	const controller = new AbortController();
	if (!parentSignal) {
		return {
			controller,
			cleanup: () => controller.abort(),
		};
	}
	const onParentAbort = () => controller.abort();
	parentSignal.addEventListener("abort", onParentAbort, { once: true });
	return {
		controller,
		cleanup: () => {
			parentSignal.removeEventListener("abort", onParentAbort);
			controller.abort();
		},
	};
}

function getSessionBindingEntryPasses(entries, sinceMs, sessionId, hasKnownRolloutPath) {
	const sortedEntries = [...entries].sort((left, right) => right.mtimeMs - left.mtimeMs);
	const recentEntries = sortedEntries.filter((entry) => entry.mtimeMs >= sinceMs - 2_000);
	if (!sessionId || hasKnownRolloutPath) {
		return [recentEntries];
	}
	if (recentEntries.length === 0 || recentEntries.length === sortedEntries.length) {
		return [sortedEntries];
	}
	return [recentEntries, sortedEntries.filter((entry) => !recentEntries.includes(entry))];
}

async function importIfPresent(specifier) {
	try {
		return await import(specifier);
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

async function loadSupervisorRuntime() {
	const [configModule, accountsModule, quotaModule, storageModule] =
		await Promise.all([
			importIfPresent("../dist/lib/config.js"),
			importIfPresent("../dist/lib/accounts.js"),
			importIfPresent("../dist/lib/quota-probe.js"),
			importIfPresent("../dist/lib/storage.js"),
		]);

	if (
		!configModule ||
		!accountsModule?.AccountManager ||
		!quotaModule?.fetchCodexQuotaSnapshot
	) {
		return null;
	}

	const configAccessors = createRuntimeConfigAccessors(configModule);

	return {
		loadPluginConfig: configModule.loadPluginConfig,
		...configAccessors,
		AccountManager: accountsModule.AccountManager,
		fetchCodexQuotaSnapshot: quotaModule.fetchCodexQuotaSnapshot,
		getStoragePath: storageModule?.getStoragePath,
	};
}

function createRuntimeConfigAccessors(configModule) {
	return {
		getCodexCliSessionSupervisor:
			configModule?.getCodexCliSessionSupervisor ??
			((pluginConfig) =>
				parseBooleanEnv(
					"CODEX_AUTH_CLI_SESSION_SUPERVISOR",
					pluginConfig?.codexCliSessionSupervisor ?? false,
				)),
		getRetryAllAccountsRateLimited:
			configModule?.getRetryAllAccountsRateLimited ??
			((pluginConfig) =>
				parseBooleanEnv(
					"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
					pluginConfig?.retryAllAccountsRateLimited !== false,
				)),
		getPreemptiveQuotaEnabled:
			configModule?.getPreemptiveQuotaEnabled ??
			((pluginConfig) =>
				parseBooleanEnv(
					"CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED",
					pluginConfig?.preemptiveQuotaEnabled !== false,
				)),
		getPreemptiveQuotaRemainingPercent5h:
			configModule?.getPreemptiveQuotaRemainingPercent5h ??
			((pluginConfig) =>
				parseNumberEnv(
					"CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT",
					pluginConfig?.preemptiveQuotaRemainingPercent5h ?? 5,
					0,
					100,
				)),
		getPreemptiveQuotaRemainingPercent7d:
			configModule?.getPreemptiveQuotaRemainingPercent7d ??
			((pluginConfig) =>
				parseNumberEnv(
					"CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT",
					pluginConfig?.preemptiveQuotaRemainingPercent7d ?? 5,
					0,
					100,
				)),
	};
}

function relaunchNotice(message) {
	process.stderr.write(`codex-multi-auth: ${message}\n`);
}

function supervisorDebug(message) {
	if (
		parseBooleanEnv("CODEX_AUTH_CLI_SESSION_DEBUG", false)
	) {
		relaunchNotice(message);
	}
}

function formatQuotaPressure(pressure) {
	const parts = [];
	if (typeof pressure.remaining5h === "number") {
		parts.push(`5h=${pressure.remaining5h}%`);
	}
	if (typeof pressure.remaining7d === "number") {
		parts.push(`7d=${pressure.remaining7d}%`);
	}
	return parts.length > 0 ? parts.join(" ") : "quota=unknown";
}

function logRotationSummary(sessionId, trace, nextReady) {
	if (!parseBooleanEnv("CODEX_AUTH_CLI_SESSION_DEBUG", false)) {
		return;
	}

	const parts = [];
	if (trace.detectedAtMs && trace.restartRequestedAtMs) {
		parts.push(`detect_to_restart=${trace.restartRequestedAtMs - trace.detectedAtMs}ms`);
	}
	if (trace.prewarmStartedAtMs && trace.prewarmCompletedAtMs) {
		parts.push(
			`prewarm=${trace.prewarmCompletedAtMs - trace.prewarmStartedAtMs}ms`,
		);
	}
	if (trace.restartRequestedAtMs && trace.resumeReadyAtMs) {
		parts.push(`restart_to_ready=${trace.resumeReadyAtMs - trace.restartRequestedAtMs}ms`);
	}

	const accountLabel =
		nextReady?.account?.email ??
		nextReady?.account?.accountId ??
		`index ${nextReady?.account?.index ?? "unknown"}`;
	supervisorDebug(
		`rotation summary session=${sessionId} account=${accountLabel} ${parts.join(" ")}`.trim(),
	);
}

function normalizeExitCode(code, signal) {
	if (signal) {
		return signal === "SIGINT" ? 130 : 1;
	}
	return typeof code === "number" ? code : 1;
}

function buildResumeArgs(sessionId, currentArgs) {
	const { leadingArgs, command, trailingArgs } = splitCodexCommandArgs(currentArgs);
	const remainingArgs =
		(command === "resume" || command === "fork") &&
		isValidSessionId(trailingArgs[0])
			? trailingArgs.slice(1)
			: trailingArgs;
	return [...leadingArgs, "resume", sessionId, ...remainingArgs];
}

function getCurrentAccount(manager) {
	if (typeof manager.getCurrentAccountForFamily === "function") {
		return manager.getCurrentAccountForFamily(CODEX_FAMILY);
	}
	if (typeof manager.getCurrentAccount === "function") {
		return manager.getCurrentAccount();
	}
	return null;
}

function pickNextCandidate(manager) {
	if (typeof manager.getCurrentOrNextForFamilyHybrid === "function") {
		return manager.getCurrentOrNextForFamilyHybrid(CODEX_FAMILY);
	}
	if (typeof manager.getCurrentOrNext === "function") {
		return manager.getCurrentOrNext();
	}
	return null;
}

function getNearestWaitMs(manager) {
	if (typeof manager.getMinWaitTimeForFamily === "function") {
		return Math.max(0, manager.getMinWaitTimeForFamily(CODEX_FAMILY));
	}
	if (typeof manager.getMinWaitTime === "function") {
		return Math.max(0, manager.getMinWaitTime());
	}
	return 0;
}

async function persistActiveSelection(manager, account, signal) {
	if (typeof manager.setActiveIndex === "function") {
		manager.setActiveIndex(account.index);
	}
	if (typeof manager.syncCodexCliActiveSelectionForIndex === "function") {
		await manager.syncCodexCliActiveSelectionForIndex(account.index);
	}
	if (typeof manager.saveToDisk === "function") {
		throwIfAborted(signal, "Supervisor storage lock lease lost");
		await manager.saveToDisk();
	}
}

async function safeUnlink(path) {
	for (let attempt = 0; attempt < DEFAULT_UNLINK_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await fs.unlink(path);
			return true;
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? `${error.code ?? ""}`
					: "";
			if (code === "ENOENT") {
				return true;
			}
			const canRetry =
				(code === "EPERM" || code === "EBUSY") &&
				attempt + 1 < DEFAULT_UNLINK_RETRY_ATTEMPTS;
			if (!canRetry) {
				return false;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, DEFAULT_UNLINK_RETRY_BASE_DELAY_MS * (attempt + 1)),
			);
		}
	}
	return false;
}

function getSupervisorStoragePath(runtime) {
	if (typeof runtime.getStoragePath === "function") {
		let storagePath;
		try {
			storagePath = runtime.getStoragePath();
		} catch (error) {
			throw new Error(
				`Failed to resolve supervisor storage path via runtime.getStoragePath(): ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error },
			);
		}
		if (typeof storagePath !== "string" || storagePath.trim().length === 0) {
			throw new Error(
				"Failed to resolve supervisor storage path via runtime.getStoragePath(): received an empty path",
			);
		}
		return storagePath;
	}

	return join(
		resolveCodexHomeDir(),
		"multi-auth",
		"openai-codex-accounts.json",
	);
}

function getSupervisorStorageLockPath(runtime) {
	return `${getSupervisorStoragePath(runtime)}.supervisor.lock`;
}

function isValidSessionId(value) {
	return SESSION_ID_PATTERN.test(`${value ?? ""}`.trim());
}

async function readSupervisorLockPayload(lockPath) {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function createSupervisorLockPayload(ownerId, acquiredAt, ttlMs) {
	return {
		ownerId,
		pid: process.pid,
		acquiredAt,
		expiresAt: Date.now() + ttlMs,
	};
}

async function writeSupervisorLockPayload(lockPath, ownerId, acquiredAt, ttlMs) {
	await fs.writeFile(
		lockPath,
		`${JSON.stringify(
			createSupervisorLockPayload(ownerId, acquiredAt, ttlMs),
		)}\n`,
		"utf8",
	);
}

async function safeUnlinkOwnedSupervisorLock(lockPath, ownerId) {
	const payload = await readSupervisorLockPayload(lockPath);
	if (
		payload &&
		typeof payload.ownerId === "string" &&
		payload.ownerId.length > 0 &&
		payload.ownerId !== ownerId
	) {
		return false;
	}
	return safeUnlink(lockPath);
}

function createSupervisorLockHeartbeat(lockPath, ownerId, acquiredAt, ttlMs, signal) {
	const refreshMs = Math.max(25, Math.floor(ttlMs / 3));
	let stopped = false;
	let failedError = null;
	let settleHeartbeat;
	let rejectHeartbeat;
	let pendingRefresh = Promise.resolve();
	const heartbeatPromise = new Promise((resolve, reject) => {
		settleHeartbeat = resolve;
		rejectHeartbeat = reject;
	});
	let timer = null;
	const stopWithError = (error) => {
		if (failedError || stopped) {
			return;
		}
		failedError = error;
		stopped = true;
		if (timer) {
			clearInterval(timer);
		}
		rejectHeartbeat(error);
	};
	const refresh = () => {
		if (stopped || signal?.aborted) {
			return;
		}
		pendingRefresh = pendingRefresh.then(async () => {
			const payload = await readSupervisorLockPayload(lockPath);
			if (!payload) {
				stopWithError(
					new Error(
						`Supervisor lock heartbeat lost lease at ${lockPath} for owner ${ownerId}: lock file disappeared`,
					),
				);
				return;
			}
			if (
				typeof payload.ownerId === "string" &&
				payload.ownerId.length > 0 &&
				payload.ownerId !== ownerId
			) {
				stopWithError(
					new Error(
						`Supervisor lock heartbeat lost lease at ${lockPath} for owner ${ownerId}: observed owner ${payload.ownerId}`,
					),
				);
				return;
			}
			try {
				await writeSupervisorLockPayload(lockPath, ownerId, acquiredAt, ttlMs);
			} catch (error) {
				stopWithError(
					new Error(
						`Failed to refresh supervisor lock lease at ${lockPath} for owner ${ownerId}: ${
							error instanceof Error ? error.message : String(error)
						}`,
						{ cause: error },
					),
				);
			}
		});
	};
	timer = setInterval(refresh, refreshMs);
	if (typeof timer.unref === "function") {
		timer.unref();
	}
	return {
		promise: heartbeatPromise,
		stop: async () => {
			stopped = true;
			clearInterval(timer);
			settleHeartbeat();
			await pendingRefresh;
			if (failedError) {
				throw failedError;
			}
		},
	};
}

async function isSupervisorLockStale(lockPath, ttlMs) {
	const now = Date.now();
	const payload = await readSupervisorLockPayload(lockPath);
	if (payload && typeof payload.expiresAt === "number" && payload.expiresAt <= now) {
		return true;
	}

	try {
		const stat = await fs.stat(lockPath);
		return now - stat.mtimeMs > ttlMs;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return true;
		}
		console.warn(
			`codex-multi-auth: treating unreadable supervisor lock as stale at ${lockPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return true;
	}
}

async function withSupervisorStorageLock(runtime, fn, signal) {
	const lockPath = getSupervisorStorageLockPath(runtime);
	const lockDir = dirname(lockPath);
	const waitMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS",
		DEFAULT_STORAGE_LOCK_WAIT_MS,
		0,
	);
	const pollMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS",
		DEFAULT_STORAGE_LOCK_POLL_MS,
		25,
	);
	const ttlMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_LOCK_TTL_MS",
		DEFAULT_STORAGE_LOCK_TTL_MS,
		1_000,
	);

	await fs.mkdir(lockDir, { recursive: true });

	const deadline = Date.now() + waitMs;
	while (true) {
		if (signal?.aborted) {
			throw createAbortError("Supervisor storage lock wait aborted");
		}

		try {
			const handle = await fs.open(lockPath, "wx");
			const acquiredAt = Date.now();
			const ownerId = `${process.pid}:${acquiredAt}:${Math.random()
				.toString(36)
				.slice(2)}`;
			try {
				await handle.writeFile(
					`${JSON.stringify(
						createSupervisorLockPayload(ownerId, acquiredAt, ttlMs),
					)}\n`,
					"utf8",
				);
			} finally {
				await handle.close();
			}
			const heartbeat = createSupervisorLockHeartbeat(
				lockPath,
				ownerId,
				acquiredAt,
				ttlMs,
				signal,
			);

			const lease = createLinkedAbortController(signal);
			let heartbeatError = null;
			heartbeat.promise.catch((error) => {
				heartbeatError = heartbeatError ?? error;
				if (!lease.controller.signal.aborted) {
					lease.controller.abort();
				}
			});
			let result;
			let fnError = null;
			try {
				result = await fn(lease.controller.signal);
			} catch (error) {
				fnError = error;
			} finally {
				lease.cleanup();
				try {
					await heartbeat.stop();
				} catch (error) {
					heartbeatError = heartbeatError ?? error;
				}
				await safeUnlinkOwnedSupervisorLock(lockPath, ownerId);
			}
			if (heartbeatError) {
				if (fnError && fnError?.name !== "AbortError") {
					throw fnError;
				}
				throw heartbeatError;
			}
			if (fnError) {
				throw fnError;
			}
			return result;
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? `${error.code ?? ""}`
					: "";
			if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") {
				throw error;
			}

			if (await isSupervisorLockStale(lockPath, ttlMs)) {
				const stalePayload = await readSupervisorLockPayload(lockPath);
				const removed =
					typeof stalePayload?.ownerId === "string" &&
					stalePayload.ownerId.length > 0
						? await safeUnlinkOwnedSupervisorLock(
								lockPath,
								stalePayload.ownerId,
							)
						: await safeUnlink(lockPath);
				if (removed) continue;
			}

			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out waiting for supervisor storage lock at ${lockPath}`,
				);
			}

			const slept = await sleep(pollMs, signal);
			if (!slept) {
				throw createAbortError("Supervisor storage lock wait aborted");
			}
		}
	}
}

async function withLockedManager(runtime, mutate, signal) {
	return withSupervisorStorageLock(runtime, async (lockSignal) => {
		throwIfAborted(lockSignal, "Supervisor storage lock lease lost");
		const manager = await runtime.AccountManager.loadFromDisk();
		throwIfAborted(lockSignal, "Supervisor storage lock lease lost");
		return mutate(manager, lockSignal);
	}, signal);
}

function getManagerAccounts(manager, extraAccounts = []) {
	const accounts =
		typeof manager.getAccountsSnapshot === "function"
			? manager.getAccountsSnapshot()
			: [];
	const seen = new Set();
	const deduped = [];
	for (const item of [...accounts, ...extraAccounts]) {
		if (!item) continue;
		const key = [
			`${item.index ?? ""}`,
			`${item.accountId ?? ""}`,
			`${item.email ?? ""}`,
		].join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}
	return deduped;
}

function getAccountIdentityKey(account) {
	if (!account) return "";
	return [
		`${account.index ?? ""}`,
		`${account.accountId ?? ""}`,
		`${account.email ?? ""}`,
	].join("|");
}

function isEligibleProbeAccount(account, now = Date.now()) {
	return Boolean(
		account &&
			account.enabled !== false &&
			(account.coolingDownUntil ?? 0) <= now,
	);
}

function getProbeCandidateBatch(manager, limit, excludedAccounts = []) {
	const accounts = getManagerAccounts(manager);
	const leadingCandidate = pickNextCandidate(manager);
	const ordered = leadingCandidate ? [leadingCandidate, ...accounts] : accounts;
	const now = Date.now();
	const excludedKeys = new Set(
		excludedAccounts.map((account) => getAccountIdentityKey(account)).filter(Boolean),
	);
	const seen = new Set();
	const batch = [];

	for (const item of ordered) {
		const account = resolveMatchingAccount(accounts, item) ?? item;
		if (!isEligibleProbeAccount(account, now)) {
			continue;
		}
		const key = getAccountIdentityKey(account);
		if (excludedKeys.has(key)) {
			continue;
		}
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		batch.push(account);
		if (batch.length >= limit) {
			break;
		}
	}

	return batch;
}

function resolveUniqueFieldMatch(accounts, field, value) {
	if (!value) return null;
	const matches = accounts.filter((item) => item && item[field] === value);
	return matches.length === 1 ? matches[0] : null;
}

function resolveMatchingAccount(accounts, account) {
	if (!account) return null;
	if (account.refreshToken) {
		const byRefreshToken =
			accounts.find((item) => item?.refreshToken === account.refreshToken) ??
			null;
		if (byRefreshToken) return byRefreshToken;
	}
	const byAccountId = resolveUniqueFieldMatch(
		accounts,
		"accountId",
		account.accountId,
	);
	if (byAccountId) return byAccountId;
	const byEmail = resolveUniqueFieldMatch(accounts, "email", account.email);
	if (byEmail) return byEmail;
	return accounts.find((item) => item?.index === account.index) ?? null;
}

function resolveAccountInManager(manager, account, knownAccounts = null) {
	if (!account) return null;

	const direct =
		typeof manager.getAccountByIndex === "function"
			? manager.getAccountByIndex(account.index)
			: null;
	const current = getCurrentAccount(manager);
	const candidate = pickNextCandidate(manager);
	const accounts =
		knownAccounts ?? getManagerAccounts(manager, [direct, current, candidate]);

	if (direct && resolveMatchingAccount(accounts, account) === direct) return direct;
	if (current && resolveMatchingAccount(accounts, account) === current) return current;
	if (candidate && resolveMatchingAccount(accounts, account) === candidate) {
		return candidate;
	}

	return resolveMatchingAccount(accounts, account);
}

function accountsReferToSameStoredAccount(
	manager,
	left,
	right,
	knownAccounts = null,
) {
	const accounts = knownAccounts ?? getManagerAccounts(manager, [left, right]);
	const resolvedLeft = resolveAccountInManager(manager, left, accounts);
	const resolvedRight = resolveAccountInManager(manager, right, accounts);
	return Boolean(
		resolvedLeft &&
			resolvedRight &&
			resolvedLeft.index === resolvedRight.index &&
			`${resolvedLeft.refreshToken ?? ""}` === `${resolvedRight.refreshToken ?? ""}`,
	);
}

function computeWaitMsFromSnapshot(snapshot) {
	const now = Date.now();
	const candidates = [snapshot?.primary?.resetAtMs, snapshot?.secondary?.resetAtMs]
		.filter((value) => typeof value === "number" && Number.isFinite(value))
		.map((value) => Math.max(0, value - now))
		.filter((value) => value > 0);
	return candidates.length > 0 ? Math.min(...candidates) : 0;
}

function computeQuotaPressure(snapshot, runtime, pluginConfig) {
	if (!snapshot) {
		return {
			prewarm: false,
			rotate: false,
			reason: "none",
			waitMs: 0,
			remaining5h: undefined,
			remaining7d: undefined,
		};
	}

	if (snapshot.status === 429) {
		return {
			prewarm: true,
			rotate: true,
			reason: "rate-limit",
			waitMs: computeWaitMsFromSnapshot(snapshot),
			remaining5h: undefined,
			remaining7d: undefined,
		};
	}

	if (!runtime.getPreemptiveQuotaEnabled(pluginConfig)) {
		return {
			prewarm: false,
			rotate: false,
			reason: "none",
			waitMs: 0,
			remaining5h: undefined,
			remaining7d: undefined,
		};
	}

	const remaining5h =
		typeof snapshot.primary?.usedPercent === "number"
			? Math.max(0, Math.round(100 - snapshot.primary.usedPercent))
			: undefined;
	const remaining7d =
		typeof snapshot.secondary?.usedPercent === "number"
			? Math.max(0, Math.round(100 - snapshot.secondary.usedPercent))
			: undefined;
	const threshold5h = runtime.getPreemptiveQuotaRemainingPercent5h(pluginConfig);
	const threshold7d = runtime.getPreemptiveQuotaRemainingPercent7d(pluginConfig);
	const prewarmThreshold5h = Math.min(
		100,
		threshold5h +
			parseNumberEnv(
				"CODEX_AUTH_CLI_SESSION_PREWARM_MARGIN_PERCENT_5H",
				DEFAULT_PREWARM_MARGIN_PERCENT_5H,
				0,
			),
	);
	const prewarmThreshold7d = Math.min(
		100,
		threshold7d +
			parseNumberEnv(
				"CODEX_AUTH_CLI_SESSION_PREWARM_MARGIN_PERCENT_7D",
				DEFAULT_PREWARM_MARGIN_PERCENT_7D,
				0,
			),
	);
	const near5h =
		typeof remaining5h === "number" && remaining5h <= threshold5h;
	const near7d =
		typeof remaining7d === "number" && remaining7d <= threshold7d;
	const prewarm5h =
		typeof remaining5h === "number" && remaining5h <= prewarmThreshold5h;
	const prewarm7d =
		typeof remaining7d === "number" && remaining7d <= prewarmThreshold7d;

	if (!near5h && !near7d) {
		return {
			prewarm: prewarm5h || prewarm7d,
			rotate: false,
			reason: "none",
			waitMs: 0,
			remaining5h,
			remaining7d,
		};
	}

	return {
		prewarm: true,
		rotate: true,
		reason: "quota-near-exhaustion",
		waitMs: computeWaitMsFromSnapshot(snapshot),
		remaining5h,
		remaining7d,
	};
}

function evaluateQuotaSnapshot(snapshot, runtime, pluginConfig) {
	const pressure = computeQuotaPressure(snapshot, runtime, pluginConfig);
	return {
		rotate: pressure.rotate,
		reason: pressure.reason,
		waitMs: pressure.waitMs,
	};
}

function getSnapshotCacheKey(account) {
	if (!account) return "";
	const segments = [
		`${account.accountId ?? ""}`,
		`${account.email ?? ""}`,
		`${account.index ?? ""}`,
	];
	return segments.some((segment) => segment.length > 0) ? segments.join("|") : "";
}

function getSnapshotCacheTtlMs() {
	return parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_SNAPSHOT_CACHE_TTL_MS",
		DEFAULT_SNAPSHOT_CACHE_TTL_MS,
		0,
	);
}

function clearProbeSnapshotCache(account) {
	const cacheKey = getSnapshotCacheKey(account);
	if (!cacheKey) return;
	snapshotProbeCache.delete(cacheKey);
}

function clearAllProbeSnapshotCache() {
	snapshotProbeCache.clear();
}

function readCachedProbeSnapshot(account) {
	const cacheKey = getSnapshotCacheKey(account);
	if (!cacheKey) return null;
	const entry = snapshotProbeCache.get(cacheKey);
	if (!entry?.snapshot || entry.expiresAt <= Date.now()) {
		if (entry && !entry.pending) {
			snapshotProbeCache.delete(cacheKey);
		}
		return null;
	}
	return entry.snapshot;
}

function rememberProbeSnapshot(account, snapshot) {
	const cacheKey = getSnapshotCacheKey(account);
	if (!cacheKey) return;
	const ttlMs = getSnapshotCacheTtlMs();
	if (ttlMs <= 0) {
		snapshotProbeCache.delete(cacheKey);
		return;
	}
	const current = snapshotProbeCache.get(cacheKey);
	snapshotProbeCache.set(cacheKey, {
		...current,
		snapshot,
		expiresAt: Date.now() + ttlMs,
	});
}

async function probeAccountSnapshot(runtime, account, signal, timeoutMs, options = {}) {
	if (signal?.aborted) {
		throw createAbortError("Quota probe aborted");
	}
	if (!account?.accountId || !account?.access) {
		return null;
	}
	const cacheKey = getSnapshotCacheKey(account);
	let pendingResolver = null;
	let pendingRejecter = null;
	let pendingPromise = null;
	if (options.useCache !== false) {
		const cachedSnapshot = readCachedProbeSnapshot(account);
		if (cachedSnapshot) {
			return cachedSnapshot;
		}
		const pendingEntry = cacheKey ? snapshotProbeCache.get(cacheKey) : null;
		if (pendingEntry?.pending) {
			try {
				return await abortablePromise(
					pendingEntry.pending,
					signal,
					"Quota probe aborted",
				);
			} catch (error) {
				if (signal?.aborted || (error?.name === "AbortError" && signal?.aborted)) {
					throw error;
				}
				if (error?.name === "AbortError") {
					throw createProbeUnavailableError(error);
				}
				throw error;
			}
		}
		if (cacheKey) {
			pendingPromise = new Promise((resolve, reject) => {
				pendingResolver = resolve;
				pendingRejecter = reject;
			});
			pendingPromise.catch(() => undefined);
			snapshotProbeCache.set(cacheKey, {
				snapshot: pendingEntry?.snapshot ?? null,
				expiresAt: pendingEntry?.expiresAt ?? 0,
				pending: pendingPromise,
			});
		}
	}

	const fetchPromise = (async () => {
		try {
			const snapshot = await runtime.fetchCodexQuotaSnapshot({
				accountId: account.accountId,
				accessToken: account.access,
				timeoutMs: timeoutMs ?? DEFAULT_QUOTA_PROBE_TIMEOUT_MS,
				signal,
			});
			rememberProbeSnapshot(account, snapshot);
			pendingResolver?.(snapshot);
			return snapshot;
		} catch (error) {
			const normalizedError =
				signal?.aborted || error?.name === "AbortError"
					? error
					: createProbeUnavailableError(error);
			pendingRejecter?.(normalizedError);
			if (signal?.aborted || error?.name === "AbortError") {
				throw error;
			}
			throw normalizedError;
		} finally {
			if (cacheKey) {
				const current = snapshotProbeCache.get(cacheKey);
				if (current?.pending === pendingPromise) {
					snapshotProbeCache.set(cacheKey, {
						snapshot: current.snapshot ?? null,
						expiresAt: current.expiresAt ?? 0,
					});
				}
			}
		}
	})();

	try {
		return await abortablePromise(fetchPromise, signal, "Quota probe aborted");
	} catch (error) {
		if (signal?.aborted || (error?.name === "AbortError" && signal?.aborted)) {
			throw error;
		}
		if (error?.name === "AbortError") {
			throw createProbeUnavailableError(error);
		}
		if (error?.name === "QuotaProbeUnavailableError") {
			throw error;
		}
		return null;
	}
}

function markAccountUnavailable(manager, account, evaluation) {
	clearProbeSnapshotCache(account);
	const waitMs = Math.max(
		evaluation.waitMs || 0,
		evaluation.reason === "rate-limit" ? 1 : 0,
	);

	if (waitMs > 0 && typeof manager.markRateLimitedWithReason === "function") {
		manager.markRateLimitedWithReason(
			account,
			waitMs,
			CODEX_FAMILY,
			evaluation.reason === "rate-limit"
				? "rate_limit_detected"
				: "quota_near_exhaustion",
		);
		return;
	}

	if (typeof manager.markAccountCoolingDown === "function") {
		manager.markAccountCoolingDown(
			account,
			INTERNAL_RECOVERABLE_COOLDOWN_MS,
			evaluation.reason === "rate-limit" ? "rate-limit" : "network-error",
		);
	}
}

async function markCurrentAccountForRestart(
	runtime,
	currentAccount,
	restartDecision,
	signal,
) {
	if (!currentAccount || !restartDecision) {
		return null;
	}

	return withLockedManager(runtime, async (freshManager, lockSignal) => {
		const targetAccount = resolveAccountInManager(freshManager, currentAccount);
		if (targetAccount) {
			markAccountUnavailable(freshManager, targetAccount, restartDecision);
			if (typeof freshManager.saveToDisk === "function") {
				throwIfAborted(lockSignal, "Supervisor storage lock lease lost");
				await freshManager.saveToDisk();
			}
		}
		return freshManager;
	}, signal);
}

async function ensureLaunchableAccount(
	runtime,
	pluginConfig,
	signal,
	options = {},
) {
	const maxAccountSelectionAttempts =
		options.maxAccountSelectionAttempts ?? getMaxAccountSelectionAttempts();
	const probeTimeoutMs =
		options.probeTimeoutMs ?? DEFAULT_SELECTION_PROBE_TIMEOUT_MS;
	const probeBatchSize = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_SELECTION_PROBE_BATCH_SIZE",
		DEFAULT_SELECTION_PROBE_BATCH_SIZE,
		1,
	);
	let attempts = 0;
	while (attempts < maxAccountSelectionAttempts) {
		attempts += 1;
		if (signal?.aborted) {
			return { ok: false, account: null, aborted: true };
		}

		const initial = await withLockedManager(runtime, async (manager) => {
			const accounts = getProbeCandidateBatch(
				manager,
				probeBatchSize,
				options.excludedAccounts ?? [],
			);
			if (accounts.length === 0) {
				return {
					kind: "wait",
					waitMs: getNearestWaitMs(manager),
					account: null,
				};
			}
			return {
				kind: "probe",
				accounts,
			};
		}, signal);

		if (initial.kind === "wait") {
			if (initial.waitMs <= 0 || !runtime.getRetryAllAccountsRateLimited(pluginConfig)) {
				return { ok: false, account: null };
			}

			relaunchNotice(
				`all accounts unavailable, waiting ${Math.ceil(initial.waitMs / 1000)}s for the next eligible window`,
			);
			const slept = await sleep(initial.waitMs, signal);
			if (!slept) {
				return { ok: false, account: null, aborted: true };
			}
			continue;
		}

		const probeResults = [];
		for (const account of initial.accounts) {
			probeResults.push(
				(async () => {
					try {
						const snapshot = await probeAccountSnapshot(
							runtime,
							account,
							signal,
							probeTimeoutMs,
						);
						return {
							account,
							snapshot,
							evaluation: evaluateQuotaSnapshot(snapshot, runtime, pluginConfig),
						};
					} catch (error) {
						if (signal?.aborted || error?.name === "AbortError") {
							throw error;
						}
						if (error?.name === "QuotaProbeUnavailableError") {
							return {
								account,
								snapshot: null,
								evaluation: {
									rotate: true,
									reason: "probe-unavailable",
									waitMs: 0,
								},
							};
						}
						return {
							account,
							snapshot: null,
							evaluation: {
								rotate: true,
								reason: "probe-error",
								waitMs: 0,
							},
						};
					}
				})(),
			);
		}

		let evaluatedResults;
		try {
			evaluatedResults = await Promise.all(probeResults);
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError") {
				return { ok: false, account: null, aborted: true };
			}
			throw error;
		}

		const step = await withLockedManager(runtime, async (manager, lockSignal) => {
			let dirty = false;
			const knownAccounts = getManagerAccounts(manager, initial.accounts);
			const probeUnavailableAccounts = [];
			for (const result of evaluatedResults) {
				const account = resolveAccountInManager(
					manager,
					result.account,
					knownAccounts,
				);
				const currentCandidate =
					getProbeCandidateBatch(
						manager,
						1,
						[
							...(options.excludedAccounts ?? []),
							...probeUnavailableAccounts,
						],
					)[0] ?? null;
				if (
					!account ||
					!currentCandidate ||
					!accountsReferToSameStoredAccount(
						manager,
						currentCandidate,
						account,
						knownAccounts,
					)
				) {
					return {
						kind: "retry",
						waitMs: 0,
						account: null,
					};
				}

				if (!result.evaluation.rotate) {
					if (options.persistSelection !== false) {
						await persistActiveSelection(
							manager,
							account,
							lockSignal,
						);
					}
					return {
						kind: "ready",
						waitMs: 0,
						account,
						manager,
						snapshot: result.snapshot,
					};
				}

				if (result.evaluation.reason === "probe-unavailable") {
					probeUnavailableAccounts.push(account);
					continue;
				}

				markAccountUnavailable(manager, account, result.evaluation);
				dirty = true;
			}
			if (dirty && typeof manager.saveToDisk === "function") {
				throwIfAborted(lockSignal, "Supervisor storage lock lease lost");
				await manager.saveToDisk();
			}
			return {
				kind: "retry",
				waitMs: 0,
				account: null,
			};
		}, signal);

		if (step.kind === "ready") {
			return {
				ok: true,
				...step,
			};
		}
	}

	return { ok: false, account: null };
}

async function commitPreparedSelection(runtime, selectedAccount, signal) {
	if (!selectedAccount) {
		return { ok: false, account: null };
	}

	return withLockedManager(runtime, async (manager, lockSignal) => {
		const knownAccounts = getManagerAccounts(manager, [selectedAccount]);
		const account = resolveAccountInManager(manager, selectedAccount, knownAccounts);
		const currentCandidate = getProbeCandidateBatch(manager, 1)[0] ?? null;
		if (
			!account ||
			!currentCandidate ||
			!accountsReferToSameStoredAccount(
				manager,
				currentCandidate,
				account,
				knownAccounts,
			)
		) {
			return { ok: false, account: null, manager };
		}

		await persistActiveSelection(manager, account, lockSignal);
		return {
			ok: true,
			account,
			manager,
		};
	}, signal);
}

async function prepareResumeSelection({
	runtime,
	pluginConfig,
	currentAccount,
	// Reserved for future restart-specific account-skip hints.
	restartDecision,
	signal,
}) {
	const startedAtMs = Date.now();
	const nextReady = await ensureLaunchableAccount(
		runtime,
		pluginConfig,
		signal,
		{
			probeTimeoutMs: resolveProbeTimeoutMs(
				"CODEX_AUTH_CLI_SESSION_SELECTION_PROBE_TIMEOUT_MS",
				DEFAULT_SELECTION_PROBE_TIMEOUT_MS,
			),
			excludedAccounts: currentAccount ? [currentAccount] : [],
			persistSelection: false,
		},
	);

	return {
		startedAtMs,
		completedAtMs: Date.now(),
		nextReady,
	};
}

function maybeStartPreparedResumeSelection({
	runtime,
	pluginConfig,
	currentAccount,
	restartDecision,
	signal,
	preparedResumeSelectionStarted,
	preparedResumeSelectionPromise,
}) {
	if (preparedResumeSelectionStarted || !currentAccount || !restartDecision?.sessionId) {
		return {
			preparedResumeSelectionStarted,
			preparedResumeSelectionPromise,
		};
	}

	return {
		preparedResumeSelectionStarted: true,
		preparedResumeSelectionPromise: prepareResumeSelection({
			runtime,
			pluginConfig,
			currentAccount,
			restartDecision,
			signal,
		}).catch((error) => {
			if (error?.name !== "AbortError" && !signal?.aborted) {
				supervisorDebug(
					`pre-warm selection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			return null;
		}),
	};
}

async function listJsonlFiles(rootDir) {
	const files = [];
	const pending = [rootDir];
	while (pending.length > 0) {
		const nextDir = pending.pop();
		if (!nextDir) continue;
		let entries = [];
		try {
			entries = await fs.readdir(nextDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = join(nextDir, entry.name);
			if (entry.isSymbolicLink()) {
				continue;
			}
			if (entry.isDirectory()) {
				pending.push(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(fullPath);
			}
		}
	}
	return files;
}

function normalizeCwd(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed.length === 0) return "";
	const normalized = resolvePath(trimmed).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function extractSessionMeta(filePath) {
	let stream = null;
	let lineReader = null;
	try {
		stream = createReadStream(filePath, { encoding: "utf8" });
		lineReader = createInterface({
			input: stream,
			crlfDelay: Infinity,
		});

		let scannedLineCount = 0;
		for await (const rawLine of lineReader) {
			const line = rawLine.trim();
			if (!line) continue;
			scannedLineCount += 1;
			if (scannedLineCount > SESSION_META_SCAN_LINE_LIMIT) break;

			try {
				const parsed = JSON.parse(line);
				const payload =
					parsed?.session_meta?.payload ??
					(parsed?.type === "session_meta" ? parsed.payload : null);
				const sessionId = `${payload?.id ?? ""}`.trim();
				const cwd = `${payload?.cwd ?? ""}`.trim();
				if (isValidSessionId(sessionId)) {
					return {
						sessionId,
						cwd,
					};
				}
			} catch {
				// Ignore malformed log lines.
			}
		}
	} catch {
		return null;
	} finally {
		lineReader?.close();
		stream?.destroy();
	}

	return null;
}

async function matchSessionBindingEntry(entry, cwdKey, sessionId) {
	const meta = await extractSessionMeta(entry.filePath);
	if (!meta) return null;
	if (sessionId && meta.sessionId === sessionId) {
		return {
			sessionId: meta.sessionId,
			rolloutPath: entry.filePath,
			lastActivityAtMs: entry.mtimeMs,
		};
	}
	const metaCwdKey = normalizeCwd(meta.cwd);
	if (!cwdKey || !metaCwdKey || metaCwdKey !== cwdKey) return null;
	return {
		sessionId: meta.sessionId,
		rolloutPath: entry.filePath,
		lastActivityAtMs: entry.mtimeMs,
	};
}

async function readSessionBindingEntry(filePath) {
	try {
		const stat = await fs.stat(filePath);
		return {
			filePath,
			mtimeMs: stat.mtimeMs,
		};
	} catch {
		return null;
	}
}

async function findSessionBinding({
	cwd,
	sinceMs,
	sessionId,
	rolloutPathHint,
	sessionEntries,
}) {
	const cwdKey = normalizeCwd(cwd);
	const knownRolloutPath =
		rolloutPathHint ?? (sessionId ? sessionRolloutPathById.get(sessionId) : null);
	if (knownRolloutPath) {
		const directEntry = await readSessionBindingEntry(knownRolloutPath);
		if (directEntry) {
			const directBinding = await matchSessionBindingEntry(
				directEntry,
				cwdKey,
				sessionId,
			);
			if (directBinding) {
				rememberSessionBinding(directBinding);
				return directBinding;
			}
		}
		if (sessionId && !rolloutPathHint) {
			sessionRolloutPathById.delete(sessionId);
		}
	}

	const files = (sessionEntries ??
		(await Promise.all(
			(await listJsonlFiles(getSessionsRootDir())).map(async (filePath) => {
				return readSessionBindingEntry(filePath);
			}),
		)))
		.filter(Boolean);
	const passes = getSessionBindingEntryPasses(
		files,
		sinceMs,
		sessionId,
		Boolean(knownRolloutPath),
	);
	for (const entries of passes) {
		for (const entry of entries) {
			const binding = await matchSessionBindingEntry(entry, cwdKey, sessionId);
			if (binding) {
				rememberSessionBinding(binding);
				return binding;
			}
		}
	}

	return null;
}

async function waitForSessionBinding({
	cwd,
	sinceMs,
	sessionId,
	rolloutPathHint,
	timeoutMs,
	signal,
}) {
	const deadline = Date.now() + timeoutMs;
	const pollMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_BINDING_POLL_MS",
		DEFAULT_SESSION_BINDING_POLL_MS,
		25,
	);
	const listingRefreshMs = Math.max(250, pollMs * 8);
	let cachedSessionEntries = null;
	let lastSessionEntriesRefreshAt = 0;
	while (Date.now() <= deadline) {
		if (
			!cachedSessionEntries ||
			Date.now() - lastSessionEntriesRefreshAt >= listingRefreshMs
		) {
			cachedSessionEntries = (
				await Promise.all(
					(await listJsonlFiles(getSessionsRootDir())).map(async (filePath) => {
						return readSessionBindingEntry(filePath);
					}),
				)
			).filter(Boolean);
			lastSessionEntriesRefreshAt = Date.now();
		}

		const binding = await findSessionBinding({
			cwd,
			sinceMs,
			sessionId,
			rolloutPathHint,
			sessionEntries: cachedSessionEntries,
		});
		if (binding) return binding;
		const slept = await sleep(pollMs, signal);
		if (!slept) return null;
	}
	return null;
}

async function refreshSessionActivity(binding) {
	if (!binding?.rolloutPath) return binding;
	try {
		const stat = await fs.stat(binding.rolloutPath);
		return {
			...binding,
			lastActivityAtMs: stat.mtimeMs,
		};
	} catch {
		return binding;
	}
}

async function requestChildRestart(child, platform = process.platform, signal) {
	if (child.exitCode !== null) return;

	const signalTimeoutMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS",
		DEFAULT_SIGNAL_TIMEOUT_MS,
		50,
	);
	const exitPromise = new Promise((resolve) => {
		child.once("exit", () => resolve());
	});

	if (platform !== "win32") {
		child.kill("SIGINT");
		await Promise.race([exitPromise, sleep(signalTimeoutMs, signal)]);
		if (child.exitCode !== null) return;
	}

	child.kill("SIGTERM");
	await Promise.race([exitPromise, sleep(signalTimeoutMs, signal)]);
	if (child.exitCode !== null) return;

	// On Windows, SIGTERM is already forceful; keep SIGKILL as the Unix fallback.
	child.kill("SIGKILL");
	await Promise.race([exitPromise, sleep(signalTimeoutMs, signal)]);
}

function spawnRealCodex(codexBin, args) {
	return spawn(process.execPath, [codexBin, ...args], {
		stdio: "inherit",
		env: process.env,
	});
}

async function loadCurrentSupervisorState(runtime, signal) {
	return withLockedManager(
		runtime,
		async (freshManager) => ({
			manager: freshManager,
			currentAccount: getCurrentAccount(freshManager),
		}),
		signal,
	);
}

async function runInteractiveSupervision({
	codexBin,
	initialArgs,
	runtime,
	pluginConfig,
	manager,
	signal,
	maxSessionRestarts = getMaxSessionRestarts(),
	spawnChild = spawnRealCodex,
	findBinding = findSessionBinding,
	waitForBinding = waitForSessionBinding,
	refreshBinding = refreshSessionActivity,
	requestRestart = requestChildRestart,
	loadCurrentState = loadCurrentSupervisorState,
}) {
	let launchArgs = initialArgs;
	let knownSessionId = readResumeSessionId(initialArgs);
	let knownRolloutPath = null;
	let launchCount = 0;

	while (launchCount < maxSessionRestarts) {
		if (signal?.aborted) {
			return 130;
		}
		launchCount += 1;
		const preparedResumeSelectionLink = createLinkedAbortController(signal);
		const preparedResumeSelectionController =
			preparedResumeSelectionLink.controller;
		const child = spawnChild(codexBin, launchArgs);
		let preparedResumeSelectionPromise = null;
		try {
			const launchStartedAt = Date.now();
			let binding = knownSessionId
				? await findBinding({
						cwd: process.cwd(),
						sinceMs: 0,
						sessionId: knownSessionId,
						rolloutPathHint: knownRolloutPath,
					})
				: null;
			if (binding?.rolloutPath) {
				knownRolloutPath = binding.rolloutPath;
			}
			let requestedRestart = null;
			let preparedResumeSelectionStarted = false;
			const rotationTrace = {
				detectedAtMs: 0,
				prewarmStartedAtMs: 0,
				prewarmCompletedAtMs: 0,
				restartRequestedAtMs: 0,
				resumeReadyAtMs: 0,
			};
			let monitorActive = true;
			const monitorController = new AbortController();

			const pollMs = parseNumberEnv(
				"CODEX_AUTH_CLI_SESSION_SUPERVISOR_POLL_MS",
				DEFAULT_POLL_MS,
				250,
			);
			const idleMs = parseNumberEnv(
				"CODEX_AUTH_CLI_SESSION_SUPERVISOR_IDLE_MS",
				DEFAULT_IDLE_MS,
				100,
			);
			const captureTimeoutMs = parseNumberEnv(
				"CODEX_AUTH_CLI_SESSION_CAPTURE_TIMEOUT_MS",
				DEFAULT_SESSION_CAPTURE_TIMEOUT_MS,
				1_000,
			);
			const monitorProbeTimeoutMs = resolveProbeTimeoutMs(
				"CODEX_AUTH_CLI_SESSION_MONITOR_PROBE_TIMEOUT_MS",
				DEFAULT_MONITOR_PROBE_TIMEOUT_MS,
			);

			let monitorFailure = null;
			const monitorPromise = (async () => {
				try {
					while (monitorActive) {
						if (!binding) {
							binding = await waitForBinding({
								cwd: process.cwd(),
								sinceMs: launchStartedAt,
								sessionId: knownSessionId,
								rolloutPathHint: knownRolloutPath,
								timeoutMs: captureTimeoutMs,
								signal: monitorController.signal,
							});
							if (binding?.sessionId) {
								knownSessionId = binding.sessionId;
								knownRolloutPath = binding.rolloutPath ?? knownRolloutPath;
							}
						} else {
							binding = await refreshBinding(binding);
							if (binding?.rolloutPath) {
								knownRolloutPath = binding.rolloutPath;
							}
						}

						if (!requestedRestart) {
							let currentState;
							try {
								currentState = await loadCurrentState(
									runtime,
									monitorController.signal,
								);
							} catch (error) {
								if (
									monitorController.signal.aborted ||
									error?.name === "AbortError"
								) {
									break;
								}
								throw error;
							}
							manager = currentState.manager ?? manager;
							const currentAccount = currentState.currentAccount;
							if (currentAccount) {
								let snapshot;
								try {
									snapshot = await probeAccountSnapshot(
										runtime,
										currentAccount,
										monitorController.signal,
										monitorProbeTimeoutMs,
									);
								} catch (error) {
									if (
										monitorController.signal.aborted ||
										error?.name === "AbortError"
									) {
										break;
									}
									if (error?.name === "QuotaProbeUnavailableError") {
										const slept = await sleep(
											pollMs,
											monitorController.signal,
										);
										if (!slept) {
											break;
										}
										continue;
									}
									throw error;
								}
								const pressure = computeQuotaPressure(
									snapshot,
									runtime,
									pluginConfig,
								);
								if (pressure.prewarm && binding?.sessionId) {
									if (!rotationTrace.detectedAtMs) {
										rotationTrace.detectedAtMs = Date.now();
									}
									if (!preparedResumeSelectionStarted) {
										rotationTrace.prewarmStartedAtMs = Date.now();
										supervisorDebug(
											`prewarming successor for session ${binding.sessionId} ${formatQuotaPressure(pressure)}`,
										);
										const preparedState = maybeStartPreparedResumeSelection({
											runtime,
											pluginConfig,
											currentAccount,
											restartDecision: {
												sessionId: binding.sessionId,
											},
											signal: preparedResumeSelectionController.signal,
											preparedResumeSelectionStarted,
											preparedResumeSelectionPromise,
										});
										preparedResumeSelectionStarted =
											preparedState.preparedResumeSelectionStarted;
										preparedResumeSelectionPromise =
											preparedState.preparedResumeSelectionPromise?.then((prepared) => {
												if (rotationTrace.prewarmCompletedAtMs === 0) {
													rotationTrace.prewarmCompletedAtMs = Date.now();
												}
												return prepared;
											}) ?? null;
									}
								}
								if (pressure.rotate && binding?.sessionId) {
									const pendingRestartDecision = {
										reason: pressure.reason,
										waitMs: pressure.waitMs,
										sessionId: binding.sessionId,
									};
									const lastActivityAtMs =
										binding.lastActivityAtMs ?? launchStartedAt;
									if (Date.now() - lastActivityAtMs >= idleMs) {
										requestedRestart = pendingRestartDecision;
										rotationTrace.restartRequestedAtMs = Date.now();
										relaunchNotice(
											`rotating session ${binding.sessionId} because ${pressure.reason.replace(/-/g, " ")} (${formatQuotaPressure(pressure)})`,
										);
										monitorActive = false;
										await requestRestart(child, process.platform, signal);
										monitorController.abort();
										continue;
									}
								}
							}
						}

						const slept = await sleep(pollMs, monitorController.signal);
						if (!slept) break;
					}
				} catch (error) {
					if (!monitorController.signal.aborted && error?.name !== "AbortError") {
						monitorFailure = error;
					}
				}
			})();

			const result = await abortablePromise(
				new Promise((resolve) => {
					child.once("error", (error) => {
						resolve({
							exitCode: 1,
							error,
						});
					});
					child.once("exit", (code, exitSignal) => {
						resolve({
							exitCode: normalizeExitCode(code, exitSignal),
							signal: exitSignal,
						});
					});
				}),
				signal,
				"Supervisor child wait aborted",
			).catch(async (error) => {
				if (error?.name !== "AbortError" || !signal?.aborted) {
					throw error;
				}
				monitorActive = false;
				monitorController.abort();
				await requestRestart(child, process.platform);
				return {
					exitCode: 130,
					signal: "SIGTERM",
				};
			});

			monitorActive = false;
			monitorController.abort();
			await monitorPromise;
			if (monitorFailure && !signal?.aborted) {
				relaunchNotice(
					`monitor loop failed: ${monitorFailure instanceof Error ? monitorFailure.message : String(monitorFailure)}`,
				);
				return result.exitCode === 0 ? 1 : result.exitCode;
			}
			binding =
				binding ??
				(await findBinding({
					cwd: process.cwd(),
					sinceMs: launchStartedAt,
					sessionId: knownSessionId,
					rolloutPathHint: knownRolloutPath,
				}));
			if (binding?.sessionId) {
				knownSessionId = binding.sessionId;
				knownRolloutPath = binding.rolloutPath ?? knownRolloutPath;
			}

			let restartDecision = requestedRestart;
			if (
				!restartDecision &&
				result.exitCode !== 0 &&
				result.signal !== "SIGINT" &&
				knownSessionId
			) {
				const refreshedState = await withLockedManager(
					runtime,
					async (freshManager) => ({
						manager: freshManager,
						currentAccount: getCurrentAccount(freshManager),
					}),
					signal,
				);
				manager = refreshedState.manager ?? manager;
				if (signal?.aborted) {
					return result.exitCode;
				}
				let snapshot = null;
				if (refreshedState.currentAccount) {
					try {
						snapshot = await probeAccountSnapshot(
							runtime,
							refreshedState.currentAccount,
							signal,
						);
					} catch (error) {
						if (signal?.aborted || error?.name === "AbortError") {
							throw error;
						}
						if (error?.name !== "QuotaProbeUnavailableError") {
							throw error;
						}
					}
				}
				const evaluation = evaluateQuotaSnapshot(snapshot, runtime, pluginConfig);
				if (evaluation.rotate) {
					restartDecision = {
						reason: evaluation.reason,
						waitMs: evaluation.waitMs,
						sessionId: knownSessionId,
					};
				}
			}

			if (!restartDecision) {
				return result.exitCode;
			}

			if (!restartDecision.sessionId) {
				relaunchNotice(
					"rotation needed but no resumable session was captured; re-run `codex` manually",
				);
				return result.exitCode;
			}

			const currentAccount = getCurrentAccount(manager);
			if (currentAccount) {
				const refreshedManager = await markCurrentAccountForRestart(
					runtime,
					currentAccount,
					restartDecision,
					signal,
				);
				manager = refreshedManager ?? manager;
			}

			let nextReady = null;
			if (preparedResumeSelectionPromise) {
				const prepared = await preparedResumeSelectionPromise;
				nextReady = prepared?.nextReady ?? null;
			}
			if (nextReady?.ok) {
				const committedReady = await commitPreparedSelection(
					runtime,
					nextReady.account,
					signal,
				);
				if (committedReady?.ok) {
					nextReady = committedReady;
				} else {
					nextReady = null;
				}
			}

			if (!nextReady) {
				nextReady = await ensureLaunchableAccount(runtime, pluginConfig, signal, {
					probeTimeoutMs: resolveProbeTimeoutMs(
						"CODEX_AUTH_CLI_SESSION_SELECTION_PROBE_TIMEOUT_MS",
						DEFAULT_SELECTION_PROBE_TIMEOUT_MS,
					),
				});
			}
			if (nextReady.aborted) {
				return 130;
			}
			if (!nextReady.ok) {
				relaunchNotice(
					`no healthy account available to resume ${restartDecision.sessionId}; recover manually with \`codex resume ${restartDecision.sessionId}\` when quota resets`,
				);
				return result.exitCode;
			}

			manager = nextReady.manager ?? manager;
			rotationTrace.resumeReadyAtMs = Date.now();
			logRotationSummary(restartDecision.sessionId, rotationTrace, nextReady);
			launchArgs = buildResumeArgs(restartDecision.sessionId, launchArgs);
			knownSessionId = restartDecision.sessionId;
			knownRolloutPath = binding?.rolloutPath ?? knownRolloutPath;
		} finally {
			preparedResumeSelectionLink.cleanup();
			if (preparedResumeSelectionPromise) {
				await preparedResumeSelectionPromise.catch(() => null);
			}
		}
	}

	relaunchNotice("session supervisor reached the restart safety limit");
	return 1;
}

async function runCodexSupervisorWithRuntime({
	codexBin,
	rawArgs,
	buildForwardArgs,
	forwardToRealCodex,
	runtime,
	signal,
}) {
	const pluginConfig = runtime.loadPluginConfig();
	if (!runtime.getCodexCliSessionSupervisor(pluginConfig)) {
		return null;
	}

	const initialArgs = buildForwardArgs(rawArgs);
	if (isSupervisorAccountGateBypassCommand(rawArgs)) {
		return forwardToRealCodex(codexBin, initialArgs);
	}

	const ready = await ensureLaunchableAccount(runtime, pluginConfig, signal);
	if (ready.aborted) {
		return 130;
	}
	if (!ready.ok) {
		relaunchNotice("no launchable account is currently available");
		return 1;
	}

	if (isNonInteractiveCommand(rawArgs)) {
		return forwardToRealCodex(codexBin, initialArgs);
	}

	return runInteractiveSupervision({
		codexBin,
		initialArgs,
		runtime,
		pluginConfig,
		manager: ready.manager,
		signal,
	});
}

export async function runCodexSupervisorIfEnabled({
	codexBin,
	rawArgs,
	buildForwardArgs,
	forwardToRealCodex,
}) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);

	try {
		const runtime = await loadSupervisorRuntime();
		if (!runtime) {
			return null;
		}
		return await runCodexSupervisorWithRuntime({
			codexBin,
			rawArgs,
			buildForwardArgs,
			forwardToRealCodex,
			runtime,
			signal: controller.signal,
		});
	} catch (error) {
		if (error?.name === "AbortError") {
			return 130;
		}
		relaunchNotice(
			`session supervisor failed unexpectedly: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	} finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
	}
}

const TEST_ONLY_API = {
	commitPreparedSelection,
	clearAllProbeSnapshotCache,
	computeQuotaPressure,
	clearProbeSnapshotCache,
	evaluateQuotaSnapshot,
	ensureLaunchableAccount,
	findSessionBinding,
	extractSessionMeta,
	isInteractiveCommand,
	isValidSessionId,
	createLinkedAbortController,
	getSessionBindingEntryPasses,
	listJsonlFiles,
	maybeStartPreparedResumeSelection,
	prepareResumeSelection,
	probeAccountSnapshot,
	readResumeSessionId,
	markCurrentAccountForRestart,
	requestChildRestart,
	resolveCodexHomeDir,
	createRuntimeConfigAccessors,
	getSessionsRootDir,
	getSnapshotCacheKey,
	sleep,
	safeUnlinkOwnedSupervisorLock,
	withLockedManager,
	getSupervisorStorageLockPath,
	runInteractiveSupervision,
	runCodexSupervisorWithRuntime,
	waitForSessionBinding,
	clearSessionBindingPathCache,
};

export const __testOnly =
	process.env.NODE_ENV === "test" ? TEST_ONLY_API : undefined;
