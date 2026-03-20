import { spawn } from "node:child_process";
import {
	createReadStream,
	promises as fs,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

const DEFAULT_POLL_MS = 30_000
const DEFAULT_IDLE_MS = 5_000
const DEFAULT_SESSION_CAPTURE_TIMEOUT_MS = 15_000
const DEFAULT_SIGNAL_TIMEOUT_MS = 5_000
const DEFAULT_STORAGE_LOCK_WAIT_MS = 10_000
const DEFAULT_STORAGE_LOCK_POLL_MS = 100
const DEFAULT_STORAGE_LOCK_TTL_MS = 30_000
const INTERNAL_RECOVERABLE_COOLDOWN_MS = 60_000
const SESSION_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/
const SESSION_META_SCAN_LINE_LIMIT = 200
const MAX_ACCOUNT_SELECTION_ATTEMPTS = parseNumberEnv(
	"CODEX_AUTH_CLI_SESSION_MAX_ACCOUNT_SELECTION_ATTEMPTS",
	32,
	1,
)
const MAX_SESSION_RESTARTS = parseNumberEnv(
	"CODEX_AUTH_CLI_SESSION_MAX_RESTARTS",
	16,
	1,
)
const CODEX_FAMILY = "codex"

function sleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(false)
			return
		}

		let settled = false
		const finish = (completed) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
			resolve(completed)
		}
		const onAbort = () => finish(false)
		const timer = setTimeout(() => finish(true), ms)

		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

function createAbortError(message = "Operation aborted") {
	const error = new Error(message)
	error.name = "AbortError"
	return error
}

function parseBooleanEnv(name, fallback) {
	const raw = (process.env[name] ?? "").trim().toLowerCase()
	if (raw === "1" || raw === "true") return true
	if (raw === "0" || raw === "false") return false
	return fallback
}

function parseNumberEnv(name, fallback, min = 0) {
	const raw = Number(process.env[name])
	if (!Number.isFinite(raw)) return fallback
	return Math.max(min, Math.trunc(raw))
}

function resolveCodexHomeDir() {
	const fromEnv = (process.env.CODEX_HOME ?? "").trim()
	if (fromEnv.length > 0) return fromEnv
	return join(homedir(), ".codex")
}

function getSessionsRootDir() {
	const override = (process.env.CODEX_MULTI_AUTH_CLI_SESSIONS_DIR ?? "").trim()
	if (override.length > 0) return override
	return join(resolveCodexHomeDir(), "sessions")
}

function isInteractiveCommand(rawArgs) {
	if (rawArgs.length === 0) return true
	const command = `${rawArgs[0] ?? ""}`.trim().toLowerCase()
	return command === "resume" || command === "fork"
}

function isNonInteractiveCommand(rawArgs) {
	return !isInteractiveCommand(rawArgs)
}

function isSupervisorAccountGateBypassCommand(rawArgs) {
	if (rawArgs.length === 0) return false
	const normalizedArgs = rawArgs
		.map((arg) => `${arg ?? ""}`.trim().toLowerCase())
		.filter((arg) => arg.length > 0)
	if (normalizedArgs.length === 0) return false

	const firstArg = normalizedArgs[0]
	if (firstArg === "auth" || firstArg === "help" || firstArg === "version") {
		return true
	}

	return normalizedArgs.some(
		(arg) => arg === "--help" || arg === "-h" || arg === "--version",
	)
}

function readResumeSessionId(rawArgs) {
	if ((rawArgs[0] ?? "").trim().toLowerCase() !== "resume") return null
	const sessionId = `${rawArgs[1] ?? ""}`.trim()
	return isValidSessionId(sessionId) ? sessionId : null
}

async function importIfPresent(specifier) {
	try {
		return await import(specifier)
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			return null
		}
		throw error
	}
}

