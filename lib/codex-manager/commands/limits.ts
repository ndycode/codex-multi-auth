import { formatAccountLabel } from "../../accounts.js";
import { MODEL_FAMILIES, type ModelFamily } from "../../prompts/codex.js";
import { findQuotaCacheEntryForAccount } from "../../quota-readiness.js";
import type { QuotaCacheData, QuotaCacheEntry } from "../../quota-cache.js";
import { redactEmails } from "../../redaction.js";
import type { AccountStorageV3 } from "../../storage.js";
import type { LunaReserveSnapshot } from "../../luna-reserve.js";

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
	refreshLunaReserveUsage?: (storage: AccountStorageV3) => Promise<Record<number, LunaReserveSnapshot>>;
	resolveActiveIndex: (
		storage: AccountStorageV3,
		family?: ModelFamily,
	) => number;
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


function publicReserveWindow(window: LunaReserveSnapshot["primary"]) {
	return window
		? {
			usedPercent: window.usedPercent,
			remainingPercent: window.remainingPercent,
			windowMinutes: window.windowMinutes,
			resetAtMs: window.resetAtMs,
		}
		: null;
}

function publicLunaReserve(snapshot: LunaReserveSnapshot | undefined) {
	if (!snapshot) return null;
	return {
		observedAt: snapshot.observedAt,
		offered: snapshot.offered,
		available: snapshot.available,
		limitId: snapshot.limitId,
		limitName: snapshot.limitName,
		normalModelSlug: snapshot.normalModelSlug,
		primary: publicReserveWindow(snapshot.primary),
		secondary: publicReserveWindow(snapshot.secondary),
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
					// Keep the key set identical for an empty pool so a consumer
					// never has to branch on its presence. There is no account to
					// route to, so `routedIndex` is null rather than a positional 0
					// that addresses nothing.
					selection: {
						pinnedIndex: null,
						routedIndex: null,
						activeIndexByFamily: {},
					},
					accounts: [],
				},
				null,
				2,
			),
		);
		return 0;
	}

	let cache = await deps.loadQuotaCache();
	let lunaReserveByAccount: Record<number, LunaReserveSnapshot> = {};
	if (parsed.options.refresh) {
		cache = await deps.refreshQuotaCache(
			storage,
			cache,
			LIMITS_REFRESH_MAX_AGE_MS,
		);
		if (deps.refreshLunaReserveUsage) {
			lunaReserveByAccount = await deps.refreshLunaReserveUsage(storage);
		}
	}

	const generatedAt = deps.getNow?.() ?? Date.now();
	const selection = resolveSelection(storage, deps.resolveActiveIndex);
	const accounts = storage.accounts.map((account, index) => {
		const quota = findQuotaCacheEntryForAccount(
			cache,
			account,
			storage.accounts,
		);
		return {
			index,
			// Labels are built from the account email. Mask it, exactly as
			// `forecast --json` already does, so a snapshot written to a log
			// shipper or a ticket does not carry the address.
			label: redactEmails(formatAccountLabel(account, index)),
			enabled: account.enabled !== false,
			current: index === selection.routedIndex,
			quota: quota ? publicQuotaEntry(quota) : null,
			lunaReserve: publicLunaReserve(lunaReserveByAccount[index]),
		};
	});

	logInfo(
		JSON.stringify(
			{
				schemaVersion: LIMITS_SCHEMA_VERSION,
				generatedAt,
				mode: parsed.options.refresh ? "refresh" : "cached",
				selection,
				accounts,
			},
			null,
			2,
		),
	);
	return 0;
}

/**
 * The CONFIGURED routing target, and the state that decides it.
 *
 * `current` cannot be `activeIndexByFamily.codex` alone. The runtime proxy
 * routes on `pinnedAccountIndex` whenever a `switch` pin is set, and flows that
 * move the active index without touching the pin (rotation saves, `unpin`, an
 * ephemeral `--account`) would otherwise leave `current: true` on a row that is
 * not the configured target. Both inputs are emitted so a consumer can tell
 * which one applied, and the per-family map is emitted because a pool can hold
 * a different active index per family.
 *
 * This is deliberately NOT a prediction of which account the next request
 * lands on. The proxy skips an account that is disabled, inside a rate-limit
 * window, cooling down, or behind an open circuit breaker, and it applies
 * session affinity and an ephemeral `--account` override that never touch
 * storage. Reproducing that here would mean a third copy of the selector
 * (`why-selected` and `forecast` already own live selection), and a snapshot
 * read from a cache cannot be authoritative about it in any case. Consumers
 * that need liveness have `enabled` on every row and `why-selected --json`.
 *
 * `routedIndex` is null only for an empty pool, where no row is `current`.
 */
function resolveSelection(
	storage: AccountStorageV3,
	resolveActiveIndex: LimitsCommandDeps["resolveActiveIndex"],
): {
	pinnedIndex: number | null;
	routedIndex: number | null;
	activeIndexByFamily: Partial<Record<ModelFamily, number>>;
} {
	if (storage.accounts.length === 0) {
		return { pinnedIndex: null, routedIndex: null, activeIndexByFamily: {} };
	}
	const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
	for (const family of MODEL_FAMILIES) {
		activeIndexByFamily[family] = resolveActiveIndex(storage, family);
	}
	const rawPin = storage.pinnedAccountIndex;
	const pinnedIndex =
		typeof rawPin === "number" &&
		Number.isInteger(rawPin) &&
		rawPin >= 0 &&
		rawPin < storage.accounts.length
			? rawPin
			: null;
	return {
		pinnedIndex,
		routedIndex: pinnedIndex ?? activeIndexByFamily.codex ?? 0,
		activeIndexByFamily,
	};
}
