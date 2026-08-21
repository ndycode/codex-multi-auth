//! Port of `lib/oc-chatgpt-orchestrator.ts` — plan/apply pipeline: detect
//! target -> load -> preview merge -> atomic persist; named-backup export
//! wrapper with EEXIST/collision mapping.
//!
//! Dependency injection is preserved as optional function references so the
//! TS test doubles port 1:1. Rust has no exceptions: the TS `throw` paths are
//! modeled as `Result::Err` from the injected closures, and the TS catch-all
//! in `applyOcChatgptSync` (re-run detection to classify) is reproduced on
//! the persist failure path.

use std::path::Path;

use cma_core::errors::CodexError;
use cma_core::fs_retry::with_file_operation_retry;
use cma_core::json_io::stringify_pretty2;
use cma_core::temp_path::temp_path_for;
use cma_storage::normalize::normalize_account_storage;
use cma_storage::public_types::AccountStorageV3;

use super::import_adapter::{
    OcChatgptMergePreview, OcChatgptPreviewPayload, preview_oc_chatgpt_import_merge,
};
use super::target_detection::{
    DetectOcChatgptTargetOptions, OcChatgptTargetAmbiguous, OcChatgptTargetDescriptor,
    OcChatgptTargetDetectionResult, OcChatgptTargetNone, detect_oc_chatgpt_multi_auth_target,
};

/// Boxed error payload (TS `error: unknown`).
pub type OcSyncError = Box<dyn std::error::Error + Send + Sync>;

/// TS `cause: "load" | "preview"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OcChatgptPlanErrorCause {
    Load,
    Preview,
}

impl OcChatgptPlanErrorCause {
    pub const fn as_str(self) -> &'static str {
        match self {
            OcChatgptPlanErrorCause::Load => "load",
            OcChatgptPlanErrorCause::Preview => "preview",
        }
    }
}

/// TS `OcChatgptSyncPlanResult`.
// The variant sizes intentionally mirror the TS result-object shapes; the
// enum lives briefly on one settings-menu code path, so boxing buys nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum OcChatgptSyncPlanResult {
    Ready {
        target: OcChatgptTargetDescriptor,
        preview: OcChatgptMergePreview,
        payload: OcChatgptPreviewPayload,
        destination: Option<AccountStorageV3>,
    },
    BlockedAmbiguous {
        detection: OcChatgptTargetAmbiguous,
    },
    BlockedNone {
        detection: OcChatgptTargetNone,
    },
    /// chatgpt-import-06: a structured error result so planning can report a
    /// failure to load/preview the target (e.g. a corrupt destination file)
    /// instead of throwing out of the planning step.
    PlanError {
        target: OcChatgptTargetDescriptor,
        error: OcSyncError,
        cause: OcChatgptPlanErrorCause,
    },
}

/// TS `OcChatgptSyncApplyResult`.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum OcChatgptSyncApplyResult {
    BlockedAmbiguous {
        detection: OcChatgptTargetAmbiguous,
    },
    BlockedNone {
        detection: OcChatgptTargetNone,
    },
    Applied {
        target: OcChatgptTargetDescriptor,
        preview: OcChatgptMergePreview,
        merged: AccountStorageV3,
        destination: Option<AccountStorageV3>,
        /// TS `persistedPath?: string | void`.
        persisted_path: Option<String>,
    },
    Error {
        target: OcChatgptTargetDescriptor,
        error: OcSyncError,
    },
}

type DetectFn<'a> =
    &'a (dyn Fn(&DetectOcChatgptTargetOptions) -> OcChatgptTargetDetectionResult + Sync);
type PreviewFn<'a> = &'a (dyn Fn(
    Option<&AccountStorageV3>,
    Option<&AccountStorageV3>,
) -> Result<OcChatgptMergePreview, OcSyncError>
             + Sync);
type LoadFn<'a> = &'a (dyn Fn(
    &OcChatgptTargetDescriptor,
) -> Result<Option<AccountStorageV3>, OcSyncError>
             + Sync);
type PersistFn<'a> = &'a (dyn Fn(
    &OcChatgptTargetDescriptor,
    &AccountStorageV3,
) -> Result<Option<String>, OcSyncError>
             + Sync);

