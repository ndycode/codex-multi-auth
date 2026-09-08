//! Port of `lib/runtime/rotation-storage-meta.ts` — content-hash-keyed
//! snapshot of on-disk storage metadata (spec 10 §10, issue #474).
//!
//! The proxy is a long-running process; the `switch`/`unpin`/`best` CLI
//! runs in a different process and mutates the storage file. We re-read
//! only the top-level `pinnedAccountIndex` and `affinityGeneration` fields
//! on each request so manual changes are honored without a full
//! AccountManager reload (which would lose in-memory cooldown state).
//!
//! The cache is keyed on a sha1 of the file bytes rather than mtime because
//! coarse mtime granularity (FAT 2s, some Windows/network volumes ~1s) can
//! let two atomic-rename writes share an mtime tick. The mtime+size
//! short-circuit is only trusted once the cached mtime has settled past
//! [`MTIME_SHORTCIRCUIT_SETTLE_MS`]; within the settle window we always
//! fall through to the read + sha1 path (the source of truth).
//!
//! Error paths return the LAST CACHED value for the path ("better stale
//! than wrong"); defaults are only returned when the file was never
//! successfully read. There is deliberately NO retry/busy-wait (an earlier
//! TS version blocked the event loop on the request hot path).

use cma_accounts::session_affinity::SessionAffinityStore;
use cma_core::utils::now_ms;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex as StdMutex};

/// TS `MTIME_SHORTCIRCUIT_SETTLE_MS` — 2s comfortably exceeds the coarsest
/// mtime granularity expected in practice.
pub const MTIME_SHORTCIRCUIT_SETTLE_MS: i64 = 2_000;

/// TS `StorageMeta` — the two hot-path fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorageMeta {
    pub pinned_account_index: Option<i64>,
    pub affinity_generation: i64,
}

const DEFAULT_META: StorageMeta = StorageMeta {
    pinned_account_index: None,
    affinity_generation: 0,
};

/// TS private `StorageMetaSnapshot`.
#[derive(Debug, Clone, PartialEq)]
struct StorageMetaSnapshot {
    /// Node `stats.mtimeMs` (float ms) — modeled as nanoseconds since epoch
    /// so sub-millisecond precision survives.
    mtime_ns: u128,
    size: u64,
    content_hash: String,
    pinned_account_index: Option<i64>,
    affinity_generation: i64,
}

impl StorageMetaSnapshot {
    fn meta(&self) -> StorageMeta {
        StorageMeta {
            pinned_account_index: self.pinned_account_index,
            affinity_generation: self.affinity_generation,
        }
    }
}

// Keyed by storage path so multiple proxy instances and concurrent test
// workers (each pointing at their own temp storage file) cannot corrupt
// each other's snapshots. See issue #474.
static STORAGE_META_CACHE: LazyLock<StdMutex<HashMap<String, StorageMetaSnapshot>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

fn hash_storage_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn stat_file(path: &str) -> std::io::Result<(u128, u64)> {
    let metadata = std::fs::metadata(path)?;
    let mtime_ns = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    Ok((mtime_ns, metadata.len()))
}

/// Validate exactly like the zod schema / `readPinAndGenFromDisk`: a
/// non-integer or negative pin is REJECTED (`None`), never truncated — this
/// is the value the proxy routes on, and a negative index reaching
/// `choose_account` would wedge the pool. JSON `3.0` counts as an integer
/// (JS `Number.isInteger` semantics).
fn non_negative_int(value: Option<&serde_json::Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 || number < 0.0 || number > i64::MAX as f64 {
        return None;
    }
    Some(number as i64)
}

/// TS `readStorageMetaFromDisk(storagePath = getStoragePath())`. Pass
/// `None` to read the active storage path.
pub fn read_storage_meta_from_disk(storage_path: Option<&str>) -> StorageMeta {
    let storage_path = match storage_path {
        Some(path) => path.to_string(),
        None => cma_storage::facade::get_storage_path(),
    };

    if !Path::new(&storage_path).exists() {
        STORAGE_META_CACHE
            .lock()
            .expect("storage meta cache poisoned")
            .remove(&storage_path);
        return DEFAULT_META;
    }

    match read_meta_uncached(&storage_path) {
        Ok(meta) => meta,
        Err(_) => {
            // On any failure, prefer the last good snapshot for this path so
            // we don't blow away affinity unnecessarily. Defaults are only
            // returned when this file has never been read successfully.
            let cache = STORAGE_META_CACHE
                .lock()
                .expect("storage meta cache poisoned");
            match cache.get(&storage_path) {
                Some(cached) => cached.meta(),
                None => DEFAULT_META,
            }
        }
    }
}

