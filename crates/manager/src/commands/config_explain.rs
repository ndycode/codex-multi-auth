//! Port of `lib/codex-manager/commands/config-explain.ts`.
//!
//! `config explain [--json]` — renders the 53-entry config explain report.
//! Only `--json` is accepted (NOT `-j`, TS parity); any other arg errors.

use cma_config::explain::{ConfigExplainReport, get_plugin_config_explain_report};
use cma_core::json_io::{stringify_compact, stringify_pretty2};
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;

/// Serialize a [`ConfigExplainReport`] with the exact TS key order:
/// `{ configPath, storageKind, entries: [{key, value, defaultValue, source,
/// envNames}] }`.
pub fn config_explain_report_to_value(report: &ConfigExplainReport) -> Value {
    let mut root = Map::new();
    root.insert(
        "configPath".to_string(),
        match &report.config_path {
            Some(path) => Value::String(path.to_string_lossy().into_owned()),
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
            object.insert("value".to_string(), entry.value.clone());
            object.insert("defaultValue".to_string(), entry.default_value.clone());
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

/// Report-provider seam (the TS `deps.getReport` may throw; production wraps
/// the infallible getter in `Ok`).
pub fn run_config_explain_with(
    args: &[String],
    get_report: impl FnOnce() -> Result<ConfigExplainReport, String>,
    out: &mut CliOut,
) -> i32 {
    let json = args.iter().any(|arg| arg == "--json");
    if let Some(unknown) = args.iter().find(|arg| arg.as_str() != "--json") {
        out.error(format!("Unknown option: {unknown}"));
        return 1;
    }

    let report = match get_report() {
        Ok(report) => report,
        Err(message) => {
            out.error(format!("Failed to read config: {message}"));
            return 1;
        }
    };
    if json {
        out.info(stringify_pretty2(&config_explain_report_to_value(&report)));
        return 0;
    }

    out.info(format!("Config storage: {}", report.storage_kind.as_str()));
    out.info(format!(
        "Config path: {}",
        report
            .config_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| "(none)".to_string())
    ));
    out.info("");
    for entry in &report.entries {
        let env_suffix = if entry.env_names.is_empty() {
            String::new()
        } else {
            format!(" [{}]", entry.env_names.join(", "))
        };
        out.info(format!(
            "{} = {} ({}){}",
            entry.key,
            stringify_compact(&entry.value),
            entry.source.as_str(),
            env_suffix
        ));
    }
    0
}

/// Production entry (TS `runConfigExplainCommand(args, { getReport })`).
pub fn run_config_explain_command(args: &[String], out: &mut CliOut) -> i32 {
    run_config_explain_with(args, || Ok(get_plugin_config_explain_report()), out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_config::explain::{ConfigExplainEntry, ConfigExplainSource, ConfigExplainStorageKind};
    use serde_json::json;

    fn fake_report() -> ConfigExplainReport {
        ConfigExplainReport {
            config_path: Some(std::path::PathBuf::from("/tmp/config.json")),
            storage_kind: ConfigExplainStorageKind::Unified,
            entries: vec![
                ConfigExplainEntry {
                    key: "debug",
                    value: json!(true),
                    default_value: json!(false),
                    source: ConfigExplainSource::Env,
                    env_names: &["CODEX_AUTH_DEBUG"],
                },
                ConfigExplainEntry {
                    key: "quotaThreshold",
                    value: json!(0.95),
                    default_value: json!(0.95),
                    source: ConfigExplainSource::Default,
                    env_names: &[],
                },
            ],
        }
    }

    #[test]
    fn rejects_unknown_options_with_exact_string() {
        let mut out = CliOut::capture();
        let code = run_config_explain_with(
            &["-j".to_string()],
            || Ok(fake_report()),
            &mut out,
        );
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown option: -j");
    }

    #[test]
    fn reports_getter_failure() {
        let mut out = CliOut::capture();
        let code = run_config_explain_with(&[], || Err("boom".to_string()), &mut out);
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Failed to read config: boom");
    }

    #[test]
    fn text_mode_prints_storage_path_and_entries() {
        let mut out = CliOut::capture();
        let code = run_config_explain_with(&[], || Ok(fake_report()), &mut out);
        assert_eq!(code, 0);
        let text = out.info_text();
        assert_eq!(
            text,
            [
                "Config storage: unified",
                "Config path: /tmp/config.json",
                "",
                "debug = true (env) [CODEX_AUTH_DEBUG]",
                "quotaThreshold = 0.95 (default)",
            ]
            .join("\n")
        );
    }

    #[test]
    fn json_mode_prints_report_verbatim_with_key_order() {
        let mut out = CliOut::capture();
        let code =
            run_config_explain_with(&["--json".to_string()], || Ok(fake_report()), &mut out);
        assert_eq!(code, 0);
        let text = out.info_text();
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["configPath"], json!("/tmp/config.json"));
        assert_eq!(parsed["storageKind"], json!("unified"));
        assert_eq!(parsed["entries"][0]["key"], json!("debug"));
        assert_eq!(parsed["entries"][0]["envNames"], json!(["CODEX_AUTH_DEBUG"]));
        // Key order is part of the byte contract.
        assert!(text.find("\"configPath\"").unwrap() < text.find("\"storageKind\"").unwrap());
        assert!(text.find("\"storageKind\"").unwrap() < text.find("\"entries\"").unwrap());
        let entry_start = text.find("\"key\"").unwrap();
        assert!(entry_start < text.find("\"value\"").unwrap());
        assert!(text.find("\"value\"").unwrap() < text.find("\"defaultValue\"").unwrap());
        assert!(text.find("\"defaultValue\"").unwrap() < text.find("\"source\"").unwrap());
        assert!(text.find("\"source\"").unwrap() < text.find("\"envNames\"").unwrap());
    }
}
