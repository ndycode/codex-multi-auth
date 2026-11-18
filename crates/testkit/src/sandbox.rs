//! Environment sandbox for tests — Rust port of `test/helpers/global-sandbox.ts`
//! (spec 14 §11, harness invariant 1 / tests-ci-01).
//!
//! Several subsystems resolve storage/config paths from `HOME` / `USERPROFILE` /
//! `CODEX_HOME` / `CODEX_MULTI_AUTH_DIR`. A test that forgets to redirect them (or
//! only deletes `CODEX_HOME` without pinning a home) can resolve to the developer's
//! real `~/.codex` and read or clobber live account state. [`EnvSandbox`] pins all
//! four to a fresh per-instance temp directory BEFORE the code under test runs, so
//! the unsandboxed default is an empty throwaway dir rather than the real home.
//!
//! It also pins `CODEX_AUTH_PID_OFFSET_ENABLED=0`. The production default is `true`
//! (verified by the plugin-config suite; it spreads parallel agents across accounts —
//! #628), but the offset biases selection by the current process id, which is
//! inherently non-deterministic inside a test process. Pinning it off keeps
//! account-selection assertions deterministic; the offset's own behaviour is covered
//! by the rotation suite, which passes the flag to the selector directly (spec 14
//! gotcha 21).
//!
//! # `#[serial]` is MANDATORY
//!
//! **Every test that constructs an [`EnvSandbox`] (or otherwise mutates process
//! environment variables) MUST be annotated `#[serial_test::serial(env)]`** — the
//! shared key is [`ENV_SERIAL_KEY`]. Process environment is process-global state:
//! two tests mutating it concurrently corrupt each other's view, and on some
//! platforms concurrent mutation while non-std code reads the environment is
//! undefined behavior. The vitest suite achieves the same isolation with
//! `pool: 'forks'` + `fileParallelism: false` (one worker); `serial_test` is the
//! Rust analogue (spec 14 §11 invariant 2, ARCHITECTURE.md §9.4).
//!
//! ```no_run
//! use cma_testkit::sandbox::EnvSandbox;
//!
//! #[serial_test::serial(env)]
//! fn my_env_test() {
//!     let sandbox = EnvSandbox::new();
//!     // HOME/USERPROFILE point at sandbox.root(); CODEX_HOME at
//!     // sandbox.codex_home(); CODEX_MULTI_AUTH_DIR at
//!     // sandbox.codex_multi_auth_dir(); CODEX_AUTH_PID_OFFSET_ENABLED=0.
//!     // ... exercise code under test ...
//!     drop(sandbox); // prior env values restored, temp dir removed
//! }
//! ```
//!
//! Like the TS global sandbox, this is intentionally a *baseline*: tests that need
//! additional env vars should set them through [`EnvSandbox::set_var`] /
//! [`EnvSandbox::remove_var`] so the original values are restored on drop — never
//! by leaving stray process-global mutations behind.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::remove_with_retry::remove_recursive_with_retry;

/// The `serial_test` key every env-mutating test must hold:
/// `#[serial_test::serial(env)]` (ARCHITECTURE.md §9.4).
///
/// The macro takes the key as a bare identifier; this constant exists so the
/// convention is greppable and documented in one place.
pub const ENV_SERIAL_KEY: &str = "env";

/// Temp-dir prefix, matching the TS sandbox (`mkdtempSync(join(tmpdir(), "cma-test-home-"))`).
pub const SANDBOX_PREFIX: &str = "cma-test-home-";

/// The environment variables [`EnvSandbox::new`] pins, in the order they are set.
/// Mirrors `test/helpers/global-sandbox.ts` exactly.
pub const PINNED_ENV_KEYS: [&str; 5] = [
    "HOME",
    "USERPROFILE",
    "CODEX_HOME",
    "CODEX_MULTI_AUTH_DIR",
    "CODEX_AUTH_PID_OFFSET_ENABLED",
];

/// Guard struct that pins the home/codex env vars to a fresh temp directory and
/// restores every mutated variable to its prior value (set or unset) on drop.
///
/// Layout inside the sandbox root (identical to the TS sandbox):
///
/// | variable                         | value                        |
/// |----------------------------------|------------------------------|
/// | `HOME`                           | `<root>`                     |
/// | `USERPROFILE`                    | `<root>`                     |
/// | `CODEX_HOME`                     | `<root>/.codex`              |
/// | `CODEX_MULTI_AUTH_DIR`           | `<root>/.codex/multi-auth`   |
/// | `CODEX_AUTH_PID_OFFSET_ENABLED`  | `"0"`                        |
///
/// The `.codex` subdirectories are NOT created eagerly — application code creates
/// them lazily, exactly as it would against a pristine real home (TS parity).
///
/// Nesting is supported: an inner sandbox captures the outer sandbox's values and
/// restores them when dropped. Restoration also runs during unwinding, so a failed
/// assertion cannot leak sandbox paths into the next `#[serial(env)]` test.
///
/// See the module docs: any test using this type must be `#[serial_test::serial(env)]`.
#[derive(Debug)]
pub struct EnvSandbox {
    root: PathBuf,
    temp: Option<TempDir>,
    /// Original values, captured once per key on first mutation (first-capture wins,
    /// so repeated `set_var` calls still restore the true pre-sandbox value).
    saved: Vec<(OsString, Option<OsString>)>,
}