async function loadSupervisorRuntime() {
	const [configModule, accountsModule, quotaModule, storageModule] = await Promise.all([
		importIfPresent("../dist/lib/config.js"),
		importIfPresent("../dist/lib/accounts.js"),
		importIfPresent("../dist/lib/quota-probe.js"),
		importIfPresent("../dist/lib/storage.js"),
	])

	if (!configModule || !accountsModule?.AccountManager || !quotaModule?.fetchCodexQuotaSnapshot) {
		return null
	}

	return {
		loadPluginConfig: configModule.loadPluginConfig,
		getCodexCliSessionSupervisor:
			configModule.getCodexCliSessionSupervisor ??
			((pluginConfig) => pluginConfig.codexCliSessionSupervisor !== false),
		getRetryAllAccountsRateLimited:
			configModule.getRetryAllAccountsRateLimited ??
			((pluginConfig) => pluginConfig.retryAllAccountsRateLimited !== false),
		getPreemptiveQuotaEnabled:
			configModule.getPreemptiveQuotaEnabled ??
			((pluginConfig) => pluginConfig.preemptiveQuotaEnabled !== false),
		getPreemptiveQuotaRemainingPercent5h:
			configModule.getPreemptiveQuotaRemainingPercent5h ??
			((pluginConfig) => pluginConfig.preemptiveQuotaRemainingPercent5h ?? 10),
		getPreemptiveQuotaRemainingPercent7d:
			configModule.getPreemptiveQuotaRemainingPercent7d ??
			((pluginConfig) => pluginConfig.preemptiveQuotaRemainingPercent7d ?? 5),
		AccountManager: accountsModule.AccountManager,
		fetchCodexQuotaSnapshot: quotaModule.fetchCodexQuotaSnapshot,
		getStoragePath: storageModule?.getStoragePath,
	}
}

function relaunchNotice(message) {
	process.stderr.write(`codex-multi-auth: ${message}\n`)
}

function normalizeExitCode(code, signal) {
	if (signal) {
		return signal === "SIGINT" ? 130 : 1
	}
	return typeof code === "number" ? code : 1
}

function buildResumeArgs(sessionId, buildForwardArgs) {
	return buildForwardArgs(["resume", sessionId])
}

function getCurrentAccount(manager) {
	if (typeof manager.getCurrentAccountForFamily === "function") {
		return manager.getCurrentAccountForFamily(CODEX_FAMILY)
	}
	if (typeof manager.getCurrentAccount === "function") {
		return manager.getCurrentAccount()
	}
	return null
}

function pickNextCandidate(manager) {
	if (typeof manager.getCurrentOrNextForFamilyHybrid === "function") {
		return manager.getCurrentOrNextForFamilyHybrid(CODEX_FAMILY)
	}
	if (typeof manager.getCurrentOrNext === "function") {
		return manager.getCurrentOrNext()
	}
	return null
}

function getNearestWaitMs(manager) {
	if (typeof manager.getMinWaitTimeForFamily === "function") {
		return Math.max(0, manager.getMinWaitTimeForFamily(CODEX_FAMILY))
	}
	if (typeof manager.getMinWaitTime === "function") {
		return Math.max(0, manager.getMinWaitTime())
	}
	return 0
}

async function persistActiveSelection(manager, account) {
	if (typeof manager.setActiveIndex === "function") {
		manager.setActiveIndex(account.index)
	}
	if (typeof manager.syncCodexCliActiveSelectionForIndex === "function") {
		await manager.syncCodexCliActiveSelectionForIndex(account.index)
	}
	if (typeof manager.saveToDisk === "function") {
		await manager.saveToDisk()
	}
}

async function safeUnlink(path) {
	try {
		await fs.unlink(path)
		return true
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return true
		}
		return false
	}
}

function getSupervisorStoragePath(runtime) {
	if (typeof runtime.getStoragePath === "function") {
		try {
			const storagePath = runtime.getStoragePath()
			if (typeof storagePath === "string" && storagePath.trim().length > 0) {
				return storagePath
			}
		} catch {
			// Fall back to the default Codex home path.
		}
	}

	return join(resolveCodexHomeDir(), "multi-auth", "openai-codex-accounts.json")
}

function getSupervisorStorageLockPath(runtime) {
	return `${getSupervisorStoragePath(runtime)}.supervisor.lock`
}

