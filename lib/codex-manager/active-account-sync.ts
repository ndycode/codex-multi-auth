import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
	extractAccountEmail,
	extractAccountId,
	sanitizeEmail,
} from "../accounts.js";
import { codexCliAccountIdFor } from "../auth/token-utils.js";
import {
	getCodexCliAccountsPath,
	getCodexCliAuthPath,
	getCodexCliConfigPath,
} from "../codex-cli/state.js";
import { setCodexCliActiveSelection } from "../codex-cli/writer.js";
import { queuedRefresh } from "../refresh-queue.js";
import { resolveActiveIndex } from "../runtime/account-status.js";
import {
	type AccountMetadataV3,
	findMatchingAccountIndex,
	getStoragePath,
	loadAccounts,
	setStoragePath,
	withAccountStorageTransaction,
} from "../storage.js";
import {
	applyTokenAccountIdentity,
	hasUsableAccessToken,
} from "./account-credentials.js";

/**
 * Multi-auth storage → Codex CLI active-selection mirror, minus the command
 * dispatcher. `scripts/codex.js` calls this on every forwarded invocation, so
 * it lives in its own module: importing `dist/lib/codex-manager.js` for this
 * single function drags in the whole manager/commands/settings/config graph
 * (~126 modules incl. zod) onto the wrapper cold-start path.
 *
 * Layer note: this stays under `codex-manager/` because it legitimately needs
 * the manager-layer credential helpers (`./account-credentials.js`) on top of
 * storage/accounts/refresh-queue. Moving it to `lib/runtime/` or
 * `lib/codex-cli/` would invert the declared
 * `types/constants → storage → accounts → runtime → manager/CLI` direction.
 */

interface ActiveSyncFingerprint {
	mtimeMs: number;
	size: number;
	contentHash: string;
}

/**
 * A cache entry asserts: "the mirror files currently on disk are the ones this
 * pass produced for this exact accounts-file content". Both sides must be
 * verified on every hit — the accounts file alone is not enough, because a
 * forwarded `codex login`/`logout` (or the official CLI's own token refresh)
 * rewrites the CLI auth files without touching our accounts file, and a
 * concurrent account switch can swap in new file content between this pass's
 * load and its fingerprint record. `mirror` maps each CLI auth file to the
 * fingerprint observed right after our write — `null` when the file was
 * legitimately absent (e.g. the writer skips accounts.json when it does not
 * exist).
 */
interface ActiveSyncCacheEntry {
	storage: ActiveSyncFingerprint;
	mirror: Map<string, ActiveSyncFingerprint | null>;
}

// Keyed by absolute storage path, mirroring lib/runtime/rotation-storage-meta.ts:
// the same process can host multiple wrappers/test workers pointed at different
// storage files, and none may corrupt another's snapshot.
const ACTIVE_SYNC_FINGERPRINTS: Map<string, ActiveSyncCacheEntry> = new Map();

// A cached mtime+size match is only trusted once the file has been quiescent
// long enough that no *subsequent* write could share the same coarse mtime
// tick (see rotation-storage-meta.ts / issue #474 — atomic-rename writers can
// land two rapid bumps on an identical mtimeMs). Inside the window we fall
// back to the read + sha1 comparison, which stays the source of truth.
const ACTIVE_SYNC_MTIME_SETTLE_MS = 2_000;

function hashStorageBytes(bytes: Buffer): string {
	return createHash("sha1").update(bytes).digest("hex");
}

function statFingerprint(storagePath: string): ActiveSyncFingerprint | null {
	if (typeof storagePath !== "string" || storagePath.length === 0) {
		return null;
	}
	try {
		const stats = statSync(storagePath);
		return {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			contentHash: hashStorageBytes(readFileSync(storagePath)),
		};
	} catch {
		return null;
	}
}

/**
 * The official-CLI files `setCodexCliActiveSelection` mirrors into: auth.json
 * and accounts.json carry the selection/tokens, config.toml carries the
 * credential-store pin. Resolved per call — every one is env-overridable and
 * may move between calls. The state module is already in this graph via
 * `../codex-cli/writer.js`, so these imports add no cold-start weight.
 */
