import { existsSync, promises as fs } from "node:fs";
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

async function writeSnapshot(snapshot: RuntimeObservabilitySnapshot): Promise<void> {
	const dir = getCodexMultiAuthDir();
	const path = getSnapshotPath();
	await fs.mkdir(dir, { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	let moved = false;
	try {
		await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf-8");
		await fs.rename(tempPath, path);
		moved = true;
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

export function getRuntimeObservabilitySnapshot(): RuntimeObservabilitySnapshot {
	if (!snapshotState) {
		snapshotState = createDefaultSnapshot();
	}
	return structuredClone(snapshotState);
}

export function mutateRuntimeObservabilitySnapshot(
	mutator: (snapshot: RuntimeObservabilitySnapshot) => void,
): void {
	if (!snapshotState) {
		snapshotState = createDefaultSnapshot();
	}
	mutator(snapshotState);
	snapshotState.updatedAt = Date.now();
	if (!PERSIST_RUNTIME_SNAPSHOT) {
		return;
	}
	const nextSnapshot = structuredClone(snapshotState);
	pendingWrite = (pendingWrite ?? Promise.resolve())
		.catch(() => undefined)
		.then(() => writeSnapshot(nextSnapshot));
}

export async function loadPersistedRuntimeObservabilitySnapshot(): Promise<RuntimeObservabilitySnapshot | null> {
	const path = getSnapshotPath();
	if (!existsSync(path)) {
		return null;
	}
	try {
		const raw = await fs.readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<RuntimeObservabilitySnapshot> | null;
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
	} catch {
		return null;
	}
}

export function resetRuntimeObservabilitySnapshotForTests(): void {
	snapshotState = createDefaultSnapshot();
	pendingWrite = null;
}
