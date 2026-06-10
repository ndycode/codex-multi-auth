import { existsSync, readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "../runtime-paths.js";

interface RuntimeMetricsSnapshot {
	startedAt: number;
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	responsesRequests: number;
	authRefreshRequests: number;
	diagnosticProbeRequests: number;
	outboundRequestAttemptBudget: number | null;
	outboundRequestAttemptsConsumed: number;
	requestAttemptBudgetExhaustions: number;
	poolExhaustionFastFails: number;
	serverBurstFastFails: number;
	rateLimitedResponses: number;
	serverErrors: number;
	networkErrors: number;
	userAborts: number;
	authRefreshFailures: number;
	emptyResponseRetries: number;
	accountRotations: number;
	sameAccountRetries: number;
	streamFailoverAttempts: number;
	streamFailoverCandidatesConsidered: number;
	lastStreamFailoverCandidateCount: number;
	streamFailoverRecoveries: number;
	streamFailoverCrossAccountRecoveries: number;
	cumulativeLatencyMs: number;
	lastRequestAt: number | null;
	lastError: string | null;
}

export interface RuntimeObservabilitySnapshot {
	version: number;
	updatedAt: number;
	currentRequestId: string | null;
	responsesRequests: number;
	authRefreshRequests: number;
	diagnosticProbeRequests: number;
	poolExhaustionCooldownUntil: number | null;
	serverBurstCooldownUntil: number | null;
	lastAccountIndex?: number | null;
	lastAccountLabel?: string | null;
	lastAccountEmail?: string | null;
	lastAccountId?: string | null;
	lastAccountUpdatedAt?: number | null;
	lastPoolExhaustionReason?: string | null;
	lastPoolExhaustionRetryAfterMs?: number | null;
	lastPoolExhaustionSkipReasons?: Record<string, string>;
	lastRuntimeResetAt?: number | null;
	lastRuntimeResetReason?: string | null;
	lastRuntimeReloadAt?: number | null;
	lastRuntimeReloadReason?: string | null;
	accountSkipReasons?: Record<string, string>;
	policyBlockedIndexes?: number[];
	policyBlockedReasons?: Record<string, string>;
	runtimeMetrics: RuntimeMetricsSnapshot;
}

const SNAPSHOT_FILE_NAME = "runtime-observability.json";
const PERSIST_RUNTIME_SNAPSHOT = process.env.VITEST !== "true";
const RUNTIME_OBSERVABILITY_SNAPSHOT_VERSION = 1;
const RETRYABLE_SNAPSHOT_ERRORS = new Set(["EBUSY", "EPERM"]);

let snapshotState: RuntimeObservabilitySnapshot | null = null;
let pendingWrite: Promise<void> | null = null;

function getSnapshotPath(): string {
	return join(getCodexMultiAuthDir(), SNAPSHOT_FILE_NAME);
}

function createDefaultSnapshot(): RuntimeObservabilitySnapshot {
	return {
		version: RUNTIME_OBSERVABILITY_SNAPSHOT_VERSION,
		updatedAt: 0,
		currentRequestId: null,
		responsesRequests: 0,
		authRefreshRequests: 0,
		diagnosticProbeRequests: 0,
		poolExhaustionCooldownUntil: null,
		serverBurstCooldownUntil: null,
		lastAccountIndex: null,
		lastAccountLabel: null,
		lastAccountEmail: null,
		lastAccountId: null,
		lastAccountUpdatedAt: null,
		lastPoolExhaustionReason: null,
		lastPoolExhaustionRetryAfterMs: null,
		lastPoolExhaustionSkipReasons: {},
		lastRuntimeResetAt: null,
		lastRuntimeResetReason: null,
		lastRuntimeReloadAt: null,
		lastRuntimeReloadReason: null,
		accountSkipReasons: {},
		policyBlockedIndexes: [],
		policyBlockedReasons: {},
		runtimeMetrics: {
			startedAt: 0,
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			responsesRequests: 0,
			authRefreshRequests: 0,
			diagnosticProbeRequests: 0,
			outboundRequestAttemptBudget: null,
			outboundRequestAttemptsConsumed: 0,
			requestAttemptBudgetExhaustions: 0,
			poolExhaustionFastFails: 0,
			serverBurstFastFails: 0,
			rateLimitedResponses: 0,
			serverErrors: 0,
			networkErrors: 0,
			userAborts: 0,
			authRefreshFailures: 0,
			emptyResponseRetries: 0,
			accountRotations: 0,
			sameAccountRetries: 0,
			streamFailoverAttempts: 0,
			streamFailoverCandidatesConsidered: 0,
			lastStreamFailoverCandidateCount: 0,
			streamFailoverRecoveries: 0,
			streamFailoverCrossAccountRecoveries: 0,
			cumulativeLatencyMs: 0,
			lastRequestAt: null,
			lastError: null,
		},
	};
}

function normalizePersistedSnapshot(
	parsed: Partial<RuntimeObservabilitySnapshot> | null,
): RuntimeObservabilitySnapshot | null {
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	if (
		typeof parsed.version === "number" &&
		parsed.version !== RUNTIME_OBSERVABILITY_SNAPSHOT_VERSION
	) {
		return null;
	}
	const base = createDefaultSnapshot();
	return {
		...base,
		...parsed,
		version: RUNTIME_OBSERVABILITY_SNAPSHOT_VERSION,
		runtimeMetrics: {
			...base.runtimeMetrics,
			...(parsed.runtimeMetrics ?? {}),
		},
		lastPoolExhaustionSkipReasons: {
			...(parsed.lastPoolExhaustionSkipReasons ?? {}),
		},
		accountSkipReasons: {
			...(parsed.accountSkipReasons ?? {}),
		},
		policyBlockedIndexes: Array.isArray(parsed.policyBlockedIndexes)
			? parsed.policyBlockedIndexes.filter((value): value is number =>
					Number.isInteger(value),
				)
			: [],
		policyBlockedReasons: {
			...(parsed.policyBlockedReasons ?? {}),
		},
	};
}

function loadPersistedRuntimeObservabilitySnapshotSync(): RuntimeObservabilitySnapshot | null {
	const path = getSnapshotPath();
	if (!existsSync(path)) {
		return null;
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<RuntimeObservabilitySnapshot> | null;
		return normalizePersistedSnapshot(parsed);
	} catch {
		return null;
	}
}

function ensureSnapshotState(): RuntimeObservabilitySnapshot {
	if (!snapshotState) {
		snapshotState =
			(PERSIST_RUNTIME_SNAPSHOT
				? loadPersistedRuntimeObservabilitySnapshotSync()
				: null) ?? createDefaultSnapshot();
	}
	return snapshotState;
}

async function writeSnapshot(snapshot: RuntimeObservabilitySnapshot): Promise<void> {
	const dir = getCodexMultiAuthDir();
	const path = getSnapshotPath();
	// The snapshot persists account identifiers (lastAccountId/label/index), so
	// keep it owner-only on POSIX like the other sensitive writers (logger,
	// local-client-tokens). mode is a no-op on win32 (ACL-based).
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	// mkdir's mode only applies to a freshly-created dir; an upgrade path with a
	// pre-existing multi-auth dir keeps its old (possibly permissive) perms, so
	// re-assert 0o700 on POSIX. Only ENOENT is swallowed (the dir was removed by a
	// concurrent process — the snapshot write below will recreate/fail as needed);
	// any other chmod failure is surfaced rather than silently leaving a
	// world-readable dir to hold account ids/labels.
	if (process.platform !== "win32") {
		try {
			await fs.chmod(dir, 0o700);
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
				throw error;
			}
		}
	}
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const tempPath = `${path}.${process.pid}.${Date.now()}.${attempt}.tmp`;
		let moved = false;
		try {
			await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), {
				encoding: "utf-8",
				mode: 0o600,
			});
			await fs.rename(tempPath, path);
			moved = true;
			return;
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
			if (!RETRYABLE_SNAPSHOT_ERRORS.has(code) || attempt >= 2) {
				throw error;
			}
		} finally {
			if (!moved) {
				try {
					await fs.unlink(tempPath);
				} catch {
					// Best-effort cleanup for interrupted writes.
				}
			}
		}
	}
	if (lastError) {
		throw lastError;
	}
}