function isValidSessionId(value) {
	return SESSION_ID_PATTERN.test(`${value ?? ""}`.trim())
}

async function readSupervisorLockPayload(lockPath) {
	try {
		const raw = await fs.readFile(lockPath, "utf8")
		return JSON.parse(raw)
	} catch {
		return null
	}
}

async function isSupervisorLockStale(lockPath, ttlMs) {
	const now = Date.now()
	const payload = await readSupervisorLockPayload(lockPath)
	if (payload && typeof payload.expiresAt === "number" && payload.expiresAt <= now) {
		return true
	}

	try {
		const stat = await fs.stat(lockPath)
		return now - stat.mtimeMs > ttlMs
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return true
		}
		console.warn(
			`codex-multi-auth: treating unreadable supervisor lock as stale at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
		)
		return true
	}
}

async function withSupervisorStorageLock(runtime, fn, signal) {
	const lockPath = getSupervisorStorageLockPath(runtime)
	const lockDir = dirname(lockPath)
	const waitMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_LOCK_WAIT_MS",
		DEFAULT_STORAGE_LOCK_WAIT_MS,
		0,
	)
	const pollMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_LOCK_POLL_MS",
		DEFAULT_STORAGE_LOCK_POLL_MS,
		25,
	)
	const ttlMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_LOCK_TTL_MS",
		DEFAULT_STORAGE_LOCK_TTL_MS,
		1_000,
	)

	await fs.mkdir(lockDir, { recursive: true })

	const deadline = Date.now() + waitMs
	while (true) {
		if (signal?.aborted) {
			throw createAbortError("Supervisor storage lock wait aborted")
		}

		try {
			const handle = await fs.open(lockPath, "wx")
			try {
				await handle.writeFile(
					`${JSON.stringify({
						pid: process.pid,
						acquiredAt: Date.now(),
						expiresAt: Date.now() + ttlMs,
					})}\n`,
					"utf8",
				)
			} finally {
				await handle.close()
			}

			try {
				return await fn()
			} finally {
				await safeUnlink(lockPath)
			}
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? `${error.code ?? ""}` : ""
			if (code !== "EEXIST") {
				throw error
			}

			if (await isSupervisorLockStale(lockPath, ttlMs)) {
				const removed = await safeUnlink(lockPath)
				if (removed) continue
			}

			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for supervisor storage lock at ${lockPath}`)
			}

			const slept = await sleep(pollMs, signal)
			if (!slept) {
				throw createAbortError("Supervisor storage lock wait aborted")
			}
		}
	}
}

async function withLockedManager(runtime, mutate, signal) {
	return withSupervisorStorageLock(runtime, async () => {
		const manager = await runtime.AccountManager.loadFromDisk()
		return mutate(manager)
	}, signal)
}

function getManagerAccounts(manager, extraAccounts = []) {
	const accounts =
		typeof manager.getAccountsSnapshot === "function" ? manager.getAccountsSnapshot() : []
	const seen = new Set()
	const deduped = []
	for (const item of [...accounts, ...extraAccounts]) {
		if (!item) continue
		const key = [
			`${item.index ?? ""}`,
			`${item.refreshToken ?? ""}`,
			`${item.accountId ?? ""}`,
			`${item.email ?? ""}`,
		].join("|")
		if (seen.has(key)) continue
		seen.add(key)
		deduped.push(item)
	}
	return deduped
}

function resolveUniqueFieldMatch(accounts, field, value) {
	if (!value) return null
	const matches = accounts.filter((item) => item && item[field] === value)
	return matches.length === 1 ? matches[0] : null
}

function resolveMatchingAccount(accounts, account) {
	if (!account) return null
	if (account.refreshToken) {
		const byRefreshToken =
			accounts.find((item) => item?.refreshToken === account.refreshToken) ?? null
		if (byRefreshToken) return byRefreshToken
	}
	const byAccountId = resolveUniqueFieldMatch(accounts, "accountId", account.accountId)
	if (byAccountId) return byAccountId
	const byEmail = resolveUniqueFieldMatch(accounts, "email", account.email)
	if (byEmail) return byEmail
	return accounts.find((item) => item?.index === account.index) ?? null
}

