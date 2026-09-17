//! Port of `scripts/codex-bin-resolver.js` — discovery of the OFFICIAL
//! `@openai/codex` binary the wrapper forwards to.
//!
//! Resolution order (TS parity):
//! 1. `CODEX_MULTI_AUTH_REAL_CODEX_BIN` override (exists → use; set-but-missing
//!    → `None`, the caller prints the error).
//! 2. Package-relative search roots: `<self dir>/../..` (+ npm prefix roots)
//!    joined with `@openai/codex/bin/codex.js`.
//! 3. `npm root -g` (via `cmd /d /s /c` on Windows) joined the same way.
//! 4. PATH scan for `codex`/`codex.exe` with a self-recursion guard (skip our
//!    own binary and anything inside our own directory), then `where codex` /
//!    `which codex` as a last resort.
//!
//! Deviation vs TS: Node's `require.resolve("@openai/codex/bin/codex.js")`
//! step has no Rust analogue; the search-root walk (which the TS also does)
//! covers the same install layouts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// TS `createResolvedCodexBin(path)` result shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCodexBin {
    pub path: PathBuf,
    /// True when the target is a JS entry (`.js`/`.mjs`/`.cjs`) that must be
    /// launched through `node`.
    pub launch_with_node: bool,
}

fn is_javascript_entry_path(candidate: &Path) -> bool {
    matches!(
        candidate
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("js") | Some("mjs") | Some("cjs")
    )
}

fn create_resolved_codex_bin(path: PathBuf) -> ResolvedCodexBin {
    let launch_with_node = is_javascript_entry_path(&path);
    ResolvedCodexBin {
        path,
        launch_with_node,
    }
}

/// TS `splitPathEntries(pathValue)` — split on the platform PATH delimiter,
/// trim, drop empties.
pub fn split_path_entries(path_value: &str) -> Vec<String> {
    if path_value.trim().is_empty() {
        return Vec::new();
    }
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    path_value
        .split(delimiter)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

fn normalize_resolved_path(candidate: &Path) -> PathBuf {
    candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf())
}

/// TS `isWithinDirectory` — defense-in-depth self-recursion guard: skip any
/// candidate that resolves inside the wrapper's own directory.
fn is_within_directory(candidate: &Path, directory: &Path) -> bool {
    let resolved = normalize_resolved_path(candidate);
    resolved.starts_with(directory)
}

/// Injectable environment for [`resolve_real_codex_bin_with`]; tests can pin
/// the env map, disable process spawns, and fake the self path.
#[derive(Debug, Clone, Default)]
pub struct BinResolverOptions {
    /// Environment snapshot; `None` reads the process environment.
    pub env: Option<HashMap<String, String>>,
    /// The wrapper's own executable path (self-recursion guard). `None` uses
    /// `std::env::current_exe()`.
    pub self_path: Option<PathBuf>,
    /// When false, skip the `npm root -g` and `where`/`which` subprocess
    /// lookups (hermetic tests).
    pub allow_process_lookups: bool,
    /// Extra search roots probed FIRST (tests / embedding).
    pub extra_search_roots: Vec<PathBuf>,
}

impl BinResolverOptions {
    pub fn hermetic(env: HashMap<String, String>) -> Self {
        Self {
            env: Some(env),
            self_path: None,
            allow_process_lookups: false,
            extra_search_roots: Vec::new(),
        }
    }
}

fn env_get(env: &Option<HashMap<String, String>>, key: &str) -> Option<String> {
    match env {
        Some(map) => map.get(key).cloned(),
        None => std::env::var(key).ok(),
    }
}

fn resolve_windows_cmd_path(env: &Option<HashMap<String, String>>) -> String {
    let com_spec = env_get(env, "ComSpec")
        .or_else(|| env_get(env, "COMSPEC"))
        .unwrap_or_default();
    let com_spec = com_spec.trim();
    if !com_spec.is_empty() {
        return com_spec.to_string();
    }
    let system_root = env_get(env, "SystemRoot")
        .or_else(|| env_get(env, "SYSTEMROOT"))
        .unwrap_or_default();
    let system_root = system_root.trim();
    if !system_root.is_empty() {
        let trimmed = system_root.trim_end_matches(['\\', '/']);
        return format!("{trimmed}\\System32\\cmd.exe");
    }
    "cmd.exe".to_string()
}

fn candidate_executable_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["codex.exe", "codex"]
    } else {
        &["codex"]
    }
}

fn self_guard_skips(candidate: &Path, self_script_path: Option<&Path>) -> bool {
    let Some(self_path) = self_script_path else {
        return false;
    };
    if normalize_resolved_path(candidate) == *self_path {
        return true;
    }
    if let Some(dir) = self_path.parent()
        && is_within_directory(candidate, dir)
    {
        return true;
    }
    false
}

fn resolve_codex_executable_from_path_entries(
    path_entries: &[String],
    self_script_path: Option<&Path>,
) -> Option<PathBuf> {
    for entry in path_entries {
        for executable_name in candidate_executable_names() {
            let candidate = Path::new(entry).join(executable_name);
            if !candidate.exists() {
                continue;
            }
            if self_guard_skips(&candidate, self_script_path) {
                continue;
            }
            return Some(candidate);
        }
    }
    None
}

