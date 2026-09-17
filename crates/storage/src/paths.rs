//! Port of `lib/storage/paths.ts` — project-root detection, git-worktree
//! identity resolution, per-project storage keying, and `resolvePath`, the
//! security boundary for all user-supplied file paths.
//!
//! Behavior source: spec 02 §2.5–§2.6, gotchas 21–24.
//!
//! Frozen error strings (`resolvePath`):
//! - `"Invalid path: contains a NUL byte"`
//! - `"Access denied: path must be within home directory, project directory, or temp directory"`
//! - `"Access denied: path resolves (via symlink) outside the home, project, or temp directory"`
//! - worktree/backup-root messages live in their owning modules.

use std::fs;
use std::path::{Component, Path, PathBuf};

use cma_core::runtime_paths::get_codex_multi_auth_dir;

use crate::misc::compute_sha256;
use crate::path_state::get_storage_path_state;

/// `PROJECT_MARKERS` — a directory containing any of these is a project.
pub const PROJECT_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    ".codex",
];

const PROJECTS_DIR: &str = "projects";
const PROJECT_KEY_HASH_LENGTH: usize = 12;
const CANONICALIZE_WALK_CAP: usize = 4096;

/// Plain-`Error` analogue for the frozen `resolvePath` messages (the TS code
/// threw bare `Error`s; CLI callers match on the message text).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct PathError(pub String);

// ---------------------------------------------------------------------------
// Lexical path plumbing (Node path.resolve / path.relative analogues)
// ---------------------------------------------------------------------------

/// Node `os.homedir()` analogue: env first (`USERPROFILE` on Windows, `HOME`
/// on POSIX — libuv reads the env var on every call, which is what lets the
/// test sandbox pin it), falling back to the resolved user home via the
/// runtime-paths ladder (`get_legacy_codex_dir()`'s parent).
fn os_home_dir() -> PathBuf {
    let env_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Ok(value) = std::env::var(env_key)
        && !value.trim().is_empty()
    {
        return PathBuf::from(value);
    }
    cma_core::runtime_paths::get_legacy_codex_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

/// Lexical normalization of an absolute path: collapse `.`/`..`, drop
/// duplicate separators. Never touches the filesystem (Node `path.resolve`
/// semantics).
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR_STR),
            Component::CurDir => {}
            Component::ParentDir => {
                // `..` above the root is dropped for absolute paths.
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// Node `path.resolve(p)` analogue: absolutize against the cwd, then
/// lexically normalize.
fn resolve_lexical(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_lexical(path)
    } else {
        let cwd = std::env::current_dir().unwrap_or_default();
        normalize_lexical(&cwd.join(path))
    }
}

/// `normalizePathForComparison`: resolve, lowercase on win32.
fn normalize_for_comparison(path: &Path) -> String {
    let resolved = resolve_lexical(path);
    let s = resolved.to_string_lossy().into_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// `isWithinDirectory(baseDir, targetPath)` — `relative()` empty or neither
/// `..`-prefixed nor absolute. Implemented as a normalized component-prefix
/// check (equivalent for two absolute, normalized inputs; different Windows
/// drives yield an absolute relative() in Node and a failed prefix here).
fn is_within_directory(base_dir: &Path, target_path: &Path) -> bool {
    let base = normalize_for_comparison(base_dir);
    let target = normalize_for_comparison(target_path);
    let base_trimmed = base.trim_end_matches(['\\', '/']);
    if target == base || target == base_trimmed {
        return true;
    }
    if !target.starts_with(base_trimmed) {
        return false;
    }
    matches!(target.as_bytes().get(base_trimmed.len()), Some(b'/') | Some(b'\\'))
}

/// `isLookalikeSibling(baseDir, targetPath)` — detects lookalike-prefix
/// siblings such as `<parent-of-home>/<basename(home)>-outside/file.json`
/// (spec 02 §2.6 step 4). Filesystem roots have no siblings.
fn is_lookalike_sibling(base_dir: &Path, target_path: &Path) -> bool {
    let base = normalize_for_comparison(base_dir);
    let target = normalize_for_comparison(target_path);
    let base_without_trailing = base.trim_end_matches(['\\', '/']);
    if base_without_trailing.is_empty() || is_bare_drive(base_without_trailing) {
        return false;
    }
    if target.len() <= base_without_trailing.len() {
        return false;
    }
    if !target.starts_with(base_without_trailing) {
        return false;
    }
    let boundary = target.as_bytes()[base_without_trailing.len()];
    boundary != b'/' && boundary != b'\\'
}

/// `^[a-z]:$` (the comparison string is already lowercased on win32).
fn is_bare_drive(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_lowercase() && bytes[1] == b':'
}

/// `fs::canonicalize` returns `\\?\`-prefixed extended-length paths on
/// Windows; Node `realpathSync` does not — strip the prefix so string
/// comparisons keep working.
fn simplify_canonical(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest.to_string())
    } else {
        path
    }
}