/// TS `PlanDependencies` (test seams; `None` = the real implementation).
#[derive(Default)]
pub struct PlanOcChatgptSyncDependencies<'a> {
    pub detect_target: Option<DetectFn<'a>>,
    pub preview_merge: Option<PreviewFn<'a>>,
    pub load_target_storage: Option<LoadFn<'a>>,
}

/// TS `ApplyDependencies` — plan deps + `persistMerged`.
#[derive(Default)]
pub struct ApplyOcChatgptSyncDependencies<'a> {
    pub detect_target: Option<DetectFn<'a>>,
    pub preview_merge: Option<PreviewFn<'a>>,
    pub load_target_storage: Option<LoadFn<'a>>,
    pub persist_merged: Option<PersistFn<'a>>,
}

/// TS `PlanOcChatgptSyncOptions`.
#[derive(Default)]
pub struct PlanOcChatgptSyncOptions<'a> {
    pub source: Option<&'a AccountStorageV3>,
    /// Tri-state (spec 12 gotcha 21): `None` = property absent → read the
    /// target from disk; `Some(None)` = `destination: null` (empty, do NOT
    /// touch disk); `Some(Some(storage))` = provided.
    pub destination: Option<Option<&'a AccountStorageV3>>,
    pub detect_options: DetectOcChatgptTargetOptions,
    pub dependencies: PlanOcChatgptSyncDependencies<'a>,
}

/// TS `ApplyOcChatgptSyncOptions`.
#[derive(Default)]
pub struct ApplyOcChatgptSyncOptions<'a> {
    pub source: Option<&'a AccountStorageV3>,
    pub destination: Option<Option<&'a AccountStorageV3>>,
    pub detect_options: DetectOcChatgptTargetOptions,
    pub dependencies: ApplyOcChatgptSyncDependencies<'a>,
}

enum Detected {
    Blocked(BlockedDetection),
    Target(OcChatgptTargetDescriptor),
}

enum BlockedDetection {
    Ambiguous(OcChatgptTargetAmbiguous),
    None(OcChatgptTargetNone),
}

/// TS `mapDetectionToBlocked` folded into a total match — the "Unexpected oc
/// target detection result" invariant throw guards states that are
/// unrepresentable with this enum.
fn classify_detection(detection: OcChatgptTargetDetectionResult) -> Detected {
    match detection {
        OcChatgptTargetDetectionResult::Ambiguous(ambiguous) => {
            Detected::Blocked(BlockedDetection::Ambiguous(ambiguous))
        }
        OcChatgptTargetDetectionResult::NoTarget(none) => {
            Detected::Blocked(BlockedDetection::None(none))
        }
        OcChatgptTargetDetectionResult::Target { descriptor } => Detected::Target(descriptor),
    }
}

/// TS `loadTargetStorageDefault(target)` — read + parse + normalize;
/// `ENOENT` ⇒ `Ok(None)`; any other error propagates (⇒ plan-error "load").
fn load_target_storage_default(
    target: &OcChatgptTargetDescriptor,
) -> Result<Option<AccountStorageV3>, OcSyncError> {
    let raw = match std::fs::read_to_string(&target.account_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Box::new(error)),
    };
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(OcSyncError::from)?;
    Ok(normalize_account_storage(&value))
}

/// TS `planOcChatgptSync(options)`.
pub async fn plan_oc_chatgpt_sync(
    options: PlanOcChatgptSyncOptions<'_>,
) -> OcChatgptSyncPlanResult {
    let detection = match options.dependencies.detect_target {
        Some(detect) => detect(&options.detect_options),
        None => detect_oc_chatgpt_multi_auth_target(&options.detect_options),
    };
    let descriptor = match classify_detection(detection) {
        Detected::Blocked(BlockedDetection::Ambiguous(detection)) => {
            return OcChatgptSyncPlanResult::BlockedAmbiguous { detection };
        }
        Detected::Blocked(BlockedDetection::None(detection)) => {
            return OcChatgptSyncPlanResult::BlockedNone { detection };
        }
        Detected::Target(descriptor) => descriptor,
    };

    let destination: Option<AccountStorageV3> = match options.destination {
        Some(provided) => provided.cloned(),
        None => {
            let loaded = match options.dependencies.load_target_storage {
                Some(load) => load(&descriptor),
                None => load_target_storage_default(&descriptor),
            };
            match loaded {
                Ok(destination) => destination,
                Err(error) => {
                    // chatgpt-import-06: a corrupt/unreadable destination must
                    // not throw out of planning; return a structured error.
                    return OcChatgptSyncPlanResult::PlanError {
                        target: descriptor,
                        error,
                        cause: OcChatgptPlanErrorCause::Load,
                    };
                }
            }
        }
    };

    let preview = match options.dependencies.preview_merge {
        Some(preview_merge) => preview_merge(options.source, destination.as_ref()),
        None => Ok(preview_oc_chatgpt_import_merge(
            options.source,
            destination.as_ref(),
        )),
    };
    let preview = match preview {
        Ok(preview) => preview,
        Err(error) => {
            return OcChatgptSyncPlanResult::PlanError {
                target: descriptor,
                error,
                cause: OcChatgptPlanErrorCause::Preview,
            };
        }
    };

    OcChatgptSyncPlanResult::Ready {
        target: descriptor,
        payload: preview.payload.clone(),
        preview,
        destination,
    }
}

