import { spawn } from "node:child_process";
import {
	existsSync,
	promises as fs,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import process from "node:process";

const DEFAULT_POLL_MS = 30_000
const DEFAULT_IDLE_MS = 5_000
const DEFAULT_SESSION_CAPTURE_TIMEOUT_MS = 15_000
const DEFAULT_SIGNAL_TIMEOUT_MS = 5_000
const INTERNAL_RECOVERABLE_COOLDOWN_MS = 60_000

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
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

function readResumeSessionId(rawArgs) {
	if ((rawArgs[0] ?? "").trim().toLowerCase() !== "resume") return null
	const sessionId = `${rawArgs[1] ?? ""}`.trim()
	return sessionId.length > 0 ? sessionId : null
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
	const [configModule, accountsModule, quotaModule] = await Promise.all([
		importIfPresent("../dist/lib/config.js"),
		importIfPresent("../dist/lib/accounts.js"),
		importIfPresent("../dist/lib/quota-probe.js"),
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
		return manager.getCurrentAccountForFamily("codex")
	}
	if (typeof manager.getCurrentAccount === "function") {
		return manager.getCurrentAccount()
	}
	return null
}

function pickNextCandidate(manager) {
	if (typeof manager.getCurrentOrNextForFamilyHybrid === "function") {
		return manager.getCurrentOrNextForFamilyHybrid("codex")
	}
	if (typeof manager.getCurrentOrNext === "function") {
		return manager.getCurrentOrNext()
	}
	return null
}

function getNearestWaitMs(manager) {
	if (typeof manager.getMinWaitTimeForFamily === "function") {
		return Math.max(0, manager.getMinWaitTimeForFamily("codex"))
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

async function probeAccountSnapshot(runtime, account) {
	if (!account?.accountId || !account?.access) {
		return null
	}
	try {
		return await runtime.fetchCodexQuotaSnapshot({
			accountId: account.accountId,
			accessToken: account.access,
		})
	} catch {
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
			"codex",
			"unknown",
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

async function ensureLaunchableAccount(manager, runtime, pluginConfig) {
	let attempts = 0
	while (attempts < 32) {
		attempts += 1
		const account = pickNextCandidate(manager)
		if (!account) {
			const waitMs = getNearestWaitMs(manager)
			if (waitMs <= 0 || !runtime.getRetryAllAccountsRateLimited(pluginConfig)) {
				return { ok: false, account: null }
			}
			relaunchNotice(`all accounts unavailable, waiting ${Math.ceil(waitMs / 1000)}s for the next eligible window`)
			await sleep(waitMs)
			continue
		}

		const snapshot = await probeAccountSnapshot(runtime, account)
		const evaluation = evaluateQuotaSnapshot(snapshot, runtime, pluginConfig)
		if (!evaluation.rotate) {
			await persistActiveSelection(manager, account)
			return { ok: true, account, snapshot }
		}

		markAccountUnavailable(manager, account, evaluation)
		if (typeof manager.saveToDisk === "function") {
			await manager.saveToDisk()
		}
	}

	return { ok: false, account: null }
}

function listJsonlFiles(rootDir) {
	if (!existsSync(rootDir)) return []
	const files = []
	const pending = [rootDir]
	while (pending.length > 0) {
		const nextDir = pending.pop()
		if (!nextDir) continue
		let entries = []
		try {
			entries = readdirSync(nextDir, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			const fullPath = join(nextDir, entry.name)
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
	return resolvePath(value).replace(/[\\/]+$/, "").toLowerCase()
}

function extractSessionMeta(filePath) {
	let raw = ""
	try {
		raw = readFileSync(filePath, "utf8")
	} catch {
		return null
	}

	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
	for (const line of lines.slice(0, 40)) {
		try {
			const parsed = JSON.parse(line)
			const payload = parsed?.session_meta?.payload ?? (parsed?.type === "session_meta" ? parsed.payload : null)
			const sessionId = `${payload?.id ?? ""}`.trim()
			const cwd = `${payload?.cwd ?? ""}`.trim()
			if (sessionId.length > 0) {
				return {
					sessionId,
					cwd,
				}
			}
		} catch {
			// Ignore malformed log lines.
		}
	}

	return null
}

function findSessionBinding({ cwd, sinceMs, sessionId }) {
	const sessionsRoot = getSessionsRootDir()
	const cwdKey = normalizeCwd(cwd)
	const files = listJsonlFiles(sessionsRoot)
		.map((filePath) => {
			let stat
			try {
				stat = statSync(filePath)
			} catch {
				return null
			}
			return {
				filePath,
				mtimeMs: stat.mtimeMs,
			}
		})
		.filter((entry) => entry && (sessionId ? true : entry.mtimeMs >= sinceMs - 2_000))
		.sort((left, right) => right.mtimeMs - left.mtimeMs)

	for (const entry of files) {
		const meta = extractSessionMeta(entry.filePath)
		if (!meta) continue
		if (sessionId && meta.sessionId === sessionId) {
			return {
				sessionId: meta.sessionId,
				rolloutPath: entry.filePath,
				lastActivityAtMs: entry.mtimeMs,
			}
		}
		if (cwdKey && normalizeCwd(meta.cwd) !== cwdKey) continue
		return {
			sessionId: meta.sessionId,
			rolloutPath: entry.filePath,
			lastActivityAtMs: entry.mtimeMs,
		}
	}

	return null
}

async function waitForSessionBinding({ cwd, sinceMs, sessionId, timeoutMs }) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() <= deadline) {
		const binding = findSessionBinding({ cwd, sinceMs, sessionId })
		if (binding) return binding
		await sleep(100)
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

async function requestChildRestart(child) {
	if (child.exitCode !== null) return

	const signalTimeoutMs = parseNumberEnv(
		"CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS",
		DEFAULT_SIGNAL_TIMEOUT_MS,
		50,
	)
	const exitPromise = new Promise((resolve) => {
		child.once("exit", () => resolve())
	})

	child.kill("SIGINT")
	await Promise.race([exitPromise, sleep(signalTimeoutMs)])
	if (child.exitCode !== null) return

	child.kill("SIGTERM")
	await Promise.race([exitPromise, sleep(signalTimeoutMs)])
	if (child.exitCode !== null) return

	child.kill("SIGKILL")
	await exitPromise
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
}) {
	let launchArgs = initialArgs
	let knownSessionId = readResumeSessionId(initialArgs)
	let launchCount = 0

	while (launchCount < 16) {
		launchCount += 1
		const child = spawnRealCodex(codexBin, launchArgs)
		const launchStartedAt = Date.now()
		let binding =
			knownSessionId
				? findSessionBinding({
					cwd: process.cwd(),
					sinceMs: 0,
					sessionId: knownSessionId,
				})
				: null
		let requestedRestart = null
		let monitorActive = true

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
				await sleep(pollMs)
				if (!monitorActive) break
				if (!binding) {
					binding = await waitForSessionBinding({
						cwd: process.cwd(),
						sinceMs: launchStartedAt,
						sessionId: knownSessionId,
						timeoutMs: captureTimeoutMs,
					})
					if (binding?.sessionId) {
						knownSessionId = binding.sessionId
					}
				} else {
					binding = await refreshSessionActivity(binding)
				}

				if (requestedRestart) continue

				const currentAccount = getCurrentAccount(manager)
				if (!currentAccount) continue

				const snapshot = await probeAccountSnapshot(runtime, currentAccount)
				const evaluation = evaluateQuotaSnapshot(snapshot, runtime, pluginConfig)
				if (!evaluation.rotate || !binding?.sessionId) continue

				const lastActivityAtMs = binding.lastActivityAtMs ?? launchStartedAt
				if (Date.now() - lastActivityAtMs < idleMs) continue

				requestedRestart = {
					reason: evaluation.reason,
					waitMs: evaluation.waitMs,
					sessionId: binding.sessionId,
				}
				relaunchNotice(`rotating session ${binding.sessionId} because ${evaluation.reason.replace(/-/g, " ")}`)
				await requestChildRestart(child)
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
		await monitorPromise
		binding = binding ?? findSessionBinding({
			cwd: process.cwd(),
			sinceMs: launchStartedAt,
			sessionId: knownSessionId,
		})
		if (binding?.sessionId) {
			knownSessionId = binding.sessionId
		}

		let restartDecision = requestedRestart
		if (!restartDecision && result.exitCode !== 0 && knownSessionId) {
			const currentAccount = getCurrentAccount(manager)
			const snapshot = currentAccount
				? await probeAccountSnapshot(runtime, currentAccount)
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
			markAccountUnavailable(manager, currentAccount, restartDecision)
			if (typeof manager.saveToDisk === "function") {
				await manager.saveToDisk()
			}
		}

		const nextReady = await ensureLaunchableAccount(manager, runtime, pluginConfig)
		if (!nextReady.ok) {
			relaunchNotice(
				`no healthy account available to resume ${restartDecision.sessionId}; recover manually with \`codex resume ${restartDecision.sessionId}\` when quota resets`,
			)
			return result.exitCode
		}

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
	const runtime = await loadSupervisorRuntime()
	if (!runtime) {
		return null
	}

	const pluginConfig = runtime.loadPluginConfig()
	if (!runtime.getCodexCliSessionSupervisor(pluginConfig)) {
		return null
	}

	const manager = await runtime.AccountManager.loadFromDisk()
	if (!manager) {
		return null
	}

	const ready = await ensureLaunchableAccount(manager, runtime, pluginConfig)
	if (!ready.ok) {
		relaunchNotice("no launchable account is currently available")
		return 1
	}

	const initialArgs = buildForwardArgs(rawArgs)
	if (isNonInteractiveCommand(rawArgs)) {
		return forwardToRealCodex(codexBin, initialArgs)
	}

	return runInteractiveSupervision({
		codexBin,
		initialArgs,
		buildForwardArgs,
		runtime,
		pluginConfig,
		manager,
	})
}

export const __testOnly = {
	evaluateQuotaSnapshot,
	findSessionBinding,
	extractSessionMeta,
	isInteractiveCommand,
	readResumeSessionId,
	resolveCodexHomeDir,
	getSessionsRootDir,
}
