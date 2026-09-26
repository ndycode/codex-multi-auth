//! Port of `lib/runtime/quota-settings.ts` — pipes the four
//! preemptive-quota config getters into a `configure` sink, plus the
//! (misplaced-but-real, TS parity) `resolveUiRuntimeFromConfig`
//! indirection (spec 10 §22, ARCHITECTURE §6.12).

use cma_core::schemas::plugin_config::PluginConfig;

/// The `configure(options)` payload (TS inline object type). The consumer
/// bridges it into `cma_quota::preemptive_scheduler::QuotaSchedulerOptions`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreemptiveQuotaSettings {
    pub enabled: bool,
    pub remaining_percent_threshold_primary: f64,
    pub remaining_percent_threshold_secondary: f64,
    pub max_deferral_ms: f64,
}

/// TS `applyPreemptiveQuotaSettingsFromConfig(pluginConfig, deps)` with the
/// production getters (`cma-config`): `remainingPercent5h` → primary
/// threshold, `remainingPercent7d` → secondary threshold.
pub fn apply_preemptive_quota_settings_from_config(
    plugin_config: &PluginConfig,
    configure: impl FnOnce(PreemptiveQuotaSettings),
) {
    configure(PreemptiveQuotaSettings {
        enabled: cma_config::getters::get_preemptive_quota_enabled(plugin_config),
        remaining_percent_threshold_primary:
            cma_config::getters::get_preemptive_quota_remaining_percent_5h(plugin_config),
        remaining_percent_threshold_secondary:
            cma_config::getters::get_preemptive_quota_remaining_percent_7d(plugin_config),
        max_deferral_ms: cma_config::getters::get_preemptive_quota_max_deferral_ms(plugin_config),
    });
}

/// TS `resolveUiRuntimeFromConfig(loadPluginConfig,
/// applyUiRuntimeFromConfig)` — trivial load-then-apply indirection
/// (lives here in the TS source; kept for parity).
pub fn resolve_ui_runtime_from_config<TUi>(
    load_plugin_config: impl FnOnce() -> PluginConfig,
    apply_ui_runtime_from_config: impl FnOnce(&PluginConfig) -> TUi,
) -> TUi {
    apply_ui_runtime_from_config(&load_plugin_config())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipes_the_four_getters_into_configure() {
        let config = PluginConfig::default();
        let mut captured: Option<PreemptiveQuotaSettings> = None;
        apply_preemptive_quota_settings_from_config(&config, |settings| {
            captured = Some(settings);
        });
        let settings = captured.expect("configure called exactly once");
        // Values flow from the config getters (defaults on an empty config).
        assert_eq!(
            settings.enabled,
            cma_config::getters::get_preemptive_quota_enabled(&config)
        );
        assert_eq!(
            settings.remaining_percent_threshold_primary,
            cma_config::getters::get_preemptive_quota_remaining_percent_5h(&config)
        );
        assert_eq!(
            settings.remaining_percent_threshold_secondary,
            cma_config::getters::get_preemptive_quota_remaining_percent_7d(&config)
        );
        assert_eq!(
            settings.max_deferral_ms,
            cma_config::getters::get_preemptive_quota_max_deferral_ms(&config)
        );
    }

    #[test]
    fn resolve_ui_runtime_loads_then_applies() {
        let result = resolve_ui_runtime_from_config(
            PluginConfig::default,
            |_config| "applied",
        );
        assert_eq!(result, "applied");
    }
}
