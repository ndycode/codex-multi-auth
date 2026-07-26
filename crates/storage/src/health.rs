//! Port of `lib/storage/health.ts` + the `inspectStorageHealth` wiring from
//! `lib/storage.ts` (spec 02 §13.3).
//!
//! 5-state summary: `healthy | empty | intentional-reset | corrupt |
//! recoverable`, with the frozen `details` strings and the silent WAL probe
//! on missing/invalid/throwing primaries.

use std::path::Path;

use serde::Serialize;

/// TS `StorageHealthState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum StorageHealthState {
    #[serde(rename = "healthy")]
    Healthy,
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "intentional-reset")]
    IntentionalReset,
    #[serde(rename = "corrupt")]
    Corrupt,
    #[serde(rename = "recoverable")]
    Recoverable,
}

impl StorageHealthState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::Empty => "empty",
            Self::IntentionalReset => "intentional-reset",
            Self::Corrupt => "corrupt",
            Self::Recoverable => "recoverable",
        }
    }
}

/// The only recovery source surfaced by the health probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum RecoverySource {
    #[serde(rename = "wal")]
    Wal,
}

/// TS `StorageHealthSummary`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StorageHealthSummary {
    pub state: StorageHealthState,
    pub path: String,
    #[serde(rename = "resetMarkerPath")]
    pub reset_marker_path: String,
    #[serde(rename = "walPath")]
    pub wal_path: String,
    #[serde(rename = "hasResetMarker")]
    pub has_reset_marker: bool,
    #[serde(rename = "hasWal")]
    pub has_wal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(rename = "schemaErrors", skip_serializing_if = "Option::is_none")]
    pub schema_errors: Option<Vec<String>>,
    #[serde(rename = "recoverySource", skip_serializing_if = "Option::is_none")]
    pub recovery_source: Option<RecoverySource>,
}

/// Parameters for [`create_storage_health_summary`].
#[derive(Clone, Debug, Default)]
pub struct StorageHealthParams {
    pub details: Option<String>,
    pub schema_errors: Option<Vec<String>>,
    pub recovery_source: Option<RecoverySource>,
}

/// TS `createStorageHealthSummary` — `hasResetMarker`/`hasWal` are re-stat'd
/// at construction time.
pub fn create_storage_health_summary(
    state: StorageHealthState,
    path: &Path,
    reset_marker_path: &str,
    wal_path: &str,
    params: StorageHealthParams,
) -> StorageHealthSummary {
    StorageHealthSummary {
        state,
        path: path.to_string_lossy().into_owned(),
        reset_marker_path: reset_marker_path.to_string(),
        wal_path: wal_path.to_string(),
        has_reset_marker: Path::new(reset_marker_path).exists(),
        has_wal: Path::new(wal_path).exists(),
        details: params.details,
        schema_errors: params.schema_errors,
        recovery_source: params.recovery_source,
    }
}

