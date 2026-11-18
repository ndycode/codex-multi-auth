import { createHash } from "node:crypto";
import { apiBaseUrl } from "../api-region.js";
import type { ApiRouteCredential } from "../api-route-store.js";

interface Entry { until: number; strikes: number; probing: boolean }
/** Shared by all requests in one gateway; stores no raw credentials or request content. */
export class ApiRateBackoff {
	private readonly entries = new Map<string, Entry>();
	private overflowUntil = 0;
	constructor(private readonly now: () => number = Date.now) {}
	key(credential: ApiRouteCredential, model: string): string {
		return createHash("sha256").update(JSON.stringify([apiBaseUrl(credential), credential.apiKey, model])).digest("hex");
	}
	acquire(key: string): { waitMs: number; release: (success: boolean) => void } {
		const entry = this.entries.get(key);
		const waitMs = Math.max(0, this.overflowUntil - this.now(), entry ? entry.until - this.now() : 0, entry?.probing ? 1000 : 0);
		if (waitMs || !entry) return {waitMs, release: () => undefined};
		entry.probing = true;
		return {waitMs: 0, release: success => {
			if (this.entries.get(key) !== entry) return; // A concurrent rejection owns the newer deadline.
			if (success) this.entries.delete(key);
			else entry.probing = false;
		}};
	}
	penalize(key: string, minimumMs: number): number {
		const now = this.now();
		const old = this.entries.get(key);
		const strikes = Math.min(7, (old?.strikes ?? 0) + 1);
		const delay = Math.max(minimumMs, Math.min(60_000, 1000 * 2 ** (strikes - 1))) + Math.floor(Math.random() * 251);
		const until = Math.min(Number.MAX_SAFE_INTEGER, Math.max(old?.until ?? 0, now + delay));
		if (!old && this.entries.size >= 4096) {
			for (const [entryKey, entry] of this.entries) {
				if (!entry.probing && entry.until + 300_000 < now) this.entries.delete(entryKey);
			}
			// Saturation must not evict an active provider deadline and retry early.
			if (this.entries.size >= 4096) {
				this.overflowUntil = Math.max(this.overflowUntil, until);
				return until - now;
			}
		}
		this.entries.set(key, {until, strikes, probing: false});
		return until - now;
	}
}
