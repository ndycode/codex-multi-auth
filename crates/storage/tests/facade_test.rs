//! Integration tests for the cma-storage save/load/clear pipeline (the
//! modules owned by the save+load+backup agent: facade, paths, parser, save,
//! backups, load, clear, normalize, fixture_guards, misc).
//!
//! Ports the highest-value assertions from `test/storage.test.ts`:
//! - byte-compat against the TS-produced goldens `accounts-v3.json` /
//!   `accounts-v3.wal` (crates/testkit/goldens);
//! - WAL-first save pipeline (marker unlink, WAL unlink, rotating backup);
//! - the load recovery ladder (WAL checksum replay → discovered backups);
//! - intentional-reset marker semantics (clear marker-first, accounts clear
//!   never removes its own marker, next save does);
//! - the synthetic-fixture save guard (frozen StorageError EINVALID);
//! - restore metadata (missing-storage / empty-storage / intentional-reset).
//!
//! Every test pins the storage root with `EnvSandbox` (HOME/CODEX_HOME/
//! CODEX_MULTI_AUTH_DIR) and must run `#[serial(env)]`; the storage-path
//! global is additionally serialized via the `storage_path_state` key.

use std::fs;
use std::path::PathBuf;

use serial_test::serial;

use cma_storage::facade;
use cma_storage::load::{self, PersistMigration};
use cma_storage::misc::compute_sha256;
use cma_storage::public_types::{AccountMetadataV3, AccountStorageV3, AccountsJournalEntry};
use cma_testkit::goldens::{read_golden_bytes, read_golden_string};
use cma_testkit::sandbox::EnvSandbox;

fn golden_storage() -> (String, AccountStorageV3) {
    let golden = read_golden_string("accounts-v3.json");
    let storage: AccountStorageV3 =
        serde_json::from_str(&golden).expect("golden accounts-v3.json deserializes");
    (golden, storage)
}

fn storage_path() -> PathBuf {
    PathBuf::from(facade::get_storage_path())
}

fn synthetic_storage() -> AccountStorageV3 {
    let mut storage = AccountStorageV3::empty();
    let mut account = AccountMetadataV3::new("fake_refresh_token_1", 1, 2);
    account.email = Some("account1@example.com".to_string());
    account.account_id = Some("acc_1".to_string());
    storage.accounts.push(account);
    storage
}

#[tokio::test]
#[serial(env, storage_path_state)]
async fn serializer_and_save_pipeline_reproduce_the_golden_bytes() {
    let _sandbox = EnvSandbox::new();
    let (golden, storage) = golden_storage();

    // Pure serializer parity first (JSON.stringify(x, null, 2), no trailing
    // newline, schema key order).
    assert_eq!(cma_core::json_io::stringify_pretty2(&storage), golden);

    // The full save pipeline writes exactly those bytes to the accounts path.
    facade::save_accounts(&storage).await.expect("save succeeds");
    let path = storage_path();
    let written = fs::read(&path).expect("accounts file written");
    assert_eq!(written, read_golden_bytes("accounts-v3.json"));

    // WAL and temp artifacts are gone after a successful save.
    assert!(!path.with_extension("json.wal").exists());
    let leftovers: Vec<String> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp") || name.ends_with(".wal"))
        .collect();
    assert!(leftovers.is_empty(), "stale artifacts: {leftovers:?}");

    // And the load pipeline round-trips the identical storage.
    let loaded = load::load_accounts().await.expect("loads");
    assert_eq!(loaded.storage, storage);
    assert!(loaded.restore.is_none());
}

#[test]
fn wal_journal_entry_matches_the_golden_bytes() {
    // The WAL is deleted after a successful save, so parity is asserted on
    // the entry serialization itself: compact JSON, key order
    // {version, createdAt, path, checksum, content}, sha256 of the content.
    let golden_content = read_golden_string("accounts-v3.json");
    let entry = AccountsJournalEntry::new(
        1_750_000_000_000,
        "/golden/multi-auth/openai-codex-accounts.json",
        compute_sha256(&golden_content),
        golden_content,
    );
    let serialized = cma_core::json_io::stringify_compact(&entry);
    assert_eq!(serialized.into_bytes(), read_golden_bytes("accounts-v3.wal"));
}

#[tokio::test]
#[serial(env, storage_path_state)]
async fn save_rotates_backups_and_a_marker_is_unlinked_by_the_next_save() {
    let _sandbox = EnvSandbox::new();
    let (_, storage) = golden_storage();
    facade::save_accounts(&storage).await.unwrap();
    let path = storage_path();
    let first_bytes = fs::read(&path).unwrap();

    // Simulate a prior clear: the reset marker persists until a save.
    let marker = PathBuf::from(format!("{}.reset-intent", path.to_string_lossy()));
    fs::write(&marker, "{\"version\":1,\"createdAt\":1}").unwrap();

    let mut second = storage.clone();
    second.active_index = 0;
    facade::save_accounts(&second).await.unwrap();

    assert!(!marker.exists(), "successful save unlinks the reset marker");
    let bak = PathBuf::from(format!("{}.bak", path.to_string_lossy()));
    assert_eq!(
        fs::read(&bak).unwrap(),
        first_bytes,
        ".bak holds the previous file state byte-for-byte"
    );
}

