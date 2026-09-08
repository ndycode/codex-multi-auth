//! Port of `lib/codex-manager/commands/debug-bundle.ts`.
//!
//! `debug bundle [--json]` — a share-safe diagnostic snapshot. All paths are
//! home-redacted, account ids/emails masked, and config values routed through
//! the logger's `sanitize_value` (errors-logging-04).

use chrono::{SecondsFormat, Utc};
use cma_cli_mirror::state::CodexCliState;
use cma_config::explain::{ConfigExplainReport, get_plugin_config_explain_report};
use cma_core::json_io::stringify_pretty2;
use cma_core::logger::{mask_email, mask_token, sanitize_value};
use cma_core::schemas::account_storage::AccountStorageV3;
use serde_json::{Map, Value, json};

use crate::dispatcher::{CliOut, js_number};

/// `os.homedir()` analogue for the redactor: `USERPROFILE` on Windows,
/// `HOME` on POSIX (empty string when unset — TS then skips redaction).
fn os_homedir() -> String {
    if cfg!(windows) {
        std::env::var("USERPROFILE")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_default()
    } else {
        std::env::var("HOME").unwrap_or_default()
    }
}

/// Platform-injectable core of [`redact_home`] (exported for tests — the TS
/// module exports `redactHome` itself for the same reason).
pub fn redact_home_with(value: &str, home: &str, is_windows: bool) -> String {
    if home.is_empty() {
        return value.to_string();
    }

    // On win32 the comparison must be case-insensitive AND separator-
    // insensitive; the ORIGINAL `value` keeps its separators in the suffix.
    let canon = |s: &str| -> String {
        if is_windows {
            s.to_lowercase().replace('/', "\\")
        } else {
            s.to_string()
        }
    };
    let normalized_value = canon(value);
    let normalized_home = canon(home);

    if normalized_value == normalized_home {
        return "~".to_string();
    }

    // Require a path boundary after the home prefix so `/users/alice2` is not
    // treated as living under home `/users/alice`.
    if normalized_value.starts_with(&normalized_home) {
        let boundary = normalized_value[normalized_home.len()..].chars().next();
        let sep = if is_windows { '\\' } else { '/' };
        if matches!(boundary, Some(b) if b == sep || b == '/' || b == '\\') {
            // `home.len()` in TS is a UTF-16 unit count into `value`; paths
            // are byte-compatible here because the canonicalization never
            // changes lengths for ASCII drive/sep transforms. Use the char
            // boundary from the ORIGINAL value.
            let suffix: String = value.chars().skip(home.chars().count()).collect();
            return format!("~{suffix}");
        }
    }

    value.to_string()
}

/// TS `redactHome(value)` — replace the home-directory prefix with `~`,
/// path-boundary aware.
pub fn redact_home(value: &str) -> String {
    redact_home_with(value, &os_homedir(), cfg!(windows))
}

/// TS `sanitizeConfigReport` — redact the config path, sanitize every entry
/// `value`/`defaultValue`. Emits the report in explain key order.
pub fn sanitize_config_report_value(report: &ConfigExplainReport, home: &str, is_windows: bool) -> Value {
    let mut root = Map::new();
    root.insert(
        "configPath".to_string(),
        match &report.config_path {
            Some(path) => Value::String(redact_home_with(
                &path.to_string_lossy(),
                home,
                is_windows,
            )),
            None => Value::Null,
        },
    );
    root.insert(
        "storageKind".to_string(),
        Value::String(report.storage_kind.as_str().to_string()),
    );
    let entries: Vec<Value> = report
        .entries
        .iter()
        .map(|entry| {
            let mut object = Map::new();
            object.insert("key".to_string(), Value::String(entry.key.to_string()));
            object.insert("value".to_string(), sanitize_value(&entry.value));
            object.insert(
                "defaultValue".to_string(),
                sanitize_value(&entry.default_value),
            );
            object.insert(
                "source".to_string(),
                Value::String(entry.source.as_str().to_string()),
            );
            object.insert(
                "envNames".to_string(),
                Value::Array(
                    entry
                        .env_names
                        .iter()
                        .map(|name| Value::String((*name).to_string()))
                        .collect(),
                ),
            );
            Value::Object(object)
        })
        .collect();
    root.insert("entries".to_string(), Value::Array(entries));
    Value::Object(root)
}

