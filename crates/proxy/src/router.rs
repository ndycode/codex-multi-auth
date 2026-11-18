//! Port of `scripts/codex-app-router.js` — the detached app-bind router
//! process (ARCHITECTURE R3: new `codex-multi-auth-app-router` binary).
//!
//! Responsibilities:
//! - parse `--host/--port/--status/--state/--log/--max-log-bytes`;
//! - read the app-bind state JSON (host/port/clientApiKey/statusPath) and
//!   refuse to run without a valid loopback host, port, and client token
//!   (frozen error messages);
//! - start the runtime rotation proxy ([`crate::server`]);
//! - write the app-bind status JSON (`runtime-rotation-app-bind-status.json`,
//!   kind `codex-app-runtime-rotation-router`, 2-space JSON + trailing `\n`,
//!   0600, atomic temp+rename, best-effort) on a heartbeat;
//! - bound its own log file size (1 MiB default, checked every 60 s);
//! - clean shutdown on SIGINT (130) / SIGTERM / SIGHUP (0);
//! - idle-exit via `CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS` (R3 merge of the
//!   TS app-helper idle loop: default 12 h, floor 50 ms, activity = the
//!   proxy's `totalRequests` advancing; exits with status state
//!   `"idle-timeout"`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value, json};

use cma_core::json_io::stringify_pretty2;
use cma_core::utils::now_ms;
use cma_runtime::rotation::server_types::{
    RuntimeRotationProxyOptions, RuntimeRotationProxyStatus,
};

use crate::server::{RuntimeRotationProxyServer, start_runtime_rotation_proxy};

/// TS `DEFAULT_MAX_LOG_BYTES`.
pub const DEFAULT_MAX_LOG_BYTES: u64 = 1024 * 1024;
/// TS `LOG_SIZE_CHECK_INTERVAL_MS`.
pub const LOG_SIZE_CHECK_INTERVAL_MS: i64 = 60_000;
/// TS `DEFAULT_APP_RUNTIME_HELPER_IDLE_MS` (scripts/codex.js) — 12 hours.
pub const DEFAULT_IDLE_TIMEOUT_MS: i64 = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Argument / state parsing
// ---------------------------------------------------------------------------

/// TS `parsePort` — digits-only 0..=65535, else invalid (`NaN` → `None`).
pub fn parse_port(value: Option<&str>) -> Option<u16> {
    let text = value?.trim();
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port: u64 = text.parse().ok()?;
    u16::try_from(port).ok()
}

/// TS `parseArgs` result.
#[derive(Debug, Clone, PartialEq)]
pub struct RouterArgs {
    pub host: String,
    /// `None` = the TS `NaN` (invalid/absent `--port` value).
    pub port: Option<u16>,
    pub status_path: String,
    pub state_path: String,
    pub log_path: String,
    pub max_log_bytes: u64,
}

/// TS `parseArgs(argv)`.
pub fn parse_args(argv: &[String]) -> RouterArgs {
    let mut result = RouterArgs {
        host: "127.0.0.1".to_string(),
        port: Some(0),
        status_path: String::new(),
        state_path: String::new(),
        log_path: String::new(),
        max_log_bytes: DEFAULT_MAX_LOG_BYTES,
    };
    let mut index = 0;
    while index < argv.len() {
        let arg = argv[index].as_str();
        let next = argv.get(index + 1).map(String::as_str).unwrap_or("");
        match arg {
            "--host" => {
                result.host = next.to_string();
                index += 1;
            }
            "--port" => {
                result.port = parse_port(Some(next));
                index += 1;
            }
            "--status" => {
                result.status_path = next.to_string();
                index += 1;
            }
            "--state" => {
                result.state_path = next.to_string();
                index += 1;
            }
            "--max-log-bytes" => {
                result.max_log_bytes = match next.trim().parse::<i64>() {
                    Ok(parsed) if parsed > 0 => parsed as u64,
                    _ => DEFAULT_MAX_LOG_BYTES,
                };
                index += 1;
            }
            "--log" => {
                result.log_path = next.to_string();
                index += 1;
            }
            _ => {}
        }
        index += 1;
    }
    result
}

/// TS `readState(path)` — unreadable/unparseable → `None`.
fn read_state(path: &str) -> Option<Map<String, Value>> {
    if path.is_empty() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&raw).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// TS `readTrimmedString(record, key)`.