fn normalize_where_output(stdout: &str) -> Vec<String> {
    stdout
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Run a lookup command with a 5 s deadline (TS `spawnSync … timeout: 5000`).
fn run_lookup_command(program: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_millis(5000);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut output = String::new();
                use std::io::Read;
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut output);
                }
                return Some(output);
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

fn resolve_codex_executable_from_system_path(
    options: &BinResolverOptions,
    self_script_path: Option<&Path>,
) -> Option<PathBuf> {
    let path_value = env_get(&options.env, "PATH")
        .or_else(|| env_get(&options.env, "Path"))
        .unwrap_or_default();
    let path_entries = split_path_entries(&path_value);
    if let Some(found) = resolve_codex_executable_from_path_entries(&path_entries, self_script_path)
    {
        return Some(found);
    }

    if !options.allow_process_lookups {
        return None;
    }

    let stdout = if cfg!(windows) {
        let cmd = resolve_windows_cmd_path(&options.env);
        run_lookup_command(&cmd, &["/d", "/s", "/c", "where codex"])?
    } else {
        run_lookup_command("which", &["codex"])?
    };
    for candidate in normalize_where_output(&stdout) {
        let candidate_path = Path::new(&candidate);
        if !candidate_path.exists() {
            continue;
        }
        if self_guard_skips(candidate_path, self_script_path) {
            continue;
        }
        let file_name = candidate_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_ascii_lowercase())
            .unwrap_or_default();
        if file_name == "codex" || file_name == "codex.exe" {
            return Some(candidate_path.to_path_buf());
        }
    }
    None
}