/// Inputs for [`build_debug_bundle`] (the loaders' outputs).
pub struct DebugBundleData<'a> {
    pub generated_at: String,
    pub storage_path: String,
    pub last_accounts_save_timestamp: i64,
    pub config: &'a ConfigExplainReport,
    pub accounts: Option<&'a AccountStorageV3>,
    pub flagged_total: usize,
    pub codex_cli: Option<&'a CodexCliState>,
}

/// Pure bundle builder (exact TS key order).
pub fn build_debug_bundle(data: &DebugBundleData<'_>, home: &str, is_windows: bool) -> Value {
    let total = data.accounts.map(|s| s.accounts.len()).unwrap_or(0);
    let enabled = data
        .accounts
        .map(|s| {
            s.accounts
                .iter()
                .filter(|account| account.enabled != Some(false))
                .count()
        })
        .unwrap_or(0);
    // `activeIndex` is always numeric in the Rust storage model; the TS
    // typeof-number guard is vacuously true when storage exists.
    let active_index = data
        .accounts
        .map(|s| Value::from(s.active_index + 1))
        .unwrap_or(Value::Null);

    let codex_cli = match data.codex_cli {
        Some(state) => json!({
            "path": redact_home_with(&state.path.to_string_lossy(), home, is_windows),
            "accountCount": state.accounts.len(),
            "activeEmail": state.active_email.as_deref().map(mask_email),
            "activeAccountId": state.active_account_id.as_deref().map(mask_token),
            "syncVersion": state.sync_version.map(js_number),
            "sourceUpdatedAtMs": state.source_updated_at_ms.map(js_number),
        }),
        None => Value::Null,
    };

    json!({
        "generatedAt": data.generated_at,
        "storagePath": redact_home_with(&data.storage_path, home, is_windows),
        "lastAccountsSaveTimestamp": data.last_accounts_save_timestamp,
        "config": sanitize_config_report_value(data.config, home, is_windows),
        "accounts": {
            "total": total,
            "enabled": enabled,
            "activeIndex": active_index,
        },
        "flaggedAccounts": {
            "total": data.flagged_total,
        },
        "codexCli": codex_cli,
    })
}

/// Emit the bundle (shared by the injectable test path and production).
fn emit_bundle(bundle: &Value, json: bool, out: &mut CliOut) -> i32 {
    if json {
        out.info(stringify_pretty2(bundle));
        return 0;
    }
    out.info(format!(
        "Generated: {}",
        bundle["generatedAt"].as_str().unwrap_or("")
    ));
    out.info(format!(
        "Storage: {}",
        bundle["storagePath"].as_str().unwrap_or("")
    ));
    out.info(format!(
        "Accounts: {} total, {} enabled",
        bundle["accounts"]["total"], bundle["accounts"]["enabled"]
    ));
    out.info(format!("Flagged: {}", bundle["flaggedAccounts"]["total"]));
    if bundle["codexCli"].is_object() {
        out.info(format!(
            "Codex CLI: {} account(s), active {}",
            bundle["codexCli"]["accountCount"],
            bundle["codexCli"]["activeEmail"]
                .as_str()
                .unwrap_or("unknown")
        ));
    }
    0
}