fn read_meta_uncached(storage_path: &str) -> Result<StorageMeta, ()> {
    // mtime+size short-circuit (L3): when neither changed since the last
    // successful read AND the cached mtime has settled, return the cached
    // snapshot without reading or hashing the file.
    let (mtime_ns, size) = stat_file(storage_path).map_err(|_| ())?;
    {
        let cache = STORAGE_META_CACHE
            .lock()
            .expect("storage meta cache poisoned");
        if let Some(cached) = cache.get(storage_path) {
            let mtime_ms = (mtime_ns / 1_000_000) as i64;
            if cached.mtime_ns == mtime_ns
                && cached.size == size
                && now_ms() - mtime_ms > MTIME_SHORTCIRCUIT_SETTLE_MS
            {
                return Ok(cached.meta());
            }
        }
    }

    let bytes = std::fs::read(storage_path).map_err(|_| ())?;
    let content_hash = hash_storage_bytes(&bytes);
    {
        let mut cache = STORAGE_META_CACHE
            .lock()
            .expect("storage meta cache poisoned");
        if let Some(cached) = cache.get_mut(storage_path)
            && cached.content_hash == content_hash
        {
            // Content is byte-identical despite the mtime/size change
            // (e.g. an atomic-rename rewrite of the same bytes). Refresh
            // the stat fields so the next request takes the fast path,
            // but skip the JSON parse.
            cached.mtime_ns = mtime_ns;
            cached.size = size;
            return Ok(cached.meta());
        }
    }

    let parsed: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let pinned_account_index = non_negative_int(parsed.get("pinnedAccountIndex"));
    let affinity_generation = non_negative_int(parsed.get("affinityGeneration")).unwrap_or(0);

    let snapshot = StorageMetaSnapshot {
        mtime_ns,
        size,
        content_hash,
        pinned_account_index,
        affinity_generation,
    };
    let meta = snapshot.meta();
    STORAGE_META_CACHE
        .lock()
        .expect("storage meta cache poisoned")
        .insert(storage_path.to_string(), snapshot);
    Ok(meta)
}

/// TS `readPinnedAccountIndexFromDisk` — backwards-compatible helper
/// retained for tests. Prefer [`read_storage_meta_from_disk`] for new
/// callers that also need the affinity generation.
pub fn read_pinned_account_index_from_disk(storage_path: Option<&str>) -> Option<i64> {
    read_storage_meta_from_disk(storage_path).pinned_account_index
}

/// TS `resetPinCacheForTesting()` — clears the content-hash cache so each
/// test starts from a clean read-from-disk state.
pub fn reset_pin_cache_for_testing() {
    STORAGE_META_CACHE
        .lock()
        .expect("storage meta cache poisoned")
        .clear();
}

