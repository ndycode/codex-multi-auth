import { existsSync, readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "../runtime-paths.js";

export interface RuntimeMetricsSnapshot {
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
	await fs.mkdir(dir, { recursive: true });
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const tempPath = `${path}.${process.pid}.${Date.now()}.${attempt}.tmp`;
		let moved = false;
		try {
			await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf-8");
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

export function resetRuntimeObservabilitySnapshotForTests(): void {
	snapshotState = createDefaultSnapshot();
	pendingWrite = null;
}
