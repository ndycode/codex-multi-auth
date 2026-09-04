//! Port of `lib/recovery/constants.ts` — session-recovery storage paths and
//! part-type classification sets (spec 11 §6.1).
//!
//! The host runtime's (opencode-style) session store lives under the XDG data
//! directory, NOT the multi-auth dir. Gotcha 35: this module uses the raw
//! home-directory / XDG resolution (`os.homedir()` in TS), not the
//! runtime-paths home ladder — the two can disagree on Windows when
//! `HOME != USERPROFILE`.
//!
//! Deviation from TS (recorded): the TS module computes `CODEX_STORAGE` once
//! at module load; the Rust port re-resolves on every call so `EnvSandbox`
//! tests can point the storage root at a tempdir. Production behavior is
//! identical (the env does not change mid-process).

use std::path::PathBuf;

/// Part types that are "thinking" content (TS `THINKING_TYPES`).
pub const THINKING_TYPES: [&str; 3] = ["thinking", "redacted_thinking", "reasoning"];

/// Part types that are step meta markers (TS `META_TYPES`).
pub const META_TYPES: [&str; 2] = ["step-start", "step-finish"];

/// Part types that count as content (TS `CONTENT_TYPES` — exported but
/// unused inside the cluster; kept for API parity).
pub const CONTENT_TYPES: [&str; 4] = ["text", "tool", "tool_use", "tool_result"];

/// True when `part_type` is one of [`THINKING_TYPES`].
pub fn is_thinking_type(part_type: &str) -> bool {
    THINKING_TYPES.contains(&part_type)
}

/// True when `part_type` is one of [`META_TYPES`].
pub fn is_meta_type(part_type: &str) -> bool {
    META_TYPES.contains(&part_type)
}

/// True when `part_type` is one of [`CONTENT_TYPES`].
pub fn is_content_type(part_type: &str) -> bool {
    CONTENT_TYPES.contains(&part_type)
}

/// Raw home directory (TS `os.homedir()`): deliberately NOT the
/// runtime-paths resolution ladder (gotcha 35). The runtime crate has no
/// `home` dependency, so this mirrors Node's env-first behavior directly
/// (`USERPROFILE` / `HOMEDRIVE`+`HOMEPATH` on Windows, `HOME` elsewhere).
fn raw_home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE")
            && !profile.is_empty()
        {
            return PathBuf::from(profile);
        }
        if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH"))
            && !drive.is_empty()
        {
            return PathBuf::from(format!("{drive}{path}"));
        }
        PathBuf::from("")
    }
    #[cfg(not(windows))]
    {
        match std::env::var("HOME") {
            Ok(home) if !home.is_empty() => PathBuf::from(home),
            _ => PathBuf::from(""),
        }
    }
}

/// XDG-style data directory used for Codex storage (TS private `getXdgData`).
///
/// win32: `$APPDATA` or `<home>/AppData/Roaming`; other platforms:
/// `$XDG_DATA_HOME` or `<home>/.local/share`.
fn get_xdg_data() -> PathBuf {
    #[cfg(windows)]
    {
        match std::env::var("APPDATA") {
            Ok(value) if !value.is_empty() => PathBuf::from(value),
            _ => raw_home_dir().join("AppData").join("Roaming"),
        }
    }
    #[cfg(not(windows))]
    {
        match std::env::var("XDG_DATA_HOME") {
            Ok(value) if !value.is_empty() => PathBuf::from(value),
            _ => raw_home_dir().join(".local").join("share"),
        }
    }
}

/// TS `CODEX_STORAGE` — `<xdgData>/codex/storage`.
pub fn codex_storage() -> PathBuf {
    get_xdg_data().join("codex").join("storage")
}

/// TS `MESSAGE_STORAGE` — `<CODEX_STORAGE>/message`.
pub fn message_storage() -> PathBuf {
    codex_storage().join("message")
}

/// TS `PART_STORAGE` — `<CODEX_STORAGE>/part`.
pub fn part_storage() -> PathBuf {
    codex_storage().join("part")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_types_match_ts_set() {
        assert!(is_thinking_type("thinking"));
        assert!(is_thinking_type("redacted_thinking"));
        assert!(is_thinking_type("reasoning"));
        assert!(!is_thinking_type("text"));
    }

    #[test]
    fn meta_and_content_types_match_ts_sets() {
        assert!(is_meta_type("step-start"));
        assert!(is_meta_type("step-finish"));
        assert!(!is_meta_type("tool"));
        for t in ["text", "tool", "tool_use", "tool_result"] {
            assert!(is_content_type(t));
        }
        assert!(!is_content_type("thinking"));
    }

    #[test]
    fn storage_paths_nest_under_codex_storage() {
        let root = codex_storage();
        assert_eq!(message_storage(), root.join("message"));
        assert_eq!(part_storage(), root.join("part"));
        assert!(root.ends_with(PathBuf::from("codex").join("storage")));
    }
}
