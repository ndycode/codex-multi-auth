//! `--account` per-invocation force-pin (issue #623 / PR #624) — port of the
//! forced-account half of `scripts/codex.js`.
//!
//! Selector rules (spec 03 + spec 14 §2.4):
//! - ALL-DIGIT selector is ALWAYS a 1-based index (numeric account ids are
//!   unreachable by id).
//! - Otherwise matched against `accountId` / `email` (case-insensitive).
//! - Env `CODEX_MULTI_AUTH_FORCE_ACCOUNT` has the same effect; the flag wins.
//! - The resolved 0-based index is published as
//!   `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` (on the SPAWNED environment — the
//!   Rust wrapper never mutates its own process env) and fed to the
//!   in-process proxy via `RuntimeRotationProxyOptions::forced_account_index`.
//! - FAIL-HARD before spawn: proxy disabled / `CODEX_MULTI_AUTH_BYPASS=1` /
//!   no match / out-of-range / empty pool all error WITHOUT launching Codex.

use serde_json::Value;

use crate::statusline::{
    read_json_file_quiet, resolve_accounts_path, resolve_status_accounts_dir,
};

/// TS `FORCE_ACCOUNT_ENV`.
pub const FORCE_ACCOUNT_ENV: &str = "CODEX_MULTI_AUTH_FORCE_ACCOUNT";
/// TS `FORCE_ACCOUNT_INDEX_ENV` (internal, wrapper-published, 0-based).
pub const FORCE_ACCOUNT_INDEX_ENV: &str = "CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX";

/// TS `extractForcedAccountFlag(args)` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedForcedAccountFlag {
    pub selector: Option<String>,
    pub stripped_args: Vec<String>,
    pub error: Option<String>,
    pub saw_flag: bool,
}

/// TS `extractForcedAccountFlag(args)` — strip `--account <sel>` /
/// `--account=<sel>`; the flag is launcher-only and must never be forwarded.
/// The LAST occurrence wins when repeated.
pub fn extract_forced_account_flag(args: &[String]) -> ExtractedForcedAccountFlag {
    let mut stripped_args: Vec<String> = Vec::with_capacity(args.len());
    let mut selector: Option<String> = None;
    let mut saw_flag = false;
    let mut index = 0usize;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--account" {
            saw_flag = true;
            match args.get(index + 1) {
                Some(next) => {
                    selector = Some(next.clone());
                    index += 2;
                    continue;
                }
                None => {
                    return ExtractedForcedAccountFlag {
                        selector: None,
                        stripped_args: args.to_vec(),
                        error: Some(
                            "codex-multi-auth: --account requires a value (account index, email, or account id)."
                                .to_string(),
                        ),
                        saw_flag,
                    };
                }
            }
        }
        if let Some(value) = arg.strip_prefix("--account=") {
            saw_flag = true;
            selector = Some(value.to_string());
            index += 1;
            continue;
        }
        stripped_args.push(args[index].clone());
        index += 1;
    }
    ExtractedForcedAccountFlag {
        selector,
        stripped_args,
        error: None,
        saw_flag,
    }
}

/// TS `resolveForcedAccountSelector(rawArgs, env)` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedForcedSelector {
    pub selector: Option<String>,
    pub stripped_args: Vec<String>,
    pub error: Option<String>,
}

