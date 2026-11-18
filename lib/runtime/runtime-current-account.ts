import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { RuntimeObservabilitySnapshot } from "./runtime-observability.js";
import type { AppBindRouterStatus } from "./app-bind.js";
import {
	isLiveRuntimeHelper,
	readRuntimeHelperPid,
	selectRuntimeHelperStatus,
} from "./app-helper-selection.js";
import { listRuntimeHelperStatusPaths } from "../runtime-constants.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import type { AccountStorageV3 } from "../storage.js";
import { isRecord } from "../utils.js";

type RuntimeCurrentAccountSource =
	| "runtime-observability"
	| "app-bind"
	| "app-helper";

type RuntimeCurrentAccountMatch = "account-id" | "email" | "index";

export type AccountCurrentMarker = "current" | "in-use" | "selected";

export interface RuntimeAccountSignal {
	source: RuntimeCurrentAccountSource;
	lastAccountIndex?: number | null;
	lastAccountId?: string | null;
	lastAccountEmail?: string | null;
	lastAccountLabel?: string | null;
	lastAccountUpdatedAt?: number | null;
	updatedAt?: number | null;
}

export interface RuntimeCurrentAccountSelection {
	index: number;
	source: RuntimeCurrentAccountSource;
	matchedBy: RuntimeCurrentAccountMatch;
	updatedAt: number;
	lastAccountId?: string;
	lastAccountEmail?: string;
	lastAccountLabel?: string;
}

export interface RuntimeCurrentAccountOptions {
	now?: number;
	maxAgeMs?: number;
}

export interface RuntimeCurrentAccountSources {
	runtimeSnapshot?: RuntimeObservabilitySnapshot | null;
	appBindStatus?: AppBindRouterStatus | null;
	appHelperStatus?: RuntimeAccountSignal | null;
}

const RUNTIME_CURRENT_ACCOUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APP_RUNTIME_HELPER_KIND = "codex-app-runtime-rotation-helper";
const MAX_STATUS_FILE_BYTES = 1024 * 1024; // 1 MB sanity cap

export interface AppRuntimeHelperAccountStatus {
	kind: string | null;
	state: string | null;
	pid: number | null;
	// Parsed so liveness can be identity-checked rather than trusting
	// `kill(pid, 0)` alone; see app-helper-selection.ts.
	startedAt: number | null;
	lastAccountIndex: number | null;
	lastAccountLabel: string | null;
	lastAccountEmail: string | null;
	lastAccountId: string | null;
	lastAccountUpdatedAt: number | null;
	updatedAt: number | null;
}

function normalizeString(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeAccountId(value: string | null | undefined): string | null {
	return normalizeString(value);
}

function normalizeEmail(value: string | null | undefined): string | null {
	return normalizeString(value)?.toLowerCase() ?? null;
}

function normalizeIndex(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const index = Math.trunc(value);
	return index >= 0 ? index : null;
}

function normalizeTimestampValue(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return null;
	}
	return value;
}

function normalizeTimestamp(signal: RuntimeAccountSignal): number | null {
	const timestamps = [
		normalizeTimestampValue(signal.lastAccountUpdatedAt),
		normalizeTimestampValue(signal.updatedAt),
	].filter((timestamp): timestamp is number => timestamp !== null);
	return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}


function readAppRuntimeHelperStatusFile(
	statusPath: string,
): AppRuntimeHelperAccountStatus | null {
	if (!existsSync(statusPath)) return null;
	try {
		const stat = statSync(statusPath);
		if (stat.size > MAX_STATUS_FILE_BYTES) return null;
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as unknown;
		if (!isRecord(parsed)) return null;
		return {
			kind: readOptionalString(parsed, "kind"),
			state: readOptionalString(parsed, "state"),
			pid: readRuntimeHelperPid(parsed.pid),
			startedAt: readOptionalNumber(parsed, "startedAt"),
			lastAccountIndex: readOptionalNumber(parsed, "lastAccountIndex"),
			lastAccountLabel: readOptionalString(parsed, "lastAccountLabel"),
			lastAccountEmail: readOptionalString(parsed, "lastAccountEmail"),
			lastAccountId: readOptionalString(parsed, "lastAccountId"),
			lastAccountUpdatedAt: readOptionalNumber(parsed, "lastAccountUpdatedAt"),
			updatedAt: readOptionalNumber(parsed, "updatedAt"),
		};
	} catch {
		return null;
	}
}

