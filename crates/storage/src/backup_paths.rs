//! Port of `lib/storage/backup-paths.ts` + `lib/storage/file-paths.ts` —
//! suffix constants and sibling-path builders for the accounts backup index,
//! WAL journal, intentional-reset marker, and flagged files.
//!
//! Behavior source: spec 02 §3.2–§3.5, §14 (export inventory).
//!
//! All builders are pure string suffix appends on the FULL path (the TS code
//! did `` `${path}${suffix}` `` — the suffix goes after the `.json`
//! extension, e.g. `openai-codex-accounts.json.bak`). Mirroring the TS
//! string-path model, inputs are `impl AsRef<Path>` (so `&str`, `&String`,
//! `&Path` and `&PathBuf` all work) and outputs are `String`.

use std::path::Path;

/// `.bak` — latest rotating backup suffix.
pub const ACCOUNTS_BACKUP_SUFFIX: &str = ".bak";
/// `.wal` — write-ahead journal suffix.
pub const ACCOUNTS_WAL_SUFFIX: &str = ".wal";
/// `.reset-intent` — intentional-reset marker suffix.
pub const RESET_MARKER_SUFFIX: &str = ".reset-intent";
/// Rotation history depth (`.bak`, `.bak.1`, `.bak.2`) — file-paths.ts.
pub const ACCOUNTS_BACKUP_HISTORY_DEPTH: usize = 3;

/// Append a raw string suffix to a full path (TS template-string concat).
pub(crate) fn append_suffix(path: impl AsRef<Path>, suffix: &str) -> String {
    format!("{}{}", path.as_ref().to_string_lossy(), suffix)
}

/// `getAccountsBackupPath(path)` = `<path>.bak`.
pub fn get_accounts_backup_path(path: impl AsRef<Path>) -> String {
    append_suffix(path, ACCOUNTS_BACKUP_SUFFIX)
}

/// `getAccountsBackupPathAtIndex(path, i)`: `i == 0` ⇒ `<path>.bak`, else
/// `<path>.bak.<i>` (the TS `index <= 0` branch collapses to `== 0` for an
/// unsigned index).
pub fn get_accounts_backup_path_at_index(path: impl AsRef<Path>, index: usize) -> String {
    if index == 0 {
        get_accounts_backup_path(path)
    } else {
        append_suffix(path, &format!("{ACCOUNTS_BACKUP_SUFFIX}.{index}"))
    }
}

/// `getAccountsBackupRecoveryCandidates(path, depth)` — the ordered rotation
/// candidates `[.bak, .bak.1, …]`.
pub fn get_accounts_backup_recovery_candidates(
    path: impl AsRef<Path>,
    depth: usize,
) -> Vec<String> {
    let path = path.as_ref();
    (0..depth)
        .map(|i| get_accounts_backup_path_at_index(path, i))
        .collect()
}

/// file-paths.ts wrapper: fixed depth [`ACCOUNTS_BACKUP_HISTORY_DEPTH`] (3).
pub fn get_accounts_backup_recovery_candidates_default(path: impl AsRef<Path>) -> Vec<String> {
    get_accounts_backup_recovery_candidates(path, ACCOUNTS_BACKUP_HISTORY_DEPTH)
}

/// `getAccountsWalPath(path)` = `<path>.wal`.
pub fn get_accounts_wal_path(path: impl AsRef<Path>) -> String {
    append_suffix(path, ACCOUNTS_WAL_SUFFIX)
}

/// `getIntentionalResetMarkerPath(path)` = `<path>.reset-intent`. Shared by
/// the accounts marker AND the flagged marker (each computed on its own file
/// path — spec 02 §3.4).
pub fn get_intentional_reset_marker_path(path: impl AsRef<Path>) -> String {
    append_suffix(path, RESET_MARKER_SUFFIX)
}

/// `getFlaggedAccountsPath(storagePath, fileName)` =
/// `dirname(storagePath)/<fileName>` (sibling of the accounts file).
pub fn get_flagged_accounts_path(storage_path: impl AsRef<Path>, file_name: &str) -> String {
    build_sibling_storage_path(storage_path, file_name)
}

/// `getLegacyFlaggedAccountsPath(storagePath, legacyFileName)` — same sibling
/// builder with the legacy (`openai-codex-blocked-accounts.json`) name.
pub fn get_legacy_flagged_accounts_path(
    storage_path: impl AsRef<Path>,
    legacy_file_name: &str,
) -> String {
    build_sibling_storage_path(storage_path, legacy_file_name)
}

fn build_sibling_storage_path(storage_path: impl AsRef<Path>, file_name: &str) -> String {
    storage_path
        .as_ref()
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(file_name)
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_builders_append_after_the_json_extension() {
        let path = "/x/openai-codex-accounts.json";
        assert_eq!(
            get_accounts_backup_path(path),
            "/x/openai-codex-accounts.json.bak"
        );
        assert_eq!(
            get_accounts_wal_path(path),
            "/x/openai-codex-accounts.json.wal"
        );
        assert_eq!(
            get_intentional_reset_marker_path(path),
            "/x/openai-codex-accounts.json.reset-intent"
        );
    }

    #[test]
    fn backup_index_zero_is_bare_bak_and_positive_indices_are_numbered() {
        assert_eq!(get_accounts_backup_path_at_index("/x/a.json", 0), "/x/a.json.bak");
        assert_eq!(get_accounts_backup_path_at_index("/x/a.json", 1), "/x/a.json.bak.1");
        assert_eq!(get_accounts_backup_path_at_index("/x/a.json", 2), "/x/a.json.bak.2");
    }

    #[test]
    fn recovery_candidates_are_ordered_and_default_depth_is_three() {
        let candidates = get_accounts_backup_recovery_candidates_default("/x/a.json");
        assert_eq!(
            candidates,
            vec![
                "/x/a.json.bak".to_string(),
                "/x/a.json.bak.1".to_string(),
                "/x/a.json.bak.2".to_string(),
            ]
        );
        assert_eq!(get_accounts_backup_recovery_candidates("/x/a.json", 1).len(), 1);
        assert!(get_accounts_backup_recovery_candidates("/x/a.json", 0).is_empty());
    }

    #[test]
    fn flagged_paths_are_siblings_of_the_storage_path() {
        let storage = std::path::MAIN_SEPARATOR_STR.to_string() + "dir";
        let storage = format!("{storage}{}sub{}openai-codex-accounts.json",
            std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
        let flagged = get_flagged_accounts_path(&storage, "openai-codex-flagged-accounts.json");
        assert!(flagged.ends_with("openai-codex-flagged-accounts.json"));
        assert!(flagged.contains("sub"));
        let legacy =
            get_legacy_flagged_accounts_path(&storage, "openai-codex-blocked-accounts.json");
        assert!(legacy.ends_with("openai-codex-blocked-accounts.json"));
    }

    #[test]
    fn builders_accept_str_string_path_and_pathbuf() {
        let owned = String::from("/x/a.json");
        let pathbuf = std::path::PathBuf::from("/x/a.json");
        assert_eq!(get_accounts_wal_path(&owned), "/x/a.json.wal");
        assert_eq!(get_accounts_wal_path(&pathbuf), "/x/a.json.wal");
        assert_eq!(
            get_accounts_wal_path(std::path::Path::new("/x/a.json")),
            "/x/a.json.wal"
        );
    }
}