function resolveAccountInManager(manager, account, knownAccounts = null) {
	if (!account) return null

	const direct =
		typeof manager.getAccountByIndex === "function"
			? manager.getAccountByIndex(account.index)
			: null
	const current = getCurrentAccount(manager)
	const candidate = pickNextCandidate(manager)
	const accounts = knownAccounts ?? getManagerAccounts(manager, [direct, current, candidate])

	if (direct && resolveMatchingAccount(accounts, account) === direct) return direct
	if (current && resolveMatchingAccount(accounts, account) === current) return current
	if (candidate && resolveMatchingAccount(accounts, account) === candidate) return candidate

	return resolveMatchingAccount(accounts, account)
}

function accountsReferToSameStoredAccount(manager, left, right, knownAccounts = null) {
	const accounts = knownAccounts ?? getManagerAccounts(manager, [left, right])
	const resolvedLeft = resolveAccountInManager(manager, left, accounts)
	const resolvedRight = resolveAccountInManager(manager, right, accounts)
	return Boolean(
		resolvedLeft &&
			resolvedRight &&
			resolvedLeft.index === resolvedRight.index &&
			`${resolvedLeft.refreshToken ?? ""}` === `${resolvedRight.refreshToken ?? ""}`,
	)
}

function computeWaitMsFromSnapshot(snapshot) {
	const now = Date.now()
	const candidates = [snapshot?.primary?.resetAtMs, snapshot?.secondary?.resetAtMs]
		.filter((value) => typeof value === "number" && Number.isFinite(value))
		.map((value) => Math.max(0, value - now))
		.filter((value) => value > 0)
	return candidates.length > 0 ? Math.min(...candidates) : 0
}

function evaluateQuotaSnapshot(snapshot, runtime, pluginConfig) {
	if (!snapshot) {
		return { rotate: false, reason: "none", waitMs: 0 }
	}

	if (snapshot.status === 429) {
		return {
			rotate: true,
			reason: "rate-limit",
			waitMs: computeWaitMsFromSnapshot(snapshot),
		}
	}

	if (!runtime.getPreemptiveQuotaEnabled(pluginConfig)) {
		return { rotate: false, reason: "none", waitMs: 0 }
	}

	const remaining5h =
		typeof snapshot.primary?.usedPercent === "number"
			? Math.max(0, Math.round(100 - snapshot.primary.usedPercent))
			: undefined
	const remaining7d =
		typeof snapshot.secondary?.usedPercent === "number"
			? Math.max(0, Math.round(100 - snapshot.secondary.usedPercent))
			: undefined
	const threshold5h = runtime.getPreemptiveQuotaRemainingPercent5h(pluginConfig)
	const threshold7d = runtime.getPreemptiveQuotaRemainingPercent7d(pluginConfig)
	const near5h = typeof remaining5h === "number" && remaining5h <= threshold5h
	const near7d = typeof remaining7d === "number" && remaining7d <= threshold7d

	if (!near5h && !near7d) {
		return { rotate: false, reason: "none", waitMs: 0 }
	}

	return {
		rotate: true,
		reason: "quota-near-exhaustion",
		waitMs: computeWaitMsFromSnapshot(snapshot),
	}
}

async function probeAccountSnapshot(runtime, account, signal) {
	if (signal?.aborted) {
		throw createAbortError("Quota probe aborted")
	}
	if (!account?.accountId || !account?.access) {
		return null
	}
	try {
		return await runtime.fetchCodexQuotaSnapshot({
			accountId: account.accountId,
			accessToken: account.access,
			signal,
		})
	} catch (error) {
		if (signal?.aborted || error?.name === "AbortError") {
			throw error
		}
		return null
	}
}

