import { formatAccountLabel } from "../../accounts.js";
import { findQuotaCacheEntryForAccount } from "../../quota-readiness.js";
import type { QuotaCacheData, QuotaCacheEntry } from "../../quota-cache.js";
import type { AccountStorageV3 } from "../../storage.js";

const LIMITS_SCHEMA_VERSION = 1;
const LIMITS_REFRESH_MAX_AGE_MS = 5 * 60_000;
const LIMITS_USAGE = "Usage: codex-multi-auth limits --json [--refresh]";

export interface LimitsCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	loadQuotaCache: () => Promise<QuotaCacheData>;
	refreshQuotaCache: (
		storage: AccountStorageV3,
		cache: QuotaCacheData,
		maxAgeMs: number,
	) => Promise<QuotaCacheData>;
	resolveActiveIndex: (storage: AccountStorageV3, family?: "codex") => number;
	getNow?: () => number;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

interface ParsedLimitsOptions {
	json: boolean;
	refresh: boolean;
	help: boolean;
}

/** Parse the intentionally small, JSON-only limits command surface. */
function parseLimitsOptions(args: string[]):
	| { ok: true; options: ParsedLimitsOptions }
	| { ok: false; message: string } {
	const options: ParsedLimitsOptions = { json: false, refresh: false, help: false };
	for (const arg of args) {
		if (arg === "--json" || arg === "-j") {
			options.json = true;
			continue;
		}
		if (arg === "--refresh") {
			options.refresh = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		return { ok: false, message: `Unknown limits option: ${arg}` };
	}
	if (!options.json && !options.help) {
		return { ok: false, message: LIMITS_USAGE };
	}
	return { ok: true, options };
}

/** Convert a cached quota window to the explicit-null public JSON contract. */
function publicWindow(window: QuotaCacheEntry["primary"]) {
	return {
		usedPercent: window.usedPercent ?? null,
		windowMinutes: window.windowMinutes ?? null,
		resetAtMs: window.resetAtMs ?? null,
	};
}

/** Remove internal probe metadata and stabilize optional quota fields. */
function publicQuotaEntry(entry: QuotaCacheEntry) {
	return {
		updatedAt: entry.updatedAt,
		status: entry.status,
		planType: entry.planType ?? null,
		primary: publicWindow(entry.primary),
		secondary: publicWindow(entry.secondary),
	};
}

/**
 * Emit configured accounts joined to safe cached quota records.
 *
 * Cached mode performs no provider requests. Refresh mode delegates to the
 * existing sequential, age-gated refresh path before serializing the snapshot.
 */
export async function runLimitsCommand(
	args: string[],
	deps: LimitsCommandDeps,
): Promise<number> {
	const parsed = parseLimitsOptions(args);
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (!parsed.ok) {
		logError(parsed.message);
		return 1;
	}
	if (parsed.options.help) {
		logInfo(LIMITS_USAGE);
		return 0;
	}

	deps.setStoragePath(null);
	const storage = await deps.loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		const generatedAt = deps.getNow?.() ?? Date.now();
		logInfo(
			JSON.stringify(
				{
					schemaVersion: LIMITS_SCHEMA_VERSION,
					generatedAt,
					mode: parsed.options.refresh ? "refresh" : "cached",
					accounts: [],
				},
				null,
				2,
			),
		);
		return 0;
	}

	let cache = await deps.loadQuotaCache();
	if (parsed.options.refresh) {
		cache = await deps.refreshQuotaCache(
			storage,
			cache,
			LIMITS_REFRESH_MAX_AGE_MS,
		);
	}

	const generatedAt = deps.getNow?.() ?? Date.now();
	const activeIndex = deps.resolveActiveIndex(storage, "codex");
	const accounts = storage.accounts.map((account, index) => {
		const quota = findQuotaCacheEntryForAccount(
			cache,
			account,
			storage.accounts,
		);
		return {
			index,
			label: formatAccountLabel(account, index),
			enabled: account.enabled !== false,
			current: index === activeIndex,
			quota: quota ? publicQuotaEntry(quota) : null,
		};
	});

	logInfo(
		JSON.stringify(
			{
				schemaVersion: LIMITS_SCHEMA_VERSION,
				generatedAt,
				mode: parsed.options.refresh ? "refresh" : "cached",
				accounts,
			},
			null,
			2,
		),
	);
	return 0;
}