/// TS `persistMergedDefault(target, merged)` — CRITICAL byte-compat write
/// path: 0700 parent dir, temp file at 0600, `JSON.stringify(_, null, 2)` +
/// trailing `\n`, rename routed through `withFileOperationRetry`, retried
/// force-rm temp cleanup (secrets must not linger).
async fn persist_merged_default(
    target: &OcChatgptTargetDescriptor,
    merged: &AccountStorageV3,
) -> Result<Option<String>, OcSyncError> {
    let path = Path::new(&target.account_path);
    if let Some(dir) = path.parent() {
        create_dir_0700(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // mkdir's mode is ignored on an already-existing dir; re-assert
            // 0700 so a pre-existing loose-perm dir is tightened (POSIX only;
            // win32 relies on the user-profile ACL). Errors swallowed.
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let temp_path = temp_path_for(path);
    let content = format!("{}\n", stringify_pretty2(merged));

    let result = write_and_rename(&temp_path, path, &content).await;

    // finally: retried best-effort temp cleanup. force:true semantics — a
    // missing temp (rename consumed it) is a no-op.
    let cleanup_temp = temp_path.clone();
    let _ = with_file_operation_retry(move || {
        let temp = cleanup_temp.clone();
        async move {
            match std::fs::remove_file(&temp) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            }
        }
    })
    .await;

    result?;
    Ok(Some(target.account_path.clone()))
}

fn create_dir_0700(dir: &Path) -> Result<(), OcSyncError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        builder.mode(0o700);
        builder.create(dir).map_err(OcSyncError::from)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir).map_err(OcSyncError::from)
    }
}

async fn write_and_rename(
    temp_path: &Path,
    path: &Path,
    content: &str,
) -> Result<(), OcSyncError> {
    write_temp_0600(temp_path, content)?;
    // Route the atomic rename through withFileOperationRetry: on Windows the
    // destination is a live, watched store, so a concurrent reader can hold
    // it briefly and surface EBUSY/EPERM/ENOTEMPTY/EACCES.
    let temp = temp_path.to_path_buf();
    let dest = path.to_path_buf();
    with_file_operation_retry(move || {
        let temp = temp.clone();
        let dest = dest.clone();
        async move { std::fs::rename(&temp, &dest) }
    })
    .await
    .map_err(OcSyncError::from)
}

fn write_temp_0600(temp_path: &Path, content: &str) -> Result<(), OcSyncError> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(temp_path)
            .map_err(OcSyncError::from)?;
        file.write_all(content.as_bytes()).map_err(OcSyncError::from)?;
        // Re-assert 0600 (mirrors the TS explicit chmod; errors swallowed).
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(temp_path, std::fs::Permissions::from_mode(0o600));
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(temp_path, content).map_err(OcSyncError::from)
    }
}

