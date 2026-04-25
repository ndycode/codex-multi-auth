import {
	formatAccountLabel,
	formatCooldown,
	formatWaitTime,
} from "../../accounts.js";
import {
	evaluateForecastAccounts,
	recommendForecastAccount,
} from "../../forecast.js";
import type { ModelFamily } from "../../prompts/codex.js";
import {
	findQuotaCacheEntryForAccount,
	isQuotaCacheEntryExhausted,
} from "../../quota-readiness.js";
import type { QuotaCacheData } from "../../quota-cache.js";
import type { AppBindRouterStatus } from "../../runtime/app-bind.js";
import {
	resolveAccountCurrentMarkers,
	resolveRuntimeCurrentAccount,
	type RuntimeAccountSignal,
} from "../../runtime/runtime-current-account.js";
import { isRateLimitedMarker } from "../rate-limit-markers.js";
import type { RuntimeObservabilitySnapshot } from "../../runtime/runtime-observability.js";
import type { AccountStorageV3, StorageHealthSummary } from "../../storage.js";

type LoadedStorage = AccountStorageV3 | null;
type RestoreReason = "empty-storage" | "intentional-reset" | "missing-storage";

export interface StatusCommandDeps {
	setStoragePath: (path: string | null) => void;
	getStoragePath: () => string | null;
	loadAccounts: () => Promise<LoadedStorage>;
	resolveActiveIndex: (
		storage: AccountStorageV3,
		family?: ModelFamily,
	) => number;
	formatRateLimitEntry: (
		account: AccountStorageV3["accounts"][number],
		now: number,
		family: ModelFamily,
	) => string | null;
	loadRuntimeObservabilitySnapshot?: () => Promise<RuntimeObservabilitySnapshot | null>;
	loadAppBindStatus?: () => Promise<AppBindRouterStatus | null>;
	loadAppHelperStatus?: () => RuntimeAccountSignal | null;
	loadQuotaCache?: () => Promise<QuotaCacheData | null>;
	inspectStorageHealth?: () => Promise<StorageHealthSummary>;
	getNow?: () => number;
	logInfo?: (message: string) => void;
}

function isRestoreReason(value: unknown): value is RestoreReason {
	return (
		value === "empty-storage" ||
		value === "intentional-reset" ||
		value === "missing-storage"
	);
}

function readRestoreReason(storage: AccountStorageV3): RestoreReason | undefined {
	if (!("restoreReason" in storage)) return undefined;
	return isRestoreReason(storage.restoreReason)
		? storage.restoreReason
		: undefined;
}

function formatRuntimeLastAccount(
	runtimeSnapshot: RuntimeObservabilitySnapshot,
): string | null {
	if (
		runtimeSnapshot.lastAccountLabel &&
		!runtimeSnapshot.lastAccountLabel.includes("@")
	) {
		return runtimeSnapshot.lastAccountLabel;
	}
	if (runtimeSnapshot.lastAccountId) {
		return typeof runtimeSnapshot.lastAccountIndex === "number"
			? `Account ${runtimeSnapshot.lastAccountIndex + 1} (${runtimeSnapshot.lastAccountId})`
			: runtimeSnapshot.lastAccountId;
	}
	if (typeof runtimeSnapshot.lastAccountIndex === "number") {
		return `Account ${runtimeSnapshot.lastAccountIndex + 1}`;
	}
	return null;
}

