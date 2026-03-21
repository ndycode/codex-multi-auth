import { existsSync, promises as fs } from "node:fs";
import { ACCOUNT_LIMITS } from "../constants.js";
import { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } from "../dashboard-settings.js";
import {
	evaluateForecastAccounts,
	isHardRefreshFailure,
	recommendForecastAccount,
} from "../forecast.js";
import {
	extractAccountEmail,
	extractAccountId,
	formatAccountLabel,
	sanitizeEmail,
} from "../accounts.js";
import { loadQuotaCache, saveQuotaCache, type QuotaCacheData } from "../quota-cache.js";
import { fetchCodexQuotaSnapshot } from "../quota-probe.js";
import { queuedRefresh } from "../refresh-queue.js";
import {
	findMatchingAccountIndex,
	getStoragePath,
	loadAccounts,
	loadFlaggedAccounts,
	setStoragePath,
	withAccountStorageTransaction,
	withAccountAndFlaggedStorageTransaction,
	withFlaggedStorageTransaction,
	type AccountMetadataV3,
	type AccountStorageV3,
	type FlaggedAccountMetadataV1,
	type FlaggedAccountStorageV1,
} from "../storage.js";
import {
	getCodexCliAuthPath,
	getCodexCliConfigPath,
	loadCodexCliState,
} from "../codex-cli/state.js";
import { setCodexCliActiveSelection } from "../codex-cli/writer.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import type { AccountIdSource, TokenFailure, TokenResult } from "../types.js";

type TokenSuccess = Extract<TokenResult, { type: "success" }>;
type PromptTone = "accent" | "success" | "warning" | "danger" | "muted";

type QuotaEmailFallbackState = {
	matchingCount: number;
	distinctAccountIds: Set<string>;
};

type QuotaCacheAccountRef = Pick<AccountMetadataV3, "accountId"> & {
	email?: string;
};

type ParsedArgsResult<T> = { ok: true; options: T } | { ok: false; message: string };

type AccountIdentityResolution = {
	accountId?: string;
	accountIdSource?: AccountIdSource;
};

export interface FixCliOptions {
	dryRun: boolean;
	json: boolean;
	live: boolean;
	model: string;
}

export interface VerifyFlaggedCliOptions {
	dryRun: boolean;
	json: boolean;
	restore: boolean;
}

export interface DoctorCliOptions {
	json: boolean;
	fix: boolean;
	dryRun: boolean;
}

export interface RepairCommandDeps {
	stylePromptText: (text: string, tone: PromptTone) => string;
	styleAccountDetailText: (detail: string, fallbackTone?: PromptTone) => string;
	formatResultSummary: (
		segments: ReadonlyArray<{ text: string; tone: PromptTone }>,
	) => string;
	resolveActiveIndex: (
		storage: AccountStorageV3,
		family?: ModelFamily,
	) => number;
	hasUsableAccessToken: (
		account: AccountMetadataV3,
		now: number,
	) => boolean;
	hasLikelyInvalidRefreshToken: (refreshToken: string | undefined) => boolean;
	normalizeFailureDetail: (
		message: string | undefined,
		reason: string | undefined,
	) => string;
	buildQuotaEmailFallbackState: (
		accounts: readonly QuotaCacheAccountRef[],
	) => ReadonlyMap<string, QuotaEmailFallbackState>;
	updateQuotaCacheForAccount: (
		cache: QuotaCacheData,
		account: QuotaCacheAccountRef,
		snapshot: Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>,
		accounts: readonly QuotaCacheAccountRef[],
		emailFallbackState?: ReadonlyMap<string, QuotaEmailFallbackState>,
	) => boolean;
	cloneQuotaCacheData: (cache: QuotaCacheData) => QuotaCacheData;
	pruneUnsafeQuotaEmailCacheEntry: (
		cache: QuotaCacheData,
		previousEmail: string | undefined,
		accounts: readonly QuotaCacheAccountRef[],
		emailFallbackState: ReadonlyMap<string, QuotaEmailFallbackState>,
	) => boolean;
	formatCompactQuotaSnapshot: (
		snapshot: Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>,
	) => string;
	resolveStoredAccountIdentity: (
		storedAccountId: string | undefined,
		storedAccountIdSource: AccountIdSource | undefined,
		refreshedAccountId: string | undefined,
	) => AccountIdentityResolution;
	applyTokenAccountIdentity: (
		account: AccountMetadataV3,
		refreshedAccountId: string | undefined,
	) => boolean;
}

export function printFixUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth fix [--dry-run] [--json] [--live] [--model <model>]",
			"",
			"Options:",
			"  --dry-run, -n      Preview changes without writing storage",
			"  --json, -j         Print machine-readable JSON output",
			"  --live, -l         Run live session probe before deciding health",
			"  --model, -m        Probe model for live mode (default: gpt-5-codex)",
			"",
			"Behavior:",
			"  - Refreshes tokens for enabled accounts",
			"  - Disables hard-failed accounts (never deletes)",
			"  - Recommends a better current account when needed",
		].join("\n"),
	);
}

export function printVerifyFlaggedUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth verify-flagged [--dry-run] [--json] [--no-restore]",
			"",
			"Options:",
			"  --dry-run, -n      Preview changes without writing storage",
			"  --json, -j         Print machine-readable JSON output",
			"  --no-restore       Check flagged accounts without restoring healthy ones",
			"",
			"Behavior:",
			"  - Refresh-checks accounts from flagged storage",
			"  - Restores healthy accounts back to active storage by default",
		].join("\n"),
	);
}

export function printDoctorUsage(): void {
	console.log(
		[
			"Usage:",
			"  codex auth doctor [--json] [--fix] [--dry-run]",
			"",
			"Options:",
			"  --json, -j         Print machine-readable JSON diagnostics",
			"  --fix              Apply safe auto-fixes to storage",
			"  --dry-run, -n      Preview --fix changes without writing storage",
			"",
			"Behavior:",
			"  - Validates account storage readability",
			"  - Checks active index consistency and account duplication",
			"  - Flags placeholder/demo accounts and disabled-all scenarios",
		].join("\n"),
	);
}

export function parseFixArgs(args: string[]): ParsedArgsResult<FixCliOptions> {
	const options: FixCliOptions = {
		dryRun: false,
		json: false,
		live: false,
		model: "gpt-5-codex",
	};

	for (let i = 0; i < args.length; i += 1) {
		const argValue = args[i];
		if (typeof argValue !== "string") continue;
		if (argValue === "--dry-run" || argValue === "-n") {
			options.dryRun = true;
			continue;
		}
		if (argValue === "--json" || argValue === "-j") {
			options.json = true;
			continue;
		}
		if (argValue === "--live" || argValue === "-l") {
			options.live = true;
			continue;
		}
		if (argValue === "--model" || argValue === "-m") {
			const value = args[i + 1];
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			i += 1;
			continue;
		}
		if (argValue.startsWith("--model=")) {
			const value = argValue.slice("--model=".length).trim();
			if (!value) {
				return { ok: false, message: "Missing value for --model" };
			}
			options.model = value;
			continue;
		}
		return { ok: false, message: `Unknown option: ${argValue}` };
	}

	return { ok: true, options };
}

export function parseVerifyFlaggedArgs(
	args: string[],
): ParsedArgsResult<VerifyFlaggedCliOptions> {
	const options: VerifyFlaggedCliOptions = {
		dryRun: false,
		json: false,
		restore: true,
	};

	for (const arg of args) {
		if (arg === "--dry-run" || arg === "-n") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--no-restore") {
			options.restore = false;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}

	return { ok: true, options };
}