/// `canonicalizeExistingPrefix(targetPath)` — realpath the deepest existing
/// ancestor and re-join the non-existent tail; failures return the input so
/// behavior degrades to the lexical guard (spec 02 §2.6 step 6).
fn canonicalize_existing_prefix(target_path: &Path) -> PathBuf {
    let mut current = target_path.to_path_buf();
    let mut trailing: Vec<std::ffi::OsString> = Vec::new();
    for _ in 0..CANONICALIZE_WALK_CAP {
        if current.exists() {
            break;
        }
        let Some(parent) = current.parent().map(Path::to_path_buf) else {
            // Reached the filesystem root without an existing ancestor.
            return target_path.to_path_buf();
        };
        if parent == current {
            return target_path.to_path_buf();
        }
        if let Some(name) = current.file_name() {
            trailing.insert(0, name.to_os_string());
        }
        current = parent;
    }
    match fs::canonicalize(&current) {
        Ok(real_base) => {
            let mut out = simplify_canonical(real_base);
            for part in trailing {
                out.push(part);
            }
            out
        }
        Err(_) => target_path.to_path_buf(),
    }
}

// ---------------------------------------------------------------------------
// resolvePath — the security boundary (spec 02 §2.6)
// ---------------------------------------------------------------------------

const ACCESS_DENIED: &str =
    "Access denied: path must be within home directory, project directory, or temp directory";
const ACCESS_DENIED_SYMLINK: &str =
    "Access denied: path resolves (via symlink) outside the home, project, or temp directory";

fn escapes_root_set(roots: &[&Path], candidate: &Path) -> bool {
    roots.iter().any(|root| is_lookalike_sibling(root, candidate))
        || !roots.iter().any(|root| is_within_directory(root, candidate))
}

/// `resolvePath(filePath)` — NUL rejection, `~` expansion (slices only the
/// tilde), home/project/tmp containment, lookalike-sibling rejection, and the
/// canonical (realpath) symlink-escape check evaluated against BOTH the raw
/// and canonicalized root sets. Returns the RESOLVED (non-canonical) path.
pub fn resolve_path(file_path: &str) -> Result<PathBuf, PathError> {
    if file_path.contains('\0') {
        return Err(PathError("Invalid path: contains a NUL byte".to_string()));
    }

    let resolved: PathBuf = if let Some(rest) = file_path.strip_prefix('~') {
        // `join(homedir(), filePath.slice(1))`: Node join concatenates (an
        // absolute-looking segment does NOT re-root), so strip leading
        // separators before the Rust join and normalize afterwards.
        let stripped = rest.trim_start_matches(['/', '\\']);
        normalize_lexical(&os_home_dir().join(stripped))
    } else {
        resolve_lexical(Path::new(file_path))
    };

    let home = os_home_dir();
    let state = get_storage_path_state();
    let project_root = state
        .current_project_root
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let tmp = std::env::temp_dir();

    if is_lookalike_sibling(&home, &resolved)
        || is_lookalike_sibling(&project_root, &resolved)
        || is_lookalike_sibling(&tmp, &resolved)
    {
        return Err(PathError(ACCESS_DENIED.to_string()));
    }

    if !is_within_directory(&home, &resolved)
        && !is_within_directory(&project_root, &resolved)
        && !is_within_directory(&tmp, &resolved)
    {
        return Err(PathError(ACCESS_DENIED.to_string()));
    }

    // storage-02: re-verify containment against the realpath-canonicalized
    // path. Deny only when the canonical target escapes BOTH the raw and the
    // canonical root sets (a root itself reached via a symlink, e.g. macOS
    // /var → /private/var, must not falsely deny).
    let canonical = canonicalize_existing_prefix(&resolved);
    if canonical != resolved {
        let raw_roots: [&Path; 3] = [&home, &project_root, &tmp];
        let canonical_home = canonicalize_existing_prefix(&home);
        let canonical_project_root = canonicalize_existing_prefix(&project_root);
        let canonical_tmp = canonicalize_existing_prefix(&tmp);
        let canonical_roots: [&Path; 3] =
            [&canonical_home, &canonical_project_root, &canonical_tmp];
        if escapes_root_set(&raw_roots, &canonical)
            && escapes_root_set(&canonical_roots, &canonical)
        {
            return Err(PathError(ACCESS_DENIED_SYMLINK.to_string()));
        }
    }

    Ok(resolved)
}