function markAccountUnavailable(manager, account, evaluation) {
	const waitMs = Math.max(
		evaluation.waitMs || 0,
		evaluation.reason === "rate-limit" ? 1 : 0,
	)

	if (waitMs > 0 && typeof manager.markRateLimitedWithReason === "function") {
		manager.markRateLimitedWithReason(
			account,
			waitMs,
			CODEX_FAMILY,
			evaluation.reason === "rate-limit"
				? "rate_limit_detected"
				: "quota_near_exhaustion",
		)
		return
	}

	if (typeof manager.markAccountCoolingDown === "function") {
		manager.markAccountCoolingDown(
			account,
			INTERNAL_RECOVERABLE_COOLDOWN_MS,
			evaluation.reason === "rate-limit" ? "rate-limit" : "network-error",
		)
	}
}

async function ensureLaunchableAccount(runtime, pluginConfig, signal) {
	let attempts = 0
	while (attempts < MAX_ACCOUNT_SELECTION_ATTEMPTS) {
		attempts += 1
		if (signal?.aborted) {
			return { ok: false, account: null, aborted: true }
		}

		const initial = await withLockedManager(runtime, async (manager) => {
			const account = pickNextCandidate(manager)
			if (!account) {
				return {
					kind: "wait",
					waitMs: getNearestWaitMs(manager),
					account: null,
				}
			}
			return {
				kind: "probe",
				account,
			}
		}, signal)

		if (initial.kind === "wait") {
			if (initial.waitMs <= 0 || !runtime.getRetryAllAccountsRateLimited(pluginConfig)) {
				return { ok: false, account: null }
			}

			relaunchNotice(`all accounts unavailable, waiting ${Math.ceil(initial.waitMs / 1000)}s for the next eligible window`)
			const slept = await sleep(initial.waitMs, signal)
			if (!slept) {
				return { ok: false, account: null, aborted: true }
			}
			continue
		}

		let snapshot
		try {
			snapshot = await probeAccountSnapshot(runtime, initial.account, signal)
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError") {
				return { ok: false, account: null, aborted: true }
			}
			throw error
		}
		const evaluation = evaluateQuotaSnapshot(snapshot, runtime, pluginConfig)
		const step = await withLockedManager(runtime, async (manager) => {
			const account = resolveAccountInManager(manager, initial.account)
			const currentCandidate = pickNextCandidate(manager)
			if (
				!account ||
				!currentCandidate ||
				!accountsReferToSameStoredAccount(manager, currentCandidate, account)
			) {
				return {
					kind: "retry",
					waitMs: 0,
					account: null,
					manager,
				}
			}

			if (!evaluation.rotate) {
				await persistActiveSelection(manager, account)
				return {
					kind: "ready",
					waitMs: 0,
					account,
					manager,
					snapshot,
				}
			}

			markAccountUnavailable(manager, account, evaluation)
			if (typeof manager.saveToDisk === "function") {
				await manager.saveToDisk()
			}
			return {
				kind: "retry",
				waitMs: 0,
				account: null,
				manager,
			}
		}, signal)

		if (step.kind === "ready") {
			return {
				ok: true,
				...step,
			}
		}
	}

	return { ok: false, account: null }
}

