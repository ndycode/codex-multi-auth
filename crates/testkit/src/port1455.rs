//! Serialization guard for tests that touch the fixed OAuth callback port **1455**
//! — the Rust analogue of the vitest single-worker rule (spec 14 §11, harness
//! invariant 2).
//!
//! The OAuth redirect URI is provider-registered against port 1455 and is
//! immovable (spec 14 §6). The TS suite prevents port collisions by running the
//! entire suite in ONE worker (`pool: 'forks'`, `fileParallelism: false`,
//! `--maxWorkers=1` in `vitest.config.ts`) plus an awaited port release in
//! `test/oauth-server.integration.test.ts`'s `afterEach`. Rust tests run
//! multi-threaded by default, so the equivalent contract is:
//!
//! 1. **Every test that binds, probes, or otherwise depends on port 1455 MUST be
//!    annotated `#[serial(oauth_1455)]`** — the shared key is
//!    [`OAUTH_1455_SERIAL_KEY`] (ARCHITECTURE.md §9.4). The attribute macro is
//!    re-exported here so callers need no direct `serial_test` dependency:
//!
//!    ```no_run
//!    use cma_testkit::port1455::serial;
//!
//!    #[serial(oauth_1455)]
//!    fn callback_server_binds_1455() {
//!        // ... bind 127.0.0.1:1455, run assertions, and RELEASE the port
//!        // before returning (awaited shutdown — TS parity).
//!    }
//!    ```
//!
//! 2. Each such test must fully release the port before returning (drop/await
//!    server shutdown), mirroring the awaited release in the TS integration
//!    suite. `serial_test` only serializes test bodies — a leaked listener still
//!    breaks the next holder of the key.
//!
//! Note `cargo test` runs each test *binary* sequentially, so the serial key is
//! only needed within a binary — but every 1455 test must still carry it, because
//! unit and integration tests of the same crate share a binary and future suites
//! may co-locate.

/// The immovable OAuth callback port (provider-registered redirect URI —
/// `http://localhost:1455/auth/callback`). Test-side pin; the authoritative
/// runtime constant lives with the OAuth flow in `cma-auth`.
pub const OAUTH_CALLBACK_PORT: u16 = 1455;

/// The `serial_test` key for port-1455 tests: `#[serial(oauth_1455)]`.
///
/// The macro takes the key as a bare identifier; this constant exists so the
/// convention is greppable, documented, and usable in assertion messages.
pub const OAUTH_1455_SERIAL_KEY: &str = "oauth_1455";

/// Re-export of the whole `serial_test` crate, so downstream test code can use
/// additional items (e.g. `parallel`, `file_serial`) without declaring its own
/// dependency.
pub use ::serial_test;

/// Re-export of the `#[serial]` attribute macro. Use as
/// `#[cma_testkit::port1455::serial(oauth_1455)]` or import it:
/// `use cma_testkit::port1455::serial;` then `#[serial(oauth_1455)]`.
pub use serial_test::serial;

/// Fail fast (with an actionable message) when port 1455 is already occupied.
///
/// Call at the top of a `#[serial(oauth_1455)]` test to distinguish "a previous
/// test leaked the port" from downstream bind-failure behavior under test (the
/// callback server itself must NEVER reject on bind failure — it reports
/// `ready:false` — so without this probe a leaked port turns into confusing
/// downstream assertions instead of a clear harness error).
///
/// # Panics
/// Panics when `127.0.0.1:1455` cannot be bound.
pub fn assert_port_1455_free() {
    match std::net::TcpListener::bind(("127.0.0.1", OAUTH_CALLBACK_PORT)) {
        Ok(listener) => drop(listener),
        Err(error) => panic!(
            "port {OAUTH_CALLBACK_PORT} is already in use ({error}); OAuth-callback tests must \
             hold #[serial({OAUTH_1455_SERIAL_KEY})] and release the port before returning \
             (awaited shutdown — see test/oauth-server.integration.test.ts afterEach in the TS suite)"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Uses the re-exported attribute via `super::*` — proves the re-export works
    // exactly as downstream crates will consume it.
    #[test]
    #[serial(oauth_1455)]
    fn constants_and_serial_reexport() {
        assert_eq!(OAUTH_CALLBACK_PORT, 1455);
        assert_eq!(OAUTH_1455_SERIAL_KEY, "oauth_1455");
    }

    #[test]
    #[serial(oauth_1455)]
    fn port_probe_binds_and_releases() {
        // Skip (don't fail) when the developer machine genuinely has 1455 busy —
        // e.g. a live OAuth login in another process. The helper's panic path is
        // for leaks WITHIN a serialized test run, not ambient occupancy.
        if std::net::TcpListener::bind(("127.0.0.1", OAUTH_CALLBACK_PORT)).is_err() {
            eprintln!("skipping port_probe_binds_and_releases: port 1455 busy on this machine");
            return;
        }
        // Bind/drop through the helper twice: if the helper leaked its listener,
        // the second call would panic.
        assert_port_1455_free();
        assert_port_1455_free();
    }
}