// ---------------------------------------------------------------------------
// Config dirs & project keys
// ---------------------------------------------------------------------------

/// `getConfigDir()` = `getCodexMultiAuthDir()`.
pub fn get_config_dir() -> PathBuf {
    get_codex_multi_auth_dir()
}

/// `getProjectConfigDir(projectPath)` = `<projectPath>/.codex` (legacy
/// per-project location).
pub fn get_project_config_dir(project_path: &Path) -> PathBuf {
    project_path.join(".codex")
}

/// `normalizeProjectPath`: resolve, `\` → `/`, lowercase on win32.
fn normalize_project_path(project_path: &Path) -> String {
    let resolved = resolve_lexical(project_path);
    let with_forward = resolved.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        with_forward.to_lowercase()
    } else {
        with_forward
    }
}

/// `sanitizeProjectName`: basename, `[^a-zA-Z0-9._-]+ → "-"`, strip
/// leading/trailing `-`, fallback `"project"`.
fn sanitize_project_name(normalized_path: &str) -> String {
    let name = normalized_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    let mut sanitized = String::with_capacity(name.len());
    let mut last_was_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            sanitized.push(c);
            last_was_dash = false;
        } else if !last_was_dash {
            sanitized.push('-');
            last_was_dash = true;
        }
    }
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `getProjectStorageKey(projectPath)` = `"<name≤40>-<sha256[..12]>"` over
/// the normalized (lowercased-on-win32, `/`-separated) path. NOTE: the name
/// part comes from the NORMALIZED path, so it is lowercase on Windows.
pub fn get_project_storage_key(project_path: &Path) -> String {
    let normalized_path = normalize_project_path(project_path);
    let hash: String = compute_sha256(&normalized_path)
        .chars()
        .take(PROJECT_KEY_HASH_LENGTH)
        .collect();
    let project_name: String = sanitize_project_name(&normalized_path)
        .chars()
        .take(40)
        .collect();
    format!("{project_name}-{hash}")
}

/// `getProjectGlobalConfigDir(projectPath)` =
/// `<configDir>/projects/<storageKey>`.
pub fn get_project_global_config_dir(project_path: &Path) -> PathBuf {
    get_config_dir()
        .join(PROJECTS_DIR)
        .join(get_project_storage_key(project_path))
}

// ---------------------------------------------------------------------------
// Project detection
// ---------------------------------------------------------------------------

/// `isProjectDirectory(dir)`: any [`PROJECT_MARKERS`] entry exists.
pub fn is_project_directory(dir: &Path) -> bool {
    PROJECT_MARKERS.iter().any(|marker| dir.join(marker).exists())
}

/// `findProjectRoot(startDir)`: walk up; the FIRST dir containing `.git`
/// wins immediately; otherwise remember the first marker match and keep
/// walking to the fs root looking for `.git` (gotcha 24: `.git` anywhere
/// above beats a closer non-git marker).
pub fn find_project_root(start_dir: &Path) -> Option<PathBuf> {
    let mut current = start_dir.to_path_buf();
    let mut first_marker_root: Option<PathBuf> = None;

    loop {
        if current.as_os_str().is_empty() {
            break;
        }
        if current.join(".git").exists() {
            return Some(current);
        }
        if first_marker_root.is_none() && is_project_directory(&current) {
            first_marker_root = Some(current.clone());
        }
        let Some(parent) = current.parent().map(Path::to_path_buf) else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }

    first_marker_root
}