async function listJsonlFiles(rootDir) {
	const files = []
	const pending = [rootDir]
	while (pending.length > 0) {
		const nextDir = pending.pop()
		if (!nextDir) continue
		let entries = []
		try {
			entries = await fs.readdir(nextDir, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			const fullPath = join(nextDir, entry.name)
			if (entry.isSymbolicLink()) {
				continue
			}
			if (entry.isDirectory()) {
				pending.push(fullPath)
				continue
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(fullPath)
			}
		}
	}
	return files
}

function normalizeCwd(value) {
	if (typeof value !== "string") return ""
	const trimmed = value.trim()
	if (trimmed.length === 0) return ""
	const normalized = resolvePath(trimmed).replace(/[\\/]+$/, "")
	return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

async function extractSessionMeta(filePath) {
	let stream = null
	let lineReader = null
	try {
		stream = createReadStream(filePath, { encoding: "utf8" })
		lineReader = createInterface({
			input: stream,
			crlfDelay: Infinity,
		})

		let scannedLineCount = 0
		for await (const rawLine of lineReader) {
			const line = rawLine.trim()
			if (!line) continue
			scannedLineCount += 1
			if (scannedLineCount > SESSION_META_SCAN_LINE_LIMIT) break

			try {
				const parsed = JSON.parse(line)
				const payload = parsed?.session_meta?.payload ?? (parsed?.type === "session_meta" ? parsed.payload : null)
				const sessionId = `${payload?.id ?? ""}`.trim()
				const cwd = `${payload?.cwd ?? ""}`.trim()
				if (isValidSessionId(sessionId)) {
					return {
						sessionId,
						cwd,
					}
				}
			} catch {
				// Ignore malformed log lines.
			}
		}
	} catch {
		return null
	} finally {
		lineReader?.close()
		stream?.destroy()
	}

	return null
}

async function findSessionBinding({ cwd, sinceMs, sessionId }) {
	const sessionsRoot = getSessionsRootDir()
	const cwdKey = normalizeCwd(cwd)
	const files = (await Promise.all(
		(await listJsonlFiles(sessionsRoot)).map(async (filePath) => {
			try {
				const stat = await fs.stat(filePath)
				return {
					filePath,
					mtimeMs: stat.mtimeMs,
				}
			} catch {
				return null
			}
		}),
	))
		.filter((entry) => entry && (sessionId ? true : entry.mtimeMs >= sinceMs - 2_000))
		.sort((left, right) => right.mtimeMs - left.mtimeMs)

	for (const entry of files) {
		const meta = await extractSessionMeta(entry.filePath)
		if (!meta) continue
		if (sessionId && meta.sessionId === sessionId) {
			return {
				sessionId: meta.sessionId,
				rolloutPath: entry.filePath,
				lastActivityAtMs: entry.mtimeMs,
			}
		}
		const metaCwdKey = normalizeCwd(meta.cwd)
		if (!cwdKey || !metaCwdKey || metaCwdKey !== cwdKey) continue
		return {
			sessionId: meta.sessionId,
			rolloutPath: entry.filePath,
			lastActivityAtMs: entry.mtimeMs,
		}
	}

	return null
}

async function waitForSessionBinding({ cwd, sinceMs, sessionId, timeoutMs, signal }) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() <= deadline) {
		const binding = await findSessionBinding({ cwd, sinceMs, sessionId })
		if (binding) return binding
		const slept = await sleep(100, signal)
		if (!slept) return null
	}
	return null
}

async function refreshSessionActivity(binding) {
	if (!binding?.rolloutPath) return binding
	try {
		const stat = await fs.stat(binding.rolloutPath)
		return {
			...binding,
			lastActivityAtMs: stat.mtimeMs,
		}
	} catch {
		return binding
	}
}

async function requestChildRestart(child, platform = process.platform, signal) {
	if (child.exitCode !== null) return

	const signalTimeoutMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS",
		DEFAULT_SIGNAL_TIMEOUT_MS,
		50,
	)
	const exitPromise = new Promise((resolve) => {
		child.once("exit", () => resolve())
	})

	if (platform !== "win32") {
		child.kill("SIGINT")
		await Promise.race([exitPromise, sleep(signalTimeoutMs, signal)])
		if (child.exitCode !== null) return
	}

	child.kill("SIGTERM")
	await Promise.race([exitPromise, sleep(signalTimeoutMs, signal)])
	if (child.exitCode !== null) return

	child.kill("SIGKILL")
	await Promise.race([exitPromise, sleep(signalTimeoutMs, signal)])
}

function spawnRealCodex(codexBin, args) {
	return spawn(process.execPath, [codexBin, ...args], {
		stdio: "inherit",
		env: process.env,
	})
}