export function parseDoctorArgs(
	args: string[],
): ParsedArgsResult<DoctorCliOptions> {
	const options: DoctorCliOptions = { json: false, fix: false, dryRun: false };
	for (const arg of args) {
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--fix") {
			options.fix = true;
			continue;
		}
		if (arg === "--dry-run" || arg === "-n") {
			options.dryRun = true;
			continue;
		}
		return { ok: false, message: `Unknown option: ${arg}` };
	}
	if (options.dryRun && !options.fix) {
		return { ok: false, message: "--dry-run requires --fix" };
	}
	return { ok: true, options };
}

type FixOutcome =
	| "healthy"
	| "disabled-hard-failure"
	| "warning-soft-failure"
	| "already-disabled";

interface FixAccountReport {
	index: number;
	label: string;
	outcome: FixOutcome;
	message: string;
}

function summarizeFixReports(
	reports: FixAccountReport[],
): {
	healthy: number;
	disabled: number;
	warnings: number;
	skipped: number;
} {
	let healthy = 0;
	let disabled = 0;
	let warnings = 0;
	let skipped = 0;
	for (const report of reports) {
		if (report.outcome === "healthy") healthy += 1;
		else if (report.outcome === "disabled-hard-failure") disabled += 1;
		else if (report.outcome === "warning-soft-failure") warnings += 1;
		else skipped += 1;
	}
	return { healthy, disabled, warnings, skipped };
}

interface VerifyFlaggedReport {
	index: number;
	label: string;
	outcome: "restored" | "healthy-flagged" | "still-flagged" | "restore-skipped";
	message: string;
}

function createEmptyAccountStorage(): AccountStorageV3 {
	const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
	for (const family of MODEL_FAMILIES) {
		activeIndexByFamily[family] = 0;
	}
	return {
		version: 3,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily,
	};
}

type AccountStorageMutation = {
	before: AccountMetadataV3;
	after: AccountMetadataV3;
};

type FlaggedStorageMutation = {
	before: FlaggedAccountMetadataV1;
	after?: FlaggedAccountMetadataV1;
};

function hasAccountStorageMutation(
	before: AccountMetadataV3,
	after: AccountMetadataV3,
): boolean {
	return (
		before.refreshToken !== after.refreshToken
		|| before.accessToken !== after.accessToken
		|| before.expiresAt !== after.expiresAt
		|| before.email !== after.email
		|| before.accountId !== after.accountId
		|| before.accountIdSource !== after.accountIdSource
		|| before.enabled !== after.enabled
	);
}

function collectAccountStorageMutations(
	beforeAccounts: readonly AccountMetadataV3[],
	afterAccounts: readonly AccountMetadataV3[],
): AccountStorageMutation[] {
	const mutations: AccountStorageMutation[] = [];
	for (let i = 0; i < afterAccounts.length; i += 1) {
		const before = beforeAccounts[i];
		const after = afterAccounts[i];
		if (!before || !after) continue;
		if (!hasAccountStorageMutation(before, after)) continue;
		mutations.push({
			before: structuredClone(before),
			after: structuredClone(after),
		});
	}
	return mutations;
}

function applyAccountStorageMutations(
	storage: AccountStorageV3,
	mutations: readonly AccountStorageMutation[],
): void {
	for (const mutation of mutations) {
		const targetIndex =
			findMatchingAccountIndex(storage.accounts, mutation.before, {
				allowUniqueAccountIdFallbackWithoutEmail: true,
			})
			?? findMatchingAccountIndex(storage.accounts, mutation.after, {
				allowUniqueAccountIdFallbackWithoutEmail: true,
			});
		if (targetIndex === undefined) continue;
		const target = storage.accounts[targetIndex];
		if (!target) continue;
		target.refreshToken = mutation.after.refreshToken;
		target.accessToken = mutation.after.accessToken;
		target.expiresAt = mutation.after.expiresAt;
		target.email = mutation.after.email;
		target.accountId = mutation.after.accountId;
		target.accountIdSource = mutation.after.accountIdSource;
		target.enabled = mutation.after.enabled;
	}
}

function findExistingAccountIndexForFlagged(
	storage: AccountStorageV3,
	flagged: FlaggedAccountMetadataV1,
	nextRefreshToken: string,
	nextAccountId: string | undefined,
	nextEmail: string | undefined,
): number {
	const flaggedEmail = sanitizeEmail(flagged.email);
	const candidateAccountId = nextAccountId ?? flagged.accountId;
	const candidateEmail = sanitizeEmail(nextEmail) ?? flaggedEmail;
	const nextMatchIndex = findMatchingAccountIndex(storage.accounts, {
		accountId: candidateAccountId,
		email: candidateEmail,
		refreshToken: nextRefreshToken,
	}, {
		allowUniqueAccountIdFallbackWithoutEmail: true,
	});
	if (nextMatchIndex !== undefined) {
		return nextMatchIndex;
	}

	const flaggedMatchIndex = findMatchingAccountIndex(storage.accounts, {
		accountId: candidateAccountId,
		email: candidateEmail,
		refreshToken: flagged.refreshToken,
	}, {
		allowUniqueAccountIdFallbackWithoutEmail: true,
	});
	return flaggedMatchIndex ?? -1;
}

function findMatchingFlaggedAccountIndex(
	accounts: readonly FlaggedAccountMetadataV1[],
	target: FlaggedAccountMetadataV1,
): number {
	const targetEmail = sanitizeEmail(target.email);
	return accounts.findIndex((account) => {
		if (account.refreshToken === target.refreshToken) {
			return true;
		}
		if (target.accountId && account.accountId === target.accountId) {
			if (!targetEmail) {
				return true;
			}
			return sanitizeEmail(account.email) === targetEmail;
		}
		return Boolean(targetEmail) && sanitizeEmail(account.email) === targetEmail;
	});
}

function applyFlaggedStorageMutations(
	flaggedStorage: FlaggedAccountStorageV1,
	mutations: readonly FlaggedStorageMutation[],
): void {
	for (const mutation of mutations) {
		const targetIndex = findMatchingFlaggedAccountIndex(
			flaggedStorage.accounts,
			mutation.before,
		);
		if (targetIndex < 0) {
			continue;
		}
		if (mutation.after) {
			flaggedStorage.accounts[targetIndex] = structuredClone(mutation.after);
			continue;
		}
		flaggedStorage.accounts.splice(targetIndex, 1);
	}
}

function upsertRecoveredFlaggedAccount(
	storage: AccountStorageV3,
	flagged: FlaggedAccountMetadataV1,
	refreshResult: TokenSuccess,
	now: number,
	deps: Pick<RepairCommandDeps, "resolveStoredAccountIdentity">,
): { restored: boolean; changed: boolean; message: string } {
	const nextEmail =
		sanitizeEmail(extractAccountEmail(refreshResult.access, refreshResult.idToken))
		?? flagged.email;
	const tokenAccountId = extractAccountId(refreshResult.access);
	const { accountId: nextAccountId, accountIdSource: nextAccountIdSource } =
		deps.resolveStoredAccountIdentity(
			flagged.accountId,
			flagged.accountIdSource,
			tokenAccountId,
		);
	const existingIndex = findExistingAccountIndexForFlagged(
		storage,
		flagged,
		refreshResult.refresh,
		nextAccountId,
		nextEmail,
	);

	if (existingIndex >= 0) {
		const existing = storage.accounts[existingIndex];
		if (!existing) {
			return { restored: false, changed: false, message: "existing account entry is missing" };
		}
		let changed = false;
		if (existing.refreshToken !== refreshResult.refresh) {
			existing.refreshToken = refreshResult.refresh;
			changed = true;
		}
		if (existing.accessToken !== refreshResult.access) {
			existing.accessToken = refreshResult.access;
			changed = true;
		}
		if (existing.expiresAt !== refreshResult.expires) {
			existing.expiresAt = refreshResult.expires;
			changed = true;
		}
		if (nextEmail && nextEmail !== existing.email) {
			existing.email = nextEmail;
			changed = true;
		}
		if (
			nextAccountId !== undefined
			&& (
				nextAccountId !== existing.accountId
				|| nextAccountIdSource !== existing.accountIdSource
			)
		) {
			existing.accountId = nextAccountId;
			existing.accountIdSource = nextAccountIdSource;
			changed = true;
		}
		if (existing.enabled === false) {
			existing.enabled = true;
			changed = true;
		}
		if (existing.accountLabel !== flagged.accountLabel && flagged.accountLabel) {
			existing.accountLabel = flagged.accountLabel;
			changed = true;
		}
		existing.lastUsed = now;
		return {
			restored: true,
			changed,
			message: `restored into existing account ${existingIndex + 1}`,
		};
	}

	if (storage.accounts.length >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
		return {
			restored: false,
			changed: false,
			message: `cannot restore (max ${ACCOUNT_LIMITS.MAX_ACCOUNTS} accounts reached)`,
		};
	}

	storage.accounts.push({
		refreshToken: refreshResult.refresh,
		accessToken: refreshResult.access,
		expiresAt: refreshResult.expires,
		accountId: nextAccountId,
		accountIdSource: nextAccountIdSource,
		accountLabel: flagged.accountLabel,
		email: nextEmail,
		addedAt: flagged.addedAt ?? now,
		lastUsed: now,
		enabled: true,
	});
	return {
		restored: true,
		changed: true,
		message: `restored as account ${storage.accounts.length}`,
	};
}

