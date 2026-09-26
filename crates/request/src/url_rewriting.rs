//! Port of `lib/request/url-rewriting.ts` — URL rewrite & proxy resolution.
//!
//! Behavior source: spec 06 §9 + the TS source (authority).
//!
//! Proxy transport mapping: the TS module caches undici `ProxyAgent`
//! dispatchers per proxy URL and attaches them to `RequestInit`. reqwest
//! attaches proxies at `Client` build time, so the Rust analogue caches one
//! `reqwest::Client` per proxy URL ([`resolve_client_for_request`]) and falls
//! back to the shared proxy-free client from `fetch_helpers`
//! (ARCHITECTURE §5.1: explicit `reqwest::Proxy` wiring lives here).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use cma_core::constants::{CODEX_BASE_URL, URL_PATHS};
use cma_core::logger::log_warn;
use serde_json::json;
use url::Url;

use crate::request_init::FetchInput;

fn codex_base_url() -> &'static Url {
    static BASE: OnceLock<Url> = OnceLock::new();
    BASE.get_or_init(|| Url::parse(CODEX_BASE_URL).expect("CODEX_BASE_URL must parse"))
}

/// `/backend-api` — the Codex base path with any trailing slash stripped.
fn codex_base_path_prefix() -> &'static str {
    static PREFIX: OnceLock<String> = OnceLock::new();
    PREFIX.get_or_init(|| {
        let path = codex_base_url().path();
        path.strip_suffix('/').unwrap_or(path).to_string()
    })
}

/// Environment snapshot used for proxy resolution. The TS module reads
/// `process.env` (own-key semantics); tests pass explicit maps.
pub type EnvMap = HashMap<String, String>;

/// Snapshot the process environment (exact key case, one entry per var).
pub fn process_env_map() -> EnvMap {
    std::env::vars().collect()
}

/// TS `extractRequestUrl(input)` — URL string from any fetch input shape.
pub fn extract_request_url(input: &FetchInput<'_>) -> String {
    match input {
        FetchInput::Url(text) => (*text).to_string(),
        FetchInput::Parsed(url) => url.to_string(),
        FetchInput::Request(request) => request.url.clone(),
    }
}

/// TS `rewriteUrlForCodex(url)`.
///
/// - `/responses` (first occurrence in the path) → `/codex/responses`;
/// - path is prefixed with `/backend-api` unless it already equals/starts
///   with it;
/// - protocol+host are forced to `https://chatgpt.com` (no port), userinfo is
///   cleared; query/fragment survive.
///
/// Invalid URLs error (the TS version throws `TypeError`).
pub fn rewrite_url_for_codex(url: &str) -> Result<String, url::ParseError> {
    let mut parsed = Url::parse(url)?;
    let base = codex_base_url();

    let path = parsed.path().to_string();
    let rewritten = if path.contains(URL_PATHS.responses) {
        path.replacen(URL_PATHS.responses, URL_PATHS.codex_responses, 1)
    } else {
        path
    };
    let prefix = codex_base_path_prefix();
    let normalized = if rewritten == prefix || rewritten.starts_with(&format!("{prefix}/")) {
        rewritten
    } else if rewritten.starts_with('/') {
        format!("{prefix}{rewritten}")
    } else {
        format!("{prefix}/{rewritten}")
    };

    // Assignment order mirrors the TS property writes; none of these can fail
    // for an http(s) URL rewritten onto the https Codex origin.
    let _ = parsed.set_scheme(base.scheme());
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    let _ = parsed.set_host(base.host_str());
    let _ = parsed.set_port(base.port());
    parsed.set_path(&normalized);

    Ok(parsed.to_string())
}