export function getRuntimeObservabilitySnapshot(): RuntimeObservabilitySnapshot {
	return structuredClone(ensureSnapshotState());
}

export function mutateRuntimeObservabilitySnapshot(
	mutator: (snapshot: RuntimeObservabilitySnapshot) => void,
): void {
	const snapshot = ensureSnapshotState();
	mutator(snapshot);
	snapshot.updatedAt = Date.now();
	if (!PERSIST_RUNTIME_SNAPSHOT) {
		return;
	}
	const nextSnapshot = structuredClone(snapshot);
	pendingWrite = (pendingWrite ?? Promise.resolve())
		.catch(() => undefined)
		.then(() => writeSnapshot(nextSnapshot))
		.catch(() => undefined);
}

export function recordRuntimePoolExhaustion(params: {
	reason: string;
	retryAfterMs: number;
	accountSkipReasons: Record<string, string>;
}): void {
	mutateRuntimeObservabilitySnapshot((snapshot) => {
		snapshot.lastPoolExhaustionReason = params.reason;
		snapshot.lastPoolExhaustionRetryAfterMs = params.retryAfterMs;
		snapshot.lastPoolExhaustionSkipReasons = { ...params.accountSkipReasons };
		snapshot.accountSkipReasons = { ...params.accountSkipReasons };
	});
}

