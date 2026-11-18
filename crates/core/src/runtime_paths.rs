//! Port of `lib/runtime-paths.ts` — codex home / multi-auth directory
//! resolution, including the CRITICAL storage-root probing ladder.
//!
//! Behavior source: specs/02-storage.md §2.1–§2.4 (port exactly) and
//! specs/01-foundation.md §4.0.
//!
//! Contracts:
//! - Home resolution (win32): first non-empty (trimmed) of `USERPROFILE`,
//!   `HOME`, `HOMEDRIVE`+`HOMEPATH` (win32-resolved, only when BOTH
//!   non-empty), then the OS home dir. POSIX: `HOME`, then the OS home dir.
//! - `get_codex_home_dir` = trimmed `CODEX_HOME` if non-empty else
//!   `<home>/.codex`.
//! - `get_codex_multi_auth_dir` — THE storage-root selector:
//!   1. `CODEX_MULTI_AUTH_DIR` (trimmed, non-empty) wins verbatim, no probing.
//!   2. An explicitly non-default `CODEX_HOME` (path-normalized comparison
//!      against `<home>/.codex`) short-circuits to `<codexHome>/multi-auth`.
//!   3. Otherwise probe ordered candidates for real account storage
//!      (`has_accounts_storage`), then for storage signals
//!      (`has_storage_signals`) — primary first, then fallbacks — finally
//!      defaulting to the primary.
//! - Windows path dedupe/comparison is case-insensitive; returned paths
//!   preserve their original casing.
//! - Env vars are read on EVERY call (no caching) — matching the TS module.
//!
//! Testability note: the TS tests mock `process.env`/`os.homedir`; mutating
//! process env in Rust 2024 is `unsafe` (denied workspace-wide), so the
//! resolution logic is factored over an explicit [`RuntimePathEnv`] snapshot
//! and tests construct fake snapshots instead. The public functions read the
//! real process environment.

use std::fs;
use std::path::{Path, PathBuf};

const ACCOUNT_STORAGE_FILES: &[&str] = &["openai-codex-accounts.json", "codex-accounts.json"];

const STORAGE_SIGNAL_FILES: &[&str] = &[
    "openai-codex-accounts.json",
    "codex-accounts.json",
    "settings.json",
    "config.json",
    "dashboard-settings.json",
];

// ---------------------------------------------------------------------------
// Environment snapshot
// ---------------------------------------------------------------------------

/// Snapshot of the environment inputs used by path resolution. Public
/// functions build one from the live process environment per call; tests
/// build synthetic ones.
#[derive(Debug, Clone, Default)]
struct RuntimePathEnv {
    codex_home: Option<String>,
    codex_multi_auth_dir: Option<String>,
    userprofile: Option<String>,
    home: Option<String>,
    homedrive: Option<String>,
    homepath: Option<String>,
    /// `os.homedir()` analogue (`home::home_dir()`), pre-resolved.
    os_homedir: Option<String>,
}

impl RuntimePathEnv {
    fn from_process() -> Self {
        fn env(name: &str) -> Option<String> {
            std::env::var(name).ok()
        }
        Self {
            codex_home: env("CODEX_HOME"),
            codex_multi_auth_dir: env("CODEX_MULTI_AUTH_DIR"),
            userprofile: env("USERPROFILE"),
            home: env("HOME"),
            homedrive: env("HOMEDRIVE"),
            homepath: env("HOMEPATH"),
            os_homedir: home::home_dir().map(|p| p.to_string_lossy().into_owned()),
        }
    }
}

