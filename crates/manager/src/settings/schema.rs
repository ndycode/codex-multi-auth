//! Port of `lib/codex-manager/backend-settings-schema.ts` +
//! `experimental-settings-schema.ts` — the hand-rolled schema for the 11
//! backend toggles, 16 bounded numerics, and the 4 category groupings, plus
//! the experimental panel's action union and hotkey mappers.
//!
//! Labels, descriptions, bounds, steps, and units are copy-exact from the TS
//! source (spec 09 §5.13/§5.14). `BACKEND_DEFAULTS` is
//! `getDefaultPluginConfig()` evaluated on demand (TS evaluates once at module
//! load; the Rust accessor is pure so the distinction is unobservable).

use cma_core::schemas::plugin_config::PluginConfig;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// `BackendToggleSettingKey` (11 keys).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BackendToggleSettingKey {
    LiveAccountSync,
    SessionAffinity,
    ProactiveRefreshGuardian,
    RetryAllAccountsRateLimited,
    ParallelProbing,
    StorageBackupEnabled,
    PreemptiveQuotaEnabled,
    FastSession,
    SessionRecovery,
    AutoResume,
    PerProjectAccounts,
}

impl BackendToggleSettingKey {
    /// The camelCase TS key string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LiveAccountSync => "liveAccountSync",
            Self::SessionAffinity => "sessionAffinity",
            Self::ProactiveRefreshGuardian => "proactiveRefreshGuardian",
            Self::RetryAllAccountsRateLimited => "retryAllAccountsRateLimited",
            Self::ParallelProbing => "parallelProbing",
            Self::StorageBackupEnabled => "storageBackupEnabled",
            Self::PreemptiveQuotaEnabled => "preemptiveQuotaEnabled",
            Self::FastSession => "fastSession",
            Self::SessionRecovery => "sessionRecovery",
            Self::AutoResume => "autoResume",
            Self::PerProjectAccounts => "perProjectAccounts",
        }
    }

    /// Read this toggle from a `PluginConfig`.
    pub fn get(self, config: &PluginConfig) -> Option<bool> {
        match self {
            Self::LiveAccountSync => config.live_account_sync,
            Self::SessionAffinity => config.session_affinity,
            Self::ProactiveRefreshGuardian => config.proactive_refresh_guardian,
            Self::RetryAllAccountsRateLimited => config.retry_all_accounts_rate_limited,
            Self::ParallelProbing => config.parallel_probing,
            Self::StorageBackupEnabled => config.storage_backup_enabled,
            Self::PreemptiveQuotaEnabled => config.preemptive_quota_enabled,
            Self::FastSession => config.fast_session,
            Self::SessionRecovery => config.session_recovery,
            Self::AutoResume => config.auto_resume,
            Self::PerProjectAccounts => config.per_project_accounts,
        }
    }

    /// Write this toggle into a `PluginConfig`.
    pub fn set(self, config: &mut PluginConfig, value: Option<bool>) {
        match self {
            Self::LiveAccountSync => config.live_account_sync = value,
            Self::SessionAffinity => config.session_affinity = value,
            Self::ProactiveRefreshGuardian => config.proactive_refresh_guardian = value,
            Self::RetryAllAccountsRateLimited => config.retry_all_accounts_rate_limited = value,
            Self::ParallelProbing => config.parallel_probing = value,
            Self::StorageBackupEnabled => config.storage_backup_enabled = value,
            Self::PreemptiveQuotaEnabled => config.preemptive_quota_enabled = value,
            Self::FastSession => config.fast_session = value,
            Self::SessionRecovery => config.session_recovery = value,
            Self::AutoResume => config.auto_resume = value,
            Self::PerProjectAccounts => config.per_project_accounts = value,
        }
    }
}

/// `BackendNumberSettingKey` (16 keys).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BackendNumberSettingKey {
    LiveAccountSyncDebounceMs,
    LiveAccountSyncPollMs,
    SessionAffinityTtlMs,
    SessionAffinityMaxEntries,
    ProactiveRefreshIntervalMs,
    ProactiveRefreshBufferMs,
    ParallelProbingMaxConcurrency,
    FastSessionMaxInputItems,
    NetworkErrorCooldownMs,
    ServerErrorCooldownMs,
    FetchTimeoutMs,
    StreamStallTimeoutMs,
    TokenRefreshSkewMs,
    PreemptiveQuotaRemainingPercent5h,
    PreemptiveQuotaRemainingPercent7d,
    PreemptiveQuotaMaxDeferralMs,
}