impl EnvSandbox {
    /// Create the sandbox: makes a fresh `cma-test-home-*` temp dir and pins the
    /// five [`PINNED_ENV_KEYS`] into it.
    ///
    /// # Panics
    /// Panics if the temp directory cannot be created (tests cannot proceed
    /// meaningfully without an isolated home).
    pub fn new() -> Self {
        let temp = tempfile::Builder::new()
            .prefix(SANDBOX_PREFIX)
            .tempdir()
            .expect("EnvSandbox: failed to create sandbox temp dir");
        let root = temp.path().to_path_buf();
        let mut sandbox = EnvSandbox {
            root: root.clone(),
            temp: Some(temp),
            saved: Vec::new(),
        };
        let codex_home = root.join(".codex");
        let multi_auth_dir = codex_home.join("multi-auth");
        // Pin home + codex roots to the sandbox. Every in-repo resolver consults
        // these env vars before falling back to the OS home directory.
        sandbox.set_var("HOME", &root);
        sandbox.set_var("USERPROFILE", &root);
        sandbox.set_var("CODEX_HOME", &codex_home);
        sandbox.set_var("CODEX_MULTI_AUTH_DIR", &multi_auth_dir);
        // Deterministic account selection in tests (production default is true).
        sandbox.set_var("CODEX_AUTH_PID_OFFSET_ENABLED", "0");
        sandbox
    }

    /// The sandbox root directory (`HOME` / `USERPROFILE` point here).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `<root>/.codex` — the value pinned into `CODEX_HOME`.
    pub fn codex_home(&self) -> PathBuf {
        self.root.join(".codex")
    }

    /// `<root>/.codex/multi-auth` — the value pinned into `CODEX_MULTI_AUTH_DIR`.
    pub fn codex_multi_auth_dir(&self) -> PathBuf {
        self.codex_home().join("multi-auth")
    }

    /// Set an environment variable for the lifetime of the sandbox, restoring the
    /// prior value (or unset state) on drop. The original value is captured only
    /// on the FIRST mutation of a given key.
    ///
    /// Caller contract: the test holding this sandbox is `#[serial(env)]`.
    pub fn set_var(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) {
        let key = key.as_ref();
        self.capture(key);
        env_set(key, value.as_ref());
    }

    /// Remove an environment variable for the lifetime of the sandbox, restoring
    /// the prior value (or unset state) on drop.
    ///
    /// Caller contract: the test holding this sandbox is `#[serial(env)]`.
    pub fn remove_var(&mut self, key: impl AsRef<OsStr>) {
        let key = key.as_ref();
        self.capture(key);
        env_remove(key);
    }

    fn capture(&mut self, key: &OsStr) {
        if self.saved.iter().any(|(saved_key, _)| saved_key == key) {
            return;
        }
        self.saved.push((key.to_os_string(), env::var_os(key)));
    }
}

impl Default for EnvSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for EnvSandbox {
    fn drop(&mut self) {
        // Restore env first (reverse order, stack discipline), THEN remove the
        // temp dir, so nothing observes sandbox paths after their backing dir is
        // gone.
        for (key, original) in self.saved.drain(..).rev() {
            match original {
                Some(value) => env_set(&key, &value),
                None => env_remove(&key),
            }
        }
        if let Some(temp) = self.temp.take() {
            let path = temp.path().to_path_buf();
            // TempDir's own Drop is a best-effort single attempt; follow up with
            // the Windows-safe retry helper for EBUSY/EPERM stragglers
            // (spec 14 §11 harness invariant 3: never bare rm on Windows).
            drop(temp);
            if path.exists() {
                let _ = remove_recursive_with_retry(&path);
            }
        }
    }
}

/// Set a process environment variable.
///
/// In edition 2024 `std::env::set_var` is an `unsafe fn` because mutating the
/// process environment races with any other thread reading it through non-std
/// (e.g. libc) APIs. This crate's safety contract makes the call sound in
/// practice: env mutation only ever happens under the process-wide
/// `#[serial(env)]` test key ([`ENV_SERIAL_KEY`]), std's own env accessors are
/// internally synchronized, and no test code hands the environment to foreign
/// readers while a sandbox is live. This is the narrowest possible carve-out
/// from the workspace `unsafe_code = "deny"` lint; there is no safe std API for
/// env mutation.
#[allow(unsafe_code)]
fn env_set(key: &OsStr, value: &OsStr) {
    // SAFETY: see function docs — callers hold the `#[serial(env)]` key, so no
    // other test thread is concurrently mutating or foreign-reading the env.
    unsafe { env::set_var(key, value) }
}