/// TS `resolveForcedAccountSelector(rawArgs, env)` — flag wins over env; an
/// explicit empty flag value is an error; env is trimmed and ignored when
/// empty.
pub fn resolve_forced_account_selector(
    raw_args: &[String],
    env_selector: Option<&str>,
) -> ResolvedForcedSelector {
    let extracted = extract_forced_account_flag(raw_args);
    if let Some(error) = extracted.error {
        return ResolvedForcedSelector {
            selector: None,
            stripped_args: extracted.stripped_args,
            error: Some(error),
        };
    }
    if extracted.saw_flag {
        let trimmed = extracted
            .selector
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        if trimmed.is_empty() {
            return ResolvedForcedSelector {
                selector: None,
                stripped_args: extracted.stripped_args,
                error: Some(
                    "codex-multi-auth: --account requires a non-empty value (account index, email, or account id)."
                        .to_string(),
                ),
            };
        }
        return ResolvedForcedSelector {
            selector: Some(trimmed),
            stripped_args: extracted.stripped_args,
            error: None,
        };
    }
    let env_selector = env_selector.unwrap_or("").trim().to_string();
    if !env_selector.is_empty() {
        return ResolvedForcedSelector {
            selector: Some(env_selector),
            stripped_args: extracted.stripped_args,
            error: None,
        };
    }
    ResolvedForcedSelector {
        selector: None,
        stripped_args: extracted.stripped_args,
        error: None,
    }
}

/// TS `formatForcedAccountList(accounts)` — the 1-based listing appended to
/// mismatch errors.
pub fn format_forced_account_list(accounts: &[Value]) -> String {
    let lines: Vec<String> = accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            let email = account
                .get("email")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("account {}", index + 1));
            format!("  {}. {}", index + 1, email)
        })
        .collect();
    format!("Available accounts:\n{}", lines.join("\n"))
}