impl BackendNumberSettingKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LiveAccountSyncDebounceMs => "liveAccountSyncDebounceMs",
            Self::LiveAccountSyncPollMs => "liveAccountSyncPollMs",
            Self::SessionAffinityTtlMs => "sessionAffinityTtlMs",
            Self::SessionAffinityMaxEntries => "sessionAffinityMaxEntries",
            Self::ProactiveRefreshIntervalMs => "proactiveRefreshIntervalMs",
            Self::ProactiveRefreshBufferMs => "proactiveRefreshBufferMs",
            Self::ParallelProbingMaxConcurrency => "parallelProbingMaxConcurrency",
            Self::FastSessionMaxInputItems => "fastSessionMaxInputItems",
            Self::NetworkErrorCooldownMs => "networkErrorCooldownMs",
            Self::ServerErrorCooldownMs => "serverErrorCooldownMs",
            Self::FetchTimeoutMs => "fetchTimeoutMs",
            Self::StreamStallTimeoutMs => "streamStallTimeoutMs",
            Self::TokenRefreshSkewMs => "tokenRefreshSkewMs",
            Self::PreemptiveQuotaRemainingPercent5h => "preemptiveQuotaRemainingPercent5h",
            Self::PreemptiveQuotaRemainingPercent7d => "preemptiveQuotaRemainingPercent7d",
            Self::PreemptiveQuotaMaxDeferralMs => "preemptiveQuotaMaxDeferralMs",
        }
    }

    pub fn get(self, config: &PluginConfig) -> Option<f64> {
        match self {
            Self::LiveAccountSyncDebounceMs => config.live_account_sync_debounce_ms,
            Self::LiveAccountSyncPollMs => config.live_account_sync_poll_ms,
            Self::SessionAffinityTtlMs => config.session_affinity_ttl_ms,
            Self::SessionAffinityMaxEntries => config.session_affinity_max_entries,
            Self::ProactiveRefreshIntervalMs => config.proactive_refresh_interval_ms,
            Self::ProactiveRefreshBufferMs => config.proactive_refresh_buffer_ms,
            Self::ParallelProbingMaxConcurrency => config.parallel_probing_max_concurrency,
            Self::FastSessionMaxInputItems => config.fast_session_max_input_items,
            Self::NetworkErrorCooldownMs => config.network_error_cooldown_ms,
            Self::ServerErrorCooldownMs => config.server_error_cooldown_ms,
            Self::FetchTimeoutMs => config.fetch_timeout_ms,
            Self::StreamStallTimeoutMs => config.stream_stall_timeout_ms,
            Self::TokenRefreshSkewMs => config.token_refresh_skew_ms,
            Self::PreemptiveQuotaRemainingPercent5h => config.preemptive_quota_remaining_percent_5h,
            Self::PreemptiveQuotaRemainingPercent7d => config.preemptive_quota_remaining_percent_7d,
            Self::PreemptiveQuotaMaxDeferralMs => config.preemptive_quota_max_deferral_ms,
        }
    }

    pub fn set(self, config: &mut PluginConfig, value: Option<f64>) {
        match self {
            Self::LiveAccountSyncDebounceMs => config.live_account_sync_debounce_ms = value,
            Self::LiveAccountSyncPollMs => config.live_account_sync_poll_ms = value,
            Self::SessionAffinityTtlMs => config.session_affinity_ttl_ms = value,
            Self::SessionAffinityMaxEntries => config.session_affinity_max_entries = value,
            Self::ProactiveRefreshIntervalMs => config.proactive_refresh_interval_ms = value,
            Self::ProactiveRefreshBufferMs => config.proactive_refresh_buffer_ms = value,
            Self::ParallelProbingMaxConcurrency => config.parallel_probing_max_concurrency = value,
            Self::FastSessionMaxInputItems => config.fast_session_max_input_items = value,
            Self::NetworkErrorCooldownMs => config.network_error_cooldown_ms = value,
            Self::ServerErrorCooldownMs => config.server_error_cooldown_ms = value,
            Self::FetchTimeoutMs => config.fetch_timeout_ms = value,
            Self::StreamStallTimeoutMs => config.stream_stall_timeout_ms = value,
            Self::TokenRefreshSkewMs => config.token_refresh_skew_ms = value,
            Self::PreemptiveQuotaRemainingPercent5h => {
                config.preemptive_quota_remaining_percent_5h = value
            }
            Self::PreemptiveQuotaRemainingPercent7d => {
                config.preemptive_quota_remaining_percent_7d = value
            }
            Self::PreemptiveQuotaMaxDeferralMs => config.preemptive_quota_max_deferral_ms = value,
        }
    }
}

