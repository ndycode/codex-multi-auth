//! Port of `lib/runtime/preemptive-quota.ts` — the generic
//! (config-type-parametric) variant of the preemptive-quota settings
//! plumb (spec 10 §22, ARCHITECTURE §6.12). The concrete variant lives in
//! [`crate::quota_settings::apply_preemptive_quota_settings_from_config`].

use crate::quota_settings::PreemptiveQuotaSettings;

/// TS `applyRuntimePreemptiveQuotaSettings(pluginConfig, deps)`.
pub fn apply_runtime_preemptive_quota_settings<TConfig>(
    plugin_config: &TConfig,
    get_preemptive_quota_enabled: impl FnOnce(&TConfig) -> bool,
    get_preemptive_quota_remaining_percent_5h: impl FnOnce(&TConfig) -> f64,
    get_preemptive_quota_remaining_percent_7d: impl FnOnce(&TConfig) -> f64,
    get_preemptive_quota_max_deferral_ms: impl FnOnce(&TConfig) -> f64,
    configure: impl FnOnce(PreemptiveQuotaSettings),
) {
    configure(PreemptiveQuotaSettings {
        enabled: get_preemptive_quota_enabled(plugin_config),
        remaining_percent_threshold_primary: get_preemptive_quota_remaining_percent_5h(
            plugin_config,
        ),
        remaining_percent_threshold_secondary: get_preemptive_quota_remaining_percent_7d(
            plugin_config,
        ),
        max_deferral_ms: get_preemptive_quota_max_deferral_ms(plugin_config),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestConfig {
        enabled: bool,
        p5h: f64,
        p7d: f64,
        max_deferral: f64,
    }

    #[test]
    fn maps_getters_positionally_into_the_configure_payload() {
        let config = TestConfig {
            enabled: true,
            p5h: 12.0,
            p7d: 7.5,
            max_deferral: 45_000.0,
        };
        let mut captured: Option<PreemptiveQuotaSettings> = None;

        apply_runtime_preemptive_quota_settings(
            &config,
            |c| c.enabled,
            |c| c.p5h,
            |c| c.p7d,
            |c| c.max_deferral,
            |settings| captured = Some(settings),
        );

        assert_eq!(
            captured,
            Some(PreemptiveQuotaSettings {
                enabled: true,
                remaining_percent_threshold_primary: 12.0,
                remaining_percent_threshold_secondary: 7.5,
                max_deferral_ms: 45_000.0,
            })
        );
    }
}