type DoctorSeverity = "ok" | "warn" | "error";

interface DoctorCheck {
	key: string;
	severity: DoctorSeverity;
	message: string;
	details?: string;
}

interface DoctorFixAction {
	key: string;
	message: string;
}

type DoctorRefreshMutation = {
	match: AccountMetadataV3;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	email?: string;
	accountId?: string;
};

function maskDoctorEmail(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const email = value.trim();
	const atIndex = email.indexOf("@");
	if (atIndex < 0) return "***@***";
	const local = email.slice(0, atIndex);
	const domain = email.slice(atIndex + 1);
	const parts = domain.split(".");
	const tld = parts.pop() || "";
	const prefix = local.slice(0, Math.min(2, local.length));
	return `${prefix}***@***.${tld}`;
}

function redactDoctorIdentifier(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const identifier = value.trim();
	if (!identifier) return undefined;
	if (identifier.includes("@")) {
		return maskDoctorEmail(identifier);
	}
	if (identifier.length <= 8) {
		return "***";
	}
	return `${identifier.slice(0, 4)}***${identifier.slice(-3)}`;
}

function formatDoctorIdentitySummary(identity: {
	email?: string;
	accountId?: string;
}): string {
	const parts: string[] = [];
	const maskedEmail = maskDoctorEmail(identity.email);
	const maskedAccountId = redactDoctorIdentifier(identity.accountId);
	if (maskedEmail) {
		parts.push(`email=${maskedEmail}`);
	}
	if (maskedAccountId) {
		parts.push(`accountId=${maskedAccountId}`);
	}
	return parts.join(", ") || "unknown";
}

function hasPlaceholderEmail(value: string | undefined): boolean {
	if (!value) return false;
	const email = value.trim().toLowerCase();
	if (!email) return false;
	return (
		email.endsWith("@example.com")
		|| email.includes("account1@example.com")
		|| email.includes("account2@example.com")
		|| email.includes("account3@example.com")
	);
}

function normalizeDoctorIndexes(storage: AccountStorageV3): boolean {
	const total = storage.accounts.length;
	const nextActive = total === 0 ? 0 : Math.max(0, Math.min(storage.activeIndex, total - 1));
	let changed = false;
	if (storage.activeIndex !== nextActive) {
		storage.activeIndex = nextActive;
		changed = true;
	}
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of MODEL_FAMILIES) {
		const raw = storage.activeIndexByFamily[family];
		const fallback = storage.activeIndex;
		const candidate = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
		const clamped = total === 0 ? 0 : Math.max(0, Math.min(candidate, total - 1));
		if (storage.activeIndexByFamily[family] !== clamped) {
			storage.activeIndexByFamily[family] = clamped;
			changed = true;
		}
	}
	return changed;
}

function getDoctorRefreshTokenKey(refreshToken: unknown): string | undefined {
	if (typeof refreshToken !== "string") return undefined;
	const trimmed = refreshToken.trim();
	return trimmed || undefined;
}

function applyDoctorFixes(
	storage: AccountStorageV3,
	deps: Pick<RepairCommandDeps, "resolveActiveIndex">,
): { changed: boolean; actions: DoctorFixAction[] } {
	let changed = false;
	const actions: DoctorFixAction[] = [];

	if (normalizeDoctorIndexes(storage)) {
		changed = true;
		actions.push({
			key: "active-index",
			message: "Normalized active account indexes",
		});
	}

	const seenRefreshTokens = new Map<string, number>();
	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;

		const refreshToken = getDoctorRefreshTokenKey(account.refreshToken);
		if (!refreshToken) continue;
		const existingTokenIndex = seenRefreshTokens.get(refreshToken);
		if (typeof existingTokenIndex === "number") {
			if (account.enabled !== false) {
				account.enabled = false;
				changed = true;
				actions.push({
					key: "duplicate-refresh-token",
					message: `Disabled duplicate token entry on account ${i + 1} (kept account ${existingTokenIndex + 1})`,
				});
			}
		} else {
			seenRefreshTokens.set(refreshToken, i);
		}

		const tokenEmail = sanitizeEmail(extractAccountEmail(account.accessToken));
		if (tokenEmail && (!sanitizeEmail(account.email) || hasPlaceholderEmail(account.email))) {
			account.email = tokenEmail;
			changed = true;
			actions.push({
				key: "email-from-token",
				message: `Updated account ${i + 1} email from token claims`,
			});
		}

		const tokenAccountId = extractAccountId(account.accessToken);
		if (!account.accountId && tokenAccountId) {
			account.accountId = tokenAccountId;
			account.accountIdSource = "token";
			changed = true;
			actions.push({
				key: "account-id-from-token",
				message: `Filled missing accountId for account ${i + 1}`,
			});
		}
	}

	const enabledCount = storage.accounts.filter((account) => account.enabled !== false).length;
	if (storage.accounts.length > 0 && enabledCount === 0) {
		const index = deps.resolveActiveIndex(storage, "codex");
		const candidate = storage.accounts[index] ?? storage.accounts[0];
		if (candidate) {
			candidate.enabled = true;
			changed = true;
			actions.push({
				key: "enabled-accounts",
				message: `Re-enabled account ${index + 1} to avoid an all-disabled pool`,
			});
		}
	}

	if (normalizeDoctorIndexes(storage)) {
		changed = true;
	}

	return { changed, actions };
}