// ---------------------------------------------------------------------------
// Git-worktree identity resolution (spec 02 §2.5)
// ---------------------------------------------------------------------------

/// First line of a `.git` pointer file: `gitdir: <value>` (case-insensitive,
/// CRLF-tolerant, first line only).
fn parse_git_dir_pointer(pointer_content: &str) -> Option<String> {
    let first_line = pointer_content
        .split(['\r', '\n'])
        .next()
        .unwrap_or("")
        .trim();
    if first_line.is_empty() {
        return None;
    }
    // `/^gitdir:\s*(.+)$/i`
    if first_line.len() < 7 || !first_line[..7].eq_ignore_ascii_case("gitdir:") {
        return None;
    }
    let value = first_line[7..].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn normalize_path_delimiters(path_value: &str) -> String {
    path_value.replace('\\', "/")
}

/// `/^[A-Za-z]:[\\/]/`, `/^\\\\[^\\]/` or `/^\/\/[^/]/`.
fn is_windows_rooted_path(path_value: &str) -> bool {
    let bytes: Vec<char> = path_value.chars().collect();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == ':' && (bytes[2] == '\\' || bytes[2] == '/') {
        return true;
    }
    if bytes.len() >= 3 && bytes[0] == '\\' && bytes[1] == '\\' && bytes[2] != '\\' {
        return true;
    }
    bytes.len() >= 3 && bytes[0] == '/' && bytes[1] == '/' && bytes[2] != '/'
}

/// Minimal `path.win32.normalize` analogue for git-pointer handling: `/`→`\`,
/// collapse separators, resolve `.`/`..` segments below the root.
fn normalize_win32_str(input: &str) -> String {
    let converted = input.replace('/', "\\");
    // Split root: UNC (\\server\share\), drive (C:\ or C:), or rooted (\).
    let (root, rest): (String, String) = if let Some(after) = converted.strip_prefix("\\\\") {
        if let Some(server_end) = after.find('\\') {
            let after_server = &after[server_end + 1..];
            if let Some(share_end) = after_server.find('\\') {
                let root_len = 2 + server_end + 1 + share_end + 1;
                (converted[..root_len].to_string(), converted[root_len..].to_string())
            } else {
                (converted.clone(), String::new())
            }
        } else {
            (converted.clone(), String::new())
        }
    } else {
        let chars: Vec<char> = converted.chars().collect();
        if chars.len() >= 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
            if chars.len() >= 3 && chars[2] == '\\' {
                (format!("{}{}\\", chars[0], chars[1]), converted[3..].to_string())
            } else {
                (format!("{}{}", chars[0], chars[1]), converted[2..].to_string())
            }
        } else if let Some(stripped) = converted.strip_prefix('\\') {
            ("\\".to_string(), stripped.to_string())
        } else {
            (String::new(), converted.clone())
        }
    };

    let mut components: Vec<&str> = Vec::new();
    for part in rest.split('\\') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            match components.last() {
                Some(last) if *last != ".." => {
                    components.pop();
                }
                _ if root.is_empty() => components.push(".."),
                _ => {}
            }
        } else {
            components.push(part);
        }
    }
    let joined = components.join("\\");
    if root.is_empty() {
        if joined.is_empty() { ".".to_string() } else { joined }
    } else {
        format!("{root}{joined}")
    }
}

/// `win32.isAbsolute` analogue (drive-rooted, UNC, or root-relative `\x`).
fn is_win32_absolute(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    if chars.first() == Some(&'\\') || chars.first() == Some(&'/') {
        return true;
    }
    chars.len() >= 3
        && chars[0].is_ascii_alphabetic()
        && chars[1] == ':'
        && (chars[2] == '\\' || chars[2] == '/')
}

