//! Port of `lib/auth/device-auth.ts` — the non-RFC-8628 device-code login
//! flow against `auth.openai.com` (spec 07 §2).
//!
//! CRITICAL semantics (spec 07 gotchas 1–2):
//! - On the *usercode* request a 404 is TERMINAL ("Device auth login is not
//!   enabled…"); on the *token poll* bare 403/404 are NORMAL pending states
//!   (403 = user hasn't approved yet, 404 = device_auth_id propagation lag).
//! - 403/404 poll delays use the exact server interval with NO jitter; only
//!   transient statuses {408, 429, 502, 503, 504} get ±10 % jitter.
//! - A parseable `Retry-After` (seconds or HTTP-date) overrides both, floored
//!   at 1000 ms.
//! - Total budget 15 min, clamped further by the server `expires_at`.
//! - The poll response carries the PKCE verifier with the authorization code;
//!   it is never persisted and never logged (spec 07 gotcha 5).
//!
//! The TS `keepAlive` option (timer `unref` control) has no Rust equivalent —
//! tokio timers never hold or release a process the way Node's event loop
//! does — and is intentionally not ported (spec 07 §2 notes it is irrelevant
//! for a blocking runtime).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::Notify;

use cma_core::schemas::token::{TokenFailure, TokenFailureReason, TokenResult};

use crate::oauth::{
    CLIENT_ID, TOKEN_URL, exchange_authorization_code_at, sanitize_oauth_response_body_for_log,
};

// ---------------------------------------------------------------------------
// Constants (exact values, spec 07 §2)
// ---------------------------------------------------------------------------

const DEVICE_AUTH_BASE_URL: &str = "https://auth.openai.com";
pub const DEVICE_AUTH_VERIFICATION_URL: &str = "https://auth.openai.com/codex/device";
pub const DEVICE_AUTH_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
pub const DEVICE_AUTH_TIMEOUT_MS: i64 = 15 * 60 * 1000;
pub const DEVICE_AUTH_DEFAULT_INTERVAL_MS: i64 = 5_000;
const DEVICE_AUTH_ABORTED_MESSAGE: &str = "aborted";
const DEVICE_AUTH_TRANSIENT_PENDING_STATUSES: [u16; 5] = [408, 429, 502, 503, 504];

// ---------------------------------------------------------------------------
// Abort signal (AbortSignal analogue for this flow)
// ---------------------------------------------------------------------------

/// Minimal `AbortSignal` analogue: an abort flag plus a notifier so pending
/// sleeps/polls can be woken. Cloneable via `Arc`.
#[derive(Debug, Default)]
pub struct AbortSignal {
    aborted: AtomicBool,
    notify: Notify,
}

impl AbortSignal {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Trip the signal; all current and future waiters resolve immediately.
    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }

    /// Resolve once the signal is aborted (immediately when already aborted).
    pub async fn cancelled(&self) {
        loop {
            if self.is_aborted() {
                return;
            }
            let notified = self.notify.notified();
            // Re-check after registering to close the store/notify race.
            if self.is_aborted() {
                return;
            }
            notified.await;
        }
    }
}

// ---------------------------------------------------------------------------
// Options (TS `DeviceAuthFlowOptions` — injectable for tests)
// ---------------------------------------------------------------------------

pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type SleepFn = Arc<dyn Fn(i64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
pub type RandomFn = Arc<dyn Fn() -> f64 + Send + Sync>;
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Injectable seams for the device auth flow. All optional; defaults match
/// production behavior. `base_url` / `token_url` replace the TS `fetchImpl`
/// stub as the test seam (point them at a mock server).
#[derive(Clone, Default)]
pub struct DeviceAuthFlowOptions {
    /// Base URL for the device-auth endpoints (default `https://auth.openai.com`).
    pub base_url: Option<String>,
    /// Token endpoint for the final code exchange (default the production
    /// `TOKEN_URL`).
    pub token_url: Option<String>,
    /// Clock (default wall clock, epoch ms).
    pub now: Option<NowFn>,
    /// Sleep implementation (default `tokio::time::sleep`).
    pub sleep: Option<SleepFn>,
    /// Abort signal.
    pub signal: Option<Arc<AbortSignal>>,
    /// Total wait budget (default 15 min).
    pub timeout_ms: Option<i64>,
    /// Prompt sink (default stdout `println!`).
    pub log: Option<LogFn>,
    /// Jitter source in `[0, 1)` (default `rand`).
    pub random: Option<RandomFn>,
}

fn now_of(options: &DeviceAuthFlowOptions) -> i64 {
    match &options.now {
        Some(f) => f(),
        None => cma_core::utils::now_ms(),
    }
}

fn random_of(options: &DeviceAuthFlowOptions) -> f64 {
    match &options.random {
        Some(f) => f(),
        None => rand::random::<f64>(),
    }
}

fn log_line(options: &DeviceAuthFlowOptions, message: &str) {
    match &options.log {
        Some(f) => f(message),
        None => println!("{message}"),
    }
}

fn is_aborted(options: &DeviceAuthFlowOptions) -> bool {
    options
        .signal
        .as_ref()
        .is_some_and(|signal| signal.is_aborted())
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// The parsed usercode-request payload (TS `DeviceAuthCode`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthCode {
    pub verification_url: String,
    pub user_code: String,
    pub device_auth_id: String,
    pub interval_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
}

/// The parsed token-poll completion payload. The server intentionally
/// returns the PKCE verifier with the issued authorization code (mirrors the
/// upstream Codex CLI); the verifier is never persisted and never logged —
/// it is handed straight to the token exchange.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceAuthCompletion {
    pub authorization_code: String,
    pub code_verifier: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeviceAuthCodeResult {
    Success { device_code: DeviceAuthCode },
    Failed(TokenFailure),
}

impl DeviceAuthCodeResult {
    pub fn as_success(&self) -> Option<&DeviceAuthCode> {
        match self {
            Self::Success { device_code } => Some(device_code),
            Self::Failed(_) => None,
        }
    }
    pub fn as_failure(&self) -> Option<&TokenFailure> {
        match self {
            Self::Success { .. } => None,
            Self::Failed(failure) => Some(failure),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeviceAuthCompletionResult {
    Success { completion: DeviceAuthCompletion },
    Failed(TokenFailure),
}

impl DeviceAuthCompletionResult {
    pub fn as_success(&self) -> Option<&DeviceAuthCompletion> {
        match self {
            Self::Success { completion } => Some(completion),
            Self::Failed(_) => None,
        }
    }
    pub fn as_failure(&self) -> Option<&TokenFailure> {
        match self {
            Self::Success { .. } => None,
            Self::Failed(failure) => Some(failure),
        }
    }
}

fn failed_result(
    reason: TokenFailureReason,
    message: String,
    status_code: Option<i64>,
) -> TokenFailure {
    TokenFailure {
        reason: Some(reason),
        status_code,
        message: Some(message),
    }
}

fn aborted_failure() -> TokenFailure {
    failed_result(
        TokenFailureReason::NetworkError,
        DEVICE_AUTH_ABORTED_MESSAGE.to_string(),
        None,
    )
}

// ---------------------------------------------------------------------------
// Sleep with abort
// ---------------------------------------------------------------------------

struct Aborted;

async fn sleep_with_abort(ms: i64, options: &DeviceAuthFlowOptions) -> Result<(), Aborted> {
    let sleep_future: Pin<Box<dyn Future<Output = ()> + Send>> = match &options.sleep {
        Some(sleep) => sleep(ms),
        None => Box::pin(tokio::time::sleep(std::time::Duration::from_millis(
            ms.max(0) as u64,
        ))),
    };
    match &options.signal {
        None => {
            sleep_future.await;
            Ok(())
        }
        Some(signal) => {
            if signal.is_aborted() {
                return Err(Aborted);
            }
            let signal = Arc::clone(signal);
            tokio::select! {
                _ = sleep_future => Ok(()),
                _ = signal.cancelled() => Err(Aborted),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// JS-compatible parsing helpers
// ---------------------------------------------------------------------------

fn is_pending_status(status: u16) -> bool {
    status == 403 || status == 404 || DEVICE_AUTH_TRANSIENT_PENDING_STATUSES.contains(&status)
}

/// `Number.parseFloat` prefix semantics: parse the longest leading float.
fn js_parse_float(input: &str) -> Option<f64> {
    let s = input.trim_start();
    let bytes = s.as_bytes();
    let mut i = 0usize;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let has_int = i > int_start;
    let mut has_frac = false;
    if i < bytes.len() && bytes[i] == b'.' {
        let frac_start = i + 1;
        let mut j = frac_start;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if has_int || j > frac_start {
            has_frac = true;
            i = j;
        }
    }
    if !has_int && !has_frac {
        return None;
    }
    // Optional exponent.
    let mantissa_end = i;
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let digit_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > digit_start {
            i = j;
        } else {
            i = mantissa_end;
        }
    }
    s[..i].parse::<f64>().ok()
}

/// JS `Number(str)` strict semantics for the subset that matters here:
/// finite decimal numbers (the whole trimmed string — no prefix parsing).
fn js_number(input: &str) -> Option<f64> {
    let t = input.trim();
    if t.is_empty() {
        return None;
    }
    match t.parse::<f64>() {
        Ok(v) if v.is_finite() => Some(v),
        _ => None,
    }
}

/// `^\d+(?:\.\d+)?$`
fn is_plain_numeric_string(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0usize;
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == int_start {
        return false;
    }
    if i == bytes.len() {
        return true;
    }
    if bytes[i] != b'.' {
        return false;
    }
    i += 1;
    let frac_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    i > frac_start && i == bytes.len()
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_u32(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// ISO 8601 subset: `YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH:MM|±HHMM]`.
/// A missing offset is treated as UTC (JS treats date-times without offsets
/// as LOCAL time; UTC is the deterministic choice for server payloads).
fn parse_iso_8601_ms(s: &str) -> Option<i64> {
    let (date_part, rest) = match s.find(['T', 't']) {
        Some(pos) => (&s[..pos], Some(&s[pos + 1..])),
        None => (s, None),
    };
    let mut date_it = date_part.split('-');
    let year: i64 = {
        let y = date_it.next()?;
        if y.len() != 4 {
            return None;
        }
        parse_u32(y)? as i64
    };
    let month = parse_u32(date_it.next()?)?;
    let day = parse_u32(date_it.next()?)?;
    if date_it.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut hour = 0u32;
    let mut minute = 0u32;
    let mut second = 0u32;
    let mut frac_ms = 0i64;
    let mut offset_min = 0i64;

    if let Some(time_str) = rest {
        // Split off the zone designator.
        let (clock, zone): (&str, Option<&str>) =
            if let Some(stripped) = time_str.strip_suffix(['Z', 'z']) {
                (stripped, Some("Z"))
            } else if let Some(pos) = time_str.rfind(['+', '-']) {
                if pos > 0 {
                    (&time_str[..pos], Some(&time_str[pos..]))
                } else {
                    (time_str, None)
                }
            } else {
                (time_str, None)
            };

        let mut clock_it = clock.split(':');
        hour = parse_u32(clock_it.next()?)?;
        minute = parse_u32(clock_it.next()?)?;
        if let Some(sec_part) = clock_it.next() {
            let (sec_str, frac_str) = match sec_part.split_once('.') {
                Some((sec, frac)) => (sec, Some(frac)),
                None => (sec_part, None),
            };
            second = parse_u32(sec_str)?;
            if let Some(frac) = frac_str {
                if frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                let padded = format!("{frac:0<3}");
                frac_ms = parse_u32(&padded[..3])? as i64;
            }
        }
        if clock_it.next().is_some() || hour > 23 || minute > 59 || second > 60 {
            return None;
        }

        if let Some(zone) = zone
            && zone != "Z"
        {
            let sign: i64 = if zone.starts_with('-') { -1 } else { 1 };
            let digits = &zone[1..];
            let (oh, om) = match digits.split_once(':') {
                Some((h, m)) => (parse_u32(h)?, parse_u32(m)?),
                None => match digits.len() {
                    4 => (parse_u32(&digits[..2])?, parse_u32(&digits[2..])?),
                    2 => (parse_u32(digits)?, 0),
                    _ => return None,
                },
            };
            offset_min = sign * (oh as i64 * 60 + om as i64);
        }
    }

    let days = days_from_civil(year, month, day);
    let ms = days * 86_400_000
        + hour as i64 * 3_600_000
        + minute as i64 * 60_000
        + second as i64 * 1_000
        + frac_ms
        - offset_min * 60_000;
    Some(ms)
}

/// RFC 1123 / RFC 2822 HTTP dates: `[Www, ]DD Mon YYYY HH:MM:SS GMT`.
fn parse_http_date_ms(s: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let s = s.trim();
    // Strip an optional leading weekday ("Sun, ").
    let rest = match s.split_once(',') {
        Some((_, tail)) => tail.trim_start(),
        None => s,
    };
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() < 4 {
        return None;
    }
    let day = parse_u32(tokens[0])?;
    let month = MONTHS
        .iter()
        .position(|m| m.eq_ignore_ascii_case(tokens[1]))? as u32
        + 1;
    let year: i64 = parse_u32(tokens[2])? as i64;
    let mut clock_it = tokens[3].split(':');
    let hour = parse_u32(clock_it.next()?)?;
    let minute = parse_u32(clock_it.next()?)?;
    let second = parse_u32(clock_it.next()?)?;
    if clock_it.next().is_some()
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Zone: only UTC spellings are supported.
    if let Some(zone) = tokens.get(4)
        && !matches!(
            zone.to_ascii_uppercase().as_str(),
            "GMT" | "UT" | "UTC" | "+0000"
        )
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(
        days * 86_400_000
            + hour as i64 * 3_600_000
            + minute as i64 * 60_000
            + second as i64 * 1_000,
    )
}

/// `Date.parse` for the formats that occur in this flow (ISO 8601 and HTTP
/// dates). Anything else → `None` (NaN in JS).
fn js_date_parse_ms(input: &str) -> Option<i64> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    parse_iso_8601_ms(s).or_else(|| parse_http_date_ms(s))
}

fn parse_retry_after_ms(value: Option<&str>, now_ms: i64) -> Option<i64> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(seconds) = js_number(trimmed) {
        if seconds >= 0.0 {
            return Some((seconds * 1000.0).ceil() as i64);
        }
        return None;
    }
    js_date_parse_ms(trimmed).map(|date_ms| (date_ms - now_ms).max(0))
}

fn apply_light_jitter(delay_ms: i64, options: &DeviceAuthFlowOptions) -> i64 {
    let jitter_ratio = 1.0 + (random_of(options) - 0.5) * 0.2;
    ((delay_ms as f64 * jitter_ratio).round() as i64).max(1_000)
}

fn resolve_poll_delay_ms(
    status: u16,
    retry_after: Option<&str>,
    device_code: &DeviceAuthCode,
    now_ms: i64,
    options: &DeviceAuthFlowOptions,
) -> i64 {
    if let Some(retry_after_ms) = parse_retry_after_ms(retry_after, now_ms) {
        return retry_after_ms.max(1_000);
    }
    if status == 403 || status == 404 {
        return device_code.interval_ms;
    }
    apply_light_jitter(device_code.interval_ms, options)
}

fn parse_interval_ms(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(n)) => {
            if let Some(v) = n.as_f64()
                && v.is_finite()
                && v > 0.0
            {
                return (v * 1000.0).trunc() as i64;
            }
            DEVICE_AUTH_DEFAULT_INTERVAL_MS
        }
        Some(Value::String(s)) => {
            if let Some(parsed) = js_parse_float(s.trim())
                && parsed.is_finite()
                && parsed > 0.0
            {
                return (parsed * 1000.0).trunc() as i64;
            }
            DEVICE_AUTH_DEFAULT_INTERVAL_MS
        }
        _ => DEVICE_AUTH_DEFAULT_INTERVAL_MS,
    }
}

/// `expires_at`: absolute — epoch seconds when `< 1e10`, else epoch ms;
/// numeric strings the same; other strings via `Date.parse`.
fn parse_absolute_expiration_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => {
            let v = n.as_f64()?;
            if v.is_finite() && v > 0.0 {
                Some(if v < 10_000_000_000.0 {
                    (v * 1000.0) as i64
                } else {
                    v as i64
                })
            } else {
                None
            }
        }
        Value::String(s) => {
            let trimmed = s.trim();
            if is_plain_numeric_string(trimmed) {
                let n = js_parse_float(trimmed)?;
                Some(if n < 10_000_000_000.0 {
                    (n * 1000.0) as i64
                } else {
                    n as i64
                })
            } else {
                js_date_parse_ms(trimmed)
            }
        }
        _ => None,
    }
}

/// `expires_in`: relative seconds (`now + trunc(seconds*1000)`); numeric
/// strings the same; other strings via `Date.parse` as absolute.
fn parse_expiration_ms(value: Option<&Value>, now_ms: i64) -> Option<i64> {
    match value? {
        Value::Number(n) => {
            let v = n.as_f64()?;
            if v.is_finite() && v > 0.0 {
                Some(now_ms + (v * 1000.0).trunc() as i64)
            } else {
                None
            }
        }
        Value::String(s) => {
            let trimmed = s.trim();
            if is_plain_numeric_string(trimmed) {
                let seconds = js_parse_float(trimmed)?;
                Some(now_ms + (seconds * 1000.0).trunc() as i64)
            } else {
                js_date_parse_ms(trimmed)
            }
        }
        _ => None,
    }
}

fn parse_non_empty_string(value: Option<&Value>) -> Option<String> {
    let s = value?.as_str()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_device_code_payload(
    payload: &serde_json::Map<String, Value>,
    now_ms: i64,
) -> Option<DeviceAuthCode> {
    let device_auth_id = parse_non_empty_string(payload.get("device_auth_id"))?;
    let user_code = parse_non_empty_string(payload.get("user_code"))
        .or_else(|| parse_non_empty_string(payload.get("usercode")))?;
    let expires_at_ms = parse_absolute_expiration_ms(payload.get("expires_at"))
        .or_else(|| parse_expiration_ms(payload.get("expires_in"), now_ms));
    Some(DeviceAuthCode {
        verification_url: DEVICE_AUTH_VERIFICATION_URL.to_string(),
        user_code,
        device_auth_id,
        interval_ms: parse_interval_ms(payload.get("interval")),
        expires_at_ms,
    })
}

fn parse_completion_payload(
    payload: &serde_json::Map<String, Value>,
) -> Option<DeviceAuthCompletion> {
    let authorization_code = parse_non_empty_string(payload.get("authorization_code"))?;
    let code_verifier = parse_non_empty_string(payload.get("code_verifier"))?;
    Some(DeviceAuthCompletion {
        authorization_code,
        code_verifier,
    })
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

fn api_base(options: &DeviceAuthFlowOptions) -> String {
    let base = options
        .base_url
        .as_deref()
        .unwrap_or(DEVICE_AUTH_BASE_URL)
        .trim_end_matches('/')
        .to_string();
    format!("{base}/api/accounts")
}

async fn post_json_with_abort(
    url: &str,
    body: Value,
    options: &DeviceAuthFlowOptions,
) -> Result<Result<reqwest::Response, reqwest::Error>, Aborted> {
    let client = reqwest::Client::new();
    let request = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send();
    match &options.signal {
        None => Ok(request.await),
        Some(signal) => {
            if signal.is_aborted() {
                return Err(Aborted);
            }
            let signal = Arc::clone(signal);
            tokio::select! {
                result = request => Ok(result),
                _ = signal.cancelled() => Err(Aborted),
            }
        }
    }
}

async fn read_json_record(response: reqwest::Response) -> Option<serde_json::Map<String, Value>> {
    let text = response.text().await.unwrap_or_default();
    if text.trim().is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(&text).ok()?;
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

async fn read_failure_text(response: reqwest::Response) -> String {
    let text = response.text().await.unwrap_or_default();
    sanitize_oauth_response_body_for_log(&text)
}

fn format_wait_budget(timeout_ms: i64) -> String {
    let total_seconds = ((timeout_ms as f64) / 1000.0).ceil().max(1.0) as i64;
    if total_seconds < 60 {
        return format!(
            "{total_seconds} second{}",
            if total_seconds == 1 { "" } else { "s" }
        );
    }
    let total_minutes = ((total_seconds as f64) / 60.0).ceil() as i64;
    format!(
        "{total_minutes} minute{}",
        if total_minutes == 1 { "" } else { "s" }
    )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Request a device-auth user code (TS `requestDeviceAuthorization`).
///
/// A 404 HERE is terminal — the server does not offer device auth (spec 07
/// gotcha 2). Contrast with the token poll, where 404 is a pending state.
pub async fn request_device_authorization(options: &DeviceAuthFlowOptions) -> DeviceAuthCodeResult {
    if is_aborted(options) {
        return DeviceAuthCodeResult::Failed(aborted_failure());
    }
    let url = format!("{}/deviceauth/usercode", api_base(options));
    let response =
        match post_json_with_abort(&url, json!({ "client_id": CLIENT_ID }), options).await {
            Err(Aborted) => return DeviceAuthCodeResult::Failed(aborted_failure()),
            Ok(Err(error)) => {
                if is_aborted(options) {
                    return DeviceAuthCodeResult::Failed(aborted_failure());
                }
                return DeviceAuthCodeResult::Failed(failed_result(
                    TokenFailureReason::NetworkError,
                    error.to_string(),
                    None,
                ));
            }
            Ok(Ok(response)) => response,
        };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        if status == 404 {
            return DeviceAuthCodeResult::Failed(failed_result(
                TokenFailureReason::HttpError,
                "Device auth login is not enabled for this Codex server. Use browser login or --manual."
                    .to_string(),
                Some(404),
            ));
        }
        let safe_text = read_failure_text(response).await;
        let message = if safe_text.is_empty() {
            format!("Device code request failed with status {status}")
        } else {
            safe_text
        };
        return DeviceAuthCodeResult::Failed(failed_result(
            TokenFailureReason::HttpError,
            message,
            Some(status as i64),
        ));
    }

    let payload = read_json_record(response).await;
    let device_code = payload
        .as_ref()
        .and_then(|record| parse_device_code_payload(record, now_of(options)));
    match device_code {
        Some(device_code) => DeviceAuthCodeResult::Success { device_code },
        None => DeviceAuthCodeResult::Failed(failed_result(
            TokenFailureReason::InvalidResponse,
            "Device code request response failed schema validation".to_string(),
            None,
        )),
    }
}

fn print_device_authorization_prompt(
    device_code: &DeviceAuthCode,
    options: &DeviceAuthFlowOptions,
    timeout_ms: i64,
    now_ms: i64,
) {
    let effective_timeout_ms = match device_code.expires_at_ms {
        None => timeout_ms,
        Some(expires_at_ms) => timeout_ms.min((expires_at_ms - now_ms).max(0)),
    };
    log_line(options, "Device auth login");
    log_line(options, &format!("Open: {}", device_code.verification_url));
    log_line(options, &format!("Code: {}", device_code.user_code));
    log_line(
        options,
        &format!(
            "This code expires in {}. Never share it.",
            format_wait_budget(effective_timeout_ms)
        ),
    );
}

/// Poll the device-auth token endpoint until the user approves, the budget
/// runs out, or a terminal error arrives (TS `pollDeviceAuthorization`).
///
/// Bare 403/404 are PENDING (deliberate non-RFC behavior — see the module
/// docs); only 408/429/502/503/504 receive ±10 % jitter; `Retry-After`
/// overrides with a 1000 ms floor.
pub async fn poll_device_authorization(
    device_code: &DeviceAuthCode,
    options: &DeviceAuthFlowOptions,
) -> DeviceAuthCompletionResult {
    let start_ms = now_of(options);
    let timeout_ms = options.timeout_ms.unwrap_or(DEVICE_AUTH_TIMEOUT_MS);
    let deadline = match device_code.expires_at_ms {
        Some(expires_at_ms) => (start_ms + timeout_ms).min(expires_at_ms),
        None => start_ms + timeout_ms,
    };
    let effective_timeout_ms = (deadline - start_ms).max(0);
    let url = format!("{}/deviceauth/token", api_base(options));

    loop {
        if is_aborted(options) {
            return DeviceAuthCompletionResult::Failed(aborted_failure());
        }
        let body = json!({
            "device_auth_id": device_code.device_auth_id,
            "user_code": device_code.user_code,
        });
        let response = match post_json_with_abort(&url, body, options).await {
            Err(Aborted) => return DeviceAuthCompletionResult::Failed(aborted_failure()),
            Ok(Err(error)) => {
                if is_aborted(options) {
                    return DeviceAuthCompletionResult::Failed(aborted_failure());
                }
                return DeviceAuthCompletionResult::Failed(failed_result(
                    TokenFailureReason::NetworkError,
                    error.to_string(),
                    None,
                ));
            }
            Ok(Ok(response)) => response,
        };

        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            let payload = read_json_record(response).await;
            let completion = payload.as_ref().and_then(parse_completion_payload);
            return match completion {
                Some(completion) => DeviceAuthCompletionResult::Success { completion },
                None => DeviceAuthCompletionResult::Failed(failed_result(
                    TokenFailureReason::InvalidResponse,
                    "Device auth token response failed schema validation".to_string(),
                    None,
                )),
            };
        }

        if is_pending_status(status) {
            let now_ms = now_of(options);
            let remaining_ms = deadline - now_ms;
            if remaining_ms <= 0 {
                return DeviceAuthCompletionResult::Failed(failed_result(
                    TokenFailureReason::Timeout,
                    format!(
                        "Device auth timed out after {}",
                        format_wait_budget(effective_timeout_ms)
                    ),
                    None,
                ));
            }
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let delay_ms =
                resolve_poll_delay_ms(status, retry_after.as_deref(), device_code, now_ms, options);
            if sleep_with_abort(delay_ms.min(remaining_ms), options)
                .await
                .is_err()
            {
                return DeviceAuthCompletionResult::Failed(aborted_failure());
            }
            continue;
        }

        let safe_text = read_failure_text(response).await;
        let message = if safe_text.is_empty() {
            format!("Device auth failed with status {status}")
        } else {
            safe_text
        };
        return DeviceAuthCompletionResult::Failed(failed_result(
            TokenFailureReason::HttpError,
            message,
            Some(status as i64),
        ));
    }
}

/// Full device auth flow: usercode request → user prompt → poll → code
/// exchange with the DEVICE redirect URI (not the localhost one) — TS
/// `runDeviceAuthFlow`, the only function the TS barrel re-exports.
pub async fn run_device_auth_flow(options: &DeviceAuthFlowOptions) -> TokenResult {
    let device_code_result = request_device_authorization(options).await;
    let device_code = match device_code_result {
        DeviceAuthCodeResult::Failed(failure) => return TokenResult::Failed(failure),
        DeviceAuthCodeResult::Success { device_code } => device_code,
    };
    if is_aborted(options) {
        return TokenResult::Failed(aborted_failure());
    }

    print_device_authorization_prompt(
        &device_code,
        options,
        options.timeout_ms.unwrap_or(DEVICE_AUTH_TIMEOUT_MS),
        now_of(options),
    );

    let completion_result = poll_device_authorization(&device_code, options).await;
    let completion = match completion_result {
        DeviceAuthCompletionResult::Failed(failure) => return TokenResult::Failed(failure),
        DeviceAuthCompletionResult::Success { completion } => completion,
    };

    exchange_authorization_code_at(
        options.token_url.as_deref().unwrap_or(TOKEN_URL),
        &completion.authorization_code,
        &completion.code_verifier,
        Some(DEVICE_AUTH_REDIRECT_URI),
    )
    .await
}

// ===========================================================================
// Tests (ported from test/device-auth.test.ts)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicI64;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // Pinned epochs (independently computed) so a js_date_parse_ms bug cannot
    // silently pass its own round-trip.
    const T_2026_04_26: i64 = 1_777_161_600_000; // 2026-04-26T00:00:00Z
    const T_2026_05_15_NOON: i64 = 1_778_846_400_000; // 2026-05-15T12:00:00Z

    fn fixed_now(now_ms: i64) -> NowFn {
        Arc::new(move || now_ms)
    }

    fn recording_sleep() -> (SleepFn, Arc<Mutex<Vec<i64>>>) {
        let calls: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_clone = Arc::clone(&calls);
        let sleep: SleepFn = Arc::new(move |ms| {
            calls_clone.lock().unwrap().push(ms);
            Box::pin(async {})
        });
        (sleep, calls)
    }

    /// Sleep that advances an injected clock (the TS `nowMs += ms` mock).
    fn advancing_clock() -> (NowFn, SleepFn, Arc<Mutex<Vec<i64>>>) {
        let now = Arc::new(AtomicI64::new(0));
        let calls: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::new()));
        let now_reader = Arc::clone(&now);
        let now_fn: NowFn = Arc::new(move || now_reader.load(Ordering::SeqCst));
        let calls_clone = Arc::clone(&calls);
        let sleep: SleepFn = Arc::new(move |ms| {
            now.fetch_add(ms, Ordering::SeqCst);
            calls_clone.lock().unwrap().push(ms);
            Box::pin(async {})
        });
        (now_fn, sleep, calls)
    }

    fn recording_log() -> (LogFn, Arc<Mutex<Vec<String>>>) {
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let lines_clone = Arc::clone(&lines);
        let log: LogFn = Arc::new(move |message| {
            lines_clone.lock().unwrap().push(message.to_string());
        });
        (log, lines)
    }

    fn sample_device_code(interval_ms: i64, expires_at_ms: Option<i64>) -> DeviceAuthCode {
        DeviceAuthCode {
            verification_url: DEVICE_AUTH_VERIFICATION_URL.to_string(),
            user_code: "ABCD-1234".to_string(),
            device_auth_id: "device-auth-1".to_string(),
            interval_ms,
            expires_at_ms,
        }
    }

    async fn mount_usercode(server: &MockServer, body: Value) {
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/usercode"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(server)
            .await;
    }

    #[test]
    fn date_parser_pins() {
        assert_eq!(js_date_parse_ms("2026-04-26T00:00:00Z"), Some(T_2026_04_26));
        assert_eq!(
            js_date_parse_ms("2026-05-15T12:00:00Z"),
            Some(T_2026_05_15_NOON)
        );
        assert_eq!(
            js_date_parse_ms("Sun, 26 Apr 2026 00:00:04 GMT"),
            Some(T_2026_04_26 + 4_000)
        );
        assert_eq!(js_date_parse_ms("not-a-date"), None);
    }

    #[tokio::test]
    async fn requests_user_code_and_parses_string_interval_and_iso_expiry() {
        let now_ms = T_2026_04_26;
        let expires_at_ms = now_ms + 15 * 60 * 1000;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/usercode"))
            .and(header("Content-Type", "application/json"))
            .and(body_json(
                json!({ "client_id": "app_EMoamEEZ73f0CkXaXp7hrann" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "device_auth_id": "device-auth-1",
                "user_code": "ABCD-1234",
                "interval": "7.5",
                "expires_at": "2026-04-26T00:15:00.000Z",
            })))
            .expect(1)
            .mount(&server)
            .await;

        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            now: Some(fixed_now(now_ms)),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        assert_eq!(
            result.as_success(),
            Some(&DeviceAuthCode {
                verification_url: DEVICE_AUTH_VERIFICATION_URL.to_string(),
                user_code: "ABCD-1234".to_string(),
                device_auth_id: "device-auth-1".to_string(),
                interval_ms: 7_500,
                expires_at_ms: Some(expires_at_ms),
            })
        );
    }

    #[tokio::test]
    async fn accepts_usercode_alias_and_numeric_interval() {
        let server = MockServer::start().await;
        mount_usercode(
            &server,
            json!({ "device_auth_id": "device-auth-2", "usercode": "WXYZ-9876", "interval": 3 }),
        )
        .await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        let device_code = result.as_success().expect("success");
        assert_eq!(device_code.user_code, "WXYZ-9876");
        assert_eq!(device_code.device_auth_id, "device-auth-2");
        assert_eq!(device_code.interval_ms, 3_000);
        assert_eq!(device_code.expires_at_ms, None);
    }

    #[tokio::test]
    async fn parses_expires_at_as_epoch_seconds_absolute() {
        let now_ms = T_2026_04_26;
        let expires_at_seconds = T_2026_05_15_NOON / 1000;
        let server = MockServer::start().await;
        mount_usercode(
            &server,
            json!({
                "device_auth_id": "d",
                "user_code": "ABCD-1111",
                "interval": 5,
                "expires_at": expires_at_seconds,
            }),
        )
        .await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            now: Some(fixed_now(now_ms)),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        assert_eq!(
            result.as_success().unwrap().expires_at_ms,
            Some(expires_at_seconds * 1000)
        );
    }

    #[tokio::test]
    async fn parses_expires_at_as_epoch_ms_above_boundary() {
        let server = MockServer::start().await;
        mount_usercode(
            &server,
            json!({
                "device_auth_id": "d",
                "user_code": "ABCD-2222",
                "interval": 5,
                "expires_at": T_2026_05_15_NOON,
            }),
        )
        .await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            now: Some(fixed_now(T_2026_04_26)),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        assert_eq!(
            result.as_success().unwrap().expires_at_ms,
            Some(T_2026_05_15_NOON)
        );
    }

    #[tokio::test]
    async fn parses_expires_at_as_numeric_string_of_seconds() {
        let expires_at_seconds = T_2026_05_15_NOON / 1000;
        let server = MockServer::start().await;
        mount_usercode(
            &server,
            json!({
                "device_auth_id": "d",
                "user_code": "ABCD-3333",
                "interval": 5,
                "expires_at": expires_at_seconds.to_string(),
            }),
        )
        .await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            now: Some(fixed_now(T_2026_04_26)),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        assert_eq!(
            result.as_success().unwrap().expires_at_ms,
            Some(expires_at_seconds * 1000)
        );
    }

    #[tokio::test]
    async fn falls_back_to_expires_in_when_expires_at_unparseable() {
        let now_ms = T_2026_04_26;
        let server = MockServer::start().await;
        mount_usercode(
            &server,
            json!({
                "device_auth_id": "d",
                "user_code": "ABCD-4444",
                "interval": 5,
                "expires_at": "not-a-date",
                "expires_in": 600,
            }),
        )
        .await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            now: Some(fixed_now(now_ms)),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        assert_eq!(
            result.as_success().unwrap().expires_at_ms,
            Some(now_ms + 600_000)
        );
    }

    #[tokio::test]
    async fn usercode_404_is_terminal_with_clear_message() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/usercode"))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .mount(&server)
            .await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::HttpError));
        assert_eq!(failure.status_code, Some(404));
        assert_eq!(
            failure.message.as_deref(),
            Some(
                "Device auth login is not enabled for this Codex server. Use browser login or --manual."
            )
        );
    }

    #[tokio::test]
    async fn usercode_network_failure_is_network_error() {
        let options = DeviceAuthFlowOptions {
            base_url: Some("http://127.0.0.1:1".to_string()),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::NetworkError));
    }

    #[tokio::test]
    async fn pre_aborted_signal_skips_usercode_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/usercode"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let signal = AbortSignal::new();
        signal.abort();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            signal: Some(signal),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::NetworkError));
        assert_eq!(failure.message.as_deref(), Some("aborted"));
    }

    #[tokio::test]
    async fn usercode_fails_on_invalid_success_payload() {
        let server = MockServer::start().await;
        mount_usercode(&server, json!({ "user_code": "ABCD-1234", "interval": "5" })).await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::InvalidResponse));
        assert_eq!(
            failure.message.as_deref(),
            Some("Device code request response failed schema validation")
        );
    }

    #[tokio::test]
    async fn usercode_failures_are_sanitized() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/usercode"))
            .respond_with(ResponseTemplate::new(500).set_body_string("server unavailable"))
            .mount(&server)
            .await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            ..Default::default()
        };
        let result = request_device_authorization(&options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::HttpError));
        assert_eq!(failure.status_code, Some(500));
        assert_eq!(failure.message.as_deref(), Some("server unavailable"));
    }

    #[tokio::test]
    async fn treats_403_and_404_poll_responses_as_pending_before_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(403))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(404))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .and(body_json(json!({
                "device_auth_id": "device-auth-1",
                "user_code": "ABCD-1234",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "authorization_code": "authorization-code",
                "code_verifier": "code-verifier",
                "code_challenge": "code-challenge",
            })))
            .mount(&server)
            .await;

        let (sleep, calls) = recording_sleep();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            sleep: Some(sleep),
            ..Default::default()
        };
        let result = poll_device_authorization(&sample_device_code(2_000, None), &options).await;
        assert_eq!(
            result.as_success(),
            Some(&DeviceAuthCompletion {
                authorization_code: "authorization-code".to_string(),
                code_verifier: "code-verifier".to_string(),
            })
        );
        // 403/404 use the exact server interval — NO jitter.
        assert_eq!(*calls.lock().unwrap(), vec![2_000, 2_000]);
    }

    #[tokio::test]
    async fn honors_retry_after_seconds_for_429() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "7"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "authorization_code": "authorization-code",
                "code_verifier": "code-verifier",
            })))
            .mount(&server)
            .await;
        let (sleep, calls) = recording_sleep();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            sleep: Some(sleep),
            ..Default::default()
        };
        let result = poll_device_authorization(&sample_device_code(2_000, None), &options).await;
        assert!(result.as_success().is_some());
        assert_eq!(*calls.lock().unwrap(), vec![7_000]);
    }

    #[tokio::test]
    async fn honors_retry_after_http_dates_for_transient_statuses() {
        let now_ms = T_2026_04_26;
        // now + 4000 ms as an HTTP date (2026-04-26 is a Sunday).
        let retry_at = "Sun, 26 Apr 2026 00:00:04 GMT";
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(503).insert_header("Retry-After", retry_at))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "authorization_code": "authorization-code",
                "code_verifier": "code-verifier",
            })))
            .mount(&server)
            .await;
        let (sleep, calls) = recording_sleep();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            now: Some(fixed_now(now_ms)),
            sleep: Some(sleep),
            ..Default::default()
        };
        let result = poll_device_authorization(&sample_device_code(2_000, None), &options).await;
        assert!(result.as_success().is_some());
        assert_eq!(*calls.lock().unwrap(), vec![4_000]);
    }

    #[tokio::test]
    async fn falls_back_to_jittered_interval_for_429_without_retry_after() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(429))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "authorization_code": "authorization-code",
                "code_verifier": "code-verifier",
            })))
            .mount(&server)
            .await;
        let (sleep, calls) = recording_sleep();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            sleep: Some(sleep),
            // random() = 0.5 → jitter ratio exactly 1.0
            random: Some(Arc::new(|| 0.5)),
            ..Default::default()
        };
        let result = poll_device_authorization(&sample_device_code(3_000, None), &options).await;
        assert!(result.as_success().is_some());
        assert_eq!(*calls.lock().unwrap(), vec![3_000]);
    }

    #[tokio::test]
    async fn aborts_polling_without_issuing_another_token_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(403))
            .expect(1)
            .mount(&server)
            .await;
        let signal = AbortSignal::new();
        // Sleep never resolves on its own; the abort must win the race.
        let pending_sleep: SleepFn = Arc::new(|_| Box::pin(std::future::pending()));
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            signal: Some(Arc::clone(&signal)),
            sleep: Some(pending_sleep),
            timeout_ms: Some(10_000),
            ..Default::default()
        };
        let device_code = sample_device_code(5_000, None);
        let poll = tokio::spawn({
            let options = options.clone();
            async move { poll_device_authorization(&device_code, &options).await }
        });
        // Give the poll a moment to reach the sleep, then abort.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        signal.abort();
        let result = poll.await.unwrap();
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::NetworkError));
        assert_eq!(failure.message.as_deref(), Some("aborted"));
    }

    #[tokio::test]
    async fn uses_server_expiration_as_polling_deadline() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(403))
            .expect(3)
            .mount(&server)
            .await;
        let (now_fn, sleep, calls) = advancing_clock();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            now: Some(now_fn),
            sleep: Some(sleep),
            timeout_ms: Some(15_000),
            ..Default::default()
        };
        let result =
            poll_device_authorization(&sample_device_code(5_000, Some(6_000)), &options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::Timeout));
        assert_eq!(
            failure.message.as_deref(),
            Some("Device auth timed out after 6 seconds")
        );
        assert_eq!(*calls.lock().unwrap(), vec![5_000, 1_000]);
    }

    #[tokio::test]
    async fn times_out_after_configured_wait_budget() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(403))
            .expect(3)
            .mount(&server)
            .await;
        let (now_fn, sleep, calls) = advancing_clock();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            now: Some(now_fn),
            sleep: Some(sleep),
            timeout_ms: Some(10_000),
            ..Default::default()
        };
        let result = poll_device_authorization(&sample_device_code(5_000, None), &options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::Timeout));
        assert_eq!(
            failure.message.as_deref(),
            Some("Device auth timed out after 10 seconds")
        );
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn fails_polling_on_hard_non_pending_responses() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(400).set_body_string("bad request"))
            .mount(&server)
            .await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            ..Default::default()
        };
        let result = poll_device_authorization(&sample_device_code(5_000, None), &options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::HttpError));
        assert_eq!(failure.status_code, Some(400));
        assert_eq!(failure.message.as_deref(), Some("bad request"));
    }

    #[tokio::test]
    async fn fails_polling_on_invalid_completion_payloads() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "authorization_code": "missing-verifier" })),
            )
            .mount(&server)
            .await;
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            ..Default::default()
        };
        let result = poll_device_authorization(&sample_device_code(5_000, None), &options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::InvalidResponse));
        assert_eq!(
            failure.message.as_deref(),
            Some("Device auth token response failed schema validation")
        );
    }

    #[tokio::test]
    async fn exchanges_authorization_code_with_device_redirect_uri() {
        let now_ms = T_2026_04_26;
        let server = MockServer::start().await;
        mount_usercode(
            &server,
            json!({
                "device_auth_id": "device-auth-1",
                "user_code": "ABCD-1234",
                "interval": "1",
                "expires_in": "600",
            }),
        )
        .await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "authorization_code": "authorization-code",
                "code_verifier": "code-verifier",
                "code_challenge": "code-challenge",
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "access-token",
                "refresh_token": "refresh-token",
                "expires_in": 3600,
                "id_token": "id-token",
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (log, lines) = recording_log();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            token_url: Some(format!("{}/oauth/token", server.uri())),
            log: Some(log),
            now: Some(fixed_now(now_ms)),
            ..Default::default()
        };
        let result = run_device_auth_flow(&options).await;
        let success = result.as_success().expect("success");
        assert_eq!(success.access, "access-token");
        assert_eq!(success.refresh, "refresh-token");
        assert_eq!(success.id_token.as_deref(), Some("id-token"));
        assert_eq!(success.multi_account, Some(true));

        let lines = lines.lock().unwrap().clone();
        assert!(lines.contains(&"Device auth login".to_string()));
        assert!(lines.contains(&format!("Open: {DEVICE_AUTH_VERIFICATION_URL}")));
        assert!(lines.contains(&"Code: ABCD-1234".to_string()));
        assert!(lines.contains(&"This code expires in 10 minutes. Never share it.".to_string()));
        let joined = lines.join("\n");
        for secret in [
            "access-token",
            "refresh-token",
            "id-token",
            "code-verifier",
            "code_verifier",
        ] {
            assert!(!joined.contains(secret), "log leaked {secret}");
        }

        // The exchange used the DEVICE redirect URI (not localhost).
        let requests = server.received_requests().await.unwrap();
        let exchange = requests
            .iter()
            .find(|r| r.url.path() == "/oauth/token")
            .expect("token exchange request");
        let form: Vec<(String, String)> = url::form_urlencoded::parse(&exchange.body)
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let get = |key: &str| form.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        assert_eq!(get("grant_type").as_deref(), Some("authorization_code"));
        assert_eq!(
            get("client_id").as_deref(),
            Some("app_EMoamEEZ73f0CkXaXp7hrann")
        );
        assert_eq!(get("code").as_deref(), Some("authorization-code"));
        assert_eq!(get("code_verifier").as_deref(), Some("code-verifier"));
        assert_eq!(
            get("redirect_uri").as_deref(),
            Some(DEVICE_AUTH_REDIRECT_URI)
        );
    }

    #[tokio::test]
    async fn does_not_print_or_poll_when_aborted_after_usercode_response() {
        let server = MockServer::start().await;
        mount_usercode(
            &server,
            json!({ "device_auth_id": "device-auth-1", "user_code": "ABCD-1234", "interval": "1" }),
        )
        .await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(403))
            .expect(0)
            .mount(&server)
            .await;
        let signal = AbortSignal::new();
        // The TS test aborts from inside the fetch mock; here the injected
        // clock (called while parsing the usercode payload) trips the signal
        // after the request succeeded but before the abort check.
        let abort_now: NowFn = {
            let signal = Arc::clone(&signal);
            Arc::new(move || {
                signal.abort();
                0
            })
        };
        let (log, lines) = recording_log();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            signal: Some(signal),
            now: Some(abort_now),
            log: Some(log),
            ..Default::default()
        };
        let result = run_device_auth_flow(&options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::NetworkError));
        assert_eq!(failure.message.as_deref(), Some("aborted"));
        assert!(
            lines.lock().unwrap().is_empty(),
            "prompt must not print after abort"
        );
    }

    #[tokio::test]
    async fn does_not_leak_tokens_through_device_auth_logs_on_timeout() {
        let server = MockServer::start().await;
        mount_usercode(
            &server,
            json!({ "device_auth_id": "device-auth-1", "user_code": "ABCD-1234", "interval": "1" }),
        )
        .await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;
        let (now_fn, sleep, _calls) = advancing_clock();
        let (log, lines) = recording_log();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            now: Some(now_fn),
            sleep: Some(sleep),
            log: Some(log),
            timeout_ms: Some(2_000),
            ..Default::default()
        };
        let result = run_device_auth_flow(&options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::Timeout));
        assert_eq!(
            failure.message.as_deref(),
            Some("Device auth timed out after 2 seconds")
        );
        let joined = lines.lock().unwrap().join("\n");
        for secret in [
            "access-token",
            "refresh-token",
            "id-token",
            "code-verifier",
            "code_verifier",
        ] {
            assert!(!joined.contains(secret), "log leaked {secret}");
        }
    }

    #[tokio::test]
    async fn returns_token_exchange_failures_from_device_auth_flow() {
        let server = MockServer::start().await;
        mount_usercode(
            &server,
            json!({ "device_auth_id": "device-auth-1", "user_code": "ABCD-1234", "interval": "1" }),
        )
        .await;
        Mock::given(method("POST"))
            .and(path("/api/accounts/deviceauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "authorization_code": "authorization-code",
                "code_verifier": "code-verifier",
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(400).set_body_string("bad token"))
            .mount(&server)
            .await;
        let (log, lines) = recording_log();
        let options = DeviceAuthFlowOptions {
            base_url: Some(server.uri()),
            token_url: Some(format!("{}/oauth/token", server.uri())),
            log: Some(log),
            ..Default::default()
        };
        let result = run_device_auth_flow(&options).await;
        let failure = result.as_failure().expect("failed");
        assert_eq!(failure.reason, Some(TokenFailureReason::HttpError));
        assert_eq!(failure.status_code, Some(400));
        assert_eq!(failure.message.as_deref(), Some("bad token"));
        let joined = lines.lock().unwrap().join("\n");
        for secret in [
            "access-token",
            "refresh-token",
            "id-token",
            "code-verifier",
            "code_verifier",
        ] {
            assert!(!joined.contains(secret), "log leaked {secret}");
        }
    }

    #[test]
    fn format_wait_budget_matches_ts() {
        assert_eq!(format_wait_budget(500), "1 second");
        assert_eq!(format_wait_budget(1_000), "1 second");
        assert_eq!(format_wait_budget(6_000), "6 seconds");
        assert_eq!(format_wait_budget(59_000), "59 seconds");
        assert_eq!(format_wait_budget(60_000), "1 minute");
        assert_eq!(format_wait_budget(600_000), "10 minutes");
        assert_eq!(format_wait_budget(900_000), "15 minutes");
        assert_eq!(format_wait_budget(0), "1 second");
    }
}