/// `BackendSettingFocusKey = BackendToggleSettingKey | BackendNumberSettingKey | null`
/// (`None` = the TS `null`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendSettingFocusKey {
    Toggle(BackendToggleSettingKey),
    Number(BackendNumberSettingKey),
}

// ---------------------------------------------------------------------------
// Option tables
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BackendToggleSettingOption {
    pub key: BackendToggleSettingKey,
    pub label: &'static str,
    pub description: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BackendNumberSettingOption {
    pub key: BackendNumberSettingKey,
    pub label: &'static str,
    pub description: &'static str,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub unit: BackendNumberUnit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendNumberUnit {
    Ms,
    Percent,
    Count,
}

/// `BACKEND_TOGGLE_OPTIONS` — order matters for numeric hotkeys.
pub const BACKEND_TOGGLE_OPTIONS: [BackendToggleSettingOption; 11] = [
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::LiveAccountSync,
        label: "Enable Live Sync",
        description: "Keep accounts synced when files change in another window.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::SessionAffinity,
        label: "Enable Session Affinity",
        description: "Try to keep each conversation on the same account.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::ProactiveRefreshGuardian,
        label: "Enable Token Refresh Guard",
        description: "Refresh tokens early in the background.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::RetryAllAccountsRateLimited,
        label: "Retry When All Rate-Limited",
        description: "If all accounts are limited, wait and try again.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::ParallelProbing,
        label: "Enable Parallel Probing",
        description: "Check multiple accounts at the same time.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::StorageBackupEnabled,
        label: "Enable Storage Backups",
        description: "Create a backup before account data changes.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::PreemptiveQuotaEnabled,
        label: "Enable Quota Deferral",
        description: "Delay requests before limits are fully exhausted.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::FastSession,
        label: "Enable Fast Session Mode",
        description: "Use lighter request handling for faster responses.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::SessionRecovery,
        label: "Enable Session Recovery",
        description: "Restore recoverable sessions after restart.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::AutoResume,
        label: "Enable Auto Resume",
        description: "Resume the most recent recoverable session automatically.",
    },
    BackendToggleSettingOption {
        key: BackendToggleSettingKey::PerProjectAccounts,
        label: "Enable Per-Project Accounts",
        description: "Use repo-specific account storage instead of a global pool.",
    },
];