/// `resolveGitPath(basePath, pointerValue)` — resolves a git pointer relative
/// to its base, handling mixed Windows/POSIX rooted paths (spec 02 §2.5 step
/// 3). On non-Windows hosts a Windows-flavored result converts `\` → `/`.
fn resolve_git_path(base_path: &Path, pointer_value: &str) -> PathBuf {
    let trimmed_pointer = pointer_value.trim();
    if trimmed_pointer.is_empty() {
        return base_path.to_path_buf();
    }
    let base_str = base_path.to_string_lossy().into_owned();

    if is_windows_rooted_path(&base_str) || is_windows_rooted_path(trimmed_pointer) {
        let windows_base = normalize_win32_str(&base_str);
        let windows_pointer = normalize_win32_str(trimmed_pointer);
        let windows_resolved = if is_win32_absolute(&windows_pointer) {
            // win32.resolve stops at the first absolute segment; a
            // root-relative pointer (`\x`) adopts the base's drive.
            let chars: Vec<char> = windows_pointer.chars().collect();
            if chars.first() == Some(&'\\')
                && !(chars.len() >= 2 && chars[1] == '\\')
            {
                let drive: String = windows_base.chars().take_while(|c| *c != '\\').collect();
                if drive.ends_with(':') {
                    normalize_win32_str(&format!("{drive}{windows_pointer}"))
                } else {
                    windows_pointer
                }
            } else {
                windows_pointer
            }
        } else {
            normalize_win32_str(&format!("{windows_base}\\{windows_pointer}"))
        };
        if cfg!(windows) {
            PathBuf::from(windows_resolved)
        } else {
            PathBuf::from(normalize_path_delimiters(&windows_resolved))
        }
    } else {
        let normalized_pointer = normalize_path_delimiters(trimmed_pointer);
        if normalized_pointer.starts_with('/') {
            PathBuf::from(normalized_pointer)
        } else {
            normalize_lexical(&base_path.join(normalized_pointer))
        }
    }
}

fn read_git_common_dir(git_dir_path: &Path) -> PathBuf {
    let common_dir_file = git_dir_path.join("commondir");
    if !common_dir_file.exists() {
        return git_dir_path.to_path_buf();
    }
    match fs::read(&common_dir_file) {
        Ok(bytes) => {
            let raw = String::from_utf8_lossy(&bytes).trim().to_string();
            if raw.is_empty() {
                git_dir_path.to_path_buf()
            } else {
                resolve_git_path(git_dir_path, &raw)
            }
        }
        Err(_) => git_dir_path.to_path_buf(),
    }
}

fn is_worktree_git_dir_path(git_dir_path: &Path) -> bool {
    normalize_path_delimiters(&git_dir_path.to_string_lossy())
        .to_lowercase()
        .contains("/.git/worktrees/")
}

/// `normalizePathForIdentityCheck` — trim, `\`→`/`; Windows-rooted values go
/// through win32 normalization + lowercase; others resolve lexically
/// (+lowercase on win32 hosts).
fn normalize_path_for_identity_check(path_value: &str) -> String {
    let normalized_delimiters = normalize_path_delimiters(path_value.trim());
    if normalized_delimiters.is_empty() {
        return normalized_delimiters;
    }
    if is_windows_rooted_path(&normalized_delimiters) {
        return normalize_win32_str(&normalized_delimiters).to_lowercase();
    }
    let resolved = resolve_lexical(Path::new(&normalized_delimiters));
    let normalized_resolved = normalize_path_delimiters(&resolved.to_string_lossy());
    if cfg!(windows) {
        normalized_resolved.to_lowercase()
    } else {
        normalized_resolved
    }
}

fn normalize_canonical_path_for_identity_check(path_value: &str) -> String {
    let normalized = normalize_path_for_identity_check(path_value);
    if normalized.is_empty() {
        return normalized;
    }
    match fs::canonicalize(Path::new(path_value)) {
        Ok(canonical) => normalize_path_for_identity_check(
            &simplify_canonical(canonical).to_string_lossy(),
        ),
        Err(_) => normalized,
    }
}

