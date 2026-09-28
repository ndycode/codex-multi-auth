//! Port of `lib/temp-path.ts` — CSPRNG-suffixed temp filename generation for
//! atomic write-then-rename staging.
//!
//! Behavior source: specs/01-foundation.md §2.6, gotcha 18.
//!
//! Contracts:
//! - Nonce shape is `<pid>.<epochMs>.<hex8>`.
//! - The random component MUST come from the OS CSPRNG (`rand::rngs::OsRng`
//!   explicitly, per ARCHITECTURE.md §5.5) — a predictable PRNG would let a
//!   local attacker pre-create (or symlink) the staged path before the atomic
//!   write-then-rename lands. Entropy failure is a loud panic, mirroring
//!   Node's throwing `crypto.randomBytes`: staging a token file with weaker
//!   randomness instead would be strictly worse.
//! - Staged names MUST keep the trailing `.tmp` extension: stale-artifact
//!   sweepers (storage, runtime-paths, oc-chatgpt-target-detection) filter on
//!   `ends_with(".tmp")`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::TryRngCore;
use rand::rngs::OsRng;

fn epoch_ms_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Unpredictable nonce for temp/staging file names: `<pid>.<epochMs>.<hex8>`.
///
/// # Panics
///
/// Panics when the process CSPRNG is unavailable (e.g. misconfigured FIPS
/// builds) — the intended failure mode is a loud error, never a weak-random
/// fallback.
pub fn temp_file_nonce() -> String {
    let mut bytes = [0u8; 4];
    OsRng
        .try_fill_bytes(&mut bytes)
        .expect("CSPRNG unavailable: cannot generate temp-file nonce");
    format!(
        "{}.{}.{:02x}{:02x}{:02x}{:02x}",
        std::process::id(),
        epoch_ms_now(),
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
    )
}

/// Staging path for an atomic write-then-rename of `target_path`:
/// `<targetPath>.<pid>.<epochMs>.<hex8>.tmp`.
///
/// Keeps the trailing `.tmp` extension so existing stale-artifact sweepers
/// (`name.ends_with(".tmp")`) continue to skip/collect staged files.
pub fn temp_path_for(target_path: &Path) -> PathBuf {
    let mut os = target_path.as_os_str().to_os_string();
    os.push(format!(".{}.tmp", temp_file_nonce()));
    PathBuf::from(os)
}

/// String-input convenience mirroring the TS signature exactly (the TS
/// function concatenated onto the raw string, so separators are preserved
/// verbatim for both POSIX and Windows style targets).
pub fn temp_path_for_str(target_path: &str) -> String {
    format!("{}.{}.tmp", target_path, temp_file_nonce())
}

// ---------------------------------------------------------------------------
// Tests (ported from test/temp-path.test.ts)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn is_hex8(s: &str) -> bool {
        s.len() == 8 && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    }

    #[test]
    fn produces_pid_epoch_hex8_shaped_nonces() {
        let nonce = temp_file_nonce();
        let parts: Vec<&str> = nonce.split('.').collect();
        assert_eq!(parts.len(), 3, "nonce {nonce} must be <pid>.<epochMs>.<hex8>");
        assert_eq!(parts[0], std::process::id().to_string());
        assert!(
            !parts[1].is_empty() && parts[1].chars().all(|c| c.is_ascii_digit()),
            "epoch segment {} must be all digits",
            parts[1]
        );
        assert!(is_hex8(parts[2]), "random segment {} must be 8 lowercase hex", parts[2]);
    }

    #[test]
    fn does_not_repeat_across_rapid_successive_calls() {
        // pid + timestamp collide within the same millisecond, so uniqueness
        // rests on the crypto suffix; 200 draws must never collide.
        let mut seen = HashSet::new();
        for _ in 0..200 {
            seen.insert(temp_file_nonce());
        }
        assert_eq!(seen.len(), 200);
    }

    #[test]
    fn stages_next_to_the_target_and_keeps_tmp_extension_for_sweepers() {
        let temp = temp_path_for_str("/data/accounts.json");
        assert!(temp.starts_with("/data/accounts.json."));
        assert!(temp.ends_with(".tmp"));
        let middle = &temp["/data/accounts.json.".len()..temp.len() - ".tmp".len()];
        let parts: Vec<&str> = middle.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts[0].chars().all(|c| c.is_ascii_digit()));
        assert!(parts[1].chars().all(|c| c.is_ascii_digit()));
        assert!(is_hex8(parts[2]));
    }

    #[test]
    fn handles_windows_style_targets_with_drive_letter_and_backslashes() {
        let temp = temp_path_for_str("C:\\Users\\dev\\.codex\\accounts.json");
        assert!(temp.starts_with("C:\\Users\\dev\\.codex\\accounts.json."));
        assert!(temp.ends_with(".tmp"));
    }

    #[test]
    fn path_variant_appends_to_the_full_target_path() {
        let target = Path::new("/data/accounts.json");
        let temp = temp_path_for(target);
        let rendered = temp.to_string_lossy();
        assert!(rendered.starts_with("/data/accounts.json."));
        assert!(rendered.ends_with(".tmp"));
    }

    #[test]
    fn never_collides_for_the_same_target_across_rapid_calls() {
        let mut seen = HashSet::new();
        for _ in 0..200 {
            seen.insert(temp_path_for_str("/data/accounts.json"));
        }
        assert_eq!(seen.len(), 200);
    }
}
