import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { RuntimeObservabilitySnapshot } from "./runtime-observability.js";
import type { AppBindRouterStatus } from "./app-bind.js";
import { APP_RUNTIME_HELPER_STATUS_FILE } from "../runtime-constants.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import type { AccountStorageV3 } from "../storage.js";
import { isRecord } from "../utils.js";

export type RuntimeCurrentAccountSource =
	| "runtime-observability"
	| "app-bind"
	| "app-helper";

export type RuntimeCurrentAccountMatch = "account-id" | "email" | "index";

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

export const RUNTIME_CURRENT_ACCOUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APP_RUNTIME_HELPER_KIND = "codex-app-runtime-rotation-helper";
const MAX_STATUS_FILE_BYTES = 1024 * 1024; // 1 MB sanity cap

export interface AppRuntimeHelperAccountStatus {
	kind: string | null;
	state: string | null;
	pid: number | null;
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

// Best-effort liveness probe: process.kill(pid, 0) can report permission
// failures for live processes and cannot protect against rare PID reuse.
function isProcessAlive(pid: number | null): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		return code === "EPERM";
	}
}

export function readAppRuntimeHelperStatus(): AppRuntimeHelperAccountStatus | null {
	const statusPath = join(getCodexMultiAuthDir(), APP_RUNTIME_HELPER_STATUS_FILE);
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
			pid: readOptionalNumber(parsed, "pid"),
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

export function appRuntimeHelperStatusToSignal(
	status: AppRuntimeHelperAccountStatus | null,
): RuntimeAccountSignal | null {
	if (!status) return null;
	if (status.kind !== APP_RUNTIME_HELPER_KIND) return null;
	if (status.state !== "running") return null;
	if (!isProcessAlive(status.pid)) return null;
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
	return appRuntimeHelperStatusToSignal(readAppRuntimeHelperStatus());
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
