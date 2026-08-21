//! Port of `lib/prompts/fetch-utils.ts` — shared, hardened fetch helpers for
//! the GitHub-backed prompt fetchers (spec 06 / ARCHITECTURE §6.10).
//!
//! Both prompt sources (`prompts::codex` and `prompts::host_prompt`) pull
//! text over the network on a request-blocking path. These helpers add the
//! guards from the TS hardening pass (prompts-02/04/05/08):
//! - a bounded fetch timeout so a hung GitHub connection cannot stall the
//!   request pipeline indefinitely (prompts-02);
//! - a maximum response size, checked against `Content-Length` and enforced
//!   while reading, so a pathological body cannot exhaust memory (prompts-04);
//! - rejection of empty / whitespace-only 200 bodies so a bad response is not
//!   cached and served as "instructions" (prompts-05);
//! - a `User-Agent` (api.github.com rejects requests without one) plus a
//!   sensible `Accept`, applied to every request (prompts-08).
//!
//! Like the TS `fetchWithTimeout` AbortSignal, the fetch timeout here covers
//! connect+headers only (the send future); body reads are guarded separately
//! by per-chunk idle timeouts in [`read_body_text_guarded`] /
//! [`with_body_timeout`].

use std::fmt;
use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use futures::StreamExt;

pub(crate) const PROMPT_FETCH_TIMEOUT_MS: u64 = 10_000;
/// 1 MB ceiling for a prompt body.
pub const PROMPT_FETCH_MAX_BYTES: usize = 1_000_000;
const PROMPT_FETCH_USER_AGENT: &str = "codex-multi-auth";

/// Message-carrying error for the prompt fetch helpers. The TS threw plain
/// `Error`s; the message strings are frozen where noted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptFetchError(pub String);

impl PromptFetchError {
    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PromptFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PromptFetchError {}

/// TS `PromptFetchOptions`. `max_bytes` exists for interface parity but (as
/// in TS) is not consumed by [`fetch_with_timeout`] — pass it to
/// [`read_body_text_guarded`] instead.
#[derive(Clone, Debug, Default)]
pub struct PromptFetchOptions {
    pub headers: Vec<(String, String)>,
    pub timeout_ms: Option<u64>,
    pub max_bytes: Option<usize>,
    /// When true, also request GitHub's JSON API content type.
    pub json: bool,
}

fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .build()
            .expect("prompt fetch client")
    })
}

/// TS `withPromptFetchHeaders(headers, json)`.
///
/// Merges caller headers with the mandatory `User-Agent` / `Accept` defaults.
/// The mandatory headers are applied AFTER the caller's so they always win: a
/// caller must not be able to blank or replace them and bypass the hardening
/// (api.github.com rejects requests without a User-Agent). Caller headers are
/// still honored for everything else (e.g. `If-None-Match`).
pub fn with_prompt_fetch_headers(
    headers: &[(String, String)],
    json: bool,
) -> Vec<(String, String)> {
    let mut merged: Vec<(String, String)> = headers
        .iter()
        .filter(|(name, _)| {
            !name.eq_ignore_ascii_case("user-agent") && !name.eq_ignore_ascii_case("accept")
        })
        .cloned()
        .collect();
    merged.push(("User-Agent".to_string(), PROMPT_FETCH_USER_AGENT.to_string()));
    merged.push((
        "Accept".to_string(),
        if json {
            "application/vnd.github+json".to_string()
        } else {
            "text/plain, */*".to_string()
        },
    ));
    merged
}