export function recordRuntimeReload(reason: string): void {
	mutateRuntimeObservabilitySnapshot((snapshot) => {
		snapshot.lastRuntimeReloadAt = Date.now();
		snapshot.lastRuntimeReloadReason = reason;
	});
}

export function recordRuntimeReset(reason: string): void {
	mutateRuntimeObservabilitySnapshot((snapshot) => {
		snapshot.lastRuntimeResetAt = Date.now();
		snapshot.lastRuntimeResetReason = reason;
		snapshot.lastPoolExhaustionReason = null;
		snapshot.lastPoolExhaustionRetryAfterMs = null;
		snapshot.lastPoolExhaustionSkipReasons = {};
		snapshot.accountSkipReasons = {};
		snapshot.policyBlockedIndexes = [];
		snapshot.policyBlockedReasons = {};
	});
}

/**
 * Clear a single account's persisted runtime skip reason after it serves a
 * successful request. The overlay (`accountSkipReasons`) is otherwise only
 * written wholesale on pool exhaustion and cleared wholesale on a runtime
 * reset, so without this a stale reason lingers on disk and the forecast keeps
 * reporting a working account as unavailable. This is a no-op when the account
 * has no recorded skip reason, so the common success path does not write.
 */
export function recordRuntimeAccountRecovery(index: number): void {
	if (!Number.isInteger(index) || index < 0) {
		return;
	}
	const key = String(index);
	const current = ensureSnapshotState();
	const hasOverlay = current.accountSkipReasons?.[key] !== undefined;
	const hasPoolReason =
		current.lastPoolExhaustionSkipReasons?.[key] !== undefined;
	if (!hasOverlay && !hasPoolReason) {
		return;
	}
	mutateRuntimeObservabilitySnapshot((snapshot) => {
		if (snapshot.accountSkipReasons?.[key] !== undefined) {
			delete snapshot.accountSkipReasons[key];
		}
		if (snapshot.lastPoolExhaustionSkipReasons?.[key] !== undefined) {
			delete snapshot.lastPoolExhaustionSkipReasons[key];
		}
	});
}

export async function loadPersistedRuntimeObservabilitySnapshot(): Promise<RuntimeObservabilitySnapshot | null> {
	const path = getSnapshotPath();
	if (!existsSync(path)) {
		return null;
	}
	try {
		const raw = await fs.readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<RuntimeObservabilitySnapshot> | null;
		return normalizePersistedSnapshot(parsed);
	} catch {
		return null;
	}
}