function codexCliMirrorPaths(): string[] {
	return [
		...new Set([
			getCodexCliAuthPath(),
			getCodexCliAccountsPath(),
			getCodexCliConfigPath(),
		]),
	];
}

function statFingerprints(
	paths: readonly string[],
): Map<string, ActiveSyncFingerprint | null> {
	const map = new Map<string, ActiveSyncFingerprint | null>();
	for (const path of paths) {
		map.set(path, statFingerprint(path));
	}
	return map;
}

/**
 * mtime+size(+settle)/sha1 ladder for one file, same contract as
 * `lib/runtime/rotation-storage-meta.ts`: a stat match is only trusted once
 * the cached mtime has settled past ACTIVE_SYNC_MTIME_SETTLE_MS (atomic-rename
 * writers can land two bumps on the same coarse tick — issue #474); anything
 * else falls back to a content hash, which stays the source of truth. When
 * the bytes match despite a stat change (same-content rewrite) the cached
 * stat fields are refreshed in place so the next check can take the fast path.
 */
function fingerprintMatchesCurrent(
	path: string,
	cached: ActiveSyncFingerprint,
): boolean {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(path);
	} catch {
		return false;
	}
	if (
		cached.mtimeMs === stats.mtimeMs &&
		cached.size === stats.size &&
		Date.now() - stats.mtimeMs > ACTIVE_SYNC_MTIME_SETTLE_MS
	) {
		return true;
	}
	let contentHash: string;
	try {
		contentHash = hashStorageBytes(readFileSync(path));
	} catch {
		return false;
	}
	if (contentHash !== cached.contentHash) {
		return false;
	}
	cached.mtimeMs = stats.mtimeMs;
	cached.size = stats.size;
	return true;
}

/**
 * Returns true only when the whole synced state is unchanged: the on-disk
 * accounts file is byte-identical to the one we last mirrored AND every Codex
 * CLI mirror file still matches what our write left behind. The mirror side is
 * what lets the post-forward call keep working — a forwarded `codex login`
 * rewrites auth.json without touching the accounts file, so an input-only
 * check would skip the very pass that re-asserts the canonical selection.
 */
function isActiveSelectionSyncCurrent(storagePath: string): boolean {
	if (typeof storagePath !== "string" || storagePath.length === 0) {
		return false;
	}
	if (!existsSync(storagePath)) {
		ACTIVE_SYNC_FINGERPRINTS.delete(storagePath);
		return false;
	}
	const cached = ACTIVE_SYNC_FINGERPRINTS.get(storagePath);
	if (!cached) {
		return false;
	}
	if (!fingerprintMatchesCurrent(storagePath, cached.storage)) {
		return false;
	}
	const mirrorPaths = codexCliMirrorPaths();
	if (mirrorPaths.length !== cached.mirror.size) {
		return false;
	}
	for (const path of mirrorPaths) {
		const expected = cached.mirror.get(path);
		if (expected === undefined) {
			// Mirror path set changed between calls (env override moved).
			return false;
		}
		if (expected === null) {
			// Recorded as absent — e.g. `codex logout` deleted it. Any file now
			// present is drift the sync pass must reconcile.
			if (existsSync(path)) {
				return false;
			}
			continue;
		}
		if (!fingerprintMatchesCurrent(path, expected)) {
			return false;
		}
	}
	return true;
}

/**
 * Cache the synced state, but only when the bytes on disk are still the exact
 * bytes this pass mirrored (`syncedContentHash`). A concurrent switch or
 * migration landing between our load and this record would otherwise leave the
 * cache describing file content the mirror never saw, and the next call would
 * skip the sync that corrects it. Mirror outputs are fingerprinted the same
 * way; an output that existed before this pass (`preMirrorFingerprints`) or
 * that the writer must have produced (`requiredMirrorPaths`) but is now absent
 * means the mirror was torn down mid-pass — that state is never blessed.
 */
