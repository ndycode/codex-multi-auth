import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import type { RuntimeMetrics } from "./metrics.js";

export interface RuntimeObservabilitySnapshot {
	updatedAt: number;
	currentRequestId: string | null;
	responsesRequests: number;
	authRefreshRequests: number;
	diagnosticProbeRequests: number;
	poolExhaustionCooldownUntil: number | null;
	serverBurstCooldownUntil: number | null;
	runtimeMetrics: RuntimeMetrics;
}

const SNAPSHOT_FILE_NAME = "runtime-observability.json";
const PERSIST_RUNTIME_SNAPSHOT = process.env.VITEST !== "true";

let snapshotState: RuntimeObservabilitySnapshot | null = null;
let pendingWrite: Promise<void> | null = null;

function getSnapshotPath(): string {
	return join(getCodexMultiAuthDir(), SNAPSHOT_FILE_NAME);
}

function createDefaultSnapshot(): RuntimeObservabilitySnapshot {
	return {
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
	const path = getSnapshotPath();
	await fs.mkdir(getCodexMultiAuthDir(), { recursive: true });
	await fs.writeFile(path, JSON.stringify(snapshot, null, 2), "utf-8");
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
	const raw = await fs.readFile(path, "utf-8");
	const parsed = JSON.parse(raw) as RuntimeObservabilitySnapshot;
	return parsed;
}

export function resetRuntimeObservabilitySnapshotForTests(): void {
	snapshotState = createDefaultSnapshot();
	pendingWrite = null;
}