fn normalize_identifier(value: Option<&str>) -> String {
    match value {
        Some(v) if !v.trim().is_empty() => v.trim().to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// TS `findAccountIndexByIdOrEmail` specialized for the forced-account path
/// (single selector matched against BOTH id and email).
fn find_account_index_by_selector(accounts: &[Value], selector: &str) -> Option<usize> {
    let normalized = normalize_identifier(Some(selector));
    if normalized.is_empty() {
        return None;
    }
    for (index, account) in accounts.iter().enumerate() {
        if !account.is_object() {
            continue;
        }
        if normalize_identifier(account.get("accountId").and_then(Value::as_str)) == normalized {
            return Some(index);
        }
        if normalize_identifier(account.get("email").and_then(Value::as_str)) == normalized {
            return Some(index);
        }
    }
    None
}

/// Pure selector→index resolution against an accounts array (TS
/// `resolveForcedAccountIndex` minus the disk read). Returns the 0-based
/// index or the exact TS error string.
pub fn resolve_forced_account_index_in(
    accounts: &[Value],
    selector: &str,
) -> Result<usize, String> {
    if accounts.is_empty() {
        return Err(
            "codex-multi-auth: --account was set but no Codex accounts are configured. Run `codex-multi-auth login` first."
                .to_string(),
        );
    }
    if !selector.is_empty() && selector.chars().all(|c| c.is_ascii_digit()) {
        // ALL-DIGIT selector is ALWAYS a 1-based index.
        let one_based: u64 = selector.parse().unwrap_or(u64::MAX);
        if one_based < 1 || one_based as usize > accounts.len() {
            return Err(format!(
                "codex-multi-auth: --account {selector} is out of range (have {} account{}).\n{}",
                accounts.len(),
                if accounts.len() == 1 { "" } else { "s" },
                format_forced_account_list(accounts)
            ));
        }
        return Ok(one_based as usize - 1);
    }
    match find_account_index_by_selector(accounts, selector) {
        Some(index) => Ok(index),
        None => Err(format!(
            "codex-multi-auth: --account \"{selector}\" did not match any configured account.\n{}",
            format_forced_account_list(accounts)
        )),
    }
}

/// TS `resolveForcedAccountIndex(selector, env)` — resolves against the same
/// scoped accounts pool the runtime rotation proxy will load.
pub fn resolve_forced_account_index(selector: &str) -> Result<usize, String> {
    let accounts_dir = resolve_status_accounts_dir();
    let storage = read_json_file_quiet(&resolve_accounts_path(&accounts_dir));
    let accounts: Vec<Value> = storage
        .as_ref()
        .and_then(|s| s.get("accounts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    resolve_forced_account_index_in(&accounts, selector)
}

/// Outcome of [`apply_forced_account_selection`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForcedAccountOutcome {
    /// Forward with the flag stripped. `forced_index` is the resolved 0-based
    /// pin (`None` when no forced account was requested — the spawn env must
    /// then REMOVE any stray `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX`).
    Forward {
        forward_args: Vec<String>,
        forced_index: Option<usize>,
    },
    /// Fail hard: print to stderr and exit non-zero WITHOUT launching Codex.
    Error(String),
}

/// TS `applyForcedAccountSelection(rawArgs, env)` — full preflight. The
/// `proxy_enabled` gate is computed by the caller (forward.rs owns
/// `is_runtime_rotation_proxy_enabled`); it is only consulted when a forced
/// account was actually requested, mirroring the TS await order.
pub async fn apply_forced_account_selection(
    raw_args: &[String],
    proxy_enabled_for: impl AsyncFn(&[String]) -> bool,
) -> ForcedAccountOutcome {
    let env_selector = std::env::var(FORCE_ACCOUNT_ENV).ok();
    let forced = resolve_forced_account_selector(raw_args, env_selector.as_deref());
    if let Some(error) = forced.error {
        return ForcedAccountOutcome::Error(error);
    }
    let Some(selector) = forced.selector else {
        // Defensive: a request without --account can never inherit an
        // unintended pin (the caller strips the internal env var from the
        // spawn environment when forced_index is None).
        return ForcedAccountOutcome::Forward {
            forward_args: raw_args.to_vec(),
            forced_index: None,
        };
    };
    // The pin can only be honored when the runtime rotation proxy is active
    // for this command; fail hard instead of silently using another account.
    if !proxy_enabled_for(&forced.stripped_args).await {
        return ForcedAccountOutcome::Error(
            [
                "codex-multi-auth: --account requires the runtime rotation proxy, which is not active for this command.",
                "Enable it with `codex-multi-auth rotation enable`, and make sure CODEX_MULTI_AUTH_BYPASS is not set.",
            ]
            .join("\n"),
        );
    }
    match resolve_forced_account_index(&selector) {
        Ok(index) => ForcedAccountOutcome::Forward {
            forward_args: forced.stripped_args,
            forced_index: Some(index),
        },
        Err(error) => ForcedAccountOutcome::Error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn accounts3() -> Vec<Value> {
        vec![
            json!({"accountId": "acc_alpha", "email": "first@x.com"}),
            json!({"accountId": "acc_beta", "email": "second@x.com"}),
            json!({"accountId": "12345", "email": "third@x.com"}),
        ]
    }

    #[test]
    fn flag_extraction_space_and_equals_forms() {
        let extracted = extract_forced_account_flag(&v(&["exec", "--account", "2", "task"]));
        assert_eq!(extracted.selector.as_deref(), Some("2"));
        assert_eq!(extracted.stripped_args, v(&["exec", "task"]));
        assert!(extracted.saw_flag);
        assert!(extracted.error.is_none());

        let extracted = extract_forced_account_flag(&v(&["--account=me@x.com", "exec"]));
        assert_eq!(extracted.selector.as_deref(), Some("me@x.com"));
        assert_eq!(extracted.stripped_args, v(&["exec"]));

        // Last occurrence wins.
        let extracted =
            extract_forced_account_flag(&v(&["--account", "1", "--account=2"]));
        assert_eq!(extracted.selector.as_deref(), Some("2"));
        assert!(extracted.stripped_args.is_empty());
    }

    #[test]
    fn flag_missing_value_is_error() {
        let extracted = extract_forced_account_flag(&v(&["exec", "--account"]));
        assert_eq!(
            extracted.error.as_deref(),
            Some("codex-multi-auth: --account requires a value (account index, email, or account id).")
        );
        // Args untouched on error.
        assert_eq!(extracted.stripped_args, v(&["exec", "--account"]));
    }

    #[test]
    fn selector_resolution_flag_wins_over_env() {
        let resolved = resolve_forced_account_selector(&v(&["--account", "2"]), Some("9"));
        assert_eq!(resolved.selector.as_deref(), Some("2"));
        let resolved = resolve_forced_account_selector(&v(&["exec"]), Some(" env@x.com "));
        assert_eq!(resolved.selector.as_deref(), Some("env@x.com"));
        assert_eq!(resolved.stripped_args, v(&["exec"]));
        let resolved = resolve_forced_account_selector(&v(&["exec"]), None);
        assert_eq!(resolved.selector, None);
        // Empty flag value fails hard even with env fallback available.
        let resolved = resolve_forced_account_selector(&v(&["--account", "  "]), Some("2"));
        assert_eq!(
            resolved.error.as_deref(),
            Some("codex-multi-auth: --account requires a non-empty value (account index, email, or account id).")
        );
    }

    #[test]
    fn all_digit_selector_is_always_one_based_index() {
        let accounts = accounts3();
        // "12345" matches an accountId literally, but digits NEVER match ids.
        let err = resolve_forced_account_index_in(&accounts, "12345").unwrap_err();
        assert!(err.contains("--account 12345 is out of range (have 3 accounts)"));
        assert!(err.contains("Available accounts:"));
        assert!(err.contains("  1. first@x.com"));
        assert_eq!(resolve_forced_account_index_in(&accounts, "1").unwrap(), 0);
        assert_eq!(resolve_forced_account_index_in(&accounts, "3").unwrap(), 2);
        let err = resolve_forced_account_index_in(&accounts, "0").unwrap_err();
        assert!(err.contains("out of range"));
        let err = resolve_forced_account_index_in(&accounts, "4").unwrap_err();
        assert!(err.contains("out of range"));
    }

    #[test]
    fn email_and_account_id_selectors() {
        let accounts = accounts3();
        assert_eq!(
            resolve_forced_account_index_in(&accounts, "SECOND@X.COM").unwrap(),
            1
        );
        assert_eq!(
            resolve_forced_account_index_in(&accounts, "acc_beta").unwrap(),
            1
        );
        let err = resolve_forced_account_index_in(&accounts, "missing@x.com").unwrap_err();
        assert!(err.contains(
            "--account \"missing@x.com\" did not match any configured account."
        ));
        assert!(err.contains("  3. third@x.com"));
    }

    #[test]
    fn empty_pool_error_string() {
        let err = resolve_forced_account_index_in(&[], "1").unwrap_err();
        assert_eq!(
            err,
            "codex-multi-auth: --account was set but no Codex accounts are configured. Run `codex-multi-auth login` first."
        );
    }

    #[test]
    fn singular_plural_in_out_of_range_message() {
        let accounts = vec![json!({"email": "only@x.com"})];
        let err = resolve_forced_account_index_in(&accounts, "2").unwrap_err();
        assert!(err.contains("(have 1 account)"));
    }

    #[test]
    fn account_list_formatting_fallback_label() {
        let accounts = vec![json!({"email": ""}), json!({"email": "b@x.com"})];
        let list = format_forced_account_list(&accounts);
        assert_eq!(list, "Available accounts:\n  1. account 1\n  2. b@x.com");
    }

    #[tokio::test]
    async fn apply_no_selector_passes_through() {
        let outcome =
            apply_forced_account_selection(&v(&["exec", "task"]), async |_args| false).await;
        assert_eq!(
            outcome,
            ForcedAccountOutcome::Forward {
                forward_args: v(&["exec", "task"]),
                forced_index: None
            }
        );
    }

    #[tokio::test]
    async fn apply_fails_hard_when_proxy_disabled() {
        let outcome =
            apply_forced_account_selection(&v(&["--account", "1", "exec"]), async |_args| false)
                .await;
        match outcome {
            ForcedAccountOutcome::Error(message) => {
                assert!(message.contains(
                    "--account requires the runtime rotation proxy, which is not active for this command."
                ));
                assert!(message.contains("codex-multi-auth rotation enable"));
                assert!(message.contains("CODEX_MULTI_AUTH_BYPASS"));
            }
            other => panic!("expected error, got {other:?}"),
        }
    }
}
