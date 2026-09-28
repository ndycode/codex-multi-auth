//! Port of `lib/oc-chatgpt-target-detection.ts` — filesystem probing to
//! locate the oc-chatgpt-multi-auth storage root.
//!
//! Tri-state `explicitRoot` (spec 12 gotcha 18): the TS code distinguishes
//! "property absent" (env override active) from "property present but
//! null/undefined" (env override DISABLED) via the `in` operator; the Rust
//! port models this as `Option<Option<String>>`.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use cma_storage::paths::{
    find_project_root, get_project_storage_key, resolve_project_storage_identity_root,
};

const ACCOUNT_FILE_NAME: &str = "openai-codex-accounts.json";
const BACKUPS_DIR_NAME: &str = "backups";
const PROJECTS_DIR_NAME: &str = "projects";
const CANONICAL_HOME_BASENAME: &str = ".opencode";

/// TS `OcChatgptTargetScope = "global" | "project"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OcChatgptTargetScope {
    Global,
    Project,
}

impl OcChatgptTargetScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            OcChatgptTargetScope::Global => "global",
            OcChatgptTargetScope::Project => "project",
        }
    }
}

/// TS `OcChatgptTargetSource = "explicit" | "default-global" | "project"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OcChatgptTargetSource {
    Explicit,
    DefaultGlobal,
    Project,
}

impl OcChatgptTargetSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            OcChatgptTargetSource::Explicit => "explicit",
            OcChatgptTargetSource::DefaultGlobal => "default-global",
            OcChatgptTargetSource::Project => "project",
        }
    }
}

/// TS `resolution: "accounts" | "signals"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OcChatgptTargetResolution {
    Accounts,
    Signals,
}

impl OcChatgptTargetResolution {
    pub const fn as_str(self) -> &'static str {
        match self {
            OcChatgptTargetResolution::Accounts => "accounts",
            OcChatgptTargetResolution::Signals => "signals",
        }
    }
}

/// TS `OcChatgptTargetDescriptor`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OcChatgptTargetDescriptor {
    pub scope: OcChatgptTargetScope,
    pub root: String,
    pub account_path: String,
    pub backup_root: String,
    pub source: OcChatgptTargetSource,
    pub resolution: OcChatgptTargetResolution,
}

/// One `candidates` entry of the ambiguous result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OcChatgptTargetCandidateInfo {
    pub scope: OcChatgptTargetScope,
    pub root: String,
    pub account_path: String,
    pub backup_root: String,
    pub source: OcChatgptTargetSource,
    pub has_account_artifacts: bool,
    pub has_signals: bool,
}

/// One `tried` entry of the none result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OcChatgptTargetTried {
    pub scope: OcChatgptTargetScope,
    pub source: OcChatgptTargetSource,
    pub root: String,
    pub account_path: String,
    pub backup_root: String,
}

/// TS `OcChatgptTargetAmbiguous` (sans the literal `kind`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OcChatgptTargetAmbiguous {
    pub reason: String,
    pub candidates: Vec<OcChatgptTargetCandidateInfo>,
}

/// TS `OcChatgptTargetNone` (sans the literal `kind`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OcChatgptTargetNone {
    pub reason: String,
    pub tried: Vec<OcChatgptTargetTried>,
}

/// TS `OcChatgptTargetDetectionResult` (tags: `"target"`, `"ambiguous"`,
/// `"none"`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OcChatgptTargetDetectionResult {
    Target { descriptor: OcChatgptTargetDescriptor },
    Ambiguous(OcChatgptTargetAmbiguous),
    NoTarget(OcChatgptTargetNone),
}

/// Options for [`detect_oc_chatgpt_multi_auth_target`].
#[derive(Clone, Debug, Default)]
pub struct DetectOcChatgptTargetOptions {
    /// Tri-state (TS `"explicitRoot" in options`):
    /// - `None` — property absent: env `OC_CHATGPT_MULTI_AUTH_DIR` applies;
    /// - `Some(None)` — `explicitRoot: null`: env override DISABLED;
    /// - `Some(Some(root))` — explicit root forced.
    pub explicit_root: Option<Option<String>>,
    /// `None` → `findProjectRoot(process.cwd())` (TS `??` — a `null`
    /// project root also falls back to detection).
    pub project_root: Option<PathBuf>,
}