function recordActiveSelectionSync(
	storagePath: string,
	syncedContentHash: string | null,
	preMirrorFingerprints: Map<string, ActiveSyncFingerprint | null>,
	requiredMirrorPaths: ReadonlySet<string>,
): void {
	const storage = statFingerprint(storagePath);
	if (!storage || storage.contentHash !== syncedContentHash) {
		ACTIVE_SYNC_FINGERPRINTS.delete(storagePath);
		return;
	}
	const mirror = new Map<string, ActiveSyncFingerprint | null>();
	for (const path of codexCliMirrorPaths()) {
		const fingerprint = statFingerprint(path);
		const fingerprintBeforePass = preMirrorFingerprints.get(path);
		const existedBeforePass =
			fingerprintBeforePass !== undefined && fingerprintBeforePass !== null;
		if (
			fingerprint === null &&
			(existedBeforePass || requiredMirrorPaths.has(path))
		) {
			ACTIVE_SYNC_FINGERPRINTS.delete(storagePath);
			return;
		}
		mirror.set(path, fingerprint);
	}
	ACTIVE_SYNC_FINGERPRINTS.set(storagePath, { storage, mirror });
}

/**
 * Test-only: clear the storage-fingerprint cache so each test re-reads from
 * disk instead of inheriting a previous scenario's "already synced" state.
 */
export function resetActiveAccountSyncMetaForTests(): void {
	ACTIVE_SYNC_FINGERPRINTS.clear();
}