export async function runVerifyFlagged(
	args: string[],
	deps: RepairCommandDeps,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printVerifyFlaggedUsage();
		return 0;
	}

	const parsedArgs = parseVerifyFlaggedArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printVerifyFlaggedUsage();
		return 1;
	}
	const options = parsedArgs.options;

	setStoragePath(null);
	const flaggedStorage = await loadFlaggedAccounts();
	if (flaggedStorage.accounts.length === 0) {
		if (options.json) {
			console.log(
				JSON.stringify(
					{
						command: "verify-flagged",
						total: 0,
						restored: 0,
						healthyFlagged: 0,
						stillFlagged: 0,
						remainingFlagged: 0,
						changed: false,
						dryRun: options.dryRun,
						restore: options.restore,
						reports: [] as VerifyFlaggedReport[],
					},
					null,
					2,
				),
			);
			return 0;
		}
		console.log("No flagged accounts to check.");
		return 0;
	}

	let storageChanged = false;
	let flaggedChanged = false;
	const reports: VerifyFlaggedReport[] = [];
	const nextFlaggedAccounts: FlaggedAccountMetadataV1[] = [];
	const flaggedMutations: FlaggedStorageMutation[] = [];
	const now = Date.now();
	const collectRefreshChecks = async (
		accounts: FlaggedAccountMetadataV1[],
	): Promise<
		Array<{
			index: number;
			flagged: FlaggedAccountMetadataV1;
			label: string;
			result: Awaited<ReturnType<typeof queuedRefresh>>;
		}>
	> => {
		const refreshChecks: Array<{
			index: number;
			flagged: FlaggedAccountMetadataV1;
			label: string;
			result: Awaited<ReturnType<typeof queuedRefresh>>;
		}> = [];
		for (let i = 0; i < accounts.length; i += 1) {
			const flagged = accounts[i];
			if (!flagged) continue;
			refreshChecks.push({
				index: i,
				flagged,
				label: formatAccountLabel(flagged, i),
				result: await queuedRefresh(flagged.refreshToken),
			});
		}
		return refreshChecks;
	};
	const applyRefreshChecks = (
		storage: AccountStorageV3,
		refreshChecks: Array<{
		index: number;
		flagged: FlaggedAccountMetadataV1;
		label: string;
		result: Awaited<ReturnType<typeof queuedRefresh>>;
		}>,
	): void => {
		for (const check of refreshChecks) {
			const { index: i, flagged, label, result } = check;
			if (result.type === "success") {
				if (!options.restore) {
					const tokenAccountId = extractAccountId(result.access);
					const nextIdentity = deps.resolveStoredAccountIdentity(
						flagged.accountId,
						flagged.accountIdSource,
						tokenAccountId,
					);
					const nextFlagged: FlaggedAccountMetadataV1 = {
						...flagged,
						refreshToken: result.refresh,
						accessToken: result.access,
						expiresAt: result.expires,
						accountId: nextIdentity.accountId,
						accountIdSource: nextIdentity.accountIdSource,
						email:
							sanitizeEmail(extractAccountEmail(result.access, result.idToken))
							?? flagged.email,
						lastUsed: now,
						lastError: undefined,
					};
					nextFlaggedAccounts.push(nextFlagged);
					if (JSON.stringify(nextFlagged) !== JSON.stringify(flagged)) {
						flaggedChanged = true;
					}
					flaggedMutations.push({
						before: flagged,
						after: nextFlagged,
					});
					reports.push({
						index: i,
						label,
						outcome: "healthy-flagged",
						message: "session is healthy (left in flagged list due to --no-restore)",
					});
					continue;
				}

				const upsertResult = upsertRecoveredFlaggedAccount(
					storage,
					flagged,
					result,
					now,
					deps,
				);
				if (upsertResult.restored) {
					storageChanged = storageChanged || upsertResult.changed;
					flaggedChanged = true;
					flaggedMutations.push({
						before: flagged,
					});
					reports.push({
						index: i,
						label,
						outcome: "restored",
						message: upsertResult.message,
					});
					continue;
				}

				const tokenAccountId = extractAccountId(result.access);
				const nextIdentity = deps.resolveStoredAccountIdentity(
					flagged.accountId,
					flagged.accountIdSource,
					tokenAccountId,
				);
				const updatedFlagged: FlaggedAccountMetadataV1 = {
					...flagged,
					refreshToken: result.refresh,
					accessToken: result.access,
					expiresAt: result.expires,
					accountId: nextIdentity.accountId,
					accountIdSource: nextIdentity.accountIdSource,
					email:
						sanitizeEmail(extractAccountEmail(result.access, result.idToken))
						?? flagged.email,
					lastUsed: now,
					lastError: upsertResult.message,
				};
				nextFlaggedAccounts.push(updatedFlagged);
				if (JSON.stringify(updatedFlagged) !== JSON.stringify(flagged)) {
					flaggedChanged = true;
				}
				flaggedMutations.push({
					before: flagged,
					after: updatedFlagged,
				});
				reports.push({
					index: i,
					label,
					outcome: "restore-skipped",
					message: upsertResult.message,
				});
				continue;
			}

			const detail = deps.normalizeFailureDetail(result.message, result.reason);
			const failedFlagged: FlaggedAccountMetadataV1 = {
				...flagged,
				lastError: detail,
			};
			nextFlaggedAccounts.push(failedFlagged);
			if ((flagged.lastError ?? "") !== detail) {
				flaggedChanged = true;
			}
			flaggedMutations.push({
				before: flagged,
				after: failedFlagged,
			});
			reports.push({
				index: i,
				label,
				outcome: "still-flagged",
				message: detail,
			});
		}
	};

	let remainingFlagged = 0;
	const refreshChecks = await collectRefreshChecks(flaggedStorage.accounts);

	if (options.restore) {
		if (options.dryRun) {
			applyRefreshChecks(
				(await loadAccounts()) ?? createEmptyAccountStorage(),
				refreshChecks,
			);
		} else {
			await withAccountAndFlaggedStorageTransaction(
				async (loadedStorage, persist, loadedFlaggedStorage) => {
					const nextStorage = loadedStorage
						? structuredClone(loadedStorage)
						: createEmptyAccountStorage();
					const nextFlaggedStorage = structuredClone(loadedFlaggedStorage);
					applyRefreshChecks(nextStorage, refreshChecks);
					applyFlaggedStorageMutations(nextFlaggedStorage, flaggedMutations);
					remainingFlagged = nextFlaggedStorage.accounts.length;
					if (!storageChanged && !flaggedChanged) {
						return;
					}
					if (storageChanged) {
						normalizeDoctorIndexes(nextStorage);
					}
					await persist(nextStorage, nextFlaggedStorage);
				},
			);
		}
	} else {
		applyRefreshChecks(createEmptyAccountStorage(), refreshChecks);
		remainingFlagged = nextFlaggedAccounts.length;
	}

	if (options.dryRun) {
		remainingFlagged = nextFlaggedAccounts.length;
	}

	const restored = reports.filter((report) => report.outcome === "restored").length;
	const healthyFlagged = reports.filter(
		(report) => report.outcome === "healthy-flagged",
	).length;
	const stillFlagged = reports.filter(
		(report) => report.outcome === "still-flagged",
	).length;
	const changed = storageChanged || flaggedChanged;

	if (!options.dryRun && !options.restore && flaggedChanged) {
		await withFlaggedStorageTransaction(async (loadedFlaggedStorage, persist) => {
			const nextFlaggedStorage = structuredClone(loadedFlaggedStorage);
			applyFlaggedStorageMutations(nextFlaggedStorage, flaggedMutations);
			remainingFlagged = nextFlaggedStorage.accounts.length;
			await persist(nextFlaggedStorage);
		});
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					command: "verify-flagged",
					total: flaggedStorage.accounts.length,
					restored,
					healthyFlagged,
					stillFlagged,
					remainingFlagged,
					changed,
					dryRun: options.dryRun,
					restore: options.restore,
					reports,
				},
				null,
				2,
			),
		);
		return 0;
	}

	console.log(
		deps.stylePromptText(
			`Checking ${flaggedStorage.accounts.length} flagged account(s)...`,
			"accent",
		),
	);
	for (const report of reports) {
		const tone: PromptTone =
			report.outcome === "restored"
				? "success"
				: report.outcome === "healthy-flagged" || report.outcome === "restore-skipped"
					? "warning"
					: "danger";
		const marker =
			report.outcome === "restored"
				? "✓"
				: report.outcome === "healthy-flagged" || report.outcome === "restore-skipped"
					? "!"
					: "✗";
		console.log(
			`${deps.stylePromptText(marker, tone)} ${deps.stylePromptText(`${report.index + 1}. ${report.label}`, "accent")} ${deps.stylePromptText("|", "muted")} ${deps.styleAccountDetailText(report.message, tone)}`,
		);
	}
	console.log("");
	console.log(
		deps.formatResultSummary([
			{ text: `${restored} restored`, tone: restored > 0 ? "success" : "muted" },
			{
				text: `${healthyFlagged} healthy (kept flagged)`,
				tone: healthyFlagged > 0 ? "warning" : "muted",
			},
			{
				text: `${stillFlagged} still flagged`,
				tone: stillFlagged > 0 ? "danger" : "muted",
			},
		]),
	);
	if (options.dryRun) {
		console.log(deps.stylePromptText("Preview only: no changes were saved.", "warning"));
	} else if (!changed) {
		console.log(deps.stylePromptText("No storage changes were needed.", "muted"));
	}

	return 0;
}