fn first_non_empty(values: &[Option<&str>]) -> Option<String> {
    for value in values {
        let trimmed = value.unwrap_or("").trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn join_str(base: &str, segment: &str) -> String {
    Path::new(base).join(segment).to_string_lossy().into_owned()
}

fn resolved_user_home_dir(env: &RuntimePathEnv) -> String {
    let os_home = env.os_homedir.clone().unwrap_or_default();
    if cfg!(windows) {
        let home_drive = env.homedrive.as_deref().unwrap_or("").trim();
        let home_path = env.homepath.as_deref().unwrap_or("").trim();
        let drive_path_home = if !home_drive.is_empty() && !home_path.is_empty() {
            Some(resolve_drive_path(home_drive, home_path))
        } else {
            None
        };
        first_non_empty(&[
            env.userprofile.as_deref(),
            env.home.as_deref(),
            drive_path_home.as_deref(),
            Some(os_home.as_str()),
        ])
        .unwrap_or(os_home)
    } else {
        first_non_empty(&[env.home.as_deref(), Some(os_home.as_str())]).unwrap_or(os_home)
    }
}

/// `win32.resolve("<drive>\\", homePath)` analogue: a rooted-but-driveless
/// `homePath` (`\Users\x`) and a relative one (`Users\x`) both resolve under
/// the drive; an already drive-rooted `homePath` (`F:\x`) wins outright, as
/// `win32.resolve` stops at the first absolute segment from the right;
/// separators normalize to backslashes.
fn resolve_drive_path(drive: &str, home_path: &str) -> String {
    let chars: Vec<char> = home_path.chars().take(3).collect();
    if chars.len() >= 3 && chars[0].is_ascii_alphabetic() && chars[1] == ':' && (chars[2] == '\\' || chars[2] == '/') {
        return normalize_win32(home_path);
    }
    let stripped = home_path.trim_start_matches(['\\', '/']);
    normalize_win32(&format!("{drive}\\{stripped}"))
}

// ---------------------------------------------------------------------------
// Path normalization (Node path.normalize analogues, used only for
// comparison/dedupe — returned paths keep their original form)
// ---------------------------------------------------------------------------

fn split_win32_root(s: &str) -> (String, String) {
    let bytes: Vec<char> = s.chars().collect();
    // UNC: \\server\share\
    if let Some(rest) = s.strip_prefix("\\\\") {
        if let Some(server_end) = rest.find('\\') {
            let after_server = &rest[server_end + 1..];
            if let Some(share_end) = after_server.find('\\') {
                let root_len = 2 + server_end + 1 + share_end + 1;
                return (s[..root_len].to_string(), s[root_len..].to_string());
            }
            return (s.to_string(), String::new());
        }
        return (s.to_string(), String::new());
    }
    // Drive: C: or C:\
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == ':' {
        if bytes.len() >= 3 && (bytes[2] == '\\' || bytes[2] == '/') {
            return (format!("{}{}\\", bytes[0], bytes[1]), s[3..].to_string());
        }
        return (format!("{}{}", bytes[0], bytes[1]), s[2..].to_string());
    }
    // Rooted without drive: \foo
    if s.starts_with('\\') || s.starts_with('/') {
        return ("\\".to_string(), s[1..].to_string());
    }
    (String::new(), s.to_string())
}

/// `path.win32.normalize` analogue (sufficient for root comparison): converts
/// `/` to `\`, collapses separators, resolves `.` and `..` segments.
fn normalize_win32(input: &str) -> String {
    let converted: String = input
        .chars()
        .map(|c| if c == '/' { '\\' } else { c })
        .collect();
    let (root, rest) = split_win32_root(&converted);
    let mut components: Vec<&str> = Vec::new();
    for part in rest.split('\\') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            match components.last() {
                Some(last) if *last != ".." => {
                    components.pop();
                }
                _ if root.is_empty() => components.push(".."),
                _ => {} // ".." at an absolute root is dropped
            }
        } else {
            components.push(part);
        }
    }
    let joined = components.join("\\");
    if root.is_empty() {
        if joined.is_empty() {
            ".".to_string()
        } else {
            joined
        }
    } else {
        format!("{root}{joined}")
    }
}

/// `path.posix.normalize` analogue (same scope as [`normalize_win32`]).
fn normalize_posix(input: &str) -> String {
    let absolute = input.starts_with('/');
    let mut components: Vec<&str> = Vec::new();
    for part in input.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            match components.last() {
                Some(last) if *last != ".." => {
                    components.pop();
                }
                _ if !absolute => components.push(".."),
                _ => {}
            }
        } else {
            components.push(part);
        }
    }
    let joined = components.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