async function runInteractiveSupervision({
	codexBin,
	initialArgs,
	buildForwardArgs,
	runtime,
	pluginConfig,
	manager,
	signal,
}) {
	let launchArgs = initialArgs
	let knownSessionId = readResumeSessionId(initialArgs)
	let launchCount = 0

	while (launchCount < MAX_SESSION_RESTARTS) {
		if (signal?.aborted) {
			return 130
		}
		launchCount += 1
		const child = spawnRealCodex(codexBin, launchArgs)
		const launchStartedAt = Date.now()
		let binding =
			knownSessionId
				? await findSessionBinding({
					cwd: process.cwd(),
					sinceMs: 0,
					sessionId: knownSessionId,
				})
				: null
		let requestedRestart = null
		let monitorActive = true
		const monitorController = new AbortController()

		const pollMs = parseNumberEnv(
			"CODEX_AUTH_CLI_SESSION_SUPERVISOR_POLL_MS",
			DEFAULT_POLL_MS,
			250,
		)
		const idleMs = parseNumberEnv(
			"CODEX_AUTH_CLI_SESSION_SUPERVISOR_IDLE_MS",
			DEFAULT_IDLE_MS,
			500,
		)
		const captureTimeoutMs = parseNumberEnv(
			"CODEX_AUTH_CLI_SESSION_CAPTURE_TIMEOUT_MS",
			DEFAULT_SESSION_CAPTURE_TIMEOUT_MS,
			1_000,
		)

		const monitorPromise = (async () => {
			while (monitorActive) {
				if (!binding) {
					binding = await waitForSessionBinding({
						cwd: process.cwd(),
						sinceMs: launchStartedAt,
						sessionId: knownSessionId,
						timeoutMs: captureTimeoutMs,
						signal: monitorController.signal,
					})
					if (binding?.sessionId) {
						knownSessionId = binding.sessionId
					}
				} else {
					binding = await refreshSessionActivity(binding)
				}

				if (!requestedRestart) {
					let currentState
					try {
						currentState = await withLockedManager(runtime, async (freshManager) => ({
							manager: freshManager,
							currentAccount: getCurrentAccount(freshManager),
						}), monitorController.signal)
					} catch (error) {
						if (monitorController.signal.aborted || error?.name === "AbortError") {
							break
						}
						throw error
					}
					manager = currentState.manager ?? manager
					const currentAccount = currentState.currentAccount
					if (currentAccount) {
						let snapshot
						try {
							snapshot = await probeAccountSnapshot(runtime, currentAccount, monitorController.signal)
						} catch (error) {
							if (monitorController.signal.aborted || error?.name === "AbortError") {
								break
							}
							throw error
						}
						const evaluation = evaluateQuotaSnapshot(snapshot, runtime, pluginConfig)
						if (evaluation.rotate && binding?.sessionId) {
							const lastActivityAtMs = binding.lastActivityAtMs ?? launchStartedAt
							if (Date.now() - lastActivityAtMs >= idleMs) {
								requestedRestart = {
									reason: evaluation.reason,
									waitMs: evaluation.waitMs,
									sessionId: binding.sessionId,
								}
								relaunchNotice(`rotating session ${binding.sessionId} because ${evaluation.reason.replace(/-/g, " ")}`)
								monitorActive = false
								await requestChildRestart(child, process.platform, signal)
								monitorController.abort()
								continue
							}
						}
					}
				}

				const slept = await sleep(pollMs, monitorController.signal)
				if (!slept) break
			}
		})()

		const result = await new Promise((resolve) => {
			child.once("error", (error) => {
				resolve({
					exitCode: 1,
					error,
				})
			})
			child.once("exit", (code, signal) => {
				resolve({
					exitCode: normalizeExitCode(code, signal),
					signal,
				})
			})
		})

		monitorActive = false
		monitorController.abort()
		await monitorPromise
		binding = binding ?? await findSessionBinding({
			cwd: process.cwd(),
			sinceMs: launchStartedAt,
			sessionId: knownSessionId,
		})
		if (binding?.sessionId) {
			knownSessionId = binding.sessionId
		}

		let restartDecision = requestedRestart
		if (!restartDecision && result.exitCode !== 0 && knownSessionId) {
			const refreshedState = await withLockedManager(runtime, async (freshManager) => ({
				manager: freshManager,
				currentAccount: getCurrentAccount(freshManager),
			}), signal)
			manager = refreshedState.manager ?? manager
			const snapshot = refreshedState.currentAccount
				? await probeAccountSnapshot(runtime, refreshedState.currentAccount, signal)
				: null
			const evaluation = evaluateQuotaSnapshot(snapshot, runtime, pluginConfig)
			if (evaluation.rotate) {
				restartDecision = {
					reason: evaluation.reason,
					waitMs: evaluation.waitMs,
					sessionId: knownSessionId,
				}
			}
		}

		if (!restartDecision) {
			return result.exitCode
		}

		if (!restartDecision.sessionId) {
			relaunchNotice("rotation needed but no resumable session was captured; re-run `codex` manually")
			return result.exitCode
		}

		const currentAccount = getCurrentAccount(manager)
		if (currentAccount) {
			const refreshed = await withLockedManager(runtime, async (freshManager) => {
				const targetAccount = resolveAccountInManager(freshManager, currentAccount)
				if (targetAccount) {
					markAccountUnavailable(freshManager, targetAccount, restartDecision)
					if (typeof freshManager.saveToDisk === "function") {
						await freshManager.saveToDisk()
					}
				}
				return freshManager
			}, signal)
			manager = refreshed
		}

		const nextReady = await ensureLaunchableAccount(runtime, pluginConfig, signal)
		if (nextReady.aborted) {
			return 130
		}
		if (!nextReady.ok) {
			relaunchNotice(
				`no healthy account available to resume ${restartDecision.sessionId}; recover manually with \`codex resume ${restartDecision.sessionId}\` when quota resets`,
			)
			return result.exitCode
		}

		manager = nextReady.manager ?? manager
		launchArgs = buildResumeArgs(restartDecision.sessionId, buildForwardArgs)
		knownSessionId = restartDecision.sessionId
	}

	relaunchNotice("session supervisor reached the restart safety limit")
	return 1
}