#[tokio::test]
#[serial(env, storage_path_state)]
async fn load_recovers_from_wal_then_from_backups() {
    let _sandbox = EnvSandbox::new();
    let (golden, storage) = golden_storage();
    let path = storage_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();

    // Corrupt primary + valid WAL ⇒ WAL replay wins and re-persists.
    fs::write(&path, "{definitely not json").unwrap();
    let wal_entry = AccountsJournalEntry::new(
        1,
        path.to_string_lossy().into_owned(),
        compute_sha256(&golden),
        golden.clone(),
    );
    let wal_path = PathBuf::from(format!("{}.wal", path.to_string_lossy()));
    fs::write(&wal_path, cma_core::json_io::stringify_compact(&wal_entry)).unwrap();

    let recovered = load::load_accounts().await.expect("recovers from WAL");
    assert_eq!(recovered.storage, storage);
    // The recovery persisted the primary (and the save unlinked the WAL).
    assert_eq!(fs::read(&path).unwrap(), golden.as_bytes());
    assert!(!wal_path.exists());

    // Corrupt primary + NO WAL + valid .bak ⇒ backup recovery.
    fs::write(&path, "{still not json").unwrap();
    let bak_path = PathBuf::from(format!("{}.bak", path.to_string_lossy()));
    fs::write(&bak_path, golden.as_bytes()).unwrap();
    let recovered = load::load_accounts().await.expect("recovers from backup");
    assert_eq!(recovered.storage, storage);
    assert_eq!(fs::read(&path).unwrap(), golden.as_bytes());

    // A corrupted WAL checksum is rejected (fail-closed) — with no backups it
    // falls through the whole ladder to None.
    fs::write(&path, "{corrupt again").unwrap();
    fs::remove_file(&bak_path).unwrap();
    let mut bad_entry = wal_entry;
    bad_entry.checksum = "0".repeat(64);
    fs::write(&wal_path, cma_core::json_io::stringify_compact(&bad_entry)).unwrap();
    // Remove the .bak.1/.bak.2 artifacts a prior save may have rotated in.
    for candidate in fs::read_dir(path.parent().unwrap()).unwrap().flatten() {
        let name = candidate.file_name().to_string_lossy().into_owned();
        if name.contains(".bak") {
            let _ = fs::remove_file(candidate.path());
        }
    }
    assert!(load::load_accounts().await.is_none());
}

#[tokio::test]
#[serial(env, storage_path_state)]
async fn clear_is_marker_first_and_load_reports_intentional_reset() {
    let _sandbox = EnvSandbox::new();
    let (_, storage) = golden_storage();
    facade::save_accounts(&storage).await.unwrap();
    let path = storage_path();

    facade::clear_accounts().await.expect("clear succeeds");
    assert!(!path.exists(), "primary removed");
    let marker = PathBuf::from(format!("{}.reset-intent", path.to_string_lossy()));
    assert!(marker.exists(), "accounts clear never removes its marker");
    let marker_content = fs::read_to_string(&marker).unwrap();
    assert!(marker_content.starts_with("{\"version\":1,\"createdAt\":"));

    let loaded = load::load_accounts().await.expect("marker yields empty storage");
    assert!(loaded.storage.accounts.is_empty());
    let restore = loaded.restore.expect("restore metadata attached");
    assert!(!restore.restore_eligible);
    assert_eq!(restore.restore_reason, "intentional-reset");
}

#[tokio::test]
#[serial(env, storage_path_state)]
async fn missing_and_empty_storage_report_restore_metadata() {
    let _sandbox = EnvSandbox::new();

    let loaded = load::load_accounts().await.expect("missing file yields empty");
    let restore = loaded.restore.expect("restore metadata");
    assert!(restore.restore_eligible);
    assert_eq!(restore.restore_reason, "missing-storage");

    facade::save_accounts(&AccountStorageV3::empty()).await.unwrap();
    let loaded = load::load_accounts().await.expect("empty file yields storage");
    let restore = loaded.restore.expect("restore metadata");
    assert!(restore.restore_eligible);
    assert_eq!(restore.restore_reason, "empty-storage");
}

#[tokio::test]
#[serial(env, storage_path_state)]
async fn synthetic_fixture_payload_cannot_overwrite_real_storage() {
    let _sandbox = EnvSandbox::new();
    let (_, real_storage) = golden_storage();
    facade::save_accounts(&real_storage).await.unwrap();
    let before = fs::read(storage_path()).unwrap();

    let error = facade::save_accounts(&synthetic_storage())
        .await
        .expect_err("synthetic payload over real accounts must fail");
    assert_eq!(error.code(), "EINVALID");
    assert_eq!(
        error.message(),
        "Failed to save accounts: Refusing to overwrite non-synthetic account storage with synthetic fixture payload"
    );
    assert_eq!(
        fs::read(storage_path()).unwrap(),
        before,
        "the real file is untouched"
    );

    // Synthetic-over-synthetic (or over nothing) is allowed — fixtures can
    // seed empty sandboxes.
    facade::clear_accounts().await.unwrap();
    facade::save_accounts(&synthetic_storage())
        .await
        .expect("synthetic payload over empty storage is fine");
}

#[tokio::test]
#[serial(env, storage_path_state)]
async fn v1_storage_migrates_to_v3_and_persists() {
    let _sandbox = EnvSandbox::new();
    let path = storage_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"version":1,"accounts":[{"refreshToken":"rt_v1","addedAt":5,"lastUsed":6}],"activeIndex":0}"#,
    )
    .unwrap();

    let loaded = load::load_accounts_internal(PersistMigration::Locked)
        .await
        .expect("v1 file loads");
    assert_eq!(loaded.storage.accounts.len(), 1);
    let by_family = loaded
        .storage
        .active_index_by_family
        .as_ref()
        .expect("family map fanned out");
    assert!(!by_family.is_empty());

    // The migration persisted a v3 file in place.
    let migrated: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(migrated["version"], 3);
    assert_eq!(migrated["accounts"][0]["refreshToken"], "rt_v1");
}