// Helpers publish per-PID status files (`runtime-rotation-app-helper.<pid>.json`)
// so N concurrent helpers stop overwriting one shared path; path discovery is
// shared with every other reader via listRuntimeHelperStatusPaths.
function listAppRuntimeHelperStatusPaths(multiAuthDir: string): string[] {
	let entries: string[] = [];
	try {
		entries = readdirSync(multiAuthDir);
	} catch {
		entries = [];
	}
	return listRuntimeHelperStatusPaths(multiAuthDir, entries);
}

export function readAppRuntimeHelperStatus(
	now: number = Date.now(),
): AppRuntimeHelperAccountStatus | null {
	const statuses = listAppRuntimeHelperStatusPaths(getCodexMultiAuthDir())
		.map(readAppRuntimeHelperStatusFile)
		.filter(
			(status): status is AppRuntimeHelperAccountStatus =>
				status !== null && status.kind === APP_RUNTIME_HELPER_KIND,
		);
	// Selection is shared with `rotation status` so the helper named on the
	// status line and the helper whose account is marked `current` can never be
	// two different helpers (#667).
	return selectRuntimeHelperStatus(statuses, now);
}

export function appRuntimeHelperStatusToSignal(
	status: AppRuntimeHelperAccountStatus | null,
	now: number = Date.now(),
): RuntimeAccountSignal | null {
	if (!status) return null;
	if (status.kind !== APP_RUNTIME_HELPER_KIND) return null;
	if (!isLiveRuntimeHelper(status, now)) return null;
	return {
		source: "app-helper",
		lastAccountIndex: status.lastAccountIndex,
		lastAccountId: status.lastAccountId,
		lastAccountEmail: status.lastAccountEmail,
		lastAccountLabel: status.lastAccountLabel,
		lastAccountUpdatedAt: status.lastAccountUpdatedAt,
		updatedAt: status.updatedAt,
	};
}

export function readAppRuntimeHelperAccountSignal(): RuntimeAccountSignal | null {
	// One `now` for both the selection and the liveness verdict, so a helper
	// cannot be selected against one instant and judged against another.
	const now = Date.now();
	return appRuntimeHelperStatusToSignal(readAppRuntimeHelperStatus(now), now);
}

function runtimeSnapshotToSignal(
	snapshot: RuntimeObservabilitySnapshot | null | undefined,
): RuntimeAccountSignal | null {
	if (!snapshot) return null;
	return {
		source: "runtime-observability",
		lastAccountIndex: snapshot.lastAccountIndex ?? null,
		lastAccountId: snapshot.lastAccountId ?? null,
		lastAccountEmail: snapshot.lastAccountEmail ?? null,
		lastAccountLabel: snapshot.lastAccountLabel ?? null,
		lastAccountUpdatedAt: snapshot.lastAccountUpdatedAt ?? null,
		updatedAt: snapshot.updatedAt,
	};
}

function appBindStatusToSignal(
	status: AppBindRouterStatus | null | undefined,
): RuntimeAccountSignal | null {
	if (!status) return null;
	if (status.state !== "running") return null;
	return {
		source: "app-bind",
		lastAccountIndex: status.lastAccountIndex,
		lastAccountId: status.lastAccountId,
		lastAccountEmail: status.lastAccountEmail,
		lastAccountLabel: status.lastAccountLabel,
		lastAccountUpdatedAt: null,
		updatedAt: status.updatedAt,
	};
}

function findUniqueEmailIndex(
	storage: AccountStorageV3,
	email: string,
): number | null {
	let matchIndex: number | null = null;
	for (let index = 0; index < storage.accounts.length; index += 1) {
		const account = storage.accounts[index];
		if (!account || normalizeEmail(account.email) !== email) continue;
		if (matchIndex !== null) return null;
		matchIndex = index;
	}
	return matchIndex;
}

function findUniqueAccountIdIndex(
	storage: AccountStorageV3,
	accountId: string,
): number | null {
	let matchIndex: number | null = null;
	for (let index = 0; index < storage.accounts.length; index += 1) {
		const account = storage.accounts[index];
		if (!account || normalizeAccountId(account.accountId) !== accountId) {
			continue;
		}
		if (matchIndex !== null) return null;
		matchIndex = index;
	}
	return matchIndex;
}