/// TS `runDebugBundleCommand(args, deps)`.
pub async fn run_debug_bundle_command(args: &[String], out: &mut CliOut) -> i32 {
    let json = args.iter().any(|arg| arg == "--json");
    if let Some(unknown) = args.iter().find(|arg| arg.as_str() != "--json") {
        out.error(format!("Unknown option: {unknown}"));
        return 1;
    }

    let config = get_plugin_config_explain_report();
    let accounts = cma_storage::load::load_accounts()
        .await
        .map(|loaded| loaded.storage);
    let flagged = cma_storage::flagged::load_flagged_accounts().await;
    let codex_cli = cma_cli_mirror::state::load_codex_cli_state(true).await;

    let data = DebugBundleData {
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        storage_path: cma_storage::facade::get_storage_path(),
        last_accounts_save_timestamp: cma_storage::facade::get_last_accounts_save_timestamp(),
        config: &config,
        accounts: accounts.as_ref(),
        flagged_total: flagged.accounts.len(),
        codex_cli: codex_cli.as_ref(),
    };
    let bundle = build_debug_bundle(&data, &os_homedir(), cfg!(windows));
    emit_bundle(&bundle, json, out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_config::explain::{ConfigExplainEntry, ConfigExplainSource, ConfigExplainStorageKind};

    // Port of test/debug-bundle-redact.test.ts (errors-logging-04).

    #[test]
    fn posix_path_rules() {
        let home = "/home/alice";
        assert_eq!(
            redact_home_with("/home/alice/.codex/config.json", home, false),
            "~/.codex/config.json"
        );
        assert_eq!(redact_home_with("/home/alice", home, false), "~");
        assert_eq!(
            redact_home_with("/home/alice2/.codex/config.json", home, false),
            "/home/alice2/.codex/config.json"
        );
        // Case-sensitive on posix.
        assert_eq!(
            redact_home_with("/HOME/Alice/.codex", home, false),
            "/HOME/Alice/.codex"
        );
    }

    #[test]
    fn windows_path_rules() {
        let home = "C:\\Users\\Alice";
        assert_eq!(
            redact_home_with("c:\\users\\alice\\.codex\\config.json", home, true),
            "~\\.codex\\config.json"
        );
        // Mixed-separator windows path keeps original separators in suffix.
        assert_eq!(
            redact_home_with("c:/users/alice/.codex/config.json", home, true),
            "~/.codex/config.json"
        );
        assert_eq!(redact_home_with("C:\\USERS\\ALICE", home, true), "~");
        assert_eq!(
            redact_home_with("c:\\users\\alice2\\.codex", home, true),
            "c:\\users\\alice2\\.codex"
        );
    }

    #[test]
    fn empty_home_returns_value_unchanged() {
        assert_eq!(
            redact_home_with("/home/alice/.codex", "", false),
            "/home/alice/.codex"
        );
    }

    #[test]
    fn json_bundle_redacts_and_masks() {
        let report = ConfigExplainReport {
            config_path: Some(std::path::PathBuf::from("/home/alice/.codex/config.json")),
            storage_kind: ConfigExplainStorageKind::Unified,
            entries: vec![ConfigExplainEntry {
                key: "codexRuntimeRotationProxy",
                value: serde_json::json!("http://user:s3cr3t-pass@proxy.internal:8080"),
                default_value: serde_json::Value::Null,
                source: ConfigExplainSource::Unified,
                env_names: &[],
            }],
        };
        let mut cli_state = CodexCliState {
            path: std::path::PathBuf::from("/home/alice/.codex"),
            accounts: Vec::new(),
            active_account_id: Some("org-1234567890abcdef".to_string()),
            active_email: Some("alice@example.com".to_string()),
            sync_version: None,
            source_updated_at_ms: None,
        };
        cli_state.sync_version = Some(3.0);
        let data = DebugBundleData {
            generated_at: "2026-01-01T00:00:00.000Z".to_string(),
            storage_path: "/home/alice/.codex/accounts.json".to_string(),
            last_accounts_save_timestamp: 0,
            config: &report,
            accounts: None,
            flagged_total: 0,
            codex_cli: Some(&cli_state),
        };
        let bundle = build_debug_bundle(&data, "/home/alice", false);
        let text = serde_json::to_string(&bundle).unwrap();
        assert!(text.contains("~/.codex/config.json"));
        assert!(!text.contains("/home/alice/.codex/config.json"));
        assert!(!text.contains("org-1234567890abcdef"));
        assert!(!text.contains("alice@example.com"));
        assert!(!text.contains("s3cr3t-pass"));
        assert_eq!(bundle["accounts"]["activeIndex"], serde_json::Value::Null);
        assert_eq!(bundle["codexCli"]["syncVersion"], 3);
    }

    #[test]
    fn text_mode_lines() {
        let report = ConfigExplainReport {
            config_path: None,
            storage_kind: ConfigExplainStorageKind::None,
            entries: vec![],
        };
        let data = DebugBundleData {
            generated_at: "2026-01-01T00:00:00.000Z".to_string(),
            storage_path: "/x/accounts.json".to_string(),
            last_accounts_save_timestamp: 0,
            config: &report,
            accounts: None,
            flagged_total: 2,
            codex_cli: None,
        };
        let bundle = build_debug_bundle(&data, "/home/alice", false);
        let mut out = CliOut::capture();
        assert_eq!(emit_bundle(&bundle, false, &mut out), 0);
        assert_eq!(
            out.info_text(),
            [
                "Generated: 2026-01-01T00:00:00.000Z",
                "Storage: /x/accounts.json",
                "Accounts: 0 total, 0 enabled",
                "Flagged: 2",
            ]
            .join("\n")
        );
    }

    #[tokio::test]
    async fn rejects_unknown_options() {
        let mut out = CliOut::capture();
        let code = run_debug_bundle_command(&["-j".to_string()], &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown option: -j");
    }
}
