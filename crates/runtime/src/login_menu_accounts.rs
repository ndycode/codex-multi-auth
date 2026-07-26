//! Port of `lib/runtime/login-menu-accounts.ts` — login-dashboard account
//! row assembly (spec 10 §22).
//!
//! Status priority (exact): `disabled` (`enabled === false`) > `cooldown`
//! (`coolingDownUntil > now`) > `rate-limited` (`formatRateLimitEntry`
//! non-null) > `active` (display-current) > `ok`.

use cma_core::schemas::account_storage::RateLimitStateV3;

use crate::current_account::{
    AccountCurrentMarker, RuntimeCurrentAccountSelection, is_display_current_account,
    resolve_account_current_markers,
};

/// Input row (the TS inline account shape).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LoginMenuAccountInput {
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    pub email: Option<String>,
    pub added_at: Option<i64>,
    pub last_used: Option<i64>,
    /// TS `enabled?: boolean` — `Some(false)` means disabled.
    pub enabled: Option<bool>,
    pub cooling_down_until: Option<i64>,
    pub rate_limit_reset_times: Option<RateLimitStateV3>,
}

/// TS `LoginMenuAccount["status"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginMenuAccountStatus {
    Active,
    Ok,
    RateLimited,
    Cooldown,
    Disabled,
}

impl LoginMenuAccountStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Ok => "ok",
            Self::RateLimited => "rate-limited",
            Self::Cooldown => "cooldown",
            Self::Disabled => "disabled",
        }
    }
}

/// TS `LoginMenuAccount`.
#[derive(Clone, Debug, PartialEq)]
pub struct LoginMenuAccount {
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    pub email: Option<String>,
    pub index: usize,
    pub added_at: Option<i64>,
    pub last_used: Option<i64>,
    pub status: LoginMenuAccountStatus,
    pub is_current_account: bool,
    pub is_default_account: bool,
    pub is_runtime_current_account: bool,
    pub current_markers: Vec<AccountCurrentMarker>,
    pub enabled: bool,
}

/// Dependencies of [`build_login_menu_accounts`] (TS `deps`).
pub struct BuildLoginMenuAccountsDeps<'a> {
    pub now: i64,
    pub active_index: usize,
    pub runtime_current: Option<&'a RuntimeCurrentAccountSelection>,
    /// TS `formatRateLimitEntry(account, now)` — the caller binds the family
    /// and wait-time formatter (see `crate::account_status`).
    pub format_rate_limit_entry: &'a dyn Fn(&LoginMenuAccountInput, i64) -> Option<String>,
}

/// TS `buildLoginMenuAccounts(accounts, deps)`.
pub fn build_login_menu_accounts(
    accounts: &[LoginMenuAccountInput],
    deps: &BuildLoginMenuAccountsDeps<'_>,
) -> Vec<LoginMenuAccount> {
    accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            let is_current =
                is_display_current_account(index, deps.active_index, deps.runtime_current);

            let status = if account.enabled == Some(false) {
                LoginMenuAccountStatus::Disabled
            } else if account
                .cooling_down_until
                .is_some_and(|until| until > deps.now)
            {
                LoginMenuAccountStatus::Cooldown
            } else if (deps.format_rate_limit_entry)(account, deps.now).is_some() {
                LoginMenuAccountStatus::RateLimited
            } else if is_current {
                LoginMenuAccountStatus::Active
            } else {
                LoginMenuAccountStatus::Ok
            };

            LoginMenuAccount {
                account_id: account.account_id.clone(),
                account_label: account.account_label.clone(),
                email: account.email.clone(),
                index,
                added_at: account.added_at,
                last_used: account.last_used,
                status,
                is_current_account: is_current,
                is_default_account: index == deps.active_index,
                is_runtime_current_account: deps
                    .runtime_current
                    .is_some_and(|current| current.index == index),
                current_markers: resolve_account_current_markers(
                    index,
                    deps.active_index,
                    deps.runtime_current,
                ),
                enabled: account.enabled != Some(false),
            }
        })
        .collect()
}

// =============================================================================
// Tests — ported from test/login-menu-accounts.test.ts (status priority)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::model_family::ModelFamily;

    fn default_format(account: &LoginMenuAccountInput, now: i64) -> Option<String> {
        crate::account_status::format_rate_limit_entry(
            account.rate_limit_reset_times.as_ref(),
            now,
            &|ms| format!("{}ms", ms),
            ModelFamily::Codex,
        )
    }

    #[test]
    fn status_priority_disabled_cooldown_rate_limited_active_ok() {
        let now = 1_000i64;
        let accounts = vec![
            // 0: disabled wins over cooldown/rate-limit.
            LoginMenuAccountInput {
                enabled: Some(false),
                cooling_down_until: Some(now + 100),
                rate_limit_reset_times: Some(
                    [("codex".to_string(), now + 100)].into_iter().collect(),
                ),
                ..LoginMenuAccountInput::default()
            },
            // 1: cooldown beats rate-limit.
            LoginMenuAccountInput {
                cooling_down_until: Some(now + 100),
                rate_limit_reset_times: Some(
                    [("codex".to_string(), now + 100)].into_iter().collect(),
                ),
                ..LoginMenuAccountInput::default()
            },
            // 2: rate-limited (also the stored current index → beats active).
            LoginMenuAccountInput {
                rate_limit_reset_times: Some(
                    [("codex".to_string(), now + 100)].into_iter().collect(),
                ),
                ..LoginMenuAccountInput::default()
            },
            // 3: plain ok.
            LoginMenuAccountInput::default(),
        ];

        let rows = build_login_menu_accounts(
            &accounts,
            &BuildLoginMenuAccountsDeps {
                now,
                active_index: 2,
                runtime_current: None,
                format_rate_limit_entry: &default_format,
            },
        );

        assert_eq!(rows[0].status, LoginMenuAccountStatus::Disabled);
        assert!(!rows[0].enabled);
        assert_eq!(rows[1].status, LoginMenuAccountStatus::Cooldown);
        assert_eq!(rows[2].status, LoginMenuAccountStatus::RateLimited);
        assert_eq!(rows[3].status, LoginMenuAccountStatus::Ok);

        // Default-account flag follows the stored index.
        assert!(rows[2].is_default_account);
        assert!(!rows[3].is_default_account);
        // With no runtime signal the stored index is the display-current.
        assert!(rows[2].is_current_account);
        assert!(!rows[3].is_runtime_current_account);
    }

    #[test]
    fn active_status_for_current_account_without_limits() {
        let rows = build_login_menu_accounts(
            &[LoginMenuAccountInput::default(), LoginMenuAccountInput::default()],
            &BuildLoginMenuAccountsDeps {
                now: 0,
                active_index: 0,
                runtime_current: None,
                format_rate_limit_entry: &default_format,
            },
        );
        assert_eq!(rows[0].status, LoginMenuAccountStatus::Active);
        assert_eq!(rows[1].status, LoginMenuAccountStatus::Ok);
        // Expired cooldown does not force cooldown status.
        let rows = build_login_menu_accounts(
            &[LoginMenuAccountInput {
                cooling_down_until: Some(5),
                ..LoginMenuAccountInput::default()
            }],
            &BuildLoginMenuAccountsDeps {
                now: 10,
                active_index: 0,
                runtime_current: None,
                format_rate_limit_entry: &default_format,
            },
        );
        assert_eq!(rows[0].status, LoginMenuAccountStatus::Active);
    }
}