fn normalize_path_for_compare(value: &str) -> String {
    let trimmed = value.trim();
    if cfg!(windows) {
        let normalized = normalize_win32(trimmed);
        let (root, _) = split_win32_root(&normalized);
        let without_trailing = if normalized == root {
            normalized
        } else {
            normalized.trim_end_matches(['\\', '/']).to_string()
        };
        without_trailing.to_lowercase()
    } else {
        let normalized = normalize_posix(trimmed);
        if normalized == "/" {
            normalized
        } else {
            normalized.trim_end_matches('/').to_string()
        }
    }
}

fn paths_equal_normalized(a: &str, b: &str) -> bool {
    normalize_path_for_compare(a) == normalize_path_for_compare(b)
}

/// Deduplicate path strings preserving first-seen order; entries are trimmed,
/// empties dropped, and comparison is case-insensitive on Windows.
fn deduplicate_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for candidate in paths {
        let trimmed = candidate.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let key = if cfg!(windows) {
            trimmed.to_lowercase()
        } else {
            trimmed.clone()
        };
        if seen.insert(key) {
            result.push(trimmed);
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Storage probes
// ---------------------------------------------------------------------------

fn has_storage_signals(dir: &Path) -> bool {
    for signal in STORAGE_SIGNAL_FILES {
        if dir.join(signal).exists() {
            return true;
        }
    }
    dir.join("projects").exists()
}

fn has_accounts_storage(dir: &Path) -> bool {
    for file_name in ACCOUNT_STORAGE_FILES {
        if dir.join(file_name).exists() {
            return true;
        }
        if dir.join(format!("{file_name}.wal")).exists() {
            return true;
        }
    }

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            // Node `withFileTypes` dirent.isFile() does not follow symlinks;
            // DirEntry::file_type matches that.
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            for file_name in ACCOUNT_STORAGE_FILES {
                if !name.starts_with(&format!("{file_name}.")) {
                    continue;
                }
                if name.ends_with(".tmp") {
                    continue;
                }
                if name.contains(".rotate.") {
                    continue;
                }
                return true;
            }
        }
    }
    // Unreadable directories are ignored and fall back to the known probes.
    false
}

// ---------------------------------------------------------------------------
// Resolution (env-snapshot core)
// ---------------------------------------------------------------------------

fn codex_home_dir_with(env: &RuntimePathEnv) -> String {
    let from_env = env.codex_home.as_deref().unwrap_or("").trim();
    if !from_env.is_empty() {
        from_env.to_string()
    } else {
        join_str(&resolved_user_home_dir(env), ".codex")
    }
}

fn legacy_codex_dir_with(env: &RuntimePathEnv) -> String {
    join_str(&resolved_user_home_dir(env), ".codex")
}

fn fallback_codex_home_dirs(env: &RuntimePathEnv) -> Vec<String> {
    let user_home = resolved_user_home_dir(env);
    let devtools = Path::new(&user_home)
        .join("DevTools")
        .join("config")
        .join("codex")
        .to_string_lossy()
        .into_owned();
    deduplicate_paths(vec![
        codex_home_dir_with(env),
        devtools,
        join_str(&user_home, ".codex"),
    ])
}

fn codex_multi_auth_dir_with(env: &RuntimePathEnv) -> String {
    let from_env = env.codex_multi_auth_dir.as_deref().unwrap_or("").trim();
    if !from_env.is_empty() {
        return from_env.to_string();
    }

    let codex_home_from_env = env.codex_home.as_deref().unwrap_or("").trim();
    let default_codex_home = join_str(&resolved_user_home_dir(env), ".codex");
    let is_explicit_non_default_home = !codex_home_from_env.is_empty()
        && !paths_equal_normalized(codex_home_from_env, &default_codex_home);

    let primary = join_str(&codex_home_dir_with(env), "multi-auth");
    let mut fallback_inputs: Vec<String> = fallback_codex_home_dirs(env)
        .into_iter()
        .map(|dir| join_str(&dir, "multi-auth"))
        .collect();
    fallback_inputs.push(legacy_codex_dir_with(env));
    let fallback_candidates = deduplicate_paths(fallback_inputs);

    let mut ordered_inputs = vec![primary.clone()];
    ordered_inputs.extend(fallback_candidates.iter().cloned());
    let ordered_candidates = deduplicate_paths(ordered_inputs);

    if is_explicit_non_default_home {
        return primary;
    }

    // Prefer candidates that actually contain account storage. This prevents
    // accidentally switching to a fresh empty directory that only has
    // settings files.
    for candidate in &ordered_candidates {
        if has_accounts_storage(Path::new(candidate)) {
            return candidate.clone();
        }
    }

    if has_storage_signals(Path::new(&primary)) {
        return primary;
    }

    for candidate in &fallback_candidates {
        if *candidate == primary {
            continue;
        }
        if has_storage_signals(Path::new(candidate)) {
            return candidate.clone();
        }
    }

    primary
}