/// `BACKEND_NUMBER_OPTIONS` — bounds table from spec 09 §5.13.
pub const BACKEND_NUMBER_OPTIONS: [BackendNumberSettingOption; 16] = [
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::LiveAccountSyncDebounceMs,
        label: "Live Sync Debounce",
        description: "Delay before reacting to file changes.",
        min: 50.0,
        max: 10_000.0,
        step: 50.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::LiveAccountSyncPollMs,
        label: "Live Sync Poll Interval",
        description: "Polling fallback interval for external file changes.",
        min: 500.0,
        max: 60_000.0,
        step: 500.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::SessionAffinityTtlMs,
        label: "Session Affinity TTL",
        description: "How long affinity survives without activity.",
        min: 1_000.0,
        max: 86_400_000.0,
        step: 60_000.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::SessionAffinityMaxEntries,
        label: "Session Affinity Max Entries",
        description: "Upper bound for tracked affinity sessions.",
        min: 8.0,
        max: 4_096.0,
        step: 32.0,
        unit: BackendNumberUnit::Count,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::ProactiveRefreshIntervalMs,
        label: "Refresh Guard Interval",
        description: "How often the guard scans for refresh work.",
        min: 5_000.0,
        max: 600_000.0,
        step: 5_000.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::ProactiveRefreshBufferMs,
        label: "Refresh Guard Buffer",
        description: "How early tokens should refresh before expiry.",
        min: 30_000.0,
        max: 600_000.0,
        step: 30_000.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::ParallelProbingMaxConcurrency,
        label: "Parallel Probe Concurrency",
        description: "Maximum simultaneous account probes.",
        min: 1.0,
        max: 5.0,
        step: 1.0,
        unit: BackendNumberUnit::Count,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::FastSessionMaxInputItems,
        label: "Fast Session Max Inputs",
        description: "Maximum prompt items kept in fast-session mode.",
        min: 8.0,
        max: 200.0,
        step: 2.0,
        unit: BackendNumberUnit::Count,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::NetworkErrorCooldownMs,
        label: "Network Error Cooldown",
        description: "Cooldown applied after network failures.",
        min: 0.0,
        max: 120_000.0,
        step: 500.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::ServerErrorCooldownMs,
        label: "Server Error Cooldown",
        description: "Cooldown applied after upstream server failures.",
        min: 0.0,
        max: 120_000.0,
        step: 500.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::FetchTimeoutMs,
        label: "Request Timeout",
        description: "Max time to wait for a request.",
        min: 1_000.0,
        // TS: (10 * 60 * 60_000) / 60 = 600_000.
        max: (10.0 * 60.0 * 60_000.0) / 60.0,
        step: 5_000.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::StreamStallTimeoutMs,
        label: "Stream Stall Timeout",
        description: "Max wait before a stuck stream is retried.",
        min: 1_000.0,
        max: (10.0 * 60.0 * 60_000.0) / 60.0,
        step: 5_000.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::TokenRefreshSkewMs,
        label: "Token Refresh Buffer",
        description: "Refresh this long before token expiry.",
        min: 0.0,
        max: (10.0 * 60.0 * 60_000.0) / 60.0,
        step: 10_000.0,
        unit: BackendNumberUnit::Ms,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::PreemptiveQuotaRemainingPercent5h,
        label: "5h Remaining Threshold",
        description: "Start delaying when 5h remaining reaches this percent.",
        min: 0.0,
        max: 100.0,
        step: 1.0,
        unit: BackendNumberUnit::Percent,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::PreemptiveQuotaRemainingPercent7d,
        label: "7d Remaining Threshold",
        description: "Start delaying when weekly remaining reaches this percent.",
        min: 0.0,
        max: 100.0,
        step: 1.0,
        unit: BackendNumberUnit::Percent,
    },
    BackendNumberSettingOption {
        key: BackendNumberSettingKey::PreemptiveQuotaMaxDeferralMs,
        label: "Max Preemptive Deferral",
        description: "Maximum time allowed for quota-based delay.",
        min: 1_000.0,
        max: 24.0 * 60.0 * 60_000.0,
        step: 60_000.0,
        unit: BackendNumberUnit::Ms,
    },
];

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BackendCategoryKey {
    SessionSync,
    RotationQuota,
    RefreshRecovery,
    PerformanceTimeouts,
}

impl BackendCategoryKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionSync => "session-sync",
            Self::RotationQuota => "rotation-quota",
            Self::RefreshRecovery => "refresh-recovery",
            Self::PerformanceTimeouts => "performance-timeouts",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BackendCategoryOption {
    pub key: BackendCategoryKey,
    pub label: &'static str,
    pub description: &'static str,
    pub toggle_keys: &'static [BackendToggleSettingKey],
    pub number_keys: &'static [BackendNumberSettingKey],
}