export async function runFix(
	args: string[],
	deps: RepairCommandDeps,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printFixUsage();
		return 0;
	}

	const parsedArgs = parseFixArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printFixUsage();
		return 1;
	}
	const options = parsedArgs.options;
	const display = DEFAULT_DASHBOARD_DISPLAY_SETTINGS;
	const quotaCache = options.live ? await loadQuotaCache() : null;
	const workingQuotaCache = quotaCache ? deps.cloneQuotaCacheData(quotaCache) : null;
	let quotaCacheChanged = false;

	setStoragePath(null);
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		if (options.json) {
			console.log(
				JSON.stringify(
					{
						command: "fix",
						dryRun: options.dryRun,
						liveProbe: options.live,
						model: options.model,
						changed: false,
						summary: {
							healthy: 0,
							disabled: 0,
							warnings: 0,
							skipped: 0,
						},
						recommendation: {
							recommendedIndex: null,
							reason: "No accounts configured.",
						},
						recommendedSwitchCommand: null,
						reports: [] as FixAccountReport[],
					},
					null,
					2,
				),
			);
		} else {
			console.log("No accounts configured.");
		}
		return 0;
	}
	const originalAccounts = storage.accounts.map((account) => structuredClone(account));
	let quotaEmailFallbackState =
		options.live && quotaCache
			? deps.buildQuotaEmailFallbackState(storage.accounts)
			: null;

	const now = Date.now();
	const activeIndex = deps.resolveActiveIndex(storage, "codex");
	let accountStorageChanged = false;
	const reports: FixAccountReport[] = [];
	const refreshFailures = new Map<number, TokenFailure>();
	const hardDisabledIndexes: number[] = [];

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		const label = formatAccountLabel(account, i);

		if (account.enabled === false) {
			reports.push({
				index: i,
				label,
				outcome: "already-disabled",
				message: "already disabled",
			});
			continue;
		}

		if (deps.hasUsableAccessToken(account, now)) {
			let refreshAfterLiveProbeFailure = false;
			if (options.live) {
				const currentAccessToken = account.accessToken;
				const probeAccountId = currentAccessToken
					? account.accountId ?? extractAccountId(currentAccessToken)
					: undefined;
				if (probeAccountId && currentAccessToken) {
					try {
						const snapshot = await fetchCodexQuotaSnapshot({
							accountId: probeAccountId,
							accessToken: currentAccessToken,
							model: options.model,
						});
						if (workingQuotaCache) {
							quotaCacheChanged =
								deps.updateQuotaCacheForAccount(
									workingQuotaCache,
									account,
									snapshot,
									storage.accounts,
									quotaEmailFallbackState ?? undefined,
								) || quotaCacheChanged;
						}
						reports.push({
							index: i,
							label,
							outcome: "healthy",
							message: display.showQuotaDetails
								? `live session OK (${deps.formatCompactQuotaSnapshot(snapshot)})`
								: "live session OK",
						});
						continue;
					} catch {
						refreshAfterLiveProbeFailure = true;
					}
				}
			}

			if (!refreshAfterLiveProbeFailure) {
				const refreshWarning = deps.hasLikelyInvalidRefreshToken(account.refreshToken)
					? " (refresh token looks stale; re-login recommended)"
					: "";
				reports.push({
					index: i,
					label,
					outcome: "healthy",
					message: `access token still valid${refreshWarning}`,
				});
				continue;
			}
		}

		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type === "success") {
			const nextEmail = sanitizeEmail(
				extractAccountEmail(refreshResult.access, refreshResult.idToken),
			);
			const nextAccountId = extractAccountId(refreshResult.access);
			const previousEmail = account.email;
			let accountChanged = false;
			let accountIdentityChanged = false;

			if (account.refreshToken !== refreshResult.refresh) {
				account.refreshToken = refreshResult.refresh;
				accountChanged = true;
			}
			if (account.accessToken !== refreshResult.access) {
				account.accessToken = refreshResult.access;
				accountChanged = true;
			}
			if (account.expiresAt !== refreshResult.expires) {
				account.expiresAt = refreshResult.expires;
				accountChanged = true;
			}
			if (nextEmail && nextEmail !== account.email) {
				account.email = nextEmail;
				accountChanged = true;
				accountIdentityChanged = true;
			}
			if (deps.applyTokenAccountIdentity(account, nextAccountId)) {
				accountChanged = true;
				accountIdentityChanged = true;
			}

			if (accountChanged) accountStorageChanged = true;
			if (accountIdentityChanged && options.live && workingQuotaCache) {
				quotaEmailFallbackState = deps.buildQuotaEmailFallbackState(storage.accounts);
				quotaCacheChanged =
					deps.pruneUnsafeQuotaEmailCacheEntry(
						workingQuotaCache,
						previousEmail,
						storage.accounts,
						quotaEmailFallbackState,
					) || quotaCacheChanged;
			}
			if (options.live) {
				const probeAccountId = account.accountId ?? nextAccountId;
				if (probeAccountId) {
					try {
						const snapshot = await fetchCodexQuotaSnapshot({
							accountId: probeAccountId,
							accessToken: refreshResult.access,
							model: options.model,
						});
						if (workingQuotaCache) {
							quotaCacheChanged =
								deps.updateQuotaCacheForAccount(
									workingQuotaCache,
									account,
									snapshot,
									storage.accounts,
									quotaEmailFallbackState ?? undefined,
								) || quotaCacheChanged;
						}
						reports.push({
							index: i,
							label,
							outcome: "healthy",
							message: display.showQuotaDetails
								? `refresh + live probe succeeded (${deps.formatCompactQuotaSnapshot(snapshot)})`
								: "refresh + live probe succeeded",
						});
						continue;
					} catch (error) {
						const message = deps.normalizeFailureDetail(
							error instanceof Error ? error.message : String(error),
							undefined,
						);
						reports.push({
							index: i,
							label,
							outcome: "warning-soft-failure",
							message: `refresh succeeded but live probe failed: ${message}`,
						});
						continue;
					}
				}
			}
			reports.push({
				index: i,
				label,
				outcome: "healthy",
				message: "refresh succeeded",
			});
			continue;
		}

		const detail = deps.normalizeFailureDetail(
			refreshResult.message,
			refreshResult.reason,
		);
		refreshFailures.set(i, {
			...refreshResult,
			message: detail,
		});
		if (isHardRefreshFailure(refreshResult)) {
			account.enabled = false;
			accountStorageChanged = true;
			hardDisabledIndexes.push(i);
			reports.push({
				index: i,
				label,
				outcome: "disabled-hard-failure",
				message: detail,
			});
		} else {
			reports.push({
				index: i,
				label,
				outcome: "warning-soft-failure",
				message: detail,
			});
		}
	}

	if (hardDisabledIndexes.length > 0) {
		const enabledCount = storage.accounts.filter(
			(account) => account.enabled !== false,
		).length;
		if (enabledCount === 0) {
			const fallbackIndex = hardDisabledIndexes.includes(activeIndex)
				? activeIndex
				: hardDisabledIndexes[0];
			const fallback = typeof fallbackIndex === "number"
				? storage.accounts[fallbackIndex]
				: undefined;
			if (fallback && fallback.enabled === false) {
				fallback.enabled = true;
				accountStorageChanged = true;
				const existingReport = reports.find(
					(report) =>
						report.index === fallbackIndex
						&& report.outcome === "disabled-hard-failure",
				);
				if (existingReport) {
					existingReport.outcome = "warning-soft-failure";
					existingReport.message =
						`${existingReport.message} (kept enabled to avoid lockout; re-login required)`;
				}
			}
		}
	}

	const forecastResults = evaluateForecastAccounts(
		storage.accounts.map((account, index) => ({
			index,
			account,
			isCurrent: index === activeIndex,
			now,
			refreshFailure: refreshFailures.get(index),
		})),
	);
	const recommendation = recommendForecastAccount(forecastResults);
	const reportSummary = summarizeFixReports(reports);
	const accountMutations = collectAccountStorageMutations(
		originalAccounts,
		storage.accounts,
	);

	if (accountStorageChanged && !options.dryRun) {
		await withAccountStorageTransaction(async (loadedStorage, persist) => {
			const nextStorage = loadedStorage
				? structuredClone(loadedStorage)
				: createEmptyAccountStorage();
			applyAccountStorageMutations(nextStorage, accountMutations);
			await persist(nextStorage);
		});
	}

	const changed = accountStorageChanged;

	if (options.json) {
		if (!options.dryRun && workingQuotaCache && quotaCacheChanged) {
			await saveQuotaCache(workingQuotaCache);
		}
		console.log(
			JSON.stringify(
				{
					command: "fix",
					dryRun: options.dryRun,
					liveProbe: options.live,
					model: options.model,
					changed,
					quotaCacheChanged,
					summary: reportSummary,
					recommendation,
					recommendedSwitchCommand:
						recommendation.recommendedIndex !== null
						&& recommendation.recommendedIndex !== activeIndex
							? `codex auth switch ${recommendation.recommendedIndex + 1}`
							: null,
					reports,
				},
				null,
				2,
			),
		);
		return 0;
	}

	console.log(
		deps.stylePromptText(
			`Auto-fix scan (${options.dryRun ? "preview" : "apply"})`,
			"accent",
		),
	);
	console.log(
		deps.formatResultSummary([
			{ text: `${reportSummary.healthy} working`, tone: "success" },
			{
				text: `${reportSummary.disabled} disabled`,
				tone: reportSummary.disabled > 0 ? "danger" : "muted",
			},
			{
				text: `${reportSummary.warnings} warning${reportSummary.warnings === 1 ? "" : "s"}`,
				tone: reportSummary.warnings > 0 ? "warning" : "muted",
			},
			{ text: `${reportSummary.skipped} already disabled`, tone: "muted" },
		]),
	);
	if (display.showPerAccountRows) {
		console.log("");
		for (const report of reports) {
			const prefix =
				report.outcome === "healthy"
					? "✓"
					: report.outcome === "disabled-hard-failure"
						? "✗"
						: report.outcome === "warning-soft-failure"
							? "!"
							: "-";
			const tone: PromptTone =
				report.outcome === "healthy"
					? "success"
					: report.outcome === "disabled-hard-failure"
						? "danger"
						: report.outcome === "warning-soft-failure"
							? "warning"
							: "muted";
			console.log(
				`${deps.stylePromptText(prefix, tone)} ${deps.stylePromptText(`${report.index + 1}. ${report.label}`, "accent")} ${deps.stylePromptText("|", "muted")} ${deps.styleAccountDetailText(report.message, tone === "success" ? "muted" : tone)}`,
			);
		}
	} else {
		console.log("");
		console.log(
			deps.stylePromptText(
				"Per-account lines are hidden in dashboard settings.",
				"muted",
			),
		);
	}

	if (display.showRecommendations) {
		console.log("");
		if (recommendation.recommendedIndex !== null) {
			const target = recommendation.recommendedIndex + 1;
			console.log(
				`${deps.stylePromptText("Best next account:", "accent")} ${deps.stylePromptText(String(target), "success")}`,
			);
			console.log(
				`${deps.stylePromptText("Why:", "accent")} ${deps.stylePromptText(recommendation.reason, "muted")}`,
			);
			if (recommendation.recommendedIndex !== activeIndex) {
				console.log(
					`${deps.stylePromptText("Switch now with:", "accent")} codex auth switch ${target}`,
				);
			}
		} else {
			console.log(
				`${deps.stylePromptText("Note:", "accent")} ${deps.stylePromptText(recommendation.reason, "muted")}`,
			);
		}
	}
	if (!options.dryRun && workingQuotaCache && quotaCacheChanged) {
		await saveQuotaCache(workingQuotaCache);
	}

	if (changed && options.dryRun) {
		console.log(`\n${deps.stylePromptText("Preview only: no changes were saved.", "warning")}`);
	} else if (changed) {
		console.log(`\n${deps.stylePromptText("Saved updates.", "success")}`);
	} else {
		console.log(`\n${deps.stylePromptText("No changes were needed.", "muted")}`);
	}

	return 0;
}