/// TS `fetchWithTimeout(url, options)` — GET with a bounded timeout covering
/// connect+headers. Returns the `Response` (caller inspects status). Throws
/// on timeout/network error, matching native fetch rejection semantics.
/// Redirects are followed (the final URL is available via `response.url()`).
pub async fn fetch_with_timeout(
    url: &str,
    options: &PromptFetchOptions,
) -> Result<reqwest::Response, PromptFetchError> {
    let timeout_ms = options.timeout_ms.unwrap_or(PROMPT_FETCH_TIMEOUT_MS);
    let mut request = shared_client().get(url);
    for (name, value) in with_prompt_fetch_headers(&options.headers, options.json) {
        request = request.header(name, value);
    }
    match tokio::time::timeout(Duration::from_millis(timeout_ms), request.send()).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => Err(PromptFetchError(error.to_string())),
        Err(_elapsed) => Err(PromptFetchError(format!(
            "fetch timed out after {timeout_ms}ms"
        ))),
    }
}

/// TS `withBodyTimeout(response, read, timeoutMs?)` — race a response-body
/// read against a bounded timeout. `fetch_with_timeout`'s deadline only
/// covers connect+headers, so a server that sends headers then stalls
/// mid-body would otherwise hang a request-blocking path forever. Dropping
/// the losing read future tears down the underlying stream (the Rust
/// analogue of the TS `body.cancel()`).
pub async fn with_body_timeout<T, Fut>(
    read: Fut,
    timeout_ms: Option<u64>,
) -> Result<T, PromptFetchError>
where
    Fut: Future<Output = T>,
{
    let timeout_ms = timeout_ms.unwrap_or(PROMPT_FETCH_TIMEOUT_MS);
    match tokio::time::timeout(Duration::from_millis(timeout_ms), read).await {
        Ok(value) => Ok(value),
        Err(_elapsed) => Err(PromptFetchError(format!(
            "response body read timed out after {timeout_ms}ms"
        ))),
    }
}