/// `BACKEND_CATEGORY_OPTIONS` (4 categories, member order preserved).
pub const BACKEND_CATEGORY_OPTIONS: [BackendCategoryOption; 4] = [
    BackendCategoryOption {
        key: BackendCategoryKey::SessionSync,
        label: "Session & Sync",
        description: "Sync and session behavior.",
        toggle_keys: &[
            BackendToggleSettingKey::LiveAccountSync,
            BackendToggleSettingKey::SessionAffinity,
            BackendToggleSettingKey::PerProjectAccounts,
            BackendToggleSettingKey::SessionRecovery,
            BackendToggleSettingKey::AutoResume,
        ],
        number_keys: &[
            BackendNumberSettingKey::LiveAccountSyncDebounceMs,
            BackendNumberSettingKey::LiveAccountSyncPollMs,
            BackendNumberSettingKey::SessionAffinityTtlMs,
            BackendNumberSettingKey::SessionAffinityMaxEntries,
        ],
    },
    BackendCategoryOption {
        key: BackendCategoryKey::RotationQuota,
        label: "Rotation & Quota",
        description: "Quota and retry behavior.",
        toggle_keys: &[
            BackendToggleSettingKey::PreemptiveQuotaEnabled,
            BackendToggleSettingKey::RetryAllAccountsRateLimited,
        ],
        number_keys: &[
            BackendNumberSettingKey::PreemptiveQuotaRemainingPercent5h,
            BackendNumberSettingKey::PreemptiveQuotaRemainingPercent7d,
            BackendNumberSettingKey::PreemptiveQuotaMaxDeferralMs,
        ],
    },
    BackendCategoryOption {
        key: BackendCategoryKey::RefreshRecovery,
        label: "Refresh & Recovery",
        description: "Token refresh and recovery safety.",
        toggle_keys: &[
            BackendToggleSettingKey::ProactiveRefreshGuardian,
            BackendToggleSettingKey::StorageBackupEnabled,
        ],
        number_keys: &[
            BackendNumberSettingKey::ProactiveRefreshIntervalMs,
            BackendNumberSettingKey::ProactiveRefreshBufferMs,
            BackendNumberSettingKey::TokenRefreshSkewMs,
        ],
    },
    BackendCategoryOption {
        key: BackendCategoryKey::PerformanceTimeouts,
        label: "Performance & Timeouts",
        description: "Speed, probing, and timeout controls.",
        toggle_keys: &[
            BackendToggleSettingKey::FastSession,
            BackendToggleSettingKey::ParallelProbing,
        ],
        number_keys: &[
            BackendNumberSettingKey::FastSessionMaxInputItems,
            BackendNumberSettingKey::ParallelProbingMaxConcurrency,
            BackendNumberSettingKey::FetchTimeoutMs,
            BackendNumberSettingKey::StreamStallTimeoutMs,
            BackendNumberSettingKey::NetworkErrorCooldownMs,
            BackendNumberSettingKey::ServerErrorCooldownMs,
        ],
    },
];

/// `BACKEND_DEFAULTS` — `getDefaultPluginConfig()`.
pub fn backend_defaults() -> PluginConfig {
    cma_config::load::get_default_plugin_config()
}

/// `BACKEND_TOGGLE_OPTION_BY_KEY` lookup.
pub fn backend_toggle_option_by_key(
    key: BackendToggleSettingKey,
) -> &'static BackendToggleSettingOption {
    BACKEND_TOGGLE_OPTIONS
        .iter()
        .find(|option| option.key == key)
        .expect("every toggle key has an option row")
}

/// `BACKEND_NUMBER_OPTION_BY_KEY` lookup.
pub fn backend_number_option_by_key(
    key: BackendNumberSettingKey,
) -> &'static BackendNumberSettingOption {
    BACKEND_NUMBER_OPTIONS
        .iter()
        .find(|option| option.key == key)
        .expect("every number key has an option row")
}

// ---------------------------------------------------------------------------
// Action unions
// ---------------------------------------------------------------------------

/// `BackendCategoryConfigAction`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendCategoryConfigAction {
    Toggle(BackendToggleSettingKey),
    Bump {
        key: BackendNumberSettingKey,
        direction: i32,
    },
    ResetCategory,
    Back,
}

/// `BackendSettingsHubAction`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendSettingsHubAction {
    OpenCategory(BackendCategoryKey),
    Reset,
    Save,
    Cancel,
}

// ---------------------------------------------------------------------------
// Experimental settings schema (`experimental-settings-schema.ts`)
// ---------------------------------------------------------------------------

/// `ExperimentalSettingsAction`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExperimentalSettingsAction {
    Sync,
    Backup,
    ToggleRefreshGuardian,
    DecreaseRefreshInterval,
    IncreaseRefreshInterval,
    Apply,
    Save,
    Back,
}

/// `mapExperimentalMenuHotkey`.
pub fn map_experimental_menu_hotkey(raw: &str) -> Option<ExperimentalSettingsAction> {
    match raw {
        "1" => return Some(ExperimentalSettingsAction::Sync),
        "2" => return Some(ExperimentalSettingsAction::Backup),
        "3" => return Some(ExperimentalSettingsAction::ToggleRefreshGuardian),
        "[" | "-" => return Some(ExperimentalSettingsAction::DecreaseRefreshInterval),
        "]" | "+" => return Some(ExperimentalSettingsAction::IncreaseRefreshInterval),
        _ => {}
    }
    match raw.to_lowercase().as_str() {
        "q" => Some(ExperimentalSettingsAction::Back),
        "s" => Some(ExperimentalSettingsAction::Save),
        _ => None,
    }
}

