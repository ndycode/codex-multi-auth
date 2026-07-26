//! Port of `lib/auth/org-override.ts` — resolve the effective account-id
//! override for a login (spec 07 §4).
//!
//! Precedence: an explicit `login --org <id>` argument wins over the ambient
//! `CODEX_AUTH_ACCOUNT_ID` env var, for that call only. A blank/whitespace
//! explicit org is treated as absent so an empty `--org ""` does NOT suppress
//! the env fallback (spec 07 gotcha 19).
//!
//! Concurrency contract (spec 07 gotcha 19): the login launcher must NOT
//! mutate the process environment for the duration of a login — the previous
//! implementation raced on re-entry / reused test workers. This function only
//! READS the environment (or an injected value) and never writes it.
//!
//! Deliberately not re-exported from the CLI entrypoint surface in TS; kept a
//! plain internal-style module here as well.

/// Environment variable carrying the ambient account-id override.
pub const CODEX_AUTH_ACCOUNT_ID_ENV: &str = "CODEX_AUTH_ACCOUNT_ID";

/// Resolve the effective org/account-id override from an explicit `--org`
/// value and the ambient `CODEX_AUTH_ACCOUNT_ID` environment variable
/// (TS `resolveOrgOverride` with the default `process.env`).
///
/// Returns the trimmed effective override, or `None` when neither source
/// provides one.
pub fn resolve_org_override(explicit_org: Option<&str>) -> Option<String> {
    let env_value = std::env::var(CODEX_AUTH_ACCOUNT_ID_ENV).ok();
    resolve_org_override_in(explicit_org, env_value.as_deref())
}

/// [`resolve_org_override`] with the environment value injected (TS
/// `resolveOrgOverride(explicitOrg, env)` — the injectable-env test seam).
///
/// Semantics mirror the TS falsy-empty-string chain exactly:
/// `((explicitOrg?.trim() || env.CODEX_AUTH_ACCOUNT_ID) || "").trim()`,
/// `None` when the result is empty.
pub fn resolve_org_override_in(
    explicit_org: Option<&str>,
    env_account_id: Option<&str>,
) -> Option<String> {
    // `explicitOrg?.trim()` — an all-whitespace explicit value trims to the
    // empty string, which is falsy in TS and therefore falls through to env.
    let explicit = explicit_org.map(str::trim).filter(|value| !value.is_empty());
    let chosen = explicit.or(env_account_id).unwrap_or("");
    let trimmed = chosen.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ===========================================================================
// Tests (ported from test/codex-manager-org-override.test.ts)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    #[test]
    fn explicit_org_argument_wins_over_env_override() {
        assert_eq!(
            resolve_org_override_in(Some("explicit-org-wins"), Some("env-org-should-lose")),
            Some("explicit-org-wins".to_string())
        );
    }

    #[test]
    fn falls_back_to_env_override_when_no_explicit_org() {
        assert_eq!(
            resolve_org_override_in(None, Some("env-org-used")),
            Some("env-org-used".to_string())
        );
    }

    #[test]
    fn ignores_blank_explicit_org_and_uses_env_override() {
        assert_eq!(
            resolve_org_override_in(Some("   "), Some("env-org-fallback")),
            Some("env-org-fallback".to_string())
        );
    }

    #[test]
    fn returns_none_when_neither_source_is_set() {
        assert_eq!(resolve_org_override_in(None, None), None);
        assert_eq!(resolve_org_override_in(Some("   "), None), None);
        // Env set but empty is also absent (falsy chain + final trim).
        assert_eq!(resolve_org_override_in(None, Some("")), None);
        assert_eq!(resolve_org_override_in(None, Some("   ")), None);
    }

    #[test]
    fn trims_surrounding_whitespace_from_the_chosen_value() {
        assert_eq!(
            resolve_org_override_in(Some("  org-padded  "), None),
            Some("org-padded".to_string())
        );
        assert_eq!(
            resolve_org_override_in(None, Some("  env-padded ")),
            Some("env-padded".to_string())
        );
    }

    #[test]
    #[serial(env)]
    fn env_reading_variant_does_not_mutate_the_environment() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var(CODEX_AUTH_ACCOUNT_ID_ENV, "env-stays-put");

        // Explicit wins for this call only; the env var is untouched.
        assert_eq!(
            resolve_org_override(Some("explicit-org")),
            Some("explicit-org".to_string())
        );
        assert_eq!(
            std::env::var(CODEX_AUTH_ACCOUNT_ID_ENV).as_deref(),
            Ok("env-stays-put")
        );

        // And the env fallback works through the reading variant.
        assert_eq!(
            resolve_org_override(None),
            Some("env-stays-put".to_string())
        );

        sandbox.remove_var(CODEX_AUTH_ACCOUNT_ID_ENV);
        assert_eq!(resolve_org_override(None), None);
    }
}