export async function autoSyncActiveAccountToCodex(): Promise<boolean> {
	setStoragePath(null);
	// Fast path: the wrapper calls this before AND after every forwarded
	// command — skip the load/refresh/write pass when neither the canonical
	// accounts file nor the mirror files the last pass produced have moved.
	// Only ever recorded after a successful mirror write over the fingerprinted
	// bytes, so a transient refresh failure, a torn mirror, or a mid-pass
	// mutation is retried on the next call.
	const storagePath = getStoragePath();
	if (isActiveSelectionSyncCurrent(storagePath)) {
		return true;
	}

	// Snapshot the inputs before loading: the record step only caches when the
	// file at record time is byte-identical to what this pass mirrored, so a
	// concurrent switch landing mid-pass can never produce a cache entry that
	// claims the mirror reflects content it does not.
	const prePassFingerprint = statFingerprint(storagePath);
	const preMirrorFingerprints = statFingerprints(codexCliMirrorPaths());
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) {
		return false;
	}

	const activeIndex = resolveActiveIndex(storage, "codex");
	if (activeIndex < 0 || activeIndex >= storage.accounts.length) {
		return false;
	}

	const account = storage.accounts[activeIndex];
	if (!account) {
		return false;
	}
	const accountMatch = {
		accountId: account.accountId,
		email: account.email,
		refreshToken: account.refreshToken,
	};

	const now = Date.now();
	let syncAccessToken = account.accessToken;
	let syncRefreshToken = account.refreshToken;
	let syncExpiresAt = account.expiresAt;
	let syncIdToken: string | undefined;
	let syncEmail = account.email;
	let changed = false;
	let nextStoredAccount: AccountMetadataV3 | null = null;
	let selectionDrifted = false;

	if (!hasUsableAccessToken(account, now)) {
		const refreshResult = await queuedRefresh(account.refreshToken);
		if (refreshResult.type !== "success") {
			return false;
		}
		nextStoredAccount = structuredClone(account);
		const tokenAccountId = extractAccountId(refreshResult.access);
		const nextEmail = sanitizeEmail(
			extractAccountEmail(refreshResult.access, refreshResult.idToken),
		);
		if (nextStoredAccount.refreshToken !== refreshResult.refresh) {
			nextStoredAccount.refreshToken = refreshResult.refresh;
			changed = true;
		}
		if (nextStoredAccount.accessToken !== refreshResult.access) {
			nextStoredAccount.accessToken = refreshResult.access;
			changed = true;
		}
		if (nextStoredAccount.expiresAt !== refreshResult.expires) {
			nextStoredAccount.expiresAt = refreshResult.expires;
			changed = true;
		}
		if (nextEmail && nextEmail !== nextStoredAccount.email) {
			nextStoredAccount.email = nextEmail;
			changed = true;
		}
		if (applyTokenAccountIdentity(nextStoredAccount, tokenAccountId)) {
			changed = true;
		}
		syncAccessToken = refreshResult.access;
		syncRefreshToken = refreshResult.refresh;
		syncExpiresAt = refreshResult.expires;
		syncIdToken = refreshResult.idToken;
		syncEmail = nextStoredAccount.email;
	}

	let persistedFingerprint: ActiveSyncFingerprint | null = null;
	if (changed && nextStoredAccount) {
		let persisted = false;
		persistedFingerprint = await withAccountStorageTransaction(async (loadedStorage, persist) => {
			if (!loadedStorage) {
				return null;
			}
			const nextStorage = structuredClone(loadedStorage);
			const targetIndex =
				findMatchingAccountIndex(nextStorage.accounts, accountMatch, {
					allowUniqueAccountIdFallbackWithoutEmail: true,
				}) ??
				findMatchingAccountIndex(nextStorage.accounts, nextStoredAccount, {
					allowUniqueAccountIdFallbackWithoutEmail: true,
				});
			if (targetIndex === undefined) {
				return null;
			}
			// This under-lock re-read is the first point that sees a selection a
			// concurrent process may have switched to since our loadAccounts().
			// Persisting the refreshed tokens is still correct, but the mirror
			// write below would re-select the stale account — skip it and let
			// the next call mirror the selection that won the race.
			if (resolveActiveIndex(nextStorage, "codex") !== targetIndex) {
				selectionDrifted = true;
			}
			nextStorage.accounts[targetIndex] = structuredClone(nextStoredAccount);
			await persist(nextStorage);
			persisted = true;
			// Still inside the file lock: this fingerprint is provably the exact
			// bytes this pass persisted, i.e. what the mirror is built from.
			return statFingerprint(storagePath);
		});
		if (!persisted) {
			return false;
		}
	}

	if (selectionDrifted) {
		ACTIVE_SYNC_FINGERPRINTS.delete(storagePath);
		return false;
	}

	// The mirrored selection is derived from `baseContentHash` bytes: the
	// pre-pass content when storage was untouched, or the under-lock post-persist
	// content when this pass refreshed tokens. If the file moved past that in
	// between (concurrent switch, restore, migration), writing the mirror now
	// would re-select a stale account — skip it and keep the cache cold so the
	// next call re-reads and corrects.
	const baseContentHash = changed
		? (persistedFingerprint?.contentHash ?? null)
		: (prePassFingerprint?.contentHash ?? null);
	const liveFingerprint = statFingerprint(storagePath);
	if ((liveFingerprint?.contentHash ?? null) !== baseContentHash) {
		ACTIVE_SYNC_FINGERPRINTS.delete(storagePath);
		return false;
	}

	const synced = await setCodexCliActiveSelection({
		accountId: codexCliAccountIdFor(
			nextStoredAccount ?? account,
			syncAccessToken,
			syncIdToken,
		),
		email: syncEmail,
		accessToken: syncAccessToken,
		refreshToken: syncRefreshToken,
		expiresAt: syncExpiresAt,
		...(syncIdToken ? { idToken: syncIdToken } : {}),
	});
	if (synced) {
		// The writer always (re)writes auth.json when the selection carries a
		// token pair; treat its disappearance before the record as a torn
		// mirror rather than a cacheable "absent" state.
		const requiredMirrorPaths = new Set<string>();
		if (
			typeof syncAccessToken === "string" &&
			syncAccessToken.trim().length > 0 &&
			typeof syncRefreshToken === "string" &&
			syncRefreshToken.trim().length > 0
		) {
			requiredMirrorPaths.add(getCodexCliAuthPath());
		}
		recordActiveSelectionSync(
			storagePath,
			baseContentHash,
			preMirrorFingerprints,
			requiredMirrorPaths,
		);
	}
	return synced;
}