/// `mapExperimentalStatusHotkey`.
pub fn map_experimental_status_hotkey(raw: &str) -> Option<ExperimentalSettingsAction> {
    if raw.to_lowercase() == "q" {
        Some(ExperimentalSettingsAction::Back)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_tables_have_schema_cardinality_and_order() {
        assert_eq!(BACKEND_TOGGLE_OPTIONS.len(), 11);
        assert_eq!(BACKEND_NUMBER_OPTIONS.len(), 16);
        assert_eq!(BACKEND_CATEGORY_OPTIONS.len(), 4);
        assert_eq!(
            BACKEND_TOGGLE_OPTIONS[0].key,
            BackendToggleSettingKey::LiveAccountSync
        );
        assert_eq!(
            BACKEND_TOGGLE_OPTIONS[10].key,
            BackendToggleSettingKey::PerProjectAccounts
        );
        // Every toggle/number key appears in exactly one category.
        for option in BACKEND_TOGGLE_OPTIONS {
            let count = BACKEND_CATEGORY_OPTIONS
                .iter()
                .filter(|category| category.toggle_keys.contains(&option.key))
                .count();
            assert_eq!(count, 1, "{} in exactly one category", option.key.as_str());
        }
        for option in BACKEND_NUMBER_OPTIONS {
            let count = BACKEND_CATEGORY_OPTIONS
                .iter()
                .filter(|category| category.number_keys.contains(&option.key))
                .count();
            assert_eq!(count, 1, "{} in exactly one category", option.key.as_str());
        }
    }

    #[test]
    fn fetch_timeout_bounds_match_the_ts_expression() {
        let option = backend_number_option_by_key(BackendNumberSettingKey::FetchTimeoutMs);
        assert_eq!(option.min, 1_000.0);
        assert_eq!(option.max, 600_000.0);
        assert_eq!(option.step, 5_000.0);
        let deferral =
            backend_number_option_by_key(BackendNumberSettingKey::PreemptiveQuotaMaxDeferralMs);
        assert_eq!(deferral.max, 86_400_000.0);
    }

    #[test]
    fn refresh_interval_schema_entry_is_the_experimental_source_of_truth() {
        // Spec 09 §5.14 / gotcha 24: 5_000 / 600_000 / 5_000.
        let option = backend_number_option_by_key(BackendNumberSettingKey::ProactiveRefreshIntervalMs);
        assert_eq!((option.min, option.max, option.step), (5_000.0, 600_000.0, 5_000.0));
    }

    #[test]
    fn experimental_hotkeys_map_exactly() {
        use ExperimentalSettingsAction as A;
        assert_eq!(map_experimental_menu_hotkey("1"), Some(A::Sync));
        assert_eq!(map_experimental_menu_hotkey("2"), Some(A::Backup));
        assert_eq!(
            map_experimental_menu_hotkey("3"),
            Some(A::ToggleRefreshGuardian)
        );
        assert_eq!(
            map_experimental_menu_hotkey("["),
            Some(A::DecreaseRefreshInterval)
        );
        assert_eq!(
            map_experimental_menu_hotkey("-"),
            Some(A::DecreaseRefreshInterval)
        );
        assert_eq!(
            map_experimental_menu_hotkey("]"),
            Some(A::IncreaseRefreshInterval)
        );
        assert_eq!(
            map_experimental_menu_hotkey("+"),
            Some(A::IncreaseRefreshInterval)
        );
        assert_eq!(map_experimental_menu_hotkey("Q"), Some(A::Back));
        assert_eq!(map_experimental_menu_hotkey("s"), Some(A::Save));
        assert_eq!(map_experimental_menu_hotkey("x"), None);
        assert_eq!(map_experimental_status_hotkey("q"), Some(A::Back));
        assert_eq!(map_experimental_status_hotkey("s"), None);
    }

    #[test]
    fn toggle_and_number_accessors_round_trip() {
        let mut config = PluginConfig::default();
        BackendToggleSettingKey::FastSession.set(&mut config, Some(true));
        assert_eq!(config.fast_session, Some(true));
        assert_eq!(
            BackendToggleSettingKey::FastSession.get(&config),
            Some(true)
        );
        BackendNumberSettingKey::FetchTimeoutMs.set(&mut config, Some(42_000.0));
        assert_eq!(config.fetch_timeout_ms, Some(42_000.0));
        assert_eq!(
            BackendNumberSettingKey::FetchTimeoutMs.get(&config),
            Some(42_000.0)
        );
    }
}