fn worktree_git_dir_belongs_to_project(project_root: &Path, git_dir_path: &Path) -> bool {
    let backref_path = git_dir_path.join("gitdir");
    if !backref_path.exists() {
        return false;
    }
    let Ok(bytes) = fs::read(&backref_path) else {
        return false;
    };
    let backref_raw = String::from_utf8_lossy(&bytes).trim().to_string();
    if backref_raw.is_empty() {
        return false;
    }
    let resolved_backref = resolve_git_path(git_dir_path, &backref_raw);
    let expected_backref = project_root.join(".git");
    normalize_canonical_path_for_identity_check(&resolved_backref.to_string_lossy())
        == normalize_canonical_path_for_identity_check(&expected_backref.to_string_lossy())
}

fn is_git_dir_under_common_worktrees(git_dir_path: &Path, common_git_dir: &Path) -> bool {
    let normalized_git_dir = normalize_path_delimiters(&normalize_path_for_identity_check(
        &git_dir_path.to_string_lossy(),
    ));
    let normalized_git_dir = normalized_git_dir.trim_end_matches('/');
    let normalized_common = normalize_path_delimiters(&normalize_path_for_identity_check(
        &common_git_dir.to_string_lossy(),
    ));
    let normalized_common = normalized_common.trim_end_matches('/');
    if normalized_git_dir.is_empty() || normalized_common.is_empty() {
        return false;
    }
    let worktrees_root = format!("{normalized_common}/worktrees/");
    normalized_git_dir.starts_with(&worktrees_root)
}