export async function runDoctor(
	args: string[],
	deps: RepairCommandDeps,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printDoctorUsage();
		return 0;
	}

	const parsedArgs = parseDoctorArgs(args);
	if (!parsedArgs.ok) {
		console.error(parsedArgs.message);
		printDoctorUsage();
		return 1;
	}
	const options = parsedArgs.options;

	setStoragePath(null);
	const storagePath = getStoragePath();
	const storageFileExists = existsSync(storagePath);
	const checks: DoctorCheck[] = [];
	const addCheck = (check: DoctorCheck): void => {
		checks.push(check);
	};

	addCheck({
		key: "storage-file",
		severity: storageFileExists ? "ok" : "warn",
		message: storageFileExists
			? "Account storage file found"
			: "Account storage file does not exist yet (first login pending)",
		details: storagePath,
	});

	if (storageFileExists) {
		try {
			const stat = await fs.stat(storagePath);
			addCheck({
				key: "storage-readable",
				severity: stat.size > 0 ? "ok" : "warn",
				message: stat.size > 0 ? "Storage file is readable" : "Storage file is empty",
				details: `${stat.size} bytes`,
			});
		} catch (error) {
			addCheck({
				key: "storage-readable",
				severity: "error",
				message: "Unable to read storage file metadata",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const codexAuthPath = getCodexCliAuthPath();
	const codexConfigPath = getCodexCliConfigPath();
	const codexAuthFileExists = existsSync(codexAuthPath);
	const codexConfigFileExists = existsSync(codexConfigPath);
	let codexAuthEmail: string | undefined;
	let codexAuthAccountId: string | undefined;

	addCheck({
		key: "codex-auth-file",
		severity: codexAuthFileExists ? "ok" : "warn",
		message: codexAuthFileExists
			? "Codex auth file found"
			: "Codex auth file does not exist",
		details: codexAuthPath,
	});

	if (codexAuthFileExists) {
		try {
			const raw = await fs.readFile(codexAuthPath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === "object") {
				const payload = parsed as Record<string, unknown>;
				const tokens = payload.tokens && typeof payload.tokens === "object"
					? payload.tokens as Record<string, unknown>
					: null;
				const accessToken = tokens && typeof tokens.access_token === "string"
					? tokens.access_token
					: undefined;
				const idToken = tokens && typeof tokens.id_token === "string"
					? tokens.id_token
					: undefined;
				const accountIdFromFile =
					tokens && typeof tokens.account_id === "string"
						? tokens.account_id
						: undefined;
				const emailFromFile =
					typeof payload.email === "string" ? payload.email : undefined;
				codexAuthEmail = sanitizeEmail(
					emailFromFile ?? extractAccountEmail(accessToken, idToken),
				);
				codexAuthAccountId = accountIdFromFile ?? extractAccountId(accessToken);
			}
			addCheck({
				key: "codex-auth-readable",
				severity: "ok",
				message: "Codex auth file is readable",
				details:
					codexAuthEmail || codexAuthAccountId
						? formatDoctorIdentitySummary({
							email: codexAuthEmail,
							accountId: codexAuthAccountId,
						})
						: undefined,
			});
		} catch (error) {
			addCheck({
				key: "codex-auth-readable",
				severity: "error",
				message: "Unable to read Codex auth file",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}

	addCheck({
		key: "codex-config-file",
		severity: codexConfigFileExists ? "ok" : "warn",
		message: codexConfigFileExists
			? "Codex config file found"
			: "Codex config file does not exist",
		details: codexConfigPath,
	});

	let codexAuthStoreMode: string | undefined;
	if (codexConfigFileExists) {
		try {
			const configRaw = await fs.readFile(codexConfigPath, "utf-8");
			const match = configRaw.match(/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"\s*$/m);
			if (match?.[1]) {
				codexAuthStoreMode = match[1].trim();
			}
		} catch (error) {
			addCheck({
				key: "codex-auth-store",
				severity: "warn",
				message: "Unable to read Codex auth-store config",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (!checks.some((check) => check.key === "codex-auth-store")) {
		addCheck({
			key: "codex-auth-store",
			severity: codexAuthStoreMode === "file" ? "ok" : "warn",
			message:
				codexAuthStoreMode === "file"
					? "Codex auth storage is set to file"
					: "Codex auth storage is not explicitly set to file",
			details: codexAuthStoreMode ? `mode=${codexAuthStoreMode}` : "mode=unset",
		});
	}

	const codexCliState = await loadCodexCliState({ forceRefresh: true });
	addCheck({
		key: "codex-cli-state",
		severity: codexCliState ? "ok" : "warn",
		message: codexCliState
			? "Codex CLI state loaded"
			: "Codex CLI state unavailable",
		details: codexCliState?.path,
	});

	const loadedStorage = await loadAccounts();
	const storage = loadedStorage ? structuredClone(loadedStorage) : loadedStorage;
	let fixChanged = false;
	let storageFixChanged = false;
	let structuralFixActions: DoctorFixAction[] = [];
	const supplementalFixActions: DoctorFixAction[] = [];
	let doctorRefreshMutation: DoctorRefreshMutation | null = null;
	let pendingCodexActiveSync: {
		accountId: string | undefined;
		email: string | undefined;
		accessToken: string | undefined;
		refreshToken: string | undefined;
		expiresAt: number | undefined;
		idToken?: string;
	} | null = null;
	if (options.fix && storage && storage.accounts.length > 0) {
		const fixed = applyDoctorFixes(storage, deps);
		storageFixChanged = fixed.changed;
		structuralFixActions = fixed.actions;
	}
	if (!storage || storage.accounts.length === 0) {
		addCheck({
			key: "accounts",
			severity: "warn",
			message: "No accounts configured",
		});
	} else {
		addCheck({
			key: "accounts",
			severity: "ok",
			message: `Loaded ${storage.accounts.length} account(s)`,
		});

		const activeIndex = deps.resolveActiveIndex(storage, "codex");
		const activeExists = activeIndex >= 0 && activeIndex < storage.accounts.length;
		addCheck({
			key: "active-index",
			severity: activeExists ? "ok" : "error",
			message: activeExists
				? `Active index is valid (${activeIndex + 1})`
				: "Active index is out of range",
		});

		const disabledCount = storage.accounts.filter((a) => a.enabled === false).length;
		addCheck({
			key: "enabled-accounts",
			severity: disabledCount >= storage.accounts.length ? "error" : "ok",
			message:
				disabledCount >= storage.accounts.length
					? "All accounts are disabled"
					: `${storage.accounts.length - disabledCount} enabled / ${disabledCount} disabled`,
		});

		const seenRefreshTokens = new Set<string>();
		let duplicateTokenCount = 0;
		for (const account of storage.accounts) {
			const token = getDoctorRefreshTokenKey(account.refreshToken);
			if (!token) continue;
			if (seenRefreshTokens.has(token)) {
				duplicateTokenCount += 1;
			} else {
				seenRefreshTokens.add(token);
			}
		}
		addCheck({
			key: "duplicate-refresh-token",
			severity: duplicateTokenCount > 0 ? "warn" : "ok",
			message:
				duplicateTokenCount > 0
					? `Detected ${duplicateTokenCount} duplicate refresh token entr${duplicateTokenCount === 1 ? "y" : "ies"}`
					: "No duplicate refresh tokens detected",
		});

		const seenEmails = new Set<string>();
		let duplicateEmailCount = 0;
		let placeholderEmailCount = 0;
		let likelyInvalidRefreshTokenCount = 0;
		for (const account of storage.accounts) {
			if (deps.hasLikelyInvalidRefreshToken(account.refreshToken)) {
				likelyInvalidRefreshTokenCount += 1;
			}
			const email = sanitizeEmail(account.email);
			if (!email) continue;
			if (seenEmails.has(email)) duplicateEmailCount += 1;
			seenEmails.add(email);
			if (hasPlaceholderEmail(email)) placeholderEmailCount += 1;
		}
		addCheck({
			key: "duplicate-email",
			severity: duplicateEmailCount > 0 ? "warn" : "ok",
			message:
				duplicateEmailCount > 0
					? `Detected ${duplicateEmailCount} duplicate email entr${duplicateEmailCount === 1 ? "y" : "ies"}`
					: "No duplicate emails detected",
		});
		addCheck({
			key: "placeholder-email",
			severity: placeholderEmailCount > 0 ? "warn" : "ok",
			message:
				placeholderEmailCount > 0
					? `${placeholderEmailCount} account(s) appear to be placeholder/demo entries`
					: "No placeholder emails detected",
		});
		addCheck({
			key: "refresh-token-shape",
			severity: likelyInvalidRefreshTokenCount > 0 ? "warn" : "ok",
			message:
				likelyInvalidRefreshTokenCount > 0
					? `${likelyInvalidRefreshTokenCount} account(s) have likely invalid refresh token format`
					: "Refresh token format looks normal",
		});

		const now = Date.now();
		const forecastResults = evaluateForecastAccounts(
			storage.accounts.map((account, index) => ({
				index,
				account,
				isCurrent: index === activeIndex,
				now,
			})),
		);
		const recommendation = recommendForecastAccount(forecastResults);
		if (
			recommendation.recommendedIndex !== null
			&& recommendation.recommendedIndex !== activeIndex
		) {
			addCheck({
				key: "recommended-switch",
				severity: "warn",
				message: `A healthier account is available: switch to ${recommendation.recommendedIndex + 1}`,
				details: recommendation.reason,
			});
		} else {
			addCheck({
				key: "recommended-switch",
				severity: "ok",
				message: "Current account aligns with forecast recommendation",
			});
		}

		if (activeExists) {
			const activeAccount = storage.accounts[activeIndex];
			const managerActiveEmail = sanitizeEmail(activeAccount?.email);
			const managerActiveAccountId = activeAccount?.accountId;
			const codexActiveEmail =
				sanitizeEmail(codexCliState?.activeEmail) ?? codexAuthEmail;
			const codexActiveAccountId =
				codexCliState?.activeAccountId ?? codexAuthAccountId;
			const isEmailMismatch =
				!!managerActiveEmail
				&& !!codexActiveEmail
				&& managerActiveEmail !== codexActiveEmail;
			const isAccountIdMismatch =
				!!managerActiveAccountId
				&& !!codexActiveAccountId
				&& managerActiveAccountId !== codexActiveAccountId;

			addCheck({
				key: "active-selection-sync",
				severity: isEmailMismatch || isAccountIdMismatch ? "warn" : "ok",
				message:
					isEmailMismatch || isAccountIdMismatch
						? "Manager active account and Codex active account are not aligned"
						: "Manager active account and Codex active account are aligned",
				details:
					`manager=${formatDoctorIdentitySummary({
						email: managerActiveEmail,
						accountId: managerActiveAccountId,
					})} | codex=${formatDoctorIdentitySummary({
						email: codexActiveEmail,
						accountId: codexActiveAccountId,
					})}`,
			});

			if (options.fix && activeAccount) {
				const activeAccountMatch = structuredClone(activeAccount);
				let syncAccessToken = activeAccount.accessToken;
				let syncRefreshToken = activeAccount.refreshToken;
				let syncExpiresAt = activeAccount.expiresAt;
				let syncIdToken: string | undefined;
				let canSyncActiveAccount = deps.hasUsableAccessToken(activeAccount, now);

				if (!canSyncActiveAccount) {
					if (options.dryRun) {
						supplementalFixActions.push({
							key: "doctor-refresh",
							message: `Prepared active-account token refresh for account ${activeIndex + 1} (dry-run)`,
						});
					} else {
						const refreshResult = await queuedRefresh(activeAccount.refreshToken);
						if (refreshResult.type === "success") {
							const refreshedEmail = sanitizeEmail(
								extractAccountEmail(refreshResult.access, refreshResult.idToken),
							);
							const refreshedAccountId = extractAccountId(refreshResult.access);
							activeAccount.accessToken = refreshResult.access;
							activeAccount.refreshToken = refreshResult.refresh;
							activeAccount.expiresAt = refreshResult.expires;
							if (refreshedEmail) activeAccount.email = refreshedEmail;
							deps.applyTokenAccountIdentity(activeAccount, refreshedAccountId);
							doctorRefreshMutation = {
								match: activeAccountMatch,
								accessToken: refreshResult.access,
								refreshToken: refreshResult.refresh,
								expiresAt: refreshResult.expires,
								...(refreshedEmail ? { email: refreshedEmail } : {}),
								...(refreshedAccountId ? { accountId: refreshedAccountId } : {}),
							};
							syncAccessToken = refreshResult.access;
							syncRefreshToken = refreshResult.refresh;
							syncExpiresAt = refreshResult.expires;
							syncIdToken = refreshResult.idToken;
							canSyncActiveAccount = true;
							storageFixChanged = true;
							fixChanged = true;
							supplementalFixActions.push({
								key: "doctor-refresh",
								message: `Refreshed active account tokens for account ${activeIndex + 1}`,
							});
						} else {
							addCheck({
								key: "doctor-refresh",
								severity: "warn",
								message: "Unable to refresh active account before Codex sync",
								details: deps.normalizeFailureDetail(
									refreshResult.message,
									refreshResult.reason,
								),
							});
						}
					}
				}

				if (!options.dryRun && canSyncActiveAccount) {
					pendingCodexActiveSync = {
						accountId: activeAccount.accountId,
						email: activeAccount.email,
						accessToken: syncAccessToken,
						refreshToken: syncRefreshToken,
						expiresAt: syncExpiresAt,
						...(syncIdToken ? { idToken: syncIdToken } : {}),
					};
				} else if (options.dryRun && canSyncActiveAccount) {
					supplementalFixActions.push({
						key: "codex-active-sync",
						message: "Prepared Codex active-account sync (dry-run)",
					});
				}
			}
		}
	}

	if (options.fix && storage && storage.accounts.length > 0 && storageFixChanged && !options.dryRun) {
		await withAccountStorageTransaction(async (loadedStorage, persist) => {
			const nextStorage = loadedStorage
				? structuredClone(loadedStorage)
				: createEmptyAccountStorage();
			const transactionFixed = applyDoctorFixes(nextStorage, deps);
			structuralFixActions = transactionFixed.actions;
			let transactionChanged = transactionFixed.changed;
			if (doctorRefreshMutation) {
				const fallbackActiveIndex = deps.resolveActiveIndex(nextStorage, "codex");
				const fallbackTargetIndex =
					fallbackActiveIndex >= 0 && fallbackActiveIndex < nextStorage.accounts.length
						? fallbackActiveIndex
						: undefined;
				const targetIndex =
					findMatchingAccountIndex(nextStorage.accounts, doctorRefreshMutation.match, {
						allowUniqueAccountIdFallbackWithoutEmail: true,
					})
					?? findMatchingAccountIndex(nextStorage.accounts, {
						accountId: doctorRefreshMutation.accountId,
						email: doctorRefreshMutation.email,
						refreshToken: doctorRefreshMutation.refreshToken,
					}, {
						allowUniqueAccountIdFallbackWithoutEmail: true,
					})
					?? fallbackTargetIndex;
				const target = targetIndex === undefined ? undefined : nextStorage.accounts[targetIndex];
				if (target) {
					if (target.accessToken !== doctorRefreshMutation.accessToken) {
						target.accessToken = doctorRefreshMutation.accessToken;
						transactionChanged = true;
					}
					if (target.refreshToken !== doctorRefreshMutation.refreshToken) {
						target.refreshToken = doctorRefreshMutation.refreshToken;
						transactionChanged = true;
					}
					if (target.expiresAt !== doctorRefreshMutation.expiresAt) {
						target.expiresAt = doctorRefreshMutation.expiresAt;
						transactionChanged = true;
					}
					if (doctorRefreshMutation.email && target.email !== doctorRefreshMutation.email) {
						target.email = doctorRefreshMutation.email;
						transactionChanged = true;
					}
					if (deps.applyTokenAccountIdentity(target, doctorRefreshMutation.accountId)) {
						transactionChanged = true;
					}
				}
			}
			if (normalizeDoctorIndexes(nextStorage)) {
				transactionChanged = true;
			}
			if (!transactionChanged) {
				structuralFixActions = [];
				storageFixChanged = false;
				return;
			}
			storageFixChanged = true;
			await persist(nextStorage);
		});
	}

	if (pendingCodexActiveSync) {
		const synced = await setCodexCliActiveSelection(pendingCodexActiveSync);
		if (synced) {
			supplementalFixActions.push({
				key: "codex-active-sync",
				message: "Synced manager active account into Codex auth state",
			});
		} else {
			addCheck({
				key: "codex-active-sync",
				severity: "warn",
				message: "Failed to sync manager active account into Codex auth state",
			});
		}
	}

	const fixActions = [...structuralFixActions, ...supplementalFixActions];

	if (options.fix && storage && storage.accounts.length > 0) {
		fixChanged = storageFixChanged || fixActions.length > 0;
		addCheck({
			key: "auto-fix",
			severity: fixChanged ? "warn" : "ok",
			message: fixChanged
				? options.dryRun
					? `Prepared ${fixActions.length} fix(es) (dry-run)`
					: `Applied ${fixActions.length} fix(es)`
				: "No safe auto-fixes needed",
		});
	}

	const summary = checks.reduce(
		(acc, check) => {
			acc[check.severity] += 1;
			return acc;
		},
		{ ok: 0, warn: 0, error: 0 },
	);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					command: "doctor",
					storagePath,
					summary,
					checks,
					fix: {
						enabled: options.fix,
						dryRun: options.dryRun,
						changed: fixChanged,
						actions: fixActions,
					},
				},
				null,
				2,
			),
		);
		return summary.error > 0 ? 1 : 0;
	}

	console.log("Doctor diagnostics");
	console.log(`Storage: ${storagePath}`);
	console.log(
		`Summary: ${summary.ok} ok, ${summary.warn} warnings, ${summary.error} errors`,
	);
	console.log("");
	for (const check of checks) {
		const marker =
			check.severity === "ok" ? "✓" : check.severity === "warn" ? "!" : "✗";
		console.log(`${marker} ${check.key}: ${check.message}`);
		if (check.details) {
			console.log(`  ${check.details}`);
		}
	}
	if (options.fix) {
		console.log("");
		if (fixActions.length > 0) {
			console.log(`Auto-fix actions (${options.dryRun ? "dry-run" : "applied"}):`);
			for (const action of fixActions) {
				console.log(`  - ${action.message}`);
			}
		} else {
			console.log("Auto-fix actions: none");
		}
	}

	return summary.error > 0 ? 1 : 0;
}