/// TS `maybeInvalidateAffinityFromDisk(store, lastObservedGeneration,
/// storagePath?)` — if the on-disk `affinityGeneration` is greater than
/// `last_observed_generation`, drop every entry in the store and return the
/// new generation; otherwise return `last_observed_generation` unchanged.
/// The CLI bumps the generation via `switch|unpin|best`; the proxy itself
/// NEVER bumps it. See issue #474.
pub fn maybe_invalidate_affinity_from_disk(
    session_affinity_store: Option<&mut SessionAffinityStore>,
    last_observed_generation: i64,
    storage_path: Option<&str>,
) -> i64 {
    let meta = read_storage_meta_from_disk(storage_path);
    if meta.affinity_generation > last_observed_generation {
        if let Some(store) = session_affinity_store {
            store.clear_all();
        }
        return meta.affinity_generation;
    }
    last_observed_generation
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_accounts::session_affinity::SessionAffinityStore;
    use serial_test::serial;

    fn temp_storage_file(dir: &tempfile::TempDir, contents: &str) -> String {
        let path = dir.path().join("accounts.json");
        std::fs::write(&path, contents).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    #[serial(env)]
    fn reads_pin_and_generation_from_disk() {
        reset_pin_cache_for_testing();
        let dir = tempfile::tempdir().unwrap();
        let path = temp_storage_file(
            &dir,
            r#"{"version":3,"accounts":[],"activeIndex":0,"pinnedAccountIndex":2,"affinityGeneration":7}"#,
        );

        let meta = read_storage_meta_from_disk(Some(&path));
        assert_eq!(meta.pinned_account_index, Some(2));
        assert_eq!(meta.affinity_generation, 7);
        assert_eq!(read_pinned_account_index_from_disk(Some(&path)), Some(2));
    }

    #[test]
    #[serial(env)]
    fn missing_file_clears_the_cache_entry_and_returns_defaults() {
        reset_pin_cache_for_testing();
        let dir = tempfile::tempdir().unwrap();
        let path = temp_storage_file(&dir, r#"{"pinnedAccountIndex":1}"#);
        assert_eq!(
            read_storage_meta_from_disk(Some(&path)).pinned_account_index,
            Some(1)
        );

        std::fs::remove_file(&path).unwrap();
        let meta = read_storage_meta_from_disk(Some(&path));
        assert_eq!(meta.pinned_account_index, None);
        assert_eq!(meta.affinity_generation, 0);

        // The cache entry is gone: a later parse failure has nothing to
        // fall back to.
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(read_storage_meta_from_disk(Some(&path)), DEFAULT_META);
    }

    #[test]
    #[serial(env)]
    fn malformed_pin_is_rejected_never_truncated() {
        reset_pin_cache_for_testing();
        let dir = tempfile::tempdir().unwrap();
        // Negative pin (a negative index would wedge the pool).
        let path = temp_storage_file(&dir, r#"{"pinnedAccountIndex":-1,"affinityGeneration":3}"#);
        let meta = read_storage_meta_from_disk(Some(&path));
        assert_eq!(meta.pinned_account_index, None);
        assert_eq!(meta.affinity_generation, 3);

        // Non-integer pin is rejected; JSON 3.0 counts as an integer
        // (Number.isInteger semantics).
        std::fs::write(&path, r#"{"pinnedAccountIndex":1.5,"affinityGeneration":2.0}"#).unwrap();
        let meta = read_storage_meta_from_disk(Some(&path));
        assert_eq!(meta.pinned_account_index, None);
        assert_eq!(meta.affinity_generation, 2);

        // Non-numeric values collapse to the defaults.
        std::fs::write(
            &path,
            r#"{"pinnedAccountIndex":"2","affinityGeneration":"5"}"#,
        )
        .unwrap();
        let meta = read_storage_meta_from_disk(Some(&path));
        assert_eq!(meta.pinned_account_index, None);
        assert_eq!(meta.affinity_generation, 0);
    }

    #[test]
    #[serial(env)]
    fn parse_errors_fall_back_to_the_last_cached_value() {
        reset_pin_cache_for_testing();
        let dir = tempfile::tempdir().unwrap();
        let path = temp_storage_file(
            &dir,
            r#"{"pinnedAccountIndex":4,"affinityGeneration":9}"#,
        );
        assert_eq!(
            read_storage_meta_from_disk(Some(&path)),
            StorageMeta {
                pinned_account_index: Some(4),
                affinity_generation: 9
            }
        );

        // A partial write (torn JSON) must serve the last good snapshot.
        std::fs::write(&path, r#"{"pinnedAccountIndex":"#).unwrap();
        assert_eq!(
            read_storage_meta_from_disk(Some(&path)),
            StorageMeta {
                pinned_account_index: Some(4),
                affinity_generation: 9
            }
        );
    }

    #[test]
    #[serial(env)]
    fn rewrites_with_identical_content_keep_the_cached_meta() {
        reset_pin_cache_for_testing();
        let dir = tempfile::tempdir().unwrap();
        let contents = r#"{"pinnedAccountIndex":1,"affinityGeneration":2}"#;
        let path = temp_storage_file(&dir, contents);
        assert_eq!(
            read_storage_meta_from_disk(Some(&path)).pinned_account_index,
            Some(1)
        );

        // Atomic-rename style rewrite of the same bytes (mtime changes,
        // content hash does not).
        std::fs::write(&path, contents).unwrap();
        let meta = read_storage_meta_from_disk(Some(&path));
        assert_eq!(meta.pinned_account_index, Some(1));
        assert_eq!(meta.affinity_generation, 2);
    }

    #[test]
    #[serial(env)]
    fn fresh_content_changes_are_seen_within_the_settle_window() {
        // Within 2s of the write, mtime equality is NOT trusted: a changed
        // file must be re-read + re-hashed immediately.
        reset_pin_cache_for_testing();
        let dir = tempfile::tempdir().unwrap();
        let path = temp_storage_file(&dir, r#"{"pinnedAccountIndex":0}"#);
        assert_eq!(
            read_storage_meta_from_disk(Some(&path)).pinned_account_index,
            Some(0)
        );

        std::fs::write(&path, r#"{"pinnedAccountIndex":2}"#).unwrap();
        assert_eq!(
            read_storage_meta_from_disk(Some(&path)).pinned_account_index,
            Some(2)
        );
    }

    #[test]
    #[serial(env)]
    fn maybe_invalidate_affinity_clears_the_store_on_a_newer_generation() {
        reset_pin_cache_for_testing();
        let dir = tempfile::tempdir().unwrap();
        let path = temp_storage_file(&dir, r#"{"affinityGeneration":5}"#);
        let now = now_ms();
        let mut store = SessionAffinityStore::new(Default::default());
        store.remember(Some("sess-1"), 1, now);
        assert_eq!(store.size(), 1);

        // On-disk generation (5) > observed (3): store dropped, new
        // generation returned.
        let next = maybe_invalidate_affinity_from_disk(Some(&mut store), 3, Some(&path));
        assert_eq!(next, 5);
        assert_eq!(store.size(), 0);

        // Observed already current: unchanged, store untouched.
        store.remember(Some("sess-2"), 0, now);
        let unchanged = maybe_invalidate_affinity_from_disk(Some(&mut store), 5, Some(&path));
        assert_eq!(unchanged, 5);
        assert_eq!(store.size(), 1);
    }
}
