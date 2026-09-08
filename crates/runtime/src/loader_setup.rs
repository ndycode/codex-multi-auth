//! Port of `lib/runtime/loader-setup.ts` — the fixed-order loader runtime
//! setup (spec 10 §22, ARCHITECTURE §6.12).
//!
//! Order is CONTRACT: UI runtime → account-storage scope → session
//! affinity → refresh guardian → preemptive-quota settings.

use cma_core::schemas::plugin_config::PluginConfig;

/// TS `applyLoaderRuntimeSetup(params)` — runs the five setup steps in the
/// contractual order, passing each the same resolved plugin config.
pub fn apply_loader_runtime_setup(
    plugin_config: &PluginConfig,
    apply_ui_runtime_from_config: impl FnOnce(&PluginConfig),
    apply_account_storage_scope: impl FnOnce(&PluginConfig),
    ensure_session_affinity: impl FnOnce(&PluginConfig),
    ensure_refresh_guardian: impl FnOnce(&PluginConfig),
    apply_preemptive_quota_settings: impl FnOnce(&PluginConfig),
) {
    apply_ui_runtime_from_config(plugin_config);
    apply_account_storage_scope(plugin_config);
    ensure_session_affinity(plugin_config);
    ensure_refresh_guardian(plugin_config);
    apply_preemptive_quota_settings(plugin_config);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn runs_the_five_steps_in_the_contractual_order() {
        let order: RefCell<Vec<&'static str>> = RefCell::new(Vec::new());
        let config = PluginConfig::default();

        apply_loader_runtime_setup(
            &config,
            |_c| order.borrow_mut().push("ui-runtime"),
            |_c| order.borrow_mut().push("storage-scope"),
            |_c| order.borrow_mut().push("session-affinity"),
            |_c| order.borrow_mut().push("refresh-guardian"),
            |_c| order.borrow_mut().push("preemptive-quota"),
        );

        assert_eq!(
            order.into_inner(),
            vec![
                "ui-runtime",
                "storage-scope",
                "session-affinity",
                "refresh-guardian",
                "preemptive-quota",
            ]
        );
    }
}