fn npm_global_root(options: &BinResolverOptions) -> Option<String> {
    if !options.allow_process_lookups {
        return None;
    }
    let stdout = if cfg!(windows) {
        let cmd = resolve_windows_cmd_path(&options.env);
        run_lookup_command(&cmd, &["/d", "/s", "/c", "npm root -g"])?
    } else {
        run_lookup_command("npm", &["root", "-g"])?
    };
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// TS `resolveRealCodexBin(options)` with the process environment.
pub fn resolve_real_codex_bin() -> Option<ResolvedCodexBin> {
    resolve_real_codex_bin_with(&BinResolverOptions {
        env: None,
        self_path: None,
        allow_process_lookups: true,
        extra_search_roots: Vec::new(),
    })
}

/// TS `resolveRealCodexBin(options)` — full resolution ladder.
pub fn resolve_real_codex_bin_with(options: &BinResolverOptions) -> Option<ResolvedCodexBin> {
    // 1. Explicit override.
    let override_value = env_get(&options.env, "CODEX_MULTI_AUTH_REAL_CODEX_BIN")
        .unwrap_or_default()
        .trim()
        .to_string();
    if !override_value.is_empty() {
        let override_path = PathBuf::from(&override_value);
        if override_path.exists() {
            return Some(create_resolved_codex_bin(override_path));
        }
        return None;
    }

    // Self path for the recursion guard (resolved once, TS parity).
    let self_script_path: Option<PathBuf> = options
        .self_path
        .clone()
        .or_else(|| std::env::current_exe().ok())
        .map(|p| normalize_resolved_path(&p));

    // 2. Package-relative search roots.
    let mut search_roots: Vec<PathBuf> = options.extra_search_roots.clone();
    if let Some(self_path) = &self_script_path
        && let Some(script_dir) = self_path.parent()
    {
        search_roots.push(script_dir.join("..").join(".."));
    }
    let npm_prefix = env_get(&options.env, "npm_config_prefix")
        .or_else(|| env_get(&options.env, "PREFIX"))
        .unwrap_or_default();
    let npm_prefix = npm_prefix.trim();
    if !npm_prefix.is_empty() {
        search_roots.push(Path::new(npm_prefix).join("node_modules"));
        search_roots.push(Path::new(npm_prefix).join("lib").join("node_modules"));
    }
    for root in &search_roots {
        let candidate = root
            .join("@openai")
            .join("codex")
            .join("bin")
            .join("codex.js");
        if candidate.exists() {
            return Some(create_resolved_codex_bin(candidate));
        }
    }

    // 3. npm root -g.
    if let Some(global_root) = npm_global_root(options) {
        let global_bin = Path::new(&global_root)
            .join("@openai")
            .join("codex")
            .join("bin")
            .join("codex.js");
        if global_bin.exists() {
            return Some(create_resolved_codex_bin(global_bin));
        }
    }

    // 4. Native codex on PATH (+ where/which fallback).
    resolve_codex_executable_from_system_path(options, self_script_path.as_deref())
        .map(create_resolved_codex_bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn split_path_entries_handles_empty_and_trims() {
        assert!(split_path_entries("").is_empty());
        assert!(split_path_entries("   ").is_empty());
        let sep = if cfg!(windows) { ";" } else { ":" };
        let joined = format!(" /a {sep}{sep} /b ");
        assert_eq!(split_path_entries(&joined), vec!["/a", "/b"]);
    }

    #[test]
    fn js_entries_launch_with_node() {
        assert!(create_resolved_codex_bin(PathBuf::from("a/codex.js")).launch_with_node);
        assert!(create_resolved_codex_bin(PathBuf::from("a/codex.MJS")).launch_with_node);
        assert!(create_resolved_codex_bin(PathBuf::from("a/codex.cjs")).launch_with_node);
        assert!(!create_resolved_codex_bin(PathBuf::from("a/codex.exe")).launch_with_node);
        assert!(!create_resolved_codex_bin(PathBuf::from("a/codex")).launch_with_node);
    }

    #[test]
    fn override_missing_returns_none() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("nope").join("codex.js");
        let options = BinResolverOptions::hermetic(env(&[(
            "CODEX_MULTI_AUTH_REAL_CODEX_BIN",
            missing.to_str().unwrap(),
        )]));
        assert_eq!(resolve_real_codex_bin_with(&options), None);
    }

    #[test]
    fn override_existing_wins() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("codex.js");
        std::fs::write(&target, "// stub").unwrap();
        let options = BinResolverOptions::hermetic(env(&[(
            "CODEX_MULTI_AUTH_REAL_CODEX_BIN",
            target.to_str().unwrap(),
        )]));
        let resolved = resolve_real_codex_bin_with(&options).unwrap();
        assert_eq!(resolved.path, target);
        assert!(resolved.launch_with_node);
    }

    #[test]
    fn search_roots_find_openai_codex_package_bin() {
        let temp = tempfile::tempdir().unwrap();
        let bin_dir = temp
            .path()
            .join("@openai")
            .join("codex")
            .join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let target = bin_dir.join("codex.js");
        std::fs::write(&target, "// stub").unwrap();
        let mut options = BinResolverOptions::hermetic(env(&[]));
        options.extra_search_roots = vec![temp.path().to_path_buf()];
        // Self path outside the temp tree so the guard does not interfere.
        options.self_path = Some(PathBuf::from("Z:/definitely/not/here/codex-wrapper.exe"));
        let resolved = resolve_real_codex_bin_with(&options).unwrap();
        assert_eq!(normalize_resolved_path(&resolved.path), normalize_resolved_path(&target));
        assert!(resolved.launch_with_node);
    }

    #[test]
    fn npm_prefix_roots_probed() {
        let temp = tempfile::tempdir().unwrap();
        let bin_dir = temp
            .path()
            .join("lib")
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(bin_dir.join("codex.js"), "// stub").unwrap();
        let mut options = BinResolverOptions::hermetic(env(&[(
            "npm_config_prefix",
            temp.path().to_str().unwrap(),
        )]));
        options.self_path = Some(PathBuf::from("Z:/definitely/not/here/codex-wrapper.exe"));
        let resolved = resolve_real_codex_bin_with(&options).unwrap();
        assert!(resolved.launch_with_node);
    }

    #[test]
    fn path_scan_skips_self_directory() {
        let temp = tempfile::tempdir().unwrap();
        // The "self" wrapper lives in this directory and is itself named codex.exe.
        let self_dir = temp.path().join("wrapper-bin");
        std::fs::create_dir_all(&self_dir).unwrap();
        let self_name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let self_binary = self_dir.join(self_name);
        std::fs::write(&self_binary, "self").unwrap();

        // A real codex lives in another PATH entry.
        let real_dir = temp.path().join("real-bin");
        std::fs::create_dir_all(&real_dir).unwrap();
        let real_binary = real_dir.join(self_name);
        std::fs::write(&real_binary, "real").unwrap();

        let path_value = format!(
            "{}{}{}",
            self_dir.display(),
            if cfg!(windows) { ";" } else { ":" },
            real_dir.display()
        );
        let mut options = BinResolverOptions::hermetic(env(&[("PATH", path_value.as_str())]));
        options.self_path = Some(normalize_resolved_path(&self_binary));
        let resolved = resolve_real_codex_bin_with(&options).unwrap();
        assert_eq!(
            normalize_resolved_path(&resolved.path),
            normalize_resolved_path(&real_binary)
        );
        assert!(!resolved.launch_with_node);
    }

    #[test]
    fn windows_cmd_path_resolution_ladder() {
        let e = Some(env(&[("ComSpec", "C:\\Windows\\system32\\cmd.exe")]));
        assert_eq!(resolve_windows_cmd_path(&e), "C:\\Windows\\system32\\cmd.exe");
        let e = Some(env(&[("SystemRoot", "C:\\Windows\\")]));
        assert_eq!(resolve_windows_cmd_path(&e), "C:\\Windows\\System32\\cmd.exe");
        let e = Some(env(&[]));
        assert_eq!(resolve_windows_cmd_path(&e), "cmd.exe");
    }

    #[test]
    fn where_output_normalization() {
        assert_eq!(
            normalize_where_output("C:\\a\\codex.exe\r\n C:\\b\\codex \r\n\r\n"),
            vec!["C:\\a\\codex.exe", "C:\\b\\codex"]
        );
    }
}