/// TS `applyOcChatgptSync(options)`.
pub async fn apply_oc_chatgpt_sync(
    options: ApplyOcChatgptSyncOptions<'_>,
) -> OcChatgptSyncApplyResult {
    let plan = plan_oc_chatgpt_sync(PlanOcChatgptSyncOptions {
        source: options.source,
        destination: options.destination,
        detect_options: options.detect_options.clone(),
        dependencies: PlanOcChatgptSyncDependencies {
            detect_target: options.dependencies.detect_target,
            preview_merge: options.dependencies.preview_merge,
            load_target_storage: options.dependencies.load_target_storage,
        },
    })
    .await;

    let (target, preview, destination) = match plan {
        OcChatgptSyncPlanResult::PlanError { target, error, .. } => {
            // Map the structured planning error onto the apply error variant.
            return OcChatgptSyncApplyResult::Error { target, error };
        }
        OcChatgptSyncPlanResult::BlockedAmbiguous { detection } => {
            return OcChatgptSyncApplyResult::BlockedAmbiguous { detection };
        }
        OcChatgptSyncPlanResult::BlockedNone { detection } => {
            return OcChatgptSyncApplyResult::BlockedNone { detection };
        }
        OcChatgptSyncPlanResult::Ready {
            target,
            preview,
            destination,
            ..
        } => (target, preview, destination),
    };

    let persisted = match options.dependencies.persist_merged {
        Some(persist) => persist(&target, &preview.merged),
        None => persist_merged_default(&target, &preview.merged).await,
    };

    match persisted {
        Ok(persisted_path) => OcChatgptSyncApplyResult::Applied {
            target,
            merged: preview.merged.clone(),
            preview,
            destination,
            persisted_path,
        },
        Err(error) => {
            // TS catch-all: on ANY throw re-run detection to classify. A
            // now-blocked detection wins; otherwise the FRESH descriptor is
            // reported with the error.
            let detection = match options.dependencies.detect_target {
                Some(detect) => detect(&options.detect_options),
                None => detect_oc_chatgpt_multi_auth_target(&options.detect_options),
            };
            match classify_detection(detection) {
                Detected::Blocked(BlockedDetection::Ambiguous(detection)) => {
                    OcChatgptSyncApplyResult::BlockedAmbiguous { detection }
                }
                Detected::Blocked(BlockedDetection::None(detection)) => {
                    OcChatgptSyncApplyResult::BlockedNone { detection }
                }
                Detected::Target(descriptor) => OcChatgptSyncApplyResult::Error {
                    target: descriptor,
                    error,
                },
            }
        }
    }
}

type ExportBackupFn<'a> = &'a (dyn Fn(&str, bool) -> Result<String, CodexError> + Sync);

/// TS `RunNamedBackupExportOptions`.
#[derive(Default)]
pub struct RunNamedBackupExportOptions<'a> {
    pub name: String,
    pub force: bool,
    /// Test seam (TS `dependencies.exportBackup`).
    pub export_backup: Option<ExportBackupFn<'a>>,
}

/// TS `RunNamedBackupExportResult`.
#[derive(Debug)]
pub enum RunNamedBackupExportResult {
    Exported { path: String },
    Collision { path: String },
    Error { path: Option<String>, error: CodexError },
}