function matchSignalToAccount(
	storage: AccountStorageV3,
	signal: RuntimeAccountSignal,
): { index: number; matchedBy: RuntimeCurrentAccountMatch } | null {
	const accountId = normalizeAccountId(signal.lastAccountId);
	if (accountId) {
		const idIndex = findUniqueAccountIdIndex(storage, accountId);
		if (idIndex !== null) return { index: idIndex, matchedBy: "account-id" };
	}

	const email = normalizeEmail(signal.lastAccountEmail);
	if (email) {
		const emailIndex = findUniqueEmailIndex(storage, email);
		if (emailIndex !== null) return { index: emailIndex, matchedBy: "email" };
	}

	const index = normalizeIndex(signal.lastAccountIndex);
	if (index === null || index >= storage.accounts.length) return null;
	const indexedAccount = storage.accounts[index];
	if (!indexedAccount) return null;

	const indexedAccountId = normalizeAccountId(indexedAccount.accountId);
	if (accountId && indexedAccountId && indexedAccountId !== accountId) {
		return null;
	}
	const indexedEmail = normalizeEmail(indexedAccount.email);
	if (email && indexedEmail && indexedEmail !== email) {
		return null;
	}
	return { index, matchedBy: "index" };
}

export function resolveRuntimeCurrentAccount(
	storage: AccountStorageV3,
	sources: RuntimeCurrentAccountSources,
	options: RuntimeCurrentAccountOptions = {},
): RuntimeCurrentAccountSelection | null {
	if (storage.accounts.length === 0) return null;
	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? RUNTIME_CURRENT_ACCOUNT_MAX_AGE_MS;
	const sourceRank: Record<RuntimeAccountSignal["source"], number> = {
		"runtime-observability": 0,
		"app-bind": 1,
		"app-helper": 2,
	};
	const signals = [
		runtimeSnapshotToSignal(sources.runtimeSnapshot),
		appBindStatusToSignal(sources.appBindStatus),
		sources.appHelperStatus ?? null,
	]
		.filter((signal): signal is RuntimeAccountSignal => signal !== null)
		.map((signal) => ({ signal, updatedAt: normalizeTimestamp(signal) }))
		.filter(
			(item): item is { signal: RuntimeAccountSignal; updatedAt: number } =>
				item.updatedAt !== null &&
				Number.isFinite(item.updatedAt) &&
				now - item.updatedAt <= maxAgeMs,
		)
		.sort(
			(left, right) =>
				right.updatedAt - left.updatedAt ||
				sourceRank[left.signal.source] - sourceRank[right.signal.source],
		);

	for (const { signal, updatedAt } of signals) {
		const match = matchSignalToAccount(storage, signal);
		if (!match) continue;
		return {
			...match,
			source: signal.source,
			updatedAt,
			...(normalizeAccountId(signal.lastAccountId)
				? { lastAccountId: normalizeAccountId(signal.lastAccountId) ?? undefined }
				: {}),
			...(normalizeEmail(signal.lastAccountEmail)
				? { lastAccountEmail: normalizeEmail(signal.lastAccountEmail) ?? undefined }
				: {}),
			...(normalizeString(signal.lastAccountLabel)
				? { lastAccountLabel: normalizeString(signal.lastAccountLabel) ?? undefined }
				: {}),
		};
	}

	return null;
}

export function resolveAccountCurrentMarkers(
	index: number,
	storedCurrentIndex: number,
	runtimeCurrent: RuntimeCurrentAccountSelection | null,
): AccountCurrentMarker[] {
	if (!runtimeCurrent) {
		return index === storedCurrentIndex ? ["current"] : [];
	}
	if (runtimeCurrent.index === storedCurrentIndex) {
		return index === storedCurrentIndex ? ["current"] : [];
	}
	const markers: AccountCurrentMarker[] = [];
	if (index === runtimeCurrent.index) markers.push("in-use");
	if (index === storedCurrentIndex) markers.push("selected");
	return markers;
}

export function isDisplayCurrentAccount(
	index: number,
	storedCurrentIndex: number,
	runtimeCurrent: RuntimeCurrentAccountSelection | null,
): boolean {
	return runtimeCurrent ? index === runtimeCurrent.index : index === storedCurrentIndex;
}
