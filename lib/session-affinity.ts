import { createLogger } from "./logger.js";

const log = createLogger("session-affinity");

export interface SessionAffinityOptions {
	ttlMs?: number;
	maxEntries?: number;
}

interface SessionAffinityEntry {
	accountIndex: number;
	expiresAt: number;
	updatedAt: number;
}

const DEFAULT_TTL_MS = 20 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 512;
const MAX_SESSION_KEY_LENGTH = 256;

/**
 * Normalize a session key by trimming surrounding whitespace and enforcing the maximum allowed length.
 *
 * This function is pure and has no side effects; it makes no filesystem-specific assumptions (including Windows) and does not perform token redaction. Callers are responsible for any concurrency control.
 *
 * @param value - The raw session key (may be `null` or `undefined`)
 * @returns The trimmed session key truncated to at most `MAX_SESSION_KEY_LENGTH` characters, or `null` if the input is missing or contains only whitespace
 */
function normalizeSessionKey(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length <= MAX_SESSION_KEY_LENGTH) return trimmed;
	return trimmed.slice(0, MAX_SESSION_KEY_LENGTH);
}

/**
 * Tracks preferred account index per session so follow-up turns stay on the
 * same account until it becomes unhealthy or stale.
 */
export class SessionAffinityStore {
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly entries = new Map<string, SessionAffinityEntry>();

	constructor(options: SessionAffinityOptions = {}) {
		this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS));
		this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
	}

	getPreferredAccountIndex(sessionKey: string | null | undefined, now = Date.now()): number | null {
		const key = normalizeSessionKey(sessionKey);
		if (!key) return null;

		const entry = this.entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= now) {
			this.entries.delete(key);
			return null;
		}
		return entry.accountIndex;
	}

	remember(sessionKey: string | null | undefined, accountIndex: number, now = Date.now()): void {
		const key = normalizeSessionKey(sessionKey);
		if (!key) return;
		if (!Number.isFinite(accountIndex) || accountIndex < 0) return;

		if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
			const oldest = this.findOldestKey();
			if (oldest) this.entries.delete(oldest);
		}

		this.entries.set(key, {
			accountIndex,
			expiresAt: now + this.ttlMs,
			updatedAt: now,
		});
	}

	forgetSession(sessionKey: string | null | undefined): void {
		const key = normalizeSessionKey(sessionKey);
		if (!key) return;
		this.entries.delete(key);
	}

	forgetAccount(accountIndex: number): number {
		if (!Number.isFinite(accountIndex) || accountIndex < 0) return 0;
		let removed = 0;
		for (const [key, entry] of this.entries.entries()) {
			if (entry.accountIndex === accountIndex) {
				this.entries.delete(key);
				removed += 1;
			}
		}
		if (removed > 0) {
			log.debug("Cleared session affinity entries for account", {
				accountIndex,
				removed,
			});
		}
		return removed;
	}

	reindexAfterRemoval(removedIndex: number): number {
		if (!Number.isFinite(removedIndex) || removedIndex < 0) return 0;
		let shifted = 0;
		for (const [key, entry] of this.entries.entries()) {
			if (entry.accountIndex > removedIndex) {
				this.entries.set(key, { ...entry, accountIndex: entry.accountIndex - 1 });
				shifted += 1;
			}
		}
		return shifted;
	}

	prune(now = Date.now()): number {
		let removed = 0;
		for (const [key, entry] of this.entries.entries()) {
			if (entry.expiresAt <= now) {
				this.entries.delete(key);
				removed += 1;
			}
		}
		return removed;
	}

	size(): number {
		return this.entries.size;
	}

	private findOldestKey(): string | null {
		let oldestKey: string | null = null;
		let oldestTimestamp = Number.POSITIVE_INFINITY;

		for (const [key, entry] of this.entries.entries()) {
			if (entry.updatedAt < oldestTimestamp) {
				oldestTimestamp = entry.updatedAt;
				oldestKey = key;
			}
		}

		return oldestKey;
	}
}