/// TS `extractCollisionPath(error)` — the Rust `CodexError` carries no errno
/// `code`/`path` fields, so classification relies on the message contract
/// `/already exists: (?<path>.+)$/i` (named-backup export throws
/// `` `File already exists: ${destination}` ``, which this matches).
fn extract_collision_path(error: &CodexError) -> Option<String> {
    let message = error.message().trim();
    if message.is_empty() {
        return None;
    }
    // `$` without the `m` flag also matches just before a single final \n.
    let message = message.strip_suffix('\n').unwrap_or(message);
    // `.+` cannot cross a newline: the match must live on the final line.
    let final_line = message.rsplit('\n').next().unwrap_or(message);
    let lower = final_line.to_lowercase();
    let marker = "already exists: ";
    let idx = lower.find(marker)?;
    let path = final_line[idx + marker.len()..].trim();
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// TS `runNamedBackupExport(options)`.
pub async fn run_named_backup_export(
    options: RunNamedBackupExportOptions<'_>,
) -> RunNamedBackupExportResult {
    let result = match options.export_backup {
        Some(export_backup) => export_backup(&options.name, options.force),
        None => cma_storage::named_backups::export_named_backup(&options.name, options.force)
            .await,
    };
    match result {
        Ok(path) => RunNamedBackupExportResult::Exported { path },
        Err(error) => match extract_collision_path(&error) {
            Some(path) => RunNamedBackupExportResult::Collision { path },
            None => RunNamedBackupExportResult::Error { path: None, error },
        },
    }
}

#[cfg(test)]
#[allow(clippy::result_large_err)] // test doubles return CodexError by value
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use cma_testkit::remove_with_retry::remove_recursive_with_retry;

    // Ported from test/oc-chatgpt-orchestrator.test.ts.

    fn source_storage() -> AccountStorageV3 {
        let mut account = AccountMetadataV3::new("refresh-token-1", 50, 100);
        account.email = Some("user@example.com".to_string());
        account.account_id = Some("acc_1".to_string());
        let mut storage = AccountStorageV3::empty();
        storage.accounts = vec![account];
        storage
    }

    fn destination_storage() -> AccountStorageV3 {
        let mut account = AccountMetadataV3::new("refresh-token-dest", 5, 10);
        account.email = Some("dest@example.com".to_string());
        account.account_id = Some("acc_dest".to_string());
        let mut storage = AccountStorageV3::empty();
        storage.accounts = vec![account];
        storage
    }

    fn target_descriptor(root: &str) -> OcChatgptTargetDescriptor {
        use super::super::target_detection::{
            OcChatgptTargetResolution, OcChatgptTargetScope, OcChatgptTargetSource,
        };
        OcChatgptTargetDescriptor {
            scope: OcChatgptTargetScope::Global,
            root: root.to_string(),
            account_path: Path::new(root)
                .join("openai-codex-accounts.json")
                .to_string_lossy()
                .into_owned(),
            backup_root: Path::new(root).join("backups").to_string_lossy().into_owned(),
            source: OcChatgptTargetSource::DefaultGlobal,
            resolution: OcChatgptTargetResolution::Accounts,
        }
    }

    fn detect_target_fixture(
        root: String,
    ) -> impl Fn(&DetectOcChatgptTargetOptions) -> OcChatgptTargetDetectionResult + Sync {
        move |_| OcChatgptTargetDetectionResult::Target {
            descriptor: target_descriptor(&root),
        }
    }

    fn none_detection() -> OcChatgptTargetNone {
        OcChatgptTargetNone {
            reason: "missing".to_string(),
            tried: vec![],
        }
    }

    fn ambiguous_detection() -> OcChatgptTargetAmbiguous {
        OcChatgptTargetAmbiguous {
            reason: "multiple".to_string(),
            candidates: vec![],
        }
    }

    #[tokio::test]
    async fn returns_blocked_none_when_target_is_missing() {
        let source = source_storage();
        let detect = |_: &DetectOcChatgptTargetOptions| {
            OcChatgptTargetDetectionResult::NoTarget(none_detection())
        };
        let preview_called = std::sync::atomic::AtomicBool::new(false);
        let preview = |_: Option<&AccountStorageV3>, _: Option<&AccountStorageV3>| {
            preview_called.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(preview_oc_chatgpt_import_merge(None, None))
        };
        let result = plan_oc_chatgpt_sync(PlanOcChatgptSyncOptions {
            source: Some(&source),
            dependencies: PlanOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                preview_merge: Some(&preview),
                load_target_storage: None,
            },
            ..Default::default()
        })
        .await;
        match result {
            OcChatgptSyncPlanResult::BlockedNone { detection } => {
                assert_eq!(detection.reason, "missing");
            }
            other => panic!("expected blocked-none, got {other:?}"),
        }
        assert!(!preview_called.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn returns_blocked_ambiguous_when_target_is_ambiguous() {
        let source = source_storage();
        let detect = |_: &DetectOcChatgptTargetOptions| {
            OcChatgptTargetDetectionResult::Ambiguous(ambiguous_detection())
        };
        let result = plan_oc_chatgpt_sync(PlanOcChatgptSyncOptions {
            source: Some(&source),
            dependencies: PlanOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                preview_merge: None,
                load_target_storage: None,
            },
            ..Default::default()
        })
        .await;
        match result {
            OcChatgptSyncPlanResult::BlockedAmbiguous { detection } => {
                assert_eq!(detection.reason, "multiple");
            }
            other => panic!("expected blocked-ambiguous, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_ready_preview_when_target_is_found() {
        let source = source_storage();
        let destination = destination_storage();
        let detect = detect_target_fixture("C:/target".to_string());
        let result = plan_oc_chatgpt_sync(PlanOcChatgptSyncOptions {
            source: Some(&source),
            destination: Some(Some(&destination)),
            dependencies: PlanOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                preview_merge: None,
                load_target_storage: None,
            },
            ..Default::default()
        })
        .await;
        match result {
            OcChatgptSyncPlanResult::Ready {
                target,
                preview,
                payload,
                destination: dest,
            } => {
                assert_eq!(preview.to_add.len(), 1);
                assert_eq!(preview.to_update.len(), 0);
                assert_eq!(preview.to_skip.len(), 0);
                assert_eq!(preview.unchanged_destination_only.len(), 1);
                assert_eq!(preview.active_selection_behavior, "preserve-destination");
                assert_eq!(preview.merged.accounts.len(), 2);
                assert_eq!(preview.merged.active_index, destination.active_index);
                assert_eq!(payload, preview.payload);
                assert_eq!(dest.as_ref(), Some(&destination));
                assert!(target.account_path.contains("openai-codex-accounts.json"));
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    // chatgpt-import-06: planning must return a structured error (not
    // panic/throw) when loading the target fails.
    #[tokio::test]
    async fn returns_plan_error_when_loading_the_target_fails() {
        let source = source_storage();
        let detect = detect_target_fixture("C:/target".to_string());
        let load = |_: &OcChatgptTargetDescriptor| -> Result<Option<AccountStorageV3>, OcSyncError> {
            Err("corrupt destination file".into())
        };
        let result = plan_oc_chatgpt_sync(PlanOcChatgptSyncOptions {
            source: Some(&source),
            // destination omitted -> loadTargetStorage is invoked
            destination: None,
            dependencies: PlanOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                preview_merge: None,
                load_target_storage: Some(&load),
            },
            ..Default::default()
        })
        .await;
        match result {
            OcChatgptSyncPlanResult::PlanError { target, error, cause } => {
                assert_eq!(cause, OcChatgptPlanErrorCause::Load);
                assert!(error.to_string().contains("corrupt destination"));
                assert!(target.account_path.contains("openai-codex-accounts.json"));
            }
            other => panic!("expected plan-error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_plan_error_when_previewing_the_merge_fails() {
        let source = source_storage();
        let destination = destination_storage();
        let detect = detect_target_fixture("C:/target".to_string());
        let preview = |_: Option<&AccountStorageV3>,
                       _: Option<&AccountStorageV3>|
         -> Result<OcChatgptMergePreview, OcSyncError> { Err("preview boom".into()) };
        let result = plan_oc_chatgpt_sync(PlanOcChatgptSyncOptions {
            source: Some(&source),
            destination: Some(Some(&destination)),
            dependencies: PlanOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                preview_merge: Some(&preview),
                load_target_storage: None,
            },
            ..Default::default()
        })
        .await;
        match result {
            OcChatgptSyncPlanResult::PlanError { cause, .. } => {
                assert_eq!(cause, OcChatgptPlanErrorCause::Preview);
            }
            other => panic!("expected plan-error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_applied_when_persist_succeeds() {
        let source = source_storage();
        let destination = destination_storage();
        let detect = detect_target_fixture("C:/target".to_string());
        let persist_calls = std::sync::Mutex::new(Vec::<(String, usize)>::new());
        let persist = |target: &OcChatgptTargetDescriptor,
                       merged: &AccountStorageV3|
         -> Result<Option<String>, OcSyncError> {
            persist_calls
                .lock()
                .unwrap()
                .push((target.account_path.clone(), merged.accounts.len()));
            Ok(Some("C:/target/openai-codex-accounts.json".to_string()))
        };
        let result = apply_oc_chatgpt_sync(ApplyOcChatgptSyncOptions {
            source: Some(&source),
            destination: Some(Some(&destination)),
            dependencies: ApplyOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                persist_merged: Some(&persist),
                ..Default::default()
            },
            ..Default::default()
        })
        .await;

        let calls = persist_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].0.contains("openai-codex-accounts.json"));
        assert_eq!(calls[0].1, 2);
        match result {
            OcChatgptSyncApplyResult::Applied {
                persisted_path,
                preview,
                merged,
                ..
            } => {
                assert_eq!(
                    persisted_path.as_deref(),
                    Some("C:/target/openai-codex-accounts.json")
                );
                assert_eq!(preview.to_add.len(), 1);
                assert_eq!(preview.unchanged_destination_only.len(), 1);
                assert!(merged.accounts.iter().any(|a| a.account_id.as_deref() == Some("acc_dest")));
                assert!(merged.accounts.iter().any(|a| a.account_id.as_deref() == Some("acc_1")));
            }
            other => panic!("expected applied, got {other:?}"),
        }
    }

    // Regression (chatgpt-import-01/02): the default persister writes the
    // merged secret-bearing account file atomically; no temp file leaks.
    #[tokio::test]
    async fn default_persister_writes_the_merged_file_atomically() {
        let dir = std::env::temp_dir().join(format!(
            "codex-oc-persist-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let account_path = dir.join("openai-codex-accounts.json");
        let source = source_storage();
        let destination = destination_storage();
        let root = dir.to_string_lossy().into_owned();
        let detect = detect_target_fixture(root);

        let result = apply_oc_chatgpt_sync(ApplyOcChatgptSyncOptions {
            source: Some(&source),
            destination: Some(Some(&destination)),
            dependencies: ApplyOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                // no persist_merged -> real persist_merged_default runs
                ..Default::default()
            },
            ..Default::default()
        })
        .await;

        match &result {
            OcChatgptSyncApplyResult::Applied { persisted_path, .. } => {
                assert_eq!(
                    persisted_path.as_deref(),
                    Some(account_path.to_string_lossy().as_ref())
                );
            }
            other => panic!("expected applied, got {other:?}"),
        }

        // File landed (atomic rename completed), parses, ends with "\n", and
        // no temp file leaked behind.
        let written = std::fs::read_to_string(&account_path).unwrap();
        assert!(written.ends_with('\n'));
        assert!(!written.ends_with("\n\n"));
        let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(parsed["version"], 3);
        assert!(parsed["accounts"].as_array().unwrap().len() >= 2);
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leaked temp files: {leftovers:?}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&account_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        remove_recursive_with_retry(&dir).unwrap();
    }

    #[tokio::test]
    async fn returns_structured_error_when_persist_fails() {
        let source = source_storage();
        let destination = destination_storage();
        let detect = detect_target_fixture("C:/locked".to_string());
        let persist = |_: &OcChatgptTargetDescriptor,
                       _: &AccountStorageV3|
         -> Result<Option<String>, OcSyncError> {
            Err("EACCES: permission denied, open C:/locked/openai-codex-accounts.json".into())
        };
        let result = apply_oc_chatgpt_sync(ApplyOcChatgptSyncOptions {
            source: Some(&source),
            destination: Some(Some(&destination)),
            dependencies: ApplyOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                persist_merged: Some(&persist),
                ..Default::default()
            },
            ..Default::default()
        })
        .await;
        match result {
            OcChatgptSyncApplyResult::Error { target, error } => {
                assert!(error.to_string().contains("EACCES"));
                assert!(target.account_path.contains("openai-codex-accounts.json"));
                assert!(target.root.contains("locked"));
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn persist_failure_with_now_blocked_detection_returns_blocked() {
        // The TS catch-all re-runs detection; a now-blocked detection wins.
        let source = source_storage();
        let destination = destination_storage();
        let call_count = std::sync::atomic::AtomicUsize::new(0);
        let detect = |_: &DetectOcChatgptTargetOptions| {
            let n = call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                OcChatgptTargetDetectionResult::Target {
                    descriptor: target_descriptor("C:/target"),
                }
            } else {
                OcChatgptTargetDetectionResult::NoTarget(none_detection())
            }
        };
        let persist = |_: &OcChatgptTargetDescriptor,
                       _: &AccountStorageV3|
         -> Result<Option<String>, OcSyncError> { Err("boom".into()) };
        let result = apply_oc_chatgpt_sync(ApplyOcChatgptSyncOptions {
            source: Some(&source),
            destination: Some(Some(&destination)),
            dependencies: ApplyOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                persist_merged: Some(&persist),
                ..Default::default()
            },
            ..Default::default()
        })
        .await;
        assert!(matches!(
            result,
            OcChatgptSyncApplyResult::BlockedNone { .. }
        ));
    }

    #[tokio::test]
    async fn passes_injected_load_target_storage_through_apply_planning() {
        let source = source_storage();
        let loaded_destination = destination_storage();
        let load_calls = std::sync::atomic::AtomicUsize::new(0);
        let load = |_: &OcChatgptTargetDescriptor| -> Result<Option<AccountStorageV3>, OcSyncError> {
            load_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(Some(loaded_destination.clone()))
        };
        let detect = detect_target_fixture("C:/target".to_string());
        let persist = |_: &OcChatgptTargetDescriptor,
                       _: &AccountStorageV3|
         -> Result<Option<String>, OcSyncError> {
            Ok(Some("C:/target/openai-codex-accounts.json".to_string()))
        };
        let result = apply_oc_chatgpt_sync(ApplyOcChatgptSyncOptions {
            source: Some(&source),
            destination: None,
            dependencies: ApplyOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                load_target_storage: Some(&load),
                persist_merged: Some(&persist),
                ..Default::default()
            },
            ..Default::default()
        })
        .await;
        assert_eq!(load_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(matches!(result, OcChatgptSyncApplyResult::Applied { .. }));
    }

    #[tokio::test]
    async fn returns_structured_error_when_load_target_storage_fails_during_apply() {
        let source = source_storage();
        let detect = detect_target_fixture("C:/target".to_string());
        let load = |_: &OcChatgptTargetDescriptor| -> Result<Option<AccountStorageV3>, OcSyncError> {
            Err("EACCES: permission denied".into())
        };
        let result = apply_oc_chatgpt_sync(ApplyOcChatgptSyncOptions {
            source: Some(&source),
            destination: None,
            dependencies: ApplyOcChatgptSyncDependencies {
                detect_target: Some(&detect),
                load_target_storage: Some(&load),
                ..Default::default()
            },
            ..Default::default()
        })
        .await;
        match result {
            OcChatgptSyncApplyResult::Error { target, error } => {
                assert!(error.to_string().contains("EACCES"));
                assert_eq!(
                    target.account_path,
                    Path::new("C:/target")
                        .join("openai-codex-accounts.json")
                        .to_string_lossy()
                );
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_collision_when_named_backup_export_collides() {
        let export = |_: &str, _: bool| -> Result<String, CodexError> {
            Err(CodexError::new(
                "named backup already exists: C:/target/backups/backup-2026-03-10.json",
            ))
        };
        let result = run_named_backup_export(RunNamedBackupExportOptions {
            name: "backup-2026-03-10".to_string(),
            force: false,
            export_backup: Some(&export),
        })
        .await;
        match result {
            RunNamedBackupExportResult::Collision { path } => {
                assert!(path.contains("backup-2026-03-10.json"));
            }
            other => panic!("expected collision, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn extracts_collision_paths_from_message_only_backup_errors() {
        let export = |_: &str, _: bool| -> Result<String, CodexError> {
            Err(CodexError::new(
                "named backup already exists: C:/target/backups/backup-2026-03-11.json",
            ))
        };
        let result = run_named_backup_export(RunNamedBackupExportOptions {
            name: "backup-2026-03-11".to_string(),
            force: false,
            export_backup: Some(&export),
        })
        .await;
        match result {
            RunNamedBackupExportResult::Collision { path } => {
                assert_eq!(path, "C:/target/backups/backup-2026-03-11.json");
            }
            other => panic!("expected collision, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_error_for_non_collision_backup_failures() {
        let export = |_: &str, _: bool| -> Result<String, CodexError> {
            Err(CodexError::new(
                "EACCES: permission denied, mkdir C:/target/backups",
            ))
        };
        let result = run_named_backup_export(RunNamedBackupExportOptions {
            name: "backup-2026-03-12".to_string(),
            force: false,
            export_backup: Some(&export),
        })
        .await;
        match result {
            RunNamedBackupExportResult::Error { path, error } => {
                assert_eq!(path, None);
                assert!(error.message().contains("EACCES"));
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn extract_collision_path_matches_the_frozen_export_message() {
        let error = CodexError::new("File already exists: /root/backups/name.json");
        assert_eq!(
            extract_collision_path(&error).as_deref(),
            Some("/root/backups/name.json")
        );
        let no_match = CodexError::new("something else went wrong");
        assert_eq!(extract_collision_path(&no_match), None);
    }
}