/// Remove a process environment variable. Same safety contract as [`env_set`].
#[allow(unsafe_code)]
fn env_remove(key: &OsStr) {
    // SAFETY: see `env_set` — callers hold the `#[serial(env)]` key.
    unsafe { env::remove_var(key) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial(env)]
    fn pins_env_to_tempdir_and_restores_on_drop() {
        let before: Vec<(String, Option<OsString>)> = PINNED_ENV_KEYS
            .iter()
            .map(|key| ((*key).to_string(), env::var_os(key)))
            .collect();

        let root;
        {
            let sandbox = EnvSandbox::new();
            root = sandbox.root().to_path_buf();
            assert!(root.exists());
            assert!(
                root.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(SANDBOX_PREFIX)),
                "sandbox root should carry the {SANDBOX_PREFIX:?} prefix: {}",
                root.display()
            );

            assert_eq!(env::var_os("HOME"), Some(root.clone().into_os_string()));
            assert_eq!(
                env::var_os("USERPROFILE"),
                Some(root.clone().into_os_string())
            );
            assert_eq!(
                env::var_os("CODEX_HOME"),
                Some(sandbox.codex_home().into_os_string())
            );
            assert_eq!(
                env::var_os("CODEX_MULTI_AUTH_DIR"),
                Some(sandbox.codex_multi_auth_dir().into_os_string())
            );
            assert_eq!(
                env::var_os("CODEX_AUTH_PID_OFFSET_ENABLED"),
                Some(OsString::from("0"))
            );
            assert_eq!(sandbox.codex_home(), root.join(".codex"));
            assert_eq!(
                sandbox.codex_multi_auth_dir(),
                root.join(".codex").join("multi-auth")
            );
            // TS parity: the sandbox does NOT eagerly create the codex dirs.
            assert!(!sandbox.codex_home().exists());
        }

        for (key, value) in before {
            assert_eq!(env::var_os(&key), value, "{key} was not restored");
        }
        assert!(!root.exists(), "sandbox temp dir should be removed on drop");
    }

    #[test]
    #[serial(env)]
    fn nested_sandboxes_restore_to_outer_values() {
        let outer = EnvSandbox::new();
        let outer_home = env::var_os("HOME");
        let outer_mad = env::var_os("CODEX_MULTI_AUTH_DIR");
        {
            let inner = EnvSandbox::new();
            assert_ne!(env::var_os("HOME"), outer_home);
            assert_ne!(env::var_os("CODEX_MULTI_AUTH_DIR"), outer_mad);
            let _ = inner.root();
        }
        assert_eq!(env::var_os("HOME"), outer_home);
        assert_eq!(env::var_os("CODEX_MULTI_AUTH_DIR"), outer_mad);
        drop(outer);
    }

    #[test]
    #[serial(env)]
    fn set_var_and_remove_var_capture_once_and_restore() {
        const KEY: &str = "CMA_TESTKIT_SANDBOX_CUSTOM_VAR";
        let mut outer = EnvSandbox::new();
        outer.set_var(KEY, "outer-value");

        {
            let mut inner = EnvSandbox::new();
            inner.set_var(KEY, "first");
            inner.set_var(KEY, "second");
            assert_eq!(env::var_os(KEY), Some(OsString::from("second")));
            inner.remove_var(KEY);
            assert_eq!(env::var_os(KEY), None);
        }
        // Inner restores to the OUTER value captured at its first mutation.
        assert_eq!(env::var_os(KEY), Some(OsString::from("outer-value")));

        {
            let mut inner = EnvSandbox::new();
            inner.remove_var(KEY);
            assert_eq!(env::var_os(KEY), None);
        }
        assert_eq!(env::var_os(KEY), Some(OsString::from("outer-value")));

        drop(outer);
        // The outer sandbox captured the true original (unset) and restores it.
        assert_eq!(env::var_os(KEY), None);
    }

    #[test]
    #[serial(env)]
    fn restore_runs_even_when_values_were_previously_unset() {
        const KEY: &str = "CMA_TESTKIT_SANDBOX_UNSET_PROBE";
        let mut outer = EnvSandbox::new();
        outer.remove_var(KEY); // guarantee unset without direct env mutation
        {
            let mut inner = EnvSandbox::new();
            inner.set_var(KEY, "transient");
            assert_eq!(env::var_os(KEY), Some(OsString::from("transient")));
        }
        assert_eq!(
            env::var_os(KEY),
            None,
            "a previously-unset var must be UNSET again after drop, not empty"
        );
    }
}