/// Own-key env resolution (spec 06 §24): when the lowercase key EXISTS its
/// trimmed value wins — an empty value disables the variable entirely with NO
/// fallback to the uppercase key. Otherwise the uppercase key's trimmed value
/// is used (empty → `None`).
fn resolve_proxy_env_value(env: &EnvMap, lower_key: &str, upper_key: &str) -> Option<String> {
    if let Some(value) = env.get(lower_key) {
        let trimmed = value.trim();
        return if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
    env.get(upper_key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

struct NoProxyEntry {
    hostname: String,
    port: u32,
}

fn parse_no_proxy_entries(no_proxy_value: &str) -> Vec<NoProxyEntry> {
    no_proxy_value
        .split([',', ' ', '\t', '\n', '\r', '\u{0c}', '\u{0b}'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            // TS `/^(.+):(\d+)$/` — greedy host capture, trailing digit port.
            if let Some(idx) = entry.rfind(':') {
                let (host, port_text) = (&entry[..idx], &entry[idx + 1..]);
                if !host.is_empty()
                    && !port_text.is_empty()
                    && port_text.bytes().all(|b| b.is_ascii_digit())
                {
                    return NoProxyEntry {
                        hostname: host.to_lowercase(),
                        port: port_text.parse().unwrap_or(0),
                    };
                }
            }
            NoProxyEntry {
                hostname: entry.to_lowercase(),
                port: 0,
            }
        })
        .collect()
}

fn should_bypass_proxy_for_url(url: &Url, no_proxy_value: Option<&str>) -> bool {
    let Some(no_proxy_value) = no_proxy_value else {
        return false;
    };
    if no_proxy_value == "*" {
        return true;
    }

    let hostname = url.host_str().unwrap_or("").to_lowercase();
    let port: u32 = url
        .port()
        .map(u32::from)
        .or_else(|| match url.scheme() {
            "http" => Some(80),
            "https" => Some(443),
            _ => None,
        })
        .unwrap_or(0);

    for entry in parse_no_proxy_entries(no_proxy_value) {
        if entry.hostname == "*" {
            return true;
        }
        if entry.port != 0 && entry.port != port {
            continue;
        }

        if !entry.hostname.starts_with('.') && !entry.hostname.starts_with('*') {
            if hostname == entry.hostname {
                return true;
            }
            continue;
        }

        let suffix = entry.hostname.strip_prefix('*').unwrap_or(&entry.hostname);
        if hostname.ends_with(suffix) {
            return true;
        }
    }

    false
}

/// TS `resolveProxyUrlForRequest(url, env)` — proxy URL for the request, or
/// `None` (direct). Invalid URLs resolve to `None` (the TS version throws;
/// callers only pass URLs that already survived `rewriteUrlForCodex`).
pub fn resolve_proxy_url_for_request(url: &str, env: &EnvMap) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }

    let http_proxy = resolve_proxy_env_value(env, "http_proxy", "HTTP_PROXY");
    let https_proxy = resolve_proxy_env_value(env, "https_proxy", "HTTPS_PROXY");
    if http_proxy.is_none() && https_proxy.is_none() {
        return None;
    }

    let no_proxy = resolve_proxy_env_value(env, "no_proxy", "NO_PROXY");
    if should_bypass_proxy_for_url(&parsed, no_proxy.as_deref()) {
        return None;
    }

    if parsed.scheme() == "https" {
        https_proxy.or(http_proxy)
    } else {
        http_proxy
    }
}

fn shared_proxy_clients() -> &'static Mutex<HashMap<String, reqwest::Client>> {
    static CLIENTS: OnceLock<Mutex<HashMap<String, reqwest::Client>>> = OnceLock::new();
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Shared-dispatcher analogue: one proxied `reqwest::Client` per proxy URL.
/// Returns `None` when the proxy client cannot be built (invalid proxy URL) —
/// the caller falls back to the direct shared client with a warning.
fn get_shared_proxy_client(proxy_url: &str) -> Option<reqwest::Client> {
    let mut clients = shared_proxy_clients()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = clients.get(proxy_url) {
        return Some(existing.clone());
    }

    let proxy = match reqwest::Proxy::all(proxy_url) {
        Ok(proxy) => proxy,
        Err(error) => {
            log_warn(
                "Failed to configure proxy transport; using direct connection",
                Some(&json!({ "proxyUrl": proxy_url, "error": error.to_string() })),
            );
            return None;
        }
    };
    let client = match reqwest::Client::builder().proxy(proxy).build() {
        Ok(client) => client,
        Err(error) => {
            log_warn(
                "Failed to configure proxy transport; using direct connection",
                Some(&json!({ "proxyUrl": proxy_url, "error": error.to_string() })),
            );
            return None;
        }
    };
    clients.insert(proxy_url.to_string(), client.clone());
    Some(client)
}

/// TS `closeSharedProxyDispatchers()` — drains the cache in a loop so entries
/// added re-entrantly while draining are also dropped. Dropped clients close
/// their pooled connections when the last handle goes away.
pub async fn close_shared_proxy_dispatchers() {
    loop {
        let drained: Vec<reqwest::Client> = {
            let mut clients = shared_proxy_clients()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if clients.is_empty() {
                return;
            }
            clients.drain().map(|(_, client)| client).collect()
        };
        drop(drained);
    }
}

/// TS `applyProxyCompatibleInit` analogue: the HTTP client to use for the
/// request — a cached proxied client when proxy env applies, else the shared
/// direct client from `fetch_helpers`. (`reqwest::Client` clones share the
/// underlying pool.)
pub fn resolve_client_for_request(url: &str, env: &EnvMap) -> reqwest::Client {
    match resolve_proxy_url_for_request(url, env) {
        Some(proxy_url) => get_shared_proxy_client(&proxy_url)
            .unwrap_or_else(|| crate::fetch_helpers::shared_client().clone()),
        None => crate::fetch_helpers::shared_client().clone(),
    }
}

/// Register the dispatcher-drain with the process shutdown registry (the TS
/// module does this at import time; Rust callers invoke it once from the
/// pipeline bootstrap).
pub fn register_proxy_dispatcher_cleanup() -> cma_core::shutdown::CleanupHandle {
    cma_core::shutdown::register_cleanup(close_shared_proxy_dispatchers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> EnvMap {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn extracts_url_from_each_input_shape() {
        assert_eq!(
            extract_request_url(&FetchInput::Url("https://example.com/test")),
            "https://example.com/test"
        );
        let url = Url::parse("https://example.com/test").unwrap();
        assert_eq!(
            extract_request_url(&FetchInput::Parsed(&url)),
            "https://example.com/test"
        );
        let request = crate::request_init::NormalizedRequest {
            url: "https://example.com/test".into(),
            method: "GET".into(),
            headers: http::HeaderMap::new(),
            body: None,
        };
        assert_eq!(
            extract_request_url(&FetchInput::Request(&request)),
            "https://example.com/test"
        );
    }

    #[test]
    fn rewrites_responses_to_codex_responses() {
        assert_eq!(
            rewrite_url_for_codex("https://chatgpt.com/backend-api/responses").unwrap(),
            "https://chatgpt.com/backend-api/codex/responses"
        );
    }

    #[test]
    fn preserves_response_subresource_paths() {
        assert_eq!(
            rewrite_url_for_codex("https://api.openai.com/v1/responses/resp_123").unwrap(),
            "https://chatgpt.com/backend-api/v1/codex/responses/resp_123"
        );
        assert_eq!(
            rewrite_url_for_codex("https://api.openai.com/v1/responses/resp_123/cancel").unwrap(),
            "https://chatgpt.com/backend-api/v1/codex/responses/resp_123/cancel"
        );
    }

    #[test]
    fn keeps_backend_api_paths_on_codex_origin() {
        let url = "https://chatgpt.com/backend-api/other";
        assert_eq!(rewrite_url_for_codex(url).unwrap(), url);
    }

    #[test]
    fn forces_codex_origin_and_preserves_query_params() {
        assert_eq!(
            rewrite_url_for_codex("https://example.com/backend-api/responses?foo=bar").unwrap(),
            "https://chatgpt.com/backend-api/codex/responses?foo=bar"
        );
    }

    #[test]
    fn prefixes_backend_api_when_path_is_outside_backend_api() {
        assert_eq!(
            rewrite_url_for_codex("https://chatgpt.com/v1/other").unwrap(),
            format!("{CODEX_BASE_URL}/v1/other")
        );
    }

    #[test]
    fn clears_userinfo_and_upgrades_scheme() {
        assert_eq!(
            rewrite_url_for_codex("http://user:pass@example.com/backend-api/responses").unwrap(),
            "https://chatgpt.com/backend-api/codex/responses"
        );
    }

    #[test]
    fn errors_for_invalid_url_input() {
        assert!(rewrite_url_for_codex("not-a-valid-url").is_err());
    }

    #[test]
    fn prefers_lowercase_proxy_env_values_over_uppercase() {
        let env = env(&[
            ("HTTPS_PROXY", "http://uppercase-proxy:8080"),
            ("https_proxy", "http://lowercase-proxy:8080"),
        ]);
        assert_eq!(
            resolve_proxy_url_for_request("https://api.openai.com/v1/chat", &env).as_deref(),
            Some("http://lowercase-proxy:8080")
        );
    }

    #[test]
    fn empty_lowercase_key_disables_without_uppercase_fallback() {
        // Spec 06 gotcha 19.
        let env = env(&[
            ("HTTPS_PROXY", "http://uppercase-proxy:8080"),
            ("https_proxy", "   "),
        ]);
        assert_eq!(
            resolve_proxy_url_for_request("https://api.openai.com/v1/chat", &env),
            None
        );
    }

    #[test]
    fn falls_back_to_http_proxy_for_https_requests() {
        let env = env(&[("HTTP_PROXY", "http://shared-proxy:8080")]);
        assert_eq!(
            resolve_proxy_url_for_request("https://api.openai.com/v1/chat", &env).as_deref(),
            Some("http://shared-proxy:8080")
        );
    }

    #[test]
    fn http_requests_never_use_https_proxy() {
        let env = env(&[("HTTPS_PROXY", "http://https-only-proxy:8080")]);
        assert_eq!(
            resolve_proxy_url_for_request("http://api.openai.com/v1/chat", &env),
            None
        );
    }

    #[test]
    fn http_requests_prefer_http_proxy_when_both_are_set() {
        let env = env(&[
            ("HTTP_PROXY", "http://http-proxy:8080"),
            ("HTTPS_PROXY", "http://https-proxy:8080"),
        ]);
        assert_eq!(
            resolve_proxy_url_for_request("http://api.openai.com/v1/chat", &env).as_deref(),
            Some("http://http-proxy:8080")
        );
    }

    #[test]
    fn bypasses_proxy_when_no_proxy_matches_host() {
        let env = env(&[
            ("HTTPS_PROXY", "http://proxy.example:8080"),
            ("NO_PROXY", "api.openai.com,.internal.example"),
        ]);
        assert_eq!(
            resolve_proxy_url_for_request("https://api.openai.com/v1/chat", &env),
            None
        );
        assert_eq!(
            resolve_proxy_url_for_request("https://service.internal.example/v1/chat", &env),
            None
        );
    }

    #[test]
    fn wildcard_entries_inside_no_proxy_lists_bypass_everything() {
        let env = env(&[
            ("HTTPS_PROXY", "http://proxy.example:8080"),
            ("NO_PROXY", "api.openai.com,*,.internal.example"),
        ]);
        assert_eq!(
            resolve_proxy_url_for_request("https://unlisted.example/v1/chat", &env),
            None
        );
    }

    #[test]
    fn no_proxy_port_entries_only_match_that_port() {
        let env = env(&[
            ("HTTPS_PROXY", "http://proxy.example:8080"),
            ("NO_PROXY", "api.openai.com:8443"),
        ]);
        // Default https port 443 ≠ 8443 → still proxied.
        assert_eq!(
            resolve_proxy_url_for_request("https://api.openai.com/v1/chat", &env).as_deref(),
            Some("http://proxy.example:8080")
        );
        assert_eq!(
            resolve_proxy_url_for_request("https://api.openai.com:8443/v1/chat", &env),
            None
        );
    }

    #[test]
    fn star_prefixed_no_proxy_entries_are_suffix_matchers() {
        let env = env(&[
            ("HTTPS_PROXY", "http://proxy.example:8080"),
            ("NO_PROXY", "*.internal.example"),
        ]);
        assert_eq!(
            resolve_proxy_url_for_request("https://svc.internal.example/x", &env),
            None
        );
        assert_eq!(
            resolve_proxy_url_for_request("https://api.openai.com/x", &env).as_deref(),
            Some("http://proxy.example:8080")
        );
    }

    #[test]
    fn non_http_schemes_resolve_to_no_proxy() {
        let env = env(&[("HTTPS_PROXY", "http://proxy.example:8080")]);
        assert_eq!(resolve_proxy_url_for_request("file:///tmp/x", &env), None);
    }

    #[tokio::test]
    async fn caches_proxy_clients_and_recreates_after_cleanup() {
        close_shared_proxy_dispatchers().await;
        let first = get_shared_proxy_client("http://proxy.example:8080").unwrap();
        let _again = get_shared_proxy_client("http://proxy.example:8080").unwrap();
        {
            let clients = shared_proxy_clients().lock().unwrap();
            assert_eq!(clients.len(), 1);
        }
        drop(first);
        close_shared_proxy_dispatchers().await;
        {
            let clients = shared_proxy_clients().lock().unwrap();
            assert!(clients.is_empty());
        }
        let recreated = get_shared_proxy_client("http://proxy.example:8080");
        assert!(recreated.is_some());
        close_shared_proxy_dispatchers().await;
    }

    #[test]
    fn invalid_proxy_urls_fall_back_to_none() {
        assert!(get_shared_proxy_client("::not-a-proxy::").is_none());
    }
}