/// TS `readBodyTextGuarded(response, maxBytes?, timeoutMs?)`.
///
/// Reads a response body as text with a size ceiling, rejecting empty bodies.
/// Checks `Content-Length` first (fast reject), then enforces the cap while
/// streaming so a server that omits/understates the header still cannot
/// exceed the limit. Each chunk read is raced against a per-chunk idle
/// timeout (prompts-02) — a chunk resets the budget; a quiet gap longer than
/// `timeout_ms` aborts. Frozen error messages:
/// - `"prompt body too large: Content-Length {n} exceeds {max}"`
/// - `"prompt body too large: exceeded {max} bytes"`
/// - `"prompt body read timed out after {ms}ms"`
/// - `"prompt body was empty"`
pub async fn read_body_text_guarded(
    response: reqwest::Response,
    max_bytes: Option<usize>,
    timeout_ms: Option<u64>,
) -> Result<String, PromptFetchError> {
    let max_bytes = max_bytes.unwrap_or(PROMPT_FETCH_MAX_BYTES);
    let timeout_ms = timeout_ms.unwrap_or(PROMPT_FETCH_TIMEOUT_MS);

    if let Some(declared) = response
        .headers()
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        && declared > max_bytes as u64
    {
        return Err(PromptFetchError(format!(
            "prompt body too large: Content-Length {declared} exceeds {max_bytes}"
        )));
    }

    let mut stream = response.bytes_stream();
    let mut chunks: Vec<u8> = Vec::new();
    loop {
        let next =
            match tokio::time::timeout(Duration::from_millis(timeout_ms), stream.next()).await {
                Ok(item) => item,
                Err(_elapsed) => {
                    return Err(PromptFetchError(format!(
                        "prompt body read timed out after {timeout_ms}ms"
                    )));
                }
            };
        match next {
            None => break,
            Some(Err(error)) => return Err(PromptFetchError(error.to_string())),
            Some(Ok(chunk)) => {
                if chunks.len() + chunk.len() > max_bytes {
                    return Err(PromptFetchError(format!(
                        "prompt body too large: exceeded {max_bytes} bytes"
                    )));
                }
                chunks.extend_from_slice(&chunk);
            }
        }
    }

    let text = String::from_utf8_lossy(&chunks).into_owned();
    if text.trim().is_empty() {
        return Err(PromptFetchError("prompt body was empty".to_string()));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn mandatory_headers_always_win() {
        let merged = with_prompt_fetch_headers(
            &[
                ("User-Agent".to_string(), "evil".to_string()),
                ("accept".to_string(), "nope".to_string()),
                ("If-None-Match".to_string(), "\"etag\"".to_string()),
            ],
            false,
        );
        let ua: Vec<_> = merged
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case("user-agent"))
            .collect();
        assert_eq!(ua, vec![&("User-Agent".to_string(), "codex-multi-auth".to_string())]);
        let accept: Vec<_> = merged
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case("accept"))
            .collect();
        assert_eq!(accept.len(), 1);
        assert_eq!(accept[0].1, "text/plain, */*");
        assert!(merged
            .iter()
            .any(|(n, v)| n == "If-None-Match" && v == "\"etag\""));
    }

    #[test]
    fn json_mode_requests_the_github_api_content_type() {
        let merged = with_prompt_fetch_headers(&[], true);
        assert!(merged
            .iter()
            .any(|(n, v)| n == "Accept" && v == "application/vnd.github+json"));
    }

    #[tokio::test]
    async fn fetch_sends_user_agent_and_reads_bodies() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/prompt.txt"))
            .and(header("user-agent", "codex-multi-auth"))
            .respond_with(ResponseTemplate::new(200).set_body_string("hello prompt"))
            .expect(1)
            .mount(&server)
            .await;

        let response = fetch_with_timeout(
            &format!("{}/prompt.txt", server.uri()),
            &PromptFetchOptions::default(),
        )
        .await
        .expect("fetch ok");
        assert_eq!(response.status(), 200);
        let text = read_body_text_guarded(response, None, None)
            .await
            .expect("body ok");
        assert_eq!(text, "hello prompt");
    }

    #[tokio::test]
    async fn rejects_oversize_bodies_while_streaming() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/big"))
            .respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(64)))
            .mount(&server)
            .await;

        let response = fetch_with_timeout(
            &format!("{}/big", server.uri()),
            &PromptFetchOptions::default(),
        )
        .await
        .expect("fetch ok");
        let err = read_body_text_guarded(response, Some(16), None)
            .await
            .expect_err("oversize");
        // Content-Length fast-reject fires first when the header is present.
        assert!(
            err.message() == "prompt body too large: Content-Length 64 exceeds 16"
                || err.message() == "prompt body too large: exceeded 16 bytes",
            "unexpected: {err}"
        );
    }

    #[tokio::test]
    async fn rejects_empty_and_whitespace_only_bodies() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/empty"))
            .respond_with(ResponseTemplate::new(200).set_body_string("   \n  "))
            .mount(&server)
            .await;

        let response = fetch_with_timeout(
            &format!("{}/empty", server.uri()),
            &PromptFetchOptions::default(),
        )
        .await
        .expect("fetch ok");
        let err = read_body_text_guarded(response, None, None)
            .await
            .expect_err("empty body");
        assert_eq!(err.message(), "prompt body was empty");
    }

    #[tokio::test]
    async fn fetch_times_out_against_unresponsive_servers() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/slow"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
            .mount(&server)
            .await;

        let err = fetch_with_timeout(
            &format!("{}/slow", server.uri()),
            &PromptFetchOptions {
                timeout_ms: Some(50),
                ..Default::default()
            },
        )
        .await
        .expect_err("timeout");
        assert_eq!(err.message(), "fetch timed out after 50ms");
    }

    #[tokio::test]
    async fn with_body_timeout_rejects_stalled_reads() {
        let err = with_body_timeout(std::future::pending::<String>(), Some(20))
            .await
            .expect_err("stalled");
        assert_eq!(err.message(), "response body read timed out after 20ms");

        let ok = with_body_timeout(async { 7usize }, Some(1_000)).await;
        assert_eq!(ok, Ok(7));
    }
}
