import { buildVisibleModelUnion, supportsModelSettings, modelEntitlements } from "../model-route-policy.js";
import { mapWithConcurrency } from "../concurrency.js";
import { clampCatalogContext, supportsCatalogSettings } from "./catalog-capabilities.js";
import { isRecord } from "../utils.js";

export class CatalogRetryError extends Error {
 constructor(readonly retryAfterMs: number) { super("Catalog temporarily rate limited"); }
}

export type CatalogModel = Record<string, unknown> & { slug: string };

/** Upper bound for a catalog 429 backoff, whatever Retry-After the upstream sends. */
export const MAX_CATALOG_RETRY_MS = 15 * 60_000;
export function clampCatalogRetryMs(retryAfterMs: number | null | undefined): number {
	const value = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? retryAfterMs : 60_000;
	return Math.min(MAX_CATALOG_RETRY_MS, Math.max(60_000, value));
}

/**
 * Per-proxy discovery cache. Failed refreshes never advertise stale access, but
 * they are "unknown", not "empty": only a successful fetch can exclude a model.
 * Routing fails open: an outage or throttle lets inference through, and the last
 * successfully fetched catalog (whatever its age) is the only thing that excludes.
 */
export class AccountModelCatalog {
	private readonly cache = new Map<
		string,
		{ expires: number; checkedAt: number; error: boolean; models: CatalogModel[] | null; lastGood: CatalogModel[] | null }
	>();
	private readonly updated = new Set<() => void>();
	private readonly pending = new Map<string, Promise<CatalogModel[] | null>>();
	constructor(
		private readonly fetchCatalog: (accountKey: string) => Promise<unknown>,
		private readonly now: () => number = Date.now,
		private readonly ttlMs = 5 * 60_000,
	) {}
	private async read(key: string): Promise<CatalogModel[] | null> {
		const cached = this.cache.get(key);
		if (cached && cached.expires > this.now()) return cached.models;
		const existing = this.pending.get(key);
		if (existing) return existing;
		const task = (async () => {
			let models: CatalogModel[] | null = null;
            let retryMs = Math.min(this.ttlMs, 5000);
			try {
				const value = await this.fetchCatalog(key);
				if (
					!isRecord(value) ||
					!Array.isArray(value.models) ||
					value.models.length > 1000 ||
					!value.models.every(
						(m) =>
							isRecord(m) &&
							typeof m.slug === "string" &&
							m.slug.length > 0 &&
							m.slug.length < 256,
					)
				) {
					throw new Error("Invalid account model catalog");
				}
				models = value.models as CatalogModel[];
			} catch (error) {
                if (error instanceof CatalogRetryError) retryMs = clampCatalogRetryMs(error.retryAfterMs);
				/* Unknown; list() advertises nothing from it and supports() fails open. */
			}
			const previous = this.cache.get(key);
			if (!previous && this.cache.size >= 3000)
				this.cache.delete(this.cache.keys().next().value ?? "");
			this.cache.set(key, {
				lastGood: models ?? previous?.lastGood ?? null,
                checkedAt: this.now(), error: models === null,
				expires:
					this.now() +
					(models !== null ? this.ttlMs : retryMs),
				models,
			});
            for (const notify of this.updated) notify();
			return models;
		})();
		this.pending.set(key, task);
		try {
			return await task;
		} finally {
			this.pending.delete(key);
		}
	}
	/** Picker-only stale-while-refresh view; routing still awaits fresh discovery. */
	cachedList(accountKeys: string[]): CatalogModel[] {
		return buildVisibleModelUnion(accountKeys.map((key, index) => {
			const entry = this.cache.get(key);
			const usable = entry && !entry.error && entry.checkedAt <= this.now() && this.now() - entry.checkedAt < 15 * 60_000;
			return {id: key, kind: "oauth" as const, priority: index, enabled: true, models: usable ? entry.models ?? [] : [], visibleModels: null};
		}));
	}
	invalidate(): void { this.cache.clear(); }
	/** Retry discovery while retaining known routing exclusions if it fails. */
	refresh(): void { for (const entry of this.cache.values()) entry.expires = Number.NEGATIVE_INFINITY; }
	supportsCached(key: string, model: string, effort?: string, tier?: string): boolean {
		const cached = this.cache.get(key);
		return Boolean(cached && !cached.error && cached.expires > this.now() && cached.models?.some(entry => entry.slug === model && supportsModelSettings(entry, effort, tier)));
	}
	/**
	 * Routing view: the last successful catalog decides, whatever its age. A workspace
	 * that has never been fetched successfully (outage, throttle, slow discovery) is
	 * unknown and stays routable; only a fetched catalog can exclude a model.
	 */
	supportsForRouting(key: string, model: string, effort?: string, tier?: string): boolean {
		const known = this.cache.get(key)?.lastGood;
		return !known || known.some(entry => entry.slug === model && supportsModelSettings(entry, effort, tier));
	}
	/** Refresh in the background; one fresh eligible route is enough to dispatch early.
	 * After the wait, routing falls back to {@link supportsForRouting}. The caller still ranks eligible accounts.
	 */
	async prepareRouting(keys: string[], model: string, effort?: string, tier?: string,
		eligible: (key: string) => boolean = () => true, waitMs = 2000,
	): Promise<"ready" | "unavailable"> {
		const ready = () => keys.some(key => eligible(key) && this.supportsCached(key, model, effort, tier));
		let notify!: () => void;
		const available = new Promise<void>(resolve => { notify = () => { if (ready()) resolve(); }; });
		this.updated.add(notify);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const refresh = this.list(keys).then(() => undefined, () => undefined);
			if (!ready()) await Promise.race([refresh, available, new Promise<void>(resolve => {timer = setTimeout(resolve, waitMs);})]);
			return ready() || keys.some(key => eligible(key) && this.supportsForRouting(key, model, effort, tier)) ? "ready" : "unavailable";
		} finally {
			if (timer) clearTimeout(timer);
			this.updated.delete(notify);
		}
	}
	async list(accountKeys: string[], referenceKey?: string): Promise<CatalogModel[]> {
		const models = new Map<string, CatalogModel>();

        const catalogs = await mapWithConcurrency([...new Set([...accountKeys, ...(referenceKey ? [referenceKey] : [])])], 3, key => this.read(key));
        const combined = buildVisibleModelUnion(catalogs.map((models, index) => ({id: String(index), kind: "oauth", enabled: true, priority: index, models: models ?? [], visibleModels: null})));
        for (const model of combined) models.set(model.slug, model);
		if (referenceKey) {
            const reference = await this.read(referenceKey);
            return (reference ?? []).map(model => clampCatalogContext(model, models.get(model.slug) ?? model));
        }
        return [...models.values()];
	}
	/** True unless a successfully fetched catalog omits the model. */
	async supports(accountKey: string, model: string, effort?: string, tier?: string): Promise<boolean> {
		const models = await this.read(accountKey);
		return models === null ? true : models.some((entry) => entry.slug === model && supportsCatalogSettings(entry, effort, tier));
	}
	snapshot(key: string) {
		const entry=this.cache.get(key);
		return {checkedAt:entry?.checkedAt??0,models:entry?.models?.map(m=>m.slug)??[],entitlements:entry?.models?.map(modelEntitlements)??[],error:entry?.error ?? true};
	}
}