fn read_trimmed_string(record: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    let value = record?.get(key)?.as_str()?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// TS router-local `isLoopbackHost` — unbracket, then 127.0.0.1/::1/localhost.
fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().to_lowercase();
    let unbracketed = if normalized.starts_with('[') && normalized.ends_with(']') {
        normalized[1..normalized.len() - 1].to_string()
    } else {
        normalized
    };
    unbracketed == "127.0.0.1" || unbracketed == "::1" || unbracketed == "localhost"
}

/// TS `resolveRuntimeRotationAppHelperIdleMs` — positive int → `max(50, v)`,
/// else the 12 h default.
pub fn resolve_idle_timeout_ms(raw: Option<&str>) -> i64 {
    match raw.and_then(|value| value.trim().parse::<i64>().ok()) {
        Some(parsed) if parsed > 0 => parsed.max(50),
        _ => DEFAULT_IDLE_TIMEOUT_MS,
    }
}

// ---------------------------------------------------------------------------
// Status file (best-effort atomic write, 0600)
// ---------------------------------------------------------------------------

/// TS `createStatusPayload` — key order is the JS property insertion order.
fn create_status_payload(
    state: &str,
    proxy_base_url: Option<&str>,
    proxy_status: Option<&RuntimeRotationProxyStatus>,
    error: Option<&str>,
    state_record: Option<&Map<String, Value>>,
) -> Value {
    let last_account_index = proxy_status.and_then(|status| status.last_account_index);
    // Privacy: never publish a label containing `@` (an email leak).
    let last_account_label = match proxy_status.and_then(|status| status.last_account_label.clone())
    {
        Some(label) if !label.contains('@') => Some(label),
        _ => last_account_index.map(|index| format!("Account {}", index + 1)),
    };
    let base_url: Value = match proxy_base_url {
        Some(url) => Value::String(url.to_string()),
        None => state_record
            .and_then(|record| record.get("baseUrl"))
            .cloned()
            .unwrap_or(Value::Null),
    };
    let last_error: Value = match error {
        Some(error) => Value::String(error.to_string()),
        None => proxy_status
            .and_then(|status| status.last_error.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    };
    json!({
        "version": 1,
        "kind": "codex-app-runtime-rotation-router",
        "state": state,
        "pid": std::process::id(),
        "updatedAt": now_ms(),
        "baseUrl": base_url,
        "totalRequests": proxy_status.map(|status| status.total_requests).unwrap_or(0),
        "upstreamRequests": proxy_status.map(|status| status.upstream_requests).unwrap_or(0),
        "retries": proxy_status.map(|status| status.retries).unwrap_or(0),
        "rotations": proxy_status.map(|status| status.rotations).unwrap_or(0),
        "lastAccountIndex": last_account_index,
        "lastAccountLabel": last_account_label,
        "lastAccountId": proxy_status.and_then(|status| status.last_account_id.clone()),
        "lastAccountUpdatedAt": proxy_status.and_then(|status| status.last_account_updated_at),
        "lastError": last_error,
    })
}

/// TS `writeStatus` — temp `.<basename>.<pid>.<now>.tmp`, 0600, 2-space JSON
/// plus `\n`, atomic rename; every failure swallowed (status is best-effort:
/// the router must keep serving if telemetry is locked).
fn write_status(status_path: &str, payload: &Value) {
    if status_path.is_empty() {
        return;
    }
    let status_path = PathBuf::from(status_path);
    let Some(status_dir) = status_path.parent() else {
        return;
    };
    let basename = status_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp_path = status_dir.join(format!(
        ".{basename}.{}.{}.tmp",
        std::process::id(),
        now_ms()
    ));
    let content = format!("{}\n", stringify_pretty2(payload));
    let result: std::io::Result<()> = (|| {
        std::fs::create_dir_all(status_dir)?;
        write_owner_only(&temp_path, &content)?;
        std::fs::rename(&temp_path, &status_path)?;
        set_owner_only(&status_path);
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
}

fn write_owner_only(path: &Path, content: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(content.as_bytes())?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, content)
    }
}

fn set_owner_only(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

// ---------------------------------------------------------------------------
// Log bounds
// ---------------------------------------------------------------------------

/// TS `truncateLogPathIfTooLarge` — truncate the log file to 0 when it
/// exceeds `max_bytes`; all errors swallowed.
fn truncate_log_path_if_too_large(log_path: &str, max_bytes: u64) -> bool {
    if log_path.is_empty() || max_bytes == 0 {
        return false;
    }
    let Ok(stats) = std::fs::metadata(log_path) else {
        return false;
    };
    if !stats.is_file() || stats.len() <= max_bytes {
        return false;
    }
    match std::fs::OpenOptions::new().write(true).open(log_path) {
        Ok(file) => file.set_len(0).is_ok(),
        Err(_) => false,
    }
}

/// The truncation marker (TS wrote it to fd 1, which the spawner redirects
/// into the log file — stdout here is that same redirect).
fn check_log_bounds(log_path: &str, max_bytes: u64) {
    if truncate_log_path_if_too_large(log_path, max_bytes) {
        println!(
            "codex-multi-auth app router log truncated after exceeding {max_bytes} bytes"
        );
    }
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/// Resolves on SIGTERM/SIGHUP (unix); pending forever elsewhere.
async fn terminate_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let term = signal(SignalKind::terminate());
        let hup = signal(SignalKind::hangup());
        match (term, hup) {
            (Ok(mut term), Ok(mut hup)) => {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = hup.recv() => {}
                }
            }
            _ => std::future::pending::<()>().await,
        }
    }
    #[cfg(not(unix))]
    {
        std::future::pending::<()>().await
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// The router process body (TS `main()` + error trailer). Returns the exit
/// code for the thin binary main.
pub async fn run(argv: &[String]) -> i32 {
    match run_inner(argv).await {
        Ok(code) => code,
        Err(message) => {
            eprintln!("codex-multi-auth app router failed: {message}");
            1
        }
    }
}

async fn run_inner(argv: &[String]) -> Result<i32, String> {
    let args = parse_args(argv);
    check_log_bounds(&args.log_path, args.max_log_bytes);

    let state_record = read_state(&args.state_path);
    if !args.state_path.is_empty() && state_record.is_none() {
        let message =
            "Codex app runtime router state is unreadable; refusing to bind an ephemeral port."
                .to_string();
        write_status(
            &args.status_path,
            &create_status_payload("error", None, None, Some(&message), None),
        );
        return Err(message);
    }
    let host = read_trimmed_string(state_record.as_ref(), "host").unwrap_or(args.host.clone());
    let state_port = state_record
        .as_ref()
        .and_then(|record| record.get("port"))
        .and_then(|value| match value {
            Value::Number(number) => parse_port(Some(&number.to_string())),
            Value::String(text) => parse_port(Some(text)),
            _ => None,
        });
    let port = state_port.or(args.port);
    let client_api_key = read_trimmed_string(state_record.as_ref(), "clientApiKey");
    let Some(port) = port else {
        return Err(
            "A valid --port in the range 0-65535 is required for the Codex app runtime router."
                .to_string(),
        );
    };
    if !is_loopback_host(&host) {
        return Err(
            "Codex app runtime router host must be loopback-only (127.0.0.1, ::1, or localhost)."
                .to_string(),
        );
    }
    let Some(client_api_key) = client_api_key else {
        return Err("Codex app runtime router state is missing its client token.".to_string());
    };

    // Status writes prefer `--status`, then the state file's `statusPath`.
    let status_path = if !args.status_path.is_empty() {
        args.status_path.clone()
    } else {
        read_trimmed_string(state_record.as_ref(), "statusPath").unwrap_or_default()
    };

    let proxy: RuntimeRotationProxyServer = match start_runtime_rotation_proxy(
        RuntimeRotationProxyOptions {
            host: Some(host),
            port: Some(port),
            client_api_key,
            ..Default::default()
        },
    )
    .await
    {
        Ok(proxy) => proxy,
        Err(error) => {
            let message = error.to_string();
            write_status(
                &status_path,
                &create_status_payload("error", None, None, Some(&message), state_record.as_ref()),
            );
            return Err(message);
        }
    };

    let publish = |state: &str, status: Option<&RuntimeRotationProxyStatus>| {
        write_status(
            &status_path,
            &create_status_payload(
                state,
                Some(&proxy.base_url),
                status,
                None,
                state_record.as_ref(),
            ),
        );
    };
    {
        let status = proxy.get_status().await;
        publish("running", Some(&status));
    }

    // Idle-exit (R3): activity = the proxy's totalRequests advancing.
    let idle_timeout_ms = resolve_idle_timeout_ms(
        std::env::var("CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS").ok().as_deref(),
    );
    let tick_ms = 1_000.min((idle_timeout_ms / 2).max(50)) as u64;
    let mut last_activity_at = now_ms();
    let mut last_request_count = proxy.get_status().await.total_requests;
    let mut last_log_check_at = now_ms();

    let mut ticker = tokio::time::interval(Duration::from_millis(tick_ms.max(1)));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticker.tick().await; // the immediate first tick

    let ctrl_c = tokio::signal::ctrl_c();
    tokio::pin!(ctrl_c);
    let term = terminate_signal();
    tokio::pin!(term);

    loop {
        tokio::select! {
            _ = &mut ctrl_c => {
                let _ = proxy.close().await;
                let status = proxy.get_status().await;
                publish("stopped", Some(&status));
                return Ok(130);
            }
            _ = &mut term => {
                let _ = proxy.close().await;
                let status = proxy.get_status().await;
                publish("stopped", Some(&status));
                return Ok(0);
            }
            _ = ticker.tick() => {
                let current_time = now_ms();
                let status = proxy.get_status().await;
                if status.total_requests != last_request_count {
                    last_request_count = status.total_requests;
                    last_activity_at = current_time;
                }
                publish("running", Some(&status));
                if current_time - last_log_check_at >= LOG_SIZE_CHECK_INTERVAL_MS {
                    last_log_check_at = current_time;
                    check_log_bounds(&args.log_path, args.max_log_bytes);
                }
                if current_time - last_activity_at >= idle_timeout_ms {
                    let _ = proxy.close().await;
                    let status = proxy.get_status().await;
                    publish("idle-timeout", Some(&status));
                    return Ok(0);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn parse_port_accepts_digit_strings_in_range_only() {
        assert_eq!(parse_port(Some("0")), Some(0));
        assert_eq!(parse_port(Some("65535")), Some(65535));
        assert_eq!(parse_port(Some(" 1456 ")), Some(1456));
        assert_eq!(parse_port(Some("65536")), None);
        assert_eq!(parse_port(Some("-1")), None);
        assert_eq!(parse_port(Some("12.5")), None);
        assert_eq!(parse_port(Some("abc")), None);
        assert_eq!(parse_port(Some("")), None);
        assert_eq!(parse_port(None), None);
    }

    #[test]
    fn parse_args_defaults_and_flags() {
        let parsed = parse_args(&args(&[]));
        assert_eq!(
            parsed,
            RouterArgs {
                host: "127.0.0.1".to_string(),
                port: Some(0),
                status_path: String::new(),
                state_path: String::new(),
                log_path: String::new(),
                max_log_bytes: DEFAULT_MAX_LOG_BYTES,
            }
        );

        let parsed = parse_args(&args(&[
            "--host", "::1", "--port", "1456", "--status", "C:/tmp/status.json", "--state",
            "C:/tmp/state.json", "--log", "C:/tmp/router.log", "--max-log-bytes", "2048",
        ]));
        assert_eq!(parsed.host, "::1");
        assert_eq!(parsed.port, Some(1456));
        assert_eq!(parsed.status_path, "C:/tmp/status.json");
        assert_eq!(parsed.state_path, "C:/tmp/state.json");
        assert_eq!(parsed.log_path, "C:/tmp/router.log");
        assert_eq!(parsed.max_log_bytes, 2048);

        // Invalid --port keeps the TS NaN semantics (None), and an invalid
        // --max-log-bytes falls back to the default.
        let parsed = parse_args(&args(&["--port", "notaport", "--max-log-bytes", "-5"]));
        assert_eq!(parsed.port, None);
        assert_eq!(parsed.max_log_bytes, DEFAULT_MAX_LOG_BYTES);
    }

    #[test]
    fn loopback_check_unbrackets_ipv6() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("[::1]"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("LOCALHOST"));
        assert!(!is_loopback_host("0.0.0.0"));
        assert!(!is_loopback_host("example.com"));
    }

    #[test]
    fn idle_timeout_resolution_clamps_and_defaults() {
        assert_eq!(resolve_idle_timeout_ms(None), DEFAULT_IDLE_TIMEOUT_MS);
        assert_eq!(resolve_idle_timeout_ms(Some("")), DEFAULT_IDLE_TIMEOUT_MS);
        assert_eq!(resolve_idle_timeout_ms(Some("0")), DEFAULT_IDLE_TIMEOUT_MS);
        assert_eq!(resolve_idle_timeout_ms(Some("-5")), DEFAULT_IDLE_TIMEOUT_MS);
        assert_eq!(resolve_idle_timeout_ms(Some("10")), 50);
        assert_eq!(resolve_idle_timeout_ms(Some("1000")), 1000);
    }

    #[test]
    fn status_payload_shape_and_label_privacy() {
        let status = RuntimeRotationProxyStatus {
            started_at: 1,
            total_requests: 7,
            upstream_requests: 5,
            retries: 2,
            rotations: 3,
            streams_started: 1,
            last_error: Some("boom".to_string()),
            last_account_index: Some(1),
            last_account_label: Some("user@example.com".to_string()),
            last_account_id: Some("acc_2".to_string()),
            last_account_updated_at: Some(123),
        };
        let payload = create_status_payload(
            "running",
            Some("http://127.0.0.1:9999"),
            Some(&status),
            None,
            None,
        );
        assert_eq!(payload["version"], 1);
        assert_eq!(payload["kind"], "codex-app-runtime-rotation-router");
        assert_eq!(payload["state"], "running");
        assert_eq!(payload["baseUrl"], "http://127.0.0.1:9999");
        assert_eq!(payload["totalRequests"], 7);
        assert_eq!(payload["upstreamRequests"], 5);
        assert_eq!(payload["retries"], 2);
        assert_eq!(payload["rotations"], 3);
        assert_eq!(payload["lastAccountIndex"], 1);
        // Labels containing "@" are replaced with the index-derived label.
        assert_eq!(payload["lastAccountLabel"], "Account 2");
        assert_eq!(payload["lastAccountId"], "acc_2");
        assert_eq!(payload["lastError"], "boom");

        // Error argument overrides the proxy lastError; missing proxy state
        // zeroes the counters and nulls the identity fields.
        let payload = create_status_payload("error", None, None, Some("bad state"), None);
        assert_eq!(payload["state"], "error");
        assert_eq!(payload["baseUrl"], Value::Null);
        assert_eq!(payload["totalRequests"], 0);
        assert_eq!(payload["lastAccountIndex"], Value::Null);
        assert_eq!(payload["lastAccountLabel"], Value::Null);
        assert_eq!(payload["lastError"], "bad state");
    }

    #[test]
    #[serial(env)]
    fn run_fails_with_frozen_messages_for_bad_state() {
        let sandbox = cma_testkit::sandbox::EnvSandbox::new();
        let dir = sandbox.root().to_path_buf();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // Unreadable state file → error status written + exit 1.
            let state_path = dir.join("state.json");
            std::fs::write(&state_path, "{ not json").unwrap();
            let status_path = dir.join("status.json");
            let code = run(&[
                "--state".to_string(),
                state_path.to_string_lossy().into_owned(),
                "--status".to_string(),
                status_path.to_string_lossy().into_owned(),
            ])
            .await;
            assert_eq!(code, 1);
            let written: Value =
                serde_json::from_str(&std::fs::read_to_string(&status_path).unwrap()).unwrap();
            assert_eq!(written["state"], "error");
            assert_eq!(written["kind"], "codex-app-runtime-rotation-router");
            assert_eq!(
                written["lastError"],
                "Codex app runtime router state is unreadable; refusing to bind an ephemeral port."
            );

            // Missing client token in a readable state → exit 1 (no status
            // write required on this path).
            std::fs::write(
                &state_path,
                r#"{"host":"127.0.0.1","port":0,"statusPath":""}"#,
            )
            .unwrap();
            let code = run(&[
                "--state".to_string(),
                state_path.to_string_lossy().into_owned(),
            ])
            .await;
            assert_eq!(code, 1);

            // Non-loopback host → exit 1.
            std::fs::write(
                &state_path,
                r#"{"host":"0.0.0.0","port":0,"clientApiKey":"key"}"#,
            )
            .unwrap();
            let code = run(&[
                "--state".to_string(),
                state_path.to_string_lossy().into_owned(),
            ])
            .await;
            assert_eq!(code, 1);
        });
    }
}