/// TS `inspectStorageHealth()` (storage.ts export).
pub async fn inspect_storage_health() -> StorageHealthSummary {
    let path = std::path::PathBuf::from(crate::facade::get_storage_path());
    let wal_path = crate::backup_paths::get_accounts_wal_path(&path);
    let reset_marker_path = crate::backup_paths::get_intentional_reset_marker_path(&path);

    if Path::new(&reset_marker_path).exists() {
        return create_storage_health_summary(
            StorageHealthState::IntentionalReset,
            &path,
            &reset_marker_path,
            &wal_path,
            StorageHealthParams {
                details: Some("intentional reset marker present".to_string()),
                ..Default::default()
            },
        );
    }

    if !Path::new(&path).exists() {
        let wal_recovered = crate::load::load_accounts_from_journal(&path, true).await;
        if wal_recovered
            .as_ref()
            .is_some_and(|storage| !storage.accounts.is_empty())
        {
            return create_storage_health_summary(
                StorageHealthState::Recoverable,
                &path,
                &reset_marker_path,
                &wal_path,
                StorageHealthParams {
                    details: Some(
                        "primary storage missing but WAL recovery is available".to_string(),
                    ),
                    recovery_source: Some(RecoverySource::Wal),
                    ..Default::default()
                },
            );
        }
        return create_storage_health_summary(
            StorageHealthState::Empty,
            &path,
            &reset_marker_path,
            &wal_path,
            StorageHealthParams {
                details: Some("storage file is missing".to_string()),
                ..Default::default()
            },
        );
    }

    match crate::parser::load_accounts_from_path(&path).await {
        Ok(parsed) => {
            let schema_errors = if parsed.schema_errors.is_empty() {
                None
            } else {
                Some(parsed.schema_errors.clone())
            };
            if let Some(normalized) = &parsed.normalized {
                if !normalized.accounts.is_empty() {
                    return create_storage_health_summary(
                        StorageHealthState::Healthy,
                        &path,
                        &reset_marker_path,
                        &wal_path,
                        StorageHealthParams {
                            schema_errors,
                            ..Default::default()
                        },
                    );
                }
                return create_storage_health_summary(
                    StorageHealthState::Empty,
                    &path,
                    &reset_marker_path,
                    &wal_path,
                    StorageHealthParams {
                        schema_errors,
                        details: Some("storage parsed but contains no accounts".to_string()),
                        ..Default::default()
                    },
                );
            }
            let wal_recovered = crate::load::load_accounts_from_journal(&path, true).await;
            if wal_recovered
                .as_ref()
                .is_some_and(|storage| !storage.accounts.is_empty())
            {
                return create_storage_health_summary(
                    StorageHealthState::Recoverable,
                    &path,
                    &reset_marker_path,
                    &wal_path,
                    StorageHealthParams {
                        schema_errors,
                        details: Some(
                            "primary storage is invalid but WAL recovery is available".to_string(),
                        ),
                        recovery_source: Some(RecoverySource::Wal),
                    },
                );
            }
            create_storage_health_summary(
                StorageHealthState::Corrupt,
                &path,
                &reset_marker_path,
                &wal_path,
                StorageHealthParams {
                    schema_errors,
                    details: Some("storage could not be normalized".to_string()),
                    ..Default::default()
                },
            )
        }
        Err(error) => {
            let wal_recovered = crate::load::load_accounts_from_journal(&path, true).await;
            if wal_recovered
                .as_ref()
                .is_some_and(|storage| !storage.accounts.is_empty())
            {
                return create_storage_health_summary(
                    StorageHealthState::Recoverable,
                    &path,
                    &reset_marker_path,
                    &wal_path,
                    StorageHealthParams {
                        details: Some(error.to_string()),
                        recovery_source: Some(RecoverySource::Wal),
                        ..Default::default()
                    },
                );
            }
            create_storage_health_summary(
                StorageHealthState::Corrupt,
                &path,
                &reset_marker_path,
                &wal_path,
                StorageHealthParams {
                    details: Some(error.to_string()),
                    ..Default::default()
                },
            )
        }
    }
}

// ============================================================================
// Tests (pure summary construction; the on-disk state matrix lives in the
// storage-health integration suite once the load/parser siblings land)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_serializes_kebab_states_and_camel_keys() {
        let summary = create_storage_health_summary(
            StorageHealthState::IntentionalReset,
            Path::new("/x/a.json"),
            "/x/a.json.reset-intent",
            "/x/a.json.wal",
            StorageHealthParams {
                details: Some("intentional reset marker present".to_string()),
                recovery_source: Some(RecoverySource::Wal),
                ..Default::default()
            },
        );
        let value = serde_json::to_value(&summary).unwrap();
        assert_eq!(value["state"], "intentional-reset");
        assert_eq!(value["resetMarkerPath"], "/x/a.json.reset-intent");
        assert_eq!(value["walPath"], "/x/a.json.wal");
        assert_eq!(value["hasResetMarker"], false);
        assert_eq!(value["hasWal"], false);
        assert_eq!(value["recoverySource"], "wal");
        assert!(value.get("schemaErrors").is_none());
    }

    #[test]
    fn state_as_str_matches_ts_labels() {
        assert_eq!(StorageHealthState::Healthy.as_str(), "healthy");
        assert_eq!(StorageHealthState::Empty.as_str(), "empty");
        assert_eq!(
            StorageHealthState::IntentionalReset.as_str(),
            "intentional-reset"
        );
        assert_eq!(StorageHealthState::Corrupt.as_str(), "corrupt");
        assert_eq!(StorageHealthState::Recoverable.as_str(), "recoverable");
    }
}
