//! Port of `lib/runtime/event-handler.ts` — the never-throwing wrapper that
//! wires a runtime plugin event into the account-select handler
//! (spec 10 §19).

use crate::account_selection::{AccountSelectEventDeps, RuntimeEvent, handle_account_select_event};

/// Extra wiring for [`handle_runtime_event`] beyond the select-event deps.
pub struct RuntimeEventParams<'a> {
    pub plugin_name: &'a str,
    pub log_debug: &'a mut dyn FnMut(&str),
}

/// TS `handleRuntimeEvent(params)` — delegates to
/// [`handle_account_select_event`]; errors are debug-logged as
/// `"[{plugin}] Event handler error: {msg}"` and never propagated.
pub async fn handle_runtime_event<D: AccountSelectEventDeps>(
    event: &RuntimeEvent,
    deps: &mut D,
    params: &mut RuntimeEventParams<'_>,
) {
    if let Err(error) = handle_account_select_event(event, deps).await {
        (params.log_debug)(&format!(
            "[{}] Event handler error: {}",
            params.plugin_name,
            error.message()
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::errors::CodexError;
    use cma_core::schemas::account_storage::AccountStorageV3;
    use serde_json::json;

    /// Deps whose save always fails — proves the wrapper swallows errors.
    struct FailingDeps;

    impl AccountSelectEventDeps for FailingDeps {
        fn provider_id(&self) -> &str {
            "openai"
        }
        async fn load_accounts(&mut self) -> Result<Option<AccountStorageV3>, CodexError> {
            let mut storage = AccountStorageV3::empty();
            storage.accounts.push(
                cma_core::schemas::account_storage::AccountMetadataV3::new("rt", 1, 1),
            );
            Ok(Some(storage))
        }
        async fn save_accounts(&mut self, _: &AccountStorageV3) -> Result<(), CodexError> {
            Err(CodexError::new("disk full"))
        }
        fn has_cached_account_manager(&self) -> bool {
            false
        }
        async fn sync_codex_cli_active_selection_for_index(
            &mut self,
            _: usize,
        ) -> Result<(), CodexError> {
            Ok(())
        }
        fn set_last_codex_cli_active_sync_index(&mut self, _: usize) {}
        async fn reload_account_manager_from_disk(&mut self) -> Result<(), CodexError> {
            Ok(())
        }
        async fn show_toast(&mut self, _: &str, _: &str) -> Result<(), CodexError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn swallows_errors_and_logs_debug_line() {
        let mut logged = Vec::new();
        let mut log = |m: &str| logged.push(m.to_string());
        let event = RuntimeEvent {
            event_type: "account.select".to_string(),
            properties: Some(json!({"index": 0})),
        };
        handle_runtime_event(
            &event,
            &mut FailingDeps,
            &mut RuntimeEventParams {
                plugin_name: "codex-multi-auth",
                log_debug: &mut log,
            },
        )
        .await;
        assert_eq!(logged.len(), 1);
        assert!(
            logged[0].starts_with("[codex-multi-auth] Event handler error: "),
            "{}",
            logged[0]
        );
        assert!(logged[0].contains("disk full"));
    }
}