export async function runCodexSupervisorIfEnabled({
	codexBin,
	rawArgs,
	buildForwardArgs,
	forwardToRealCodex,
}) {
	const controller = new AbortController()
	const abort = () => controller.abort()
	process.once("SIGINT", abort)
	process.once("SIGTERM", abort)

	try {
		const runtime = await loadSupervisorRuntime()
		if (!runtime) {
			return null
		}

		const pluginConfig = runtime.loadPluginConfig()
		if (!runtime.getCodexCliSessionSupervisor(pluginConfig)) {
			return null
		}

		const initialArgs = buildForwardArgs(rawArgs)
		if (isSupervisorAccountGateBypassCommand(rawArgs)) {
			return forwardToRealCodex(codexBin, initialArgs)
		}

		const ready = await ensureLaunchableAccount(runtime, pluginConfig, controller.signal)
		if (ready.aborted) {
			return 130
		}
		if (!ready.ok) {
			relaunchNotice("no launchable account is currently available")
			return 1
		}

		if (isNonInteractiveCommand(rawArgs)) {
			return forwardToRealCodex(codexBin, initialArgs)
		}

		return runInteractiveSupervision({
			codexBin,
			initialArgs,
			buildForwardArgs,
			runtime,
			pluginConfig,
			manager: ready.manager,
			signal: controller.signal,
		})
	} catch (error) {
		if (error?.name === "AbortError") {
			return 130
		}
		throw error
	} finally {
		process.off("SIGINT", abort)
		process.off("SIGTERM", abort)
	}
}

const TEST_ONLY_API = {
	evaluateQuotaSnapshot,
	ensureLaunchableAccount,
	findSessionBinding,
	extractSessionMeta,
	isInteractiveCommand,
	isValidSessionId,
	listJsonlFiles,
	probeAccountSnapshot,
	readResumeSessionId,
	requestChildRestart,
	resolveCodexHomeDir,
	getSessionsRootDir,
	sleep,
	withLockedManager,
	getSupervisorStorageLockPath,
}

export const __testOnly =
	process.env.NODE_ENV === "test"
		? TEST_ONLY_API
		: undefined