/// `resolveProjectStorageIdentityRoot(projectRoot)` — linked git worktrees
/// resolve to the shared repository root so all worktrees use one per-project
/// storage key; any failure falls back to `projectRoot` (spec 02 §2.5).
pub fn resolve_project_storage_identity_root(project_root: &Path) -> PathBuf {
    let git_entry_path = project_root.join(".git");
    if !git_entry_path.exists() {
        return project_root.to_path_buf();
    }

    let resolved = (|| -> Option<PathBuf> {
        let git_entry_stat = fs::metadata(&git_entry_path).ok()?;
        if git_entry_stat.is_dir() || !git_entry_stat.is_file() {
            return None;
        }
        let pointer_bytes = fs::read(&git_entry_path).ok()?;
        let git_pointer = String::from_utf8_lossy(&pointer_bytes).into_owned();
        let git_dir_value = parse_git_dir_pointer(&git_pointer)?;
        let git_dir_path = resolve_git_path(project_root, &git_dir_value);
        if !is_worktree_git_dir_path(&git_dir_path) {
            return None;
        }
        if !worktree_git_dir_belongs_to_project(project_root, &git_dir_path) {
            return None;
        }
        let common_git_dir = read_git_common_dir(&git_dir_path);
        if !is_git_dir_under_common_worktrees(&git_dir_path, &common_git_dir) {
            return None;
        }
        let candidate_repo_root = common_git_dir.parent()?.to_path_buf();
        if !candidate_repo_root.join(".git").exists() {
            return None;
        }
        Some(candidate_repo_root)
    })();

    resolved.unwrap_or_else(|| project_root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // ----- project keys -----

    #[test]
    fn project_storage_key_is_name_dash_12_hex() {
        let key = get_project_storage_key(Path::new("/work/My Project"));
        let (name, hash) = key.rsplit_once('-').expect("name-hash split");
        assert_eq!(hash.len(), 12);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        // Space collapsed to a single dash; lowercase on Windows.
        if cfg!(windows) {
            assert_eq!(name, "my-project");
        } else {
            assert_eq!(name, "My-Project");
        }
    }

    #[test]
    fn project_storage_key_is_stable_for_equivalent_paths() {
        let a = get_project_storage_key(Path::new("/work/app"));
        let b = get_project_storage_key(Path::new("/work/app"));
        assert_eq!(a, b);
        let c = get_project_storage_key(Path::new("/work/other"));
        assert_ne!(a, c);
    }

    #[cfg(windows)]
    #[test]
    fn project_storage_key_is_case_insensitive_on_windows() {
        let a = get_project_storage_key(Path::new(r"C:\Work\App"));
        let b = get_project_storage_key(Path::new(r"c:\work\app"));
        assert_eq!(a, b);
    }

    #[test]
    fn sanitize_project_name_falls_back_to_project() {
        assert_eq!(sanitize_project_name("/x/@@@"), "project");
        assert_eq!(sanitize_project_name("/x/-abc-"), "abc");
        assert_eq!(sanitize_project_name("/x/a b  c"), "a-b-c");
        assert_eq!(sanitize_project_name("/x/ok_name.v2"), "ok_name.v2");
    }

    // ----- project root detection -----

    #[test]
    fn find_project_root_prefers_git_anywhere_above_a_closer_marker() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let nested = repo.join("packages").join("app");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();
        // The nested dir has a package.json marker, but `.git` above wins.
        fs::write(nested.join("package.json"), "{}").unwrap();
        let root = find_project_root(&nested).expect("root found");
        assert_eq!(fs::canonicalize(root).unwrap(), fs::canonicalize(&repo).unwrap());
    }

    #[test]
    fn find_project_root_uses_first_marker_when_no_git_exists() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        let nested = project.join("src");
        fs::create_dir_all(&nested).unwrap();
        fs::write(project.join("Cargo.toml"), "").unwrap();
        let root = find_project_root(&nested).expect("root found");
        assert_eq!(root, project);
    }

    #[test]
    fn is_project_directory_checks_all_markers() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_project_directory(dir.path()));
        fs::write(dir.path().join("go.mod"), "").unwrap();
        assert!(is_project_directory(dir.path()));
    }

    // ----- identity root (worktrees) -----

    #[test]
    fn identity_root_returns_project_root_for_a_normal_repo() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        assert_eq!(resolve_project_storage_identity_root(&repo), repo);
    }

    #[test]
    fn identity_root_resolves_a_linked_worktree_to_the_main_repo() {
        let dir = tempfile::tempdir().unwrap();
        let main_repo = dir.path().join("main");
        let git_dir = main_repo.join(".git");
        let wt_git_dir = git_dir.join("worktrees").join("wt1");
        let worktree = dir.path().join("wt1");
        fs::create_dir_all(&wt_git_dir).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        // Worktree .git pointer file → main repo's worktrees dir.
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", wt_git_dir.to_string_lossy()),
        )
        .unwrap();
        // Backref + commondir as git lays them out.
        fs::write(
            wt_git_dir.join("gitdir"),
            format!("{}\n", worktree.join(".git").to_string_lossy()),
        )
        .unwrap();
        fs::write(wt_git_dir.join("commondir"), "../..\n").unwrap();
        let resolved = resolve_project_storage_identity_root(&worktree);
        assert_eq!(
            fs::canonicalize(resolved).unwrap(),
            fs::canonicalize(&main_repo).unwrap()
        );
    }

    #[test]
    fn identity_root_rejects_a_forged_pointer_without_backref() {
        let dir = tempfile::tempdir().unwrap();
        let main_repo = dir.path().join("main");
        let wt_git_dir = main_repo.join(".git").join("worktrees").join("wt1");
        let worktree = dir.path().join("wt1");
        fs::create_dir_all(&wt_git_dir).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", wt_git_dir.to_string_lossy()),
        )
        .unwrap();
        // No gitdir backref file ⇒ stays at the worktree root.
        assert_eq!(resolve_project_storage_identity_root(&worktree), worktree);
    }

    // ----- resolvePath -----

    #[test]
    #[serial(storage_path_state)]
    fn resolve_path_rejects_nul_bytes_with_frozen_message() {
        let error = resolve_path("bad\0path.json").unwrap_err();
        assert_eq!(error.0, "Invalid path: contains a NUL byte");
    }

    #[test]
    #[serial(storage_path_state)]
    fn resolve_path_allows_paths_inside_the_temp_dir() {
        let target = std::env::temp_dir().join("cma-resolve-path-test.json");
        let resolved = resolve_path(&target.to_string_lossy()).expect("tmp is an approved root");
        assert!(resolved.ends_with("cma-resolve-path-test.json"));
    }

    #[test]
    #[serial(storage_path_state)]
    fn resolve_path_denies_paths_outside_all_roots() {
        let outside = if cfg!(windows) {
            r"C:\cma-definitely-not-a-root\file.json"
        } else {
            "/cma-definitely-not-a-root/file.json"
        };
        let error = resolve_path(outside).unwrap_err();
        assert_eq!(
            error.0,
            "Access denied: path must be within home directory, project directory, or temp directory"
        );
    }

    #[test]
    #[serial(storage_path_state)]
    fn resolve_path_expands_a_bare_tilde_prefix() {
        let resolved = resolve_path("~/cma-tilde-test.json").expect("home is approved");
        assert!(resolved.starts_with(os_home_dir()));
        assert!(resolved.ends_with("cma-tilde-test.json"));
        // `~foo` slices only the tilde: it lands at `<home>/foo` too.
        let sliced = resolve_path("~cma-tilde-file.json").expect("home is approved");
        assert_eq!(sliced, os_home_dir().join("cma-tilde-file.json"));
    }

    #[test]
    #[serial(storage_path_state)]
    fn resolve_path_rejects_lookalike_siblings_of_home() {
        let home = os_home_dir();
        let sibling = format!("{}-outside{}file.json", home.to_string_lossy(), std::path::MAIN_SEPARATOR);
        let error = resolve_path(&sibling).unwrap_err();
        assert_eq!(
            error.0,
            "Access denied: path must be within home directory, project directory, or temp directory"
        );
    }

    // ----- helpers -----

    #[test]
    fn within_directory_component_semantics() {
        if cfg!(windows) {
            assert!(is_within_directory(Path::new(r"C:\a"), Path::new(r"C:\a\b.json")));
            assert!(is_within_directory(Path::new(r"C:\a"), Path::new(r"C:\A")));
            assert!(!is_within_directory(Path::new(r"C:\a"), Path::new(r"C:\ab")));
            assert!(!is_within_directory(Path::new(r"C:\a"), Path::new(r"D:\a\b")));
        } else {
            assert!(is_within_directory(Path::new("/a"), Path::new("/a/b.json")));
            assert!(is_within_directory(Path::new("/a"), Path::new("/a")));
            assert!(!is_within_directory(Path::new("/a"), Path::new("/ab")));
            assert!(is_within_directory(Path::new("/"), Path::new("/anything")));
        }
    }

    #[test]
    fn lookalike_sibling_detection() {
        if cfg!(windows) {
            assert!(is_lookalike_sibling(Path::new(r"C:\home\user"), Path::new(r"C:\home\user-evil\x")));
            assert!(!is_lookalike_sibling(Path::new(r"C:\home\user"), Path::new(r"C:\home\user\x")));
            // A bare drive root has no siblings.
            assert!(!is_lookalike_sibling(Path::new(r"C:\"), Path::new(r"C:\anything")));
        } else {
            assert!(is_lookalike_sibling(Path::new("/home/user"), Path::new("/home/user-evil/x")));
            assert!(!is_lookalike_sibling(Path::new("/home/user"), Path::new("/home/user/x")));
            // The filesystem root has no siblings.
            assert!(!is_lookalike_sibling(Path::new("/"), Path::new("/anything")));
        }
    }

    #[test]
    fn git_pointer_parsing_is_case_insensitive_and_first_line_only() {
        assert_eq!(
            parse_git_dir_pointer("gitdir: /x/.git/worktrees/a\n"),
            Some("/x/.git/worktrees/a".to_string())
        );
        assert_eq!(
            parse_git_dir_pointer("GITDIR:   ..\\main\\.git\\worktrees\\a\r\nsecond"),
            Some("..\\main\\.git\\worktrees\\a".to_string())
        );
        assert_eq!(parse_git_dir_pointer(""), None);
        assert_eq!(parse_git_dir_pointer("nonsense"), None);
        assert_eq!(parse_git_dir_pointer("gitdir:"), None);
    }

    #[test]
    fn windows_rooted_detection() {
        assert!(is_windows_rooted_path(r"C:\x"));
        assert!(is_windows_rooted_path("C:/x"));
        assert!(is_windows_rooted_path(r"\\server\share"));
        assert!(is_windows_rooted_path("//server/share"));
        assert!(!is_windows_rooted_path("/plain/posix"));
        assert!(!is_windows_rooted_path("relative/path"));
    }
}
