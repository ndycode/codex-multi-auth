//! Port of `lib/codex-manager/commands/models.ts`.
//!
//! `models [--json] [--model <model>]` — local model/account capability
//! availability from model profiles, quota cache, and capability policy
//! state. Read-only.

use cma_accounts::capability_matrix::{
    ModelCapabilityMatrix, ModelCapabilityMatrixInput, build_model_capability_matrix,
};
use cma_accounts::capability_policy::CapabilityPolicyStore;
use cma_core::json_io::stringify_pretty2;
use cma_core::schemas::account_storage::AccountStorageV3;
use cma_quota::cache::QuotaCacheData;
use cma_quota::readiness::find_quota_cache_entry_for_account;
use cma_request::model_map::RequestModelCatalog;
use serde_json::{Value, json};

use crate::dispatcher::CliOut;

fn print_models_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth models [--json] [--model <model>]",
            "",
            "Shows local model/account capability availability from model profiles, quota cache, and capability policy state.",
        ]
        .join("\n"),
    );
}

/// Pure matrix builder over pre-loaded state (test seam).
pub fn build_models_matrix(
    storage: Option<&AccountStorageV3>,
    models: &[String],
    quota_cache: Option<&QuotaCacheData>,
    capability_policy: &CapabilityPolicyStore,
    now: i64,
) -> ModelCapabilityMatrix {
    // Pre-resolve the (model-independent) quota-cache entry per account
    // position — the TS called findQuotaCacheEntryForAccount inline.
    let quota_by_account: Option<Vec<Option<Value>>> = storage.map(|storage| {
        storage
            .accounts
            .iter()
            .map(|account| {
                find_quota_cache_entry_for_account(quota_cache, account, &storage.accounts)
                    .and_then(|entry| serde_json::to_value(entry).ok())
            })
            .collect()
    });
    build_model_capability_matrix(
        &RequestModelCatalog,
        &ModelCapabilityMatrixInput {
            storage,
            models: if models.is_empty() { None } else { Some(models) },
            entitlements: None,
            capability_policy: Some(capability_policy),
            quota_by_account: quota_by_account.as_deref(),
            now: Some(now),
        },
    )
}

/// TS `runModelsCommand(args, deps)`.
pub async fn run_models_command(args: &[String], out: &mut CliOut) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_models_usage(out);
        return 0;
    }
    let mut models: Vec<String> = Vec::new();
    let mut json = false;
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--json" || arg == "-j" {
            json = true;
            i += 1;
            continue;
        }
        if arg == "--model" {
            let value = args.get(i + 1).map(|v| v.trim().to_string());
            match value {
                Some(v) if !v.is_empty() && !v.starts_with('-') => {
                    models.push(v);
                    i += 2;
                    continue;
                }
                _ => {
                    out.error("Missing value for --model");
                    return 1;
                }
            }
        }
        if let Some(raw) = arg.strip_prefix("--model=") {
            let value = raw.trim();
            if value.is_empty() || value.starts_with('-') {
                out.error("Missing value for --model");
                return 1;
            }
            models.push(value.to_string());
            i += 1;
            continue;
        }
        out.error(format!("Unknown models option: {arg}"));
        return 1;
    }

    cma_storage::facade::set_storage_path(None);
    let (storage, quota_cache) = tokio::join!(
        cma_storage::load::load_accounts(),
        cma_quota::cache::load_quota_cache(),
    );
    let storage = storage.map(|loaded| loaded.storage);
    let capability_policy =
        CapabilityPolicyStore::with_catalog(cma_request::model_map::shared_model_catalog());
    let matrix = build_models_matrix(
        storage.as_ref(),
        &models,
        Some(&quota_cache),
        &capability_policy,
        cma_core::utils::now_ms(),
    );
    if json {
        out.info(stringify_pretty2(&json!({
            "command": "models",
            "matrix": matrix,
        })));
        return 0;
    }
    if matrix.entries.is_empty() {
        out.info("No accounts configured.");
        return 0;
    }
    for entry in &matrix.entries {
        out.info(format!(
            "{} {}: {}",
            entry.account_label,
            entry.normalized_model,
            if entry.available {
                "available".to_string()
            } else {
                format!("unavailable ({})", entry.reasons.join("; "))
            }
        ));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // Port of test/codex-manager-models-command.test.ts option handling.
    #[tokio::test]
    async fn rejects_unknown_option_and_missing_model_value() {
        let mut out = CliOut::capture();
        let code = run_models_command(&args(&["--bogus"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown models option: --bogus");

        let mut out = CliOut::capture();
        let code = run_models_command(&args(&["--model"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Missing value for --model");

        let mut out = CliOut::capture();
        let code = run_models_command(&args(&["--model", "--json"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Missing value for --model");

        let mut out = CliOut::capture();
        let code = run_models_command(&args(&["--model=  "]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Missing value for --model");
    }

    #[tokio::test]
    async fn help_prints_usage() {
        let mut out = CliOut::capture();
        let code = run_models_command(&args(&["-h"]), &mut out).await;
        assert_eq!(code, 0);
        assert!(out.info_text().contains("codex-multi-auth models [--json] [--model <model>]"));
    }

    #[test]
    fn empty_storage_produces_no_entries() {
        let policy = CapabilityPolicyStore::new();
        let matrix = build_models_matrix(None, &[], None, &policy, 1);
        assert!(matrix.entries.is_empty());
    }

    #[test]
    fn matrix_entries_cover_each_model_per_account() {
        let mut storage = AccountStorageV3::empty();
        storage
            .accounts
            .push(AccountMetadataV3::new("rt-1".to_string(), 1, 0));
        let policy = CapabilityPolicyStore::new();
        let models = vec!["gpt-5.5".to_string()];
        let matrix = build_models_matrix(Some(&storage), &models, None, &policy, 1);
        assert_eq!(matrix.entries.len(), 1);
        assert_eq!(matrix.entries[0].account_label, "Account 1");
        assert_eq!(matrix.entries[0].normalized_model, "gpt-5.5");
    }
}