struct Candidate {
    scope: OcChatgptTargetScope,
    source: OcChatgptTargetSource,
    root: String,
    account_path: String,
    backup_root: String,
    has_account_artifacts: bool,
    has_signals: bool,
}

/// TS `getResolvedUserHomeDir()` — win32 prefers USERPROFILE > HOME >
/// HOMEDRIVE+HOMEPATH > os home; POSIX prefers HOME > os home.
fn get_resolved_user_home_dir() -> String {
    fn env_trimmed(key: &str) -> Option<String> {
        let value = std::env::var(key).ok()?;
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
    let os_home = || {
        std::env::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    if cfg!(windows) {
        if let Some(userprofile) = env_trimmed("USERPROFILE") {
            return userprofile;
        }
        if let Some(home) = env_trimmed("HOME") {
            return home;
        }
        if let (Some(drive), Some(path)) = (env_trimmed("HOMEDRIVE"), env_trimmed("HOMEPATH")) {
            // `win32.resolve(`${HOMEDRIVE}\\`, HOMEPATH)` — join the drive
            // root with the (usually root-relative) home path.
            let joined = if path.starts_with('\\') || path.starts_with('/') {
                format!("{drive}{path}")
            } else {
                format!("{drive}\\{path}")
            };
            return joined;
        }
        return os_home();
    }
    if let Some(home) = env_trimmed("HOME") {
        return home;
    }
    os_home()
}

/// TS `isWindowsDriveRoot(candidate)` — `C:` or `C:\`.
fn is_windows_drive_root(candidate: &str) -> bool {
    let bytes = candidate.as_bytes();
    match bytes.len() {
        2 => bytes[0].is_ascii_alphabetic() && bytes[1] == b':',
        3 => bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\',
        _ => false,
    }
}

/// Lexical `normalize(resolve(p))` — absolutize against the cwd, resolve
/// `.`/`..` segments, and reassemble with the platform separator (Node's
/// path.resolve does not consult the filesystem either).
fn lexical_resolve(p: &str) -> PathBuf {
    let path = Path::new(p);
    let joined: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let mut base = std::env::current_dir().unwrap_or_default();
        base.push(path);
        base
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let popped = out.pop();
                let _ = popped; // ".." above the root is dropped (Node parity)
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// TS `normalizeCandidatePath(candidate)`.
fn normalize_candidate_path(candidate: &str) -> String {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let normalized = lexical_resolve(trimmed).to_string_lossy().into_owned();
    if cfg!(windows) && is_windows_drive_root(&normalized) {
        if normalized.ends_with('\\') {
            return normalized;
        }
        return format!("{normalized}\\");
    }
    if normalized.chars().count() > 1
        && (normalized.ends_with('\\') || normalized.ends_with('/'))
    {
        return normalized
            .trim_end_matches(['\\', '/'])
            .to_string();
    }
    normalized
}

/// TS `deduplicatePaths(paths)` — normalize, drop empties, dedup (win32:
/// case-insensitive), first-seen order preserved.
fn deduplicate_paths(paths: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut result: Vec<String> = Vec::new();
    for candidate in paths {
        let normalized = normalize_candidate_path(candidate);
        if normalized.is_empty() {
            continue;
        }
        let key = if cfg!(windows) {
            normalized.to_lowercase()
        } else {
            normalized.clone()
        };
        if seen.insert(key) {
            result.push(normalized);
        }
    }
    result
}

fn join_str(root: &str, name: &str) -> String {
    Path::new(root).join(name).to_string_lossy().into_owned()
}

/// Rotated-artifact filename filter (spec 12 gotcha 19): starts with
/// `openai-codex-accounts.json.`, excludes `.tmp`, `.wal`, and any name
/// containing `.rotate.`. Readdir errors are swallowed.
fn has_rotated(dir: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&format!("{ACCOUNT_FILE_NAME}.")) {
            continue;
        }
        if name.ends_with(".tmp") || name.ends_with(".wal") || name.contains(".rotate.") {
            continue;
        }
        return true;
    }
    false
}

/// TS `hasAccountArtifacts(root)`.
fn has_account_artifacts(root: &str) -> bool {
    let account_path = join_str(root, ACCOUNT_FILE_NAME);
    if Path::new(&account_path).exists() || Path::new(&format!("{account_path}.wal")).exists() {
        return true;
    }
    if has_rotated(root) {
        return true;
    }
    let backups_dir = join_str(root, BACKUPS_DIR_NAME);
    if Path::new(&join_str(&backups_dir, ACCOUNT_FILE_NAME)).exists() {
        return true;
    }
    has_rotated(&backups_dir)
}

/// TS `hasStorageSignals(root)` — a `backups` or `projects` dir exists.
fn has_storage_signals(root: &str) -> bool {
    Path::new(&join_str(root, BACKUPS_DIR_NAME)).exists()
        || Path::new(&join_str(root, PROJECTS_DIR_NAME)).exists()
}

/// TS `inferScopeFromRoot(root, canonicalRoot)` — `"project"` iff `root`
/// lives under `<canonicalRoot>/projects/`.
fn infer_scope_from_root(root: &str, canonical_root: &str) -> OcChatgptTargetScope {
    // Node `relative(canonicalRoot, root)` compares case-insensitively on
    // win32 when finding the common prefix.
    let (root_key, canonical_key) = if cfg!(windows) {
        (root.to_lowercase(), canonical_root.to_lowercase())
    } else {
        (root.to_string(), canonical_root.to_string())
    };
    let sep = std::path::MAIN_SEPARATOR;
    let prefix = format!("{canonical_key}{sep}");
    let Some(remainder) = root_key.strip_prefix(&prefix) else {
        return OcChatgptTargetScope::Global;
    };
    if remainder.starts_with(&format!("{PROJECTS_DIR_NAME}{sep}")) {
        OcChatgptTargetScope::Project
    } else {
        OcChatgptTargetScope::Global
    }
}

/// TS `detectOcChatgptMultiAuthTarget(options)`.
pub fn detect_oc_chatgpt_multi_auth_target(
    options: &DetectOcChatgptTargetOptions,
) -> OcChatgptTargetDetectionResult {
    let explicit_from_env = std::env::var("OC_CHATGPT_MULTI_AUTH_DIR")
        .unwrap_or_default()
        .trim()
        .to_string();
    let explicit_root = match &options.explicit_root {
        Some(inner) => inner.clone().unwrap_or_default(),
        None => explicit_from_env,
    }
    .trim()
    .to_string();

    let user_home = get_resolved_user_home_dir();
    let canonical_root = join_str(&user_home, CANONICAL_HOME_BASENAME);
    let project_root = options.project_root.clone().or_else(|| {
        find_project_root(&std::env::current_dir().unwrap_or_default())
    });
    let identity_root = project_root
        .as_deref()
        .map(resolve_project_storage_identity_root);
    let project_storage_root = identity_root.map(|identity| {
        Path::new(&canonical_root)
            .join(PROJECTS_DIR_NAME)
            .join(get_project_storage_key(&identity))
            .to_string_lossy()
            .into_owned()
    });

    let normalized_explicit_root = if explicit_root.is_empty() {
        String::new()
    } else {
        normalize_candidate_path(&explicit_root)
    };
    let ordered_roots: Vec<String> = if !normalized_explicit_root.is_empty() {
        vec![normalized_explicit_root.clone()]
    } else {
        let mut roots = vec![canonical_root.clone()];
        if let Some(project) = &project_storage_root {
            roots.push(project.clone());
        }
        deduplicate_paths(&roots)
    };

    let candidates: Vec<Candidate> = ordered_roots
        .into_iter()
        .map(|root| {
            let inferred_scope = infer_scope_from_root(&root, &canonical_root);
            let source = if root == normalized_explicit_root && !normalized_explicit_root.is_empty()
            {
                OcChatgptTargetSource::Explicit
            } else if inferred_scope == OcChatgptTargetScope::Project {
                OcChatgptTargetSource::Project
            } else {
                OcChatgptTargetSource::DefaultGlobal
            };
            let account_path = join_str(&root, ACCOUNT_FILE_NAME);
            let backup_root = join_str(&root, BACKUPS_DIR_NAME);
            let has_account_artifacts_flag = has_account_artifacts(&root);
            let has_signals = has_account_artifacts_flag || has_storage_signals(&root);
            Candidate {
                scope: inferred_scope,
                source,
                root,
                account_path,
                backup_root,
                has_account_artifacts: has_account_artifacts_flag,
                has_signals,
            }
        })
        .collect();

    let to_descriptor = |candidate: &Candidate, resolution: OcChatgptTargetResolution| {
        OcChatgptTargetDescriptor {
            scope: candidate.scope,
            source: candidate.source,
            root: candidate.root.clone(),
            account_path: candidate.account_path.clone(),
            backup_root: candidate.backup_root.clone(),
            resolution,
        }
    };
    let to_candidate_info = |candidate: &Candidate| OcChatgptTargetCandidateInfo {
        scope: candidate.scope,
        source: candidate.source,
        root: candidate.root.clone(),
        account_path: candidate.account_path.clone(),
        backup_root: candidate.backup_root.clone(),
        has_account_artifacts: candidate.has_account_artifacts,
        has_signals: candidate.has_signals,
    };

    let with_accounts: Vec<&Candidate> = candidates
        .iter()
        .filter(|candidate| candidate.has_account_artifacts)
        .collect();
    if with_accounts.len() == 1 {
        return OcChatgptTargetDetectionResult::Target {
            descriptor: to_descriptor(with_accounts[0], OcChatgptTargetResolution::Accounts),
        };
    }
    if with_accounts.len() > 1 {
        return OcChatgptTargetDetectionResult::Ambiguous(OcChatgptTargetAmbiguous {
            reason:
                "Multiple oc-chatgpt-multi-auth targets contain account artifacts; refusing to guess."
                    .to_string(),
            candidates: with_accounts.iter().map(|c| to_candidate_info(c)).collect(),
        });
    }

    let with_signals: Vec<&Candidate> = candidates
        .iter()
        .filter(|candidate| candidate.has_signals)
        .collect();
    if with_signals.len() == 1 {
        return OcChatgptTargetDetectionResult::Target {
            descriptor: to_descriptor(with_signals[0], OcChatgptTargetResolution::Signals),
        };
    }
    if with_signals.len() > 1 {
        return OcChatgptTargetDetectionResult::Ambiguous(OcChatgptTargetAmbiguous {
            reason:
                "Multiple oc-chatgpt-multi-auth targets contain storage signals; refusing to guess."
                    .to_string(),
            candidates: with_signals.iter().map(|c| to_candidate_info(c)).collect(),
        });
    }

    OcChatgptTargetDetectionResult::NoTarget(OcChatgptTargetNone {
        reason:
            "No oc-chatgpt-multi-auth target root found; create ~/.opencode or supply OC_CHATGPT_MULTI_AUTH_DIR."
                .to_string(),
        tried: candidates
            .iter()
            .map(|candidate| OcChatgptTargetTried {
                scope: candidate.scope,
                source: candidate.source,
                root: candidate.root.clone(),
                account_path: candidate.account_path.clone(),
                backup_root: candidate.backup_root.clone(),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;
    use std::fs;

    // Ported from test/oc-chatgpt-target-detection.test.ts. Every test pins
    // HOME/USERPROFILE via the env sandbox and passes an explicit projectRoot
    // (or explicit root) so the repo's own git checkout never leaks in.

    fn assert_target(
        result: &OcChatgptTargetDetectionResult,
        expected_scope: OcChatgptTargetScope,
        expected_root: &str,
    ) -> OcChatgptTargetDescriptor {
        match result {
            OcChatgptTargetDetectionResult::Target { descriptor } => {
                assert_eq!(descriptor.scope, expected_scope);
                assert_eq!(descriptor.root, expected_root);
                descriptor.clone()
            }
            other => panic!("expected target, got {other:?}"),
        }
    }

    fn opts_with_project(project: &Path) -> DetectOcChatgptTargetOptions {
        DetectOcChatgptTargetOptions {
            explicit_root: None,
            project_root: Some(project.to_path_buf()),
        }
    }

    fn opts_with_explicit(root: &str) -> DetectOcChatgptTargetOptions {
        DetectOcChatgptTargetOptions {
            explicit_root: Some(Some(root.to_string())),
            project_root: Some(std::env::temp_dir().join("cma-no-project-here")),
        }
    }

    #[test]
    #[serial(env)]
    fn returns_project_scoped_target_when_only_project_account_storage_exists() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let home = sandbox.root().to_path_buf();
        let project_dir = home.join("project-alpha");
        fs::create_dir_all(project_dir.join(".git")).unwrap();

        let identity_root = resolve_project_storage_identity_root(&project_dir);
        let project_key = get_project_storage_key(&identity_root);
        let project_root = home.join(".opencode").join("projects").join(&project_key);
        fs::create_dir_all(&project_root).unwrap();
        fs::write(project_root.join("openai-codex-accounts.json"), "{}").unwrap();

        let result = detect_oc_chatgpt_multi_auth_target(&opts_with_project(&project_dir));
        let descriptor = assert_target(
            &result,
            OcChatgptTargetScope::Project,
            &project_root.to_string_lossy(),
        );
        assert_eq!(
            descriptor.account_path,
            project_root
                .join("openai-codex-accounts.json")
                .to_string_lossy()
        );
        assert_eq!(
            descriptor.backup_root,
            project_root.join("backups").to_string_lossy()
        );
        assert_eq!(descriptor.resolution, OcChatgptTargetResolution::Accounts);
    }

    #[test]
    #[serial(env)]
    fn returns_ambiguous_when_both_global_and_project_accounts_exist() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let home = sandbox.root().to_path_buf();
        let project_dir = home.join("project-beta");
        fs::create_dir_all(project_dir.join(".git")).unwrap();

        let identity_root = resolve_project_storage_identity_root(&project_dir);
        let project_key = get_project_storage_key(&identity_root);
        let project_root = home.join(".opencode").join("projects").join(&project_key);
        fs::create_dir_all(&project_root).unwrap();
        fs::write(project_root.join("openai-codex-accounts.json"), "{}").unwrap();

        let global_root = home.join(".opencode");
        fs::write(global_root.join("openai-codex-accounts.json"), "{}").unwrap();

        let result = detect_oc_chatgpt_multi_auth_target(&opts_with_project(&project_dir));
        match result {
            OcChatgptTargetDetectionResult::Ambiguous(ambiguous) => {
                assert_eq!(ambiguous.candidates.len(), 2);
                assert_eq!(
                    ambiguous.reason,
                    "Multiple oc-chatgpt-multi-auth targets contain account artifacts; refusing to guess."
                );
            }
            other => panic!("expected ambiguous, got {other:?}"),
        }
    }

    #[test]
    #[serial(env)]
    fn returns_explicit_target_from_storage_signals() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let override_root = sandbox.root().join("override-signals-root");
        fs::create_dir_all(override_root.join("backups")).unwrap();

        let override_str = override_root.to_string_lossy().into_owned();
        let result = detect_oc_chatgpt_multi_auth_target(&opts_with_explicit(&override_str));
        let descriptor =
            assert_target(&result, OcChatgptTargetScope::Global, &override_str);
        assert_eq!(descriptor.source, OcChatgptTargetSource::Explicit);
        assert_eq!(descriptor.resolution, OcChatgptTargetResolution::Signals);
        assert_eq!(
            descriptor.account_path,
            override_root
                .join("openai-codex-accounts.json")
                .to_string_lossy()
        );
    }

    #[test]
    #[serial(env)]
    fn explicit_root_null_disables_the_environment_override() {
        let mut sandbox = EnvSandbox::new();
        let home = sandbox.root().to_path_buf();
        let override_root = home.join("env-override-root");
        let canonical_root = home.join(".opencode");
        fs::create_dir_all(override_root.join("backups")).unwrap();
        fs::create_dir_all(canonical_root.join("backups")).unwrap();
        sandbox.set_var("OC_CHATGPT_MULTI_AUTH_DIR", &override_root);

        let options = DetectOcChatgptTargetOptions {
            explicit_root: Some(None),
            project_root: Some(home.join("no-project-here")),
        };
        let result = detect_oc_chatgpt_multi_auth_target(&options);
        let descriptor = assert_target(
            &result,
            OcChatgptTargetScope::Global,
            &canonical_root.to_string_lossy(),
        );
        assert_eq!(descriptor.source, OcChatgptTargetSource::DefaultGlobal);
    }

    #[test]
    #[serial(env)]
    fn explicit_env_override_is_authoritative_when_default_roots_also_qualify() {
        let mut sandbox = EnvSandbox::new();
        let home = sandbox.root().to_path_buf();
        let override_root = home.join("override-root");
        let canonical_root = home.join(".opencode");
        fs::create_dir_all(override_root.join("backups")).unwrap();
        fs::create_dir_all(canonical_root.join("projects")).unwrap();
        sandbox.set_var("OC_CHATGPT_MULTI_AUTH_DIR", &override_root);

        let options = DetectOcChatgptTargetOptions {
            explicit_root: None,
            project_root: Some(home.join("no-project-here")),
        };
        let result = detect_oc_chatgpt_multi_auth_target(&options);
        let descriptor = assert_target(
            &result,
            OcChatgptTargetScope::Global,
            &override_root.to_string_lossy(),
        );
        assert_eq!(descriptor.source, OcChatgptTargetSource::Explicit);
        assert_eq!(descriptor.resolution, OcChatgptTargetResolution::Signals);
    }

    #[test]
    #[serial(env)]
    fn keeps_canonical_home_root_global_when_home_contains_projects_segment() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let nested_home = sandbox.root().join("projects").join("dev-home");
        fs::create_dir_all(&nested_home).unwrap();
        sandbox.set_var("HOME", &nested_home);
        sandbox.set_var("USERPROFILE", &nested_home);

        let canonical_root = nested_home.join(".opencode");
        fs::create_dir_all(canonical_root.join("backups")).unwrap();

        let options = DetectOcChatgptTargetOptions {
            explicit_root: None,
            project_root: Some(nested_home.join("no-project-here")),
        };
        let result = detect_oc_chatgpt_multi_auth_target(&options);
        let descriptor = assert_target(
            &result,
            OcChatgptTargetScope::Global,
            &canonical_root.to_string_lossy(),
        );
        assert_eq!(descriptor.source, OcChatgptTargetSource::DefaultGlobal);
    }

    #[test]
    #[serial(env)]
    fn keeps_explicit_roots_global_even_when_their_path_includes_projects() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let explicit_root = sandbox
            .root()
            .join("custom-root")
            .join("projects")
            .join("manual")
            .join(".opencode");
        fs::create_dir_all(explicit_root.join("backups")).unwrap();

        let explicit_str = explicit_root.to_string_lossy().into_owned();
        let result = detect_oc_chatgpt_multi_auth_target(&opts_with_explicit(&explicit_str));
        let descriptor = assert_target(&result, OcChatgptTargetScope::Global, &explicit_str);
        assert_eq!(descriptor.source, OcChatgptTargetSource::Explicit);
    }

    #[cfg(windows)]
    #[test]
    #[serial(env)]
    fn preserves_windows_drive_roots_after_normalization() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        // Q:\ is (almost certainly) unmapped, so no artifacts/signals exist.
        let result = detect_oc_chatgpt_multi_auth_target(&opts_with_explicit("Q:\\"));
        match result {
            OcChatgptTargetDetectionResult::NoTarget(none) => {
                assert_eq!(none.tried[0].root, "Q:\\");
            }
            other => panic!("expected none, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    #[serial(env)]
    fn normalizes_mixed_windows_separators_in_explicit_roots() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let result = detect_oc_chatgpt_multi_auth_target(&opts_with_explicit(
            "Q:\\Users/profile\\.opencode\\",
        ));
        match result {
            OcChatgptTargetDetectionResult::NoTarget(none) => {
                assert_eq!(none.tried[0].root, "Q:\\Users\\profile\\.opencode");
            }
            other => panic!("expected none, got {other:?}"),
        }
    }

    #[test]
    #[serial(env)]
    fn resolves_relative_explicit_roots_before_target_detection() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let absolute_root = sandbox.root().join("relative-override").join(".opencode");
        fs::create_dir_all(absolute_root.join("backups")).unwrap();

        let cwd = std::env::current_dir().unwrap();
        let Some(relative) = pathdiff_lexical(&cwd, &absolute_root) else {
            // Different drives (no relative form) — nothing to exercise.
            return;
        };
        let result =
            detect_oc_chatgpt_multi_auth_target(&opts_with_explicit(&relative));
        let descriptor = assert_target(
            &result,
            OcChatgptTargetScope::Global,
            &absolute_root.to_string_lossy(),
        );
        assert_eq!(descriptor.source, OcChatgptTargetSource::Explicit);
    }

    /// Minimal lexical `path.relative` for the test above.
    fn pathdiff_lexical(from: &Path, to: &Path) -> Option<String> {
        let from_components: Vec<String> = from
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let to_components: Vec<String> = to
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        if from_components.first() != to_components.first() {
            return None; // different prefixes (drives)
        }
        let mut common = 0;
        while common < from_components.len()
            && common < to_components.len()
            && from_components[common].to_lowercase() == to_components[common].to_lowercase()
        {
            common += 1;
        }
        let mut parts: Vec<String> = Vec::new();
        for _ in common..from_components.len() {
            parts.push("..".to_string());
        }
        parts.extend(to_components[common..].iter().cloned());
        Some(parts.join(std::path::MAIN_SEPARATOR_STR))
    }

    #[test]
    #[serial(env)]
    fn prefers_explicit_override_containing_backup_artifacts() {
        let mut sandbox = EnvSandbox::new();
        let override_root = sandbox.root().join("override-root");
        let backups_dir = override_root.join("backups");
        fs::create_dir_all(&backups_dir).unwrap();
        fs::write(
            backups_dir.join("openai-codex-accounts.json.manual-2026-03-09"),
            "{}",
        )
        .unwrap();
        sandbox.set_var("OC_CHATGPT_MULTI_AUTH_DIR", &override_root);

        let options = DetectOcChatgptTargetOptions {
            explicit_root: None,
            project_root: Some(sandbox.root().join("no-project-here")),
        };
        let result = detect_oc_chatgpt_multi_auth_target(&options);
        let descriptor = assert_target(
            &result,
            OcChatgptTargetScope::Global,
            &override_root.to_string_lossy(),
        );
        assert_eq!(descriptor.resolution, OcChatgptTargetResolution::Accounts);
    }

    #[test]
    #[serial(env)]
    fn returns_none_with_guidance_when_no_targets_exist() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let options = DetectOcChatgptTargetOptions {
            explicit_root: None,
            project_root: Some(sandbox.root().join("no-project-here")),
        };
        let result = detect_oc_chatgpt_multi_auth_target(&options);
        match result {
            OcChatgptTargetDetectionResult::NoTarget(none) => {
                assert!(none.reason.contains("~/.opencode"));
                assert!(!none.tried.is_empty());
                assert_eq!(
                    none.reason,
                    "No oc-chatgpt-multi-auth target root found; create ~/.opencode or supply OC_CHATGPT_MULTI_AUTH_DIR."
                );
            }
            other => panic!("expected none, got {other:?}"),
        }
    }

    #[test]
    #[serial(env)]
    fn reports_exact_global_and_project_roots_tried() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let home = sandbox.root().to_path_buf();
        let project_dir = home.join("project-delta");
        fs::create_dir_all(project_dir.join(".git")).unwrap();

        let identity_root = resolve_project_storage_identity_root(&project_dir);
        let project_key = get_project_storage_key(&identity_root);
        let canonical_root = home.join(".opencode");
        let project_root = canonical_root.join("projects").join(&project_key);

        let result = detect_oc_chatgpt_multi_auth_target(&opts_with_project(&project_dir));
        match result {
            OcChatgptTargetDetectionResult::NoTarget(none) => {
                assert!(none.reason.contains("OC_CHATGPT_MULTI_AUTH_DIR"));
                assert_eq!(
                    none.tried,
                    vec![
                        OcChatgptTargetTried {
                            scope: OcChatgptTargetScope::Global,
                            source: OcChatgptTargetSource::DefaultGlobal,
                            root: canonical_root.to_string_lossy().into_owned(),
                            account_path: canonical_root
                                .join("openai-codex-accounts.json")
                                .to_string_lossy()
                                .into_owned(),
                            backup_root: canonical_root
                                .join("backups")
                                .to_string_lossy()
                                .into_owned(),
                        },
                        OcChatgptTargetTried {
                            scope: OcChatgptTargetScope::Project,
                            source: OcChatgptTargetSource::Project,
                            root: project_root.to_string_lossy().into_owned(),
                            account_path: project_root
                                .join("openai-codex-accounts.json")
                                .to_string_lossy()
                                .into_owned(),
                            backup_root: project_root
                                .join("backups")
                                .to_string_lossy()
                                .into_owned(),
                        },
                    ]
                );
            }
            other => panic!("expected none, got {other:?}"),
        }
    }

    #[test]
    #[serial(env)]
    fn signals_resolution_when_only_backup_directory_exists() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let explicit_root = sandbox.root().join("signals-only-root");
        fs::create_dir_all(explicit_root.join("backups")).unwrap();

        let explicit_str = explicit_root.to_string_lossy().into_owned();
        let result = detect_oc_chatgpt_multi_auth_target(&opts_with_explicit(&explicit_str));
        let descriptor = assert_target(&result, OcChatgptTargetScope::Global, &explicit_str);
        assert_eq!(descriptor.resolution, OcChatgptTargetResolution::Signals);
        assert_eq!(
            descriptor.backup_root,
            explicit_root.join("backups").to_string_lossy()
        );
    }

    #[test]
    #[serial(env)]
    fn ignores_rotate_and_tmp_artifacts_when_detecting_account_artifacts() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("OC_CHATGPT_MULTI_AUTH_DIR");
        let explicit_root = sandbox.root().join("artifact-filter-root");
        let backups_dir = explicit_root.join("backups");
        fs::create_dir_all(&backups_dir).unwrap();
        fs::write(backups_dir.join("openai-codex-accounts.json.rotate.1"), "{}").unwrap();
        fs::write(backups_dir.join("openai-codex-accounts.json.tmp"), "{}").unwrap();
        fs::write(backups_dir.join("openai-codex-accounts.json.wal"), "{}").unwrap();

        let explicit_str = explicit_root.to_string_lossy().into_owned();
        let result = detect_oc_chatgpt_multi_auth_target(&opts_with_explicit(&explicit_str));
        let descriptor = assert_target(&result, OcChatgptTargetScope::Global, &explicit_str);
        assert_eq!(descriptor.resolution, OcChatgptTargetResolution::Signals);
    }
}