export async function runStatusCommand(
	deps: StatusCommandDeps,
): Promise<number> {
	deps.setStoragePath(null);
	const storage = await deps.loadAccounts();
	const path = deps.getStoragePath();
	const storageHealth = await deps.inspectStorageHealth?.();
	const logInfo = deps.logInfo ?? console.log;
	if (!storage || storage.accounts.length === 0) {
		const restoreReason = storage ? readRestoreReason(storage) : undefined;
		const effectiveState: StorageHealthSummary["state"] | undefined =
			restoreReason === "intentional-reset"
				? "intentional-reset"
				: storageHealth?.state ??
					(restoreReason === "empty-storage" ||
					restoreReason === "missing-storage"
						? "empty"
						: undefined);
		logInfo(
			effectiveState === "intentional-reset"
				? "No accounts configured. Storage was intentionally reset."
				: effectiveState === "recoverable"
					? "No accounts configured. Recovery artifacts are available."
					: effectiveState === "corrupt"
						? "No accounts configured. Storage appears corrupted."
						: "No accounts configured.",
		);
		logInfo(`Storage: ${path}`);
		if (effectiveState) {
			logInfo(`Storage health: ${effectiveState}`);
		}
		return 0;
	}

	const now = deps.getNow?.() ?? Date.now();
	const activeIndex = deps.resolveActiveIndex(storage, "codex");
	const forecastResults = evaluateForecastAccounts(
		storage.accounts.map((account, index) => ({
			index,
			account,
			isCurrent: index === activeIndex,
			now,
		})),
	);
	const recommendation = recommendForecastAccount(forecastResults);
	logInfo(`Accounts (${storage.accounts.length})`);
	logInfo(`Storage: ${path}`);
	if (recommendation.recommendedIndex !== null) {
		logInfo(
			`Selection reason: account ${recommendation.recommendedIndex + 1} (${recommendation.reason})`,
		);
	}
	if (storageHealth) {
		logInfo(`Storage health: ${storageHealth.state}`);
	}
	const appHelperStatus = deps.loadAppHelperStatus?.() ?? null;
	const [runtimeSnapshot, appBindStatus, quotaCache] = await Promise.all([
		deps.loadRuntimeObservabilitySnapshot?.() ?? Promise.resolve(null),
		deps.loadAppBindStatus?.() ?? Promise.resolve(null),
		deps.loadQuotaCache?.() ?? Promise.resolve(null),
	]);
	const runtimeCurrent = resolveRuntimeCurrentAccount(
		storage,
		{
			runtimeSnapshot,
			appBindStatus,
			appHelperStatus,
		},
		{ now },
	);
	if (runtimeSnapshot) {
		const runtimeMetrics = runtimeSnapshot.runtimeMetrics;
		const poolCooldown =
			typeof runtimeSnapshot.poolExhaustionCooldownUntil === "number" &&
			runtimeSnapshot.poolExhaustionCooldownUntil > now
				? formatWaitTime(runtimeSnapshot.poolExhaustionCooldownUntil - now)
				: null;
		const serverCooldown =
			typeof runtimeSnapshot.serverBurstCooldownUntil === "number" &&
			runtimeSnapshot.serverBurstCooldownUntil > now
				? formatWaitTime(runtimeSnapshot.serverBurstCooldownUntil - now)
				: null;
		logInfo(
			`Runtime: responses=${runtimeSnapshot.responsesRequests}, refresh=${runtimeSnapshot.authRefreshRequests}, probes=${runtimeSnapshot.diagnosticProbeRequests}, budgetExhaustions=${runtimeMetrics.requestAttemptBudgetExhaustions}`,
		);
		const lastRuntimeAccount = formatRuntimeLastAccount(runtimeSnapshot);
		if (lastRuntimeAccount) {
			logInfo(`Last runtime account: ${lastRuntimeAccount}`);
		}
		if (poolCooldown || serverCooldown) {
			logInfo(
				`Cooldowns: pool=${poolCooldown ?? "none"}, server-burst=${serverCooldown ?? "none"}`,
			);
		}
		if (runtimeSnapshot.currentRequestId) {
			logInfo(`Last request trace: ${runtimeSnapshot.currentRequestId}`);
		}
	}
	if (runtimeCurrent) {
		logInfo(
			`Runtime in use: account ${runtimeCurrent.index + 1} (${runtimeCurrent.source})`,
		);
	}
	logInfo("");

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		const label = formatAccountLabel(account, i);
		const markers: string[] = [];
		markers.push(...resolveAccountCurrentMarkers(i, activeIndex, runtimeCurrent));
		if (account.enabled === false) markers.push("disabled");
		const rateLimit = deps.formatRateLimitEntry(account, now, "codex");
		if (rateLimit) markers.push("rate-limited");
		const quotaEntry = findQuotaCacheEntryForAccount(
			quotaCache,
			account,
			storage.accounts,
		);
		if (
			quotaEntry?.status === 429 &&
			!markers.some((marker) => isRateLimitedMarker(marker))
		) {
			markers.push("rate-limited");
		}
		if (isQuotaCacheEntryExhausted(quotaEntry, now)) {
			markers.push("quota-exhausted");
		}
		const cooldown = formatCooldown(account, now);
		if (cooldown) markers.push(`cooldown:${cooldown}`);
		const markerLabel = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
		const lastUsed =
			typeof account.lastUsed === "number" && account.lastUsed > 0
				? `used ${formatWaitTime(now - account.lastUsed)} ago`
				: "never used";
		logInfo(`${i + 1}. ${label}${markerLabel} ${lastUsed}`);
		const primaryReason = forecastResults[i]?.reasons[0];
		if (primaryReason) {
			logInfo(`   reason: ${primaryReason}`);
		}
	}

	return 0;
}

export interface FeaturesCommandDeps {
	implementedFeatures: ReadonlyArray<{ id: number; name: string }>;
	logInfo?: (message: string) => void;
}

export function runFeaturesCommand(deps: FeaturesCommandDeps): number {
	const logInfo = deps.logInfo ?? console.log;
	logInfo(`Implemented features (${deps.implementedFeatures.length})`);
	logInfo("");
	for (const feature of deps.implementedFeatures) {
		logInfo(`${feature.id}. ${feature.name}`);
	}
	return 0;
}