// ---------------------------------------------------------------------------
// Public API (reads the live process environment on every call)
// ---------------------------------------------------------------------------

/// Codex home dir: trimmed `CODEX_HOME` if non-empty, else `<home>/.codex`.
pub fn get_codex_home_dir() -> PathBuf {
    PathBuf::from(codex_home_dir_with(&RuntimePathEnv::from_process()))
}

/// The multi-auth storage root — full probing ladder (see module docs).
pub fn get_codex_multi_auth_dir() -> PathBuf {
    PathBuf::from(codex_multi_auth_dir_with(&RuntimePathEnv::from_process()))
}

/// `<multi-auth-dir>/cache`.
pub fn get_codex_cache_dir() -> PathBuf {
    get_codex_multi_auth_dir().join("cache")
}

/// `<multi-auth-dir>/logs`.
pub fn get_codex_log_dir() -> PathBuf {
    get_codex_multi_auth_dir().join("logs")
}

/// The legacy per-user dir: `<home>/.codex` (independent of `CODEX_HOME`).
pub fn get_legacy_codex_dir() -> PathBuf {
    PathBuf::from(legacy_codex_dir_with(&RuntimePathEnv::from_process()))
}

// ---------------------------------------------------------------------------
// Tests (ported from test/runtime-paths.test.ts, adapted to the env-snapshot
// seam — see module docs for why process env is not mutated)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn env_with_home(home: &str) -> RuntimePathEnv {
        // Pin the home through the platform-appropriate variable plus the OS
        // fallback so resolution is deterministic on both platforms.
        RuntimePathEnv {
            userprofile: cfg!(windows).then(|| home.to_string()),
            home: Some(home.to_string()),
            os_homedir: Some(home.to_string()),
            ..Default::default()
        }
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "{}").unwrap();
    }

    #[test]
    fn multi_auth_dir_env_override_wins_verbatim_without_probing() {
        let mut env = env_with_home("/home/neil");
        env.codex_multi_auth_dir = Some("  /custom/multi-auth  ".to_string());
        assert_eq!(codex_multi_auth_dir_with(&env), "/custom/multi-auth");
    }

    #[test]
    fn defaults_to_primary_when_no_storage_exists_anywhere() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let env = env_with_home(&home);
        let expected = Path::new(&home)
            .join(".codex")
            .join("multi-auth")
            .to_string_lossy()
            .into_owned();
        assert_eq!(codex_multi_auth_dir_with(&env), expected);
    }

    #[test]
    fn prefers_fallback_directory_with_account_storage_over_primary_signal_only_directory() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let primary = dir.path().join(".codex").join("multi-auth");
        let fallback = dir
            .path()
            .join("DevTools")
            .join("config")
            .join("codex")
            .join("multi-auth");
        touch(&primary.join("settings.json"));
        touch(&fallback.join("openai-codex-accounts.json"));

        let mut env = env_with_home(&home);
        // Default CODEX_HOME set explicitly — still counts as default root.
        env.codex_home = Some(
            dir.path()
                .join(".codex")
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(
            codex_multi_auth_dir_with(&env),
            fallback.to_string_lossy().into_owned()
        );
    }

    #[test]
    fn prefers_fallback_with_recoverable_backup_artifacts_over_primary_signal_only_directory() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let primary = dir.path().join(".codex").join("multi-auth");
        let fallback = dir
            .path()
            .join("DevTools")
            .join("config")
            .join("codex")
            .join("multi-auth");
        touch(&primary.join("settings.json"));
        touch(&fallback.join(
            "openai-codex-accounts.json.manual-before-dedupe-2026-03-03T00-25-19-753Z",
        ));

        let env = env_with_home(&home);
        assert_eq!(
            codex_multi_auth_dir_with(&env),
            fallback.to_string_lossy().into_owned()
        );
    }

    #[test]
    fn readdir_probe_skips_tmp_and_rotate_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let probe = dir.path().join("probe");
        touch(&probe.join("openai-codex-accounts.json.123.tmp"));
        touch(&probe.join("openai-codex-accounts.json.rotate.abc.bak"));
        assert!(!has_accounts_storage(&probe));

        touch(&probe.join("openai-codex-accounts.json.bak"));
        assert!(has_accounts_storage(&probe));
    }

    #[test]
    fn wal_file_counts_as_account_storage() {
        let dir = tempfile::tempdir().unwrap();
        let probe = dir.path().join("probe");
        touch(&probe.join("codex-accounts.json.wal"));
        assert!(has_accounts_storage(&probe));
    }

    #[test]
    fn keeps_canonical_multi_auth_root_when_codex_home_is_explicit_non_default() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let canonical_home = dir.path().join(".codex-canonical");
        let primary = canonical_home.join("multi-auth");
        let fallback = dir
            .path()
            .join("DevTools")
            .join("config")
            .join("codex")
            .join("multi-auth");
        touch(&primary.join("settings.json"));
        touch(&fallback.join("openai-codex-accounts.json"));

        let mut env = env_with_home(&home);
        env.codex_home = Some(canonical_home.to_string_lossy().into_owned());
        assert_eq!(
            codex_multi_auth_dir_with(&env),
            primary.to_string_lossy().into_owned()
        );
    }

    #[test]
    fn uses_legacy_root_when_it_is_the_only_directory_containing_account_storage() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let legacy_root = dir.path().join(".codex");
        touch(&legacy_root.join("openai-codex-accounts.json"));

        let env = env_with_home(&home);
        assert_eq!(
            codex_multi_auth_dir_with(&env),
            legacy_root.to_string_lossy().into_owned()
        );
    }

    #[test]
    fn treats_default_codex_home_with_trailing_separator_as_the_default_root() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let fallback = dir
            .path()
            .join("DevTools")
            .join("config")
            .join("codex")
            .join("multi-auth");
        touch(&fallback.join("openai-codex-accounts.json"));

        let mut env = env_with_home(&home);
        env.codex_home = Some(format!(
            "{}{}",
            dir.path().join(".codex").to_string_lossy(),
            std::path::MAIN_SEPARATOR
        ));
        // Default root (despite trailing separator) → probing runs → the
        // fallback holding real account storage wins.
        assert_eq!(
            codex_multi_auth_dir_with(&env),
            fallback.to_string_lossy().into_owned()
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn treats_normalized_posix_codex_home_variants_of_the_default_root_as_default() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let fallback = dir
            .path()
            .join("DevTools")
            .join("config")
            .join("codex")
            .join("multi-auth");
        touch(&fallback.join("openai-codex-accounts.json"));

        let mut env = env_with_home(&home);
        env.codex_home = Some(format!("{home}/./.codex//"));
        assert_eq!(
            codex_multi_auth_dir_with(&env),
            fallback.to_string_lossy().into_owned()
        );
    }

    #[cfg(windows)]
    #[test]
    fn deduplicates_windows_style_fallback_paths_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        // CODEX_HOME differs from the real home only by case → still default.
        let upper_home = home.to_uppercase();
        let primary_upper = Path::new(&upper_home).join(".codex").join("multi-auth");
        touch(&primary_upper.join("settings.json"));

        let mut env = env_with_home(&home);
        env.codex_home = Some(
            Path::new(&upper_home)
                .join(".codex")
                .to_string_lossy()
                .into_owned(),
        );
        // Uppercase CODEX_HOME normalizes equal to the default root, so
        // probing runs; primary (in its original uppercase form) has signals.
        assert_eq!(
            codex_multi_auth_dir_with(&env),
            primary_upper.to_string_lossy().into_owned()
        );
    }

    #[cfg(windows)]
    #[test]
    fn prefers_userprofile_over_os_homedir_on_windows_when_codex_home_unset() {
        let env = RuntimePathEnv {
            userprofile: Some("C:\\Users\\Alice".to_string()),
            os_homedir: Some("C:\\Windows\\System32\\config\\systemprofile".to_string()),
            ..Default::default()
        };
        assert_eq!(codex_home_dir_with(&env), "C:\\Users\\Alice\\.codex");
        assert_eq!(legacy_codex_dir_with(&env), "C:\\Users\\Alice\\.codex");
    }

    #[cfg(windows)]
    #[test]
    fn falls_back_to_home_when_userprofile_is_missing_on_windows() {
        let env = RuntimePathEnv {
            home: Some("D:\\Users\\Bob".to_string()),
            os_homedir: Some("C:\\Windows\\System32\\config\\systemprofile".to_string()),
            ..Default::default()
        };
        assert_eq!(codex_home_dir_with(&env), "D:\\Users\\Bob\\.codex");
    }

    #[cfg(windows)]
    #[test]
    fn falls_back_to_homedrive_and_homepath_when_userprofile_and_home_are_missing() {
        let env = RuntimePathEnv {
            homedrive: Some("E:".to_string()),
            homepath: Some("\\Users\\Carol".to_string()),
            os_homedir: Some("C:\\Windows\\System32\\config\\systemprofile".to_string()),
            ..Default::default()
        };
        assert_eq!(codex_home_dir_with(&env), "E:\\Users\\Carol\\.codex");
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_homepath_without_a_leading_slash_on_windows() {
        let env = RuntimePathEnv {
            homedrive: Some("E:".to_string()),
            homepath: Some("Users\\Carol".to_string()),
            os_homedir: Some("C:\\Windows\\System32\\config\\systemprofile".to_string()),
            ..Default::default()
        };
        assert_eq!(codex_home_dir_with(&env), "E:\\Users\\Carol\\.codex");
    }

    #[cfg(not(windows))]
    #[test]
    fn prefers_home_env_over_os_homedir_on_posix() {
        let env = RuntimePathEnv {
            home: Some("/home/alice".to_string()),
            os_homedir: Some("/root".to_string()),
            ..Default::default()
        };
        assert_eq!(codex_home_dir_with(&env), "/home/alice/.codex");
        assert_eq!(legacy_codex_dir_with(&env), "/home/alice/.codex");
    }

    #[test]
    fn derived_dirs_hang_off_the_multi_auth_root() {
        let cache = get_codex_cache_dir();
        let logs = get_codex_log_dir();
        let root = get_codex_multi_auth_dir();
        assert_eq!(cache, root.join("cache"));
        assert_eq!(logs, root.join("logs"));
    }

    // ----- normalize helpers (compiled on all platforms) -----

    #[test]
    fn normalize_win32_resolves_dots_and_separators() {
        assert_eq!(normalize_win32("C:\\Users\\..\\Users\\x\\"), "C:\\Users\\x");
        assert_eq!(normalize_win32("C:/Users/./Neil//.codex/"), "C:\\Users\\Neil\\.codex");
        assert_eq!(normalize_win32("C:\\"), "C:\\");
        assert_eq!(normalize_win32("relative\\.\\path"), "relative\\path");
    }

    #[test]
    fn normalize_posix_resolves_dots_and_separators() {
        assert_eq!(normalize_posix("/home/neil/./.codex//"), "/home/neil/.codex");
        assert_eq!(normalize_posix("/a/b/../c"), "/a/c");
        assert_eq!(normalize_posix("/"), "/");
        assert_eq!(normalize_posix("a/./b"), "a/b");
    }

    #[test]
    fn dedupe_preserves_first_seen_order_and_trims() {
        let input = vec![
            "  /a/b ".to_string(),
            "/a/b".to_string(),
            "".to_string(),
            "/c".to_string(),
        ];
        assert_eq!(
            deduplicate_paths(input),
            vec!["/a/b".to_string(), "/c".to_string()]
        );
    }

    #[cfg(windows)]
    #[test]
    fn dedupe_is_case_insensitive_on_windows() {
        let input = vec![
            "C:\\Users\\Neil".to_string(),
            "c:\\users\\neil".to_string(),
        ];
        assert_eq!(deduplicate_paths(input), vec!["C:\\Users\\Neil".to_string()]);
    }
}
