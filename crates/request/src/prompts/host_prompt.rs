//! Port of `lib/prompts/host-codex-prompt.ts` — the sst/opencode `codex.txt`
//! host-prompt cache (spec 06 / ARCHITECTURE §6.10).
//!
//! Fetches and caches the `codex.txt` system prompt from upstream GitHub
//! sources with ETag-based conditional requests, a 15-minute TTL,
//! stale-while-revalidate, an env-var source override, and a one-time
//! migration of the two legacy cache file pairs.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::SecondsFormat;
use cma_core::fs_retry::{Backoff, RetryOptions, with_retry};
use cma_core::json_io::stringify_pretty2;
use cma_core::logger::log_debug;
use cma_core::runtime_paths::get_codex_cache_dir;
use cma_core::temp_path::temp_file_nonce;
use cma_core::utils::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::fetch_utils::{PromptFetchOptions, fetch_with_timeout, read_body_text_guarded};

/// Canonical upstream is sst/opencode; only the `dev` branch `codex.txt` is
/// known-good (verified 2026-05-31) — `main` is kept as a cheap self-healing
/// fallback in case the branch layout changes upstream.
const DEFAULT_HOST_CODEX_PROMPT_URLS: [&str; 2] = [
    "https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/session/prompt/codex.txt",
    "https://raw.githubusercontent.com/sst/opencode/main/packages/opencode/src/session/prompt/codex.txt",
];
const CODEX_PROMPT_URL_OVERRIDE_ENV: &str = "CODEX_PROMPT_SOURCE_URL";
const LEGACY_HOST_CODEX_URL_OVERRIDE_ENV: &str = "CODEX_CODEX_PROMPT_URL";
const CACHE_FILE_NAME: &str = "host-codex-prompt.txt";
const CACHE_META_FILE_NAME: &str = "host-codex-prompt-meta.json";
/// Legacy cache file pairs, migrated to the current names on first read.
const LEGACY_CACHE_FILES: [(&str, &str); 2] = [
    ("opencode-codex-prompt.txt", "opencode-codex-prompt-meta.json"),
    ("codex-prompt.txt", "codex-prompt-meta.json"),
];
const CACHE_TTL_MS: i64 = 15 * 60 * 1000;
const RETRYABLE_FS_ERROR_CODES: [&str; 2] = ["EBUSY", "EPERM"];
const WRITE_RETRY_ATTEMPTS: u32 = 5;
const WRITE_RETRY_BASE_DELAY_MS: u64 = 10;

/// TS `CacheMeta` — the on-disk meta shape (2-space pretty JSON, no trailing
/// newline). `lastFetch` / `sourceUrl` are legacy fields kept for
/// compatibility reads; serde field order = TS write order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostPromptCacheMeta {
    /// Tolerant read: a legacy meta without `etag` becomes `""` (falsy in the
    /// TS conditional-request gate).
    #[serde(default)]
    pub etag: String,
    /// Legacy field for backwards compatibility.
    #[serde(rename = "lastFetch", default, skip_serializing_if = "Option::is_none")]
    pub last_fetch: Option<String>,
    /// Timestamp for rate-limit protection; `0` (or absent) invalidates the
    /// snapshot on read, matching the TS truthiness check.
    #[serde(rename = "lastChecked", default)]
    pub last_checked: i64,
    #[serde(rename = "sourceKey", default, skip_serializing_if = "Option::is_none")]
    pub source_key: Option<String>,
    /// Legacy field kept for compatibility reads.
    #[serde(rename = "sourceUrl", default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

#[derive(Clone, Debug)]
struct CacheSnapshot {
    content: String,
    meta: HostPromptCacheMeta,
}

static MEMORY_CACHE: Mutex<Option<CacheSnapshot>> = Mutex::new(None);
static REFRESH_IN_FLIGHT: Mutex<bool> = Mutex::new(false);
#[cfg(test)]
static DEFAULT_SOURCES_OVERRIDE: Mutex<Option<Vec<String>>> = Mutex::new(None);

/// Reset the in-process caches (memory snapshot + refresh flag) for tests.
pub fn reset_host_prompt_cache_for_testing() {
    *MEMORY_CACHE.lock().expect("host prompt cache poisoned") = None;
    *REFRESH_IN_FLIGHT.lock().expect("refresh flag poisoned") = false;
    #[cfg(test)]
    {
        *DEFAULT_SOURCES_OVERRIDE
            .lock()
            .expect("default sources poisoned") = None;
    }
}

#[cfg(test)]
fn set_default_sources_for_testing(sources: Vec<String>) {
    *DEFAULT_SOURCES_OVERRIDE
        .lock()
        .expect("default sources poisoned") = Some(sources);
}

fn default_sources() -> Vec<String> {
    #[cfg(test)]
    if let Some(overridden) = DEFAULT_SOURCES_OVERRIDE
        .lock()
        .expect("default sources poisoned")
        .clone()
    {
        return overridden;
    }
    DEFAULT_HOST_CODEX_PROMPT_URLS
        .iter()
        .map(|url| url.to_string())
        .collect()
}

fn cache_file_path() -> PathBuf {
    get_codex_cache_dir().join(CACHE_FILE_NAME)
}

fn cache_meta_file_path() -> PathBuf {
    get_codex_cache_dir().join(CACHE_META_FILE_NAME)
}

fn is_fresh(last_checked: i64) -> bool {
    now_ms() - last_checked < CACHE_TTL_MS
}

/// TS `redactSourceForLog` — origin + pathname (no query/credentials);
/// invalid URLs become `"<invalid-url>"`.
fn redact_source_for_log(source: &str) -> String {
    match url::Url::parse(source) {
        Ok(parsed) => format!("{}{}", parsed.origin().ascii_serialization(), parsed.path()),
        Err(_) => "<invalid-url>".to_string(),
    }
}

/// TS `parseSourceUrl` — trimmed, must parse as an http(s) URL; anything else
/// is ignored with a debug log.
fn parse_source_url(source: Option<&str>) -> Option<String> {
    let trimmed = source?.trim();
    if trimmed.is_empty() {
        return None;
    }
    match url::Url::parse(trimmed) {
        Ok(parsed) => {
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                log_debug(
                    "Ignoring codex prompt source override due to protocol",
                    Some(&json!({ "source": redact_source_for_log(trimmed) })),
                );
                return None;
            }
            Some(trimmed.to_string())
        }
        Err(_) => {
            log_debug(
                "Ignoring invalid codex prompt source override",
                Some(&json!({ "source": redact_source_for_log(trimmed) })),
            );
            None
        }
    }
}

/// TS `sourceCacheKey` — origin + pathname; unparseable sources fall back to
/// the trimmed raw string.
fn source_cache_key(source: &str) -> String {
    match url::Url::parse(source) {
        Ok(parsed) => format!("{}{}", parsed.origin().ascii_serialization(), parsed.path()),
        Err(_) => source.trim().to_string(),
    }
}

/// TS `resolvePromptSources` — env override first (current then legacy env
/// name), then the defaults, deduped.
fn resolve_prompt_sources() -> Vec<String> {
    let mut sources: Vec<String> = Vec::new();
    let mut add = |candidate: Option<String>| {
        if let Some(parsed) = parse_source_url(candidate.as_deref())
            && !sources.contains(&parsed)
        {
            sources.push(parsed);
        }
    };
    add(std::env::var(CODEX_PROMPT_URL_OVERRIDE_ENV).ok());
    add(std::env::var(LEGACY_HOST_CODEX_URL_OVERRIDE_ENV).ok());
    for source in default_sources() {
        add(Some(source));
    }
    sources
}

fn write_retry_options() -> RetryOptions<std::io::Error> {
    RetryOptions::new(
        WRITE_RETRY_ATTEMPTS,
        Backoff::from_fn(|failed_attempt| {
            WRITE_RETRY_BASE_DELAY_MS
                .saturating_mul(2u64.saturating_pow(failed_attempt.saturating_sub(1)))
        }),
    )
    .with_codes(&RETRYABLE_FS_ERROR_CODES)
}

/// TS `writeFileWithRetry` — EBUSY/EPERM x5, 10 ms doubling backoff.
async fn write_file_with_retry(file_path: &Path, content: &str) -> Result<(), std::io::Error> {
    with_retry(
        || tokio::fs::write(file_path, content.as_bytes()),
        write_retry_options(),
    )
    .await
}

/// TS `renameWithRetry` — same retry policy as writes.
async fn rename_with_retry(from_path: &Path, to_path: &Path) -> Result<(), std::io::Error> {
    with_retry(
        || tokio::fs::rename(from_path, to_path),
        write_retry_options(),
    )
    .await
}

/// TS `removeFileQuietly` — best-effort cleanup only.
async fn remove_file_quietly(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}

/// TS `writeCacheFilesAtomically` — temp-sibling writes, content rename
/// before meta rename, partial-rename recovery by rewriting the content file,
/// temp cleanup on failure.
async fn write_cache_files_atomically(
    content: &str,
    meta: &HostPromptCacheMeta,
) -> Result<(), std::io::Error> {
    let cache_dir = get_codex_cache_dir();
    tokio::fs::create_dir_all(&cache_dir).await?;

    let cache_file = cache_file_path();
    let cache_meta_file = cache_meta_file_path();
    let nonce = temp_file_nonce();
    let content_tmp = PathBuf::from(format!("{}.{nonce}.tmp", cache_file.display()));
    let meta_tmp = PathBuf::from(format!("{}.{nonce}.tmp", cache_meta_file.display()));
    let meta_json = stringify_pretty2(meta);

    write_file_with_retry(&content_tmp, content).await?;
    if let Err(error) = write_file_with_retry(&meta_tmp, &meta_json).await {
        remove_file_quietly(&content_tmp).await;
        return Err(error);
    }

    let mut renamed_content = false;
    let rename_result: Result<(), std::io::Error> = async {
        rename_with_retry(&content_tmp, &cache_file).await?;
        renamed_content = true;
        rename_with_retry(&meta_tmp, &cache_meta_file).await?;
        Ok(())
    }
    .await;
    if let Err(error) = rename_result {
        if renamed_content {
            // Only one rename succeeded: restore consistency by rewriting the
            // content file so it matches whatever meta remains on disk.
            if let Err(recovery_error) = write_file_with_retry(&cache_file, content).await {
                log_debug(
                    "Failed to restore host-codex prompt content after partial rename failure",
                    Some(&json!({ "error": recovery_error.to_string() })),
                );
            }
        }
        remove_file_quietly(&content_tmp).await;
        remove_file_quietly(&meta_tmp).await;
        return Err(error);
    }
    Ok(())
}

async fn try_read_pair(content_path: &Path, meta_path: &Path) -> Option<CacheSnapshot> {
    let content = tokio::fs::read_to_string(content_path).await.ok()?;
    let meta_content = tokio::fs::read_to_string(meta_path).await.ok()?;
    let meta: HostPromptCacheMeta = serde_json::from_str(&meta_content).ok()?;
    if meta.last_checked == 0 {
        return None;
    }
    Some(CacheSnapshot { content, meta })
}

/// TS `readDiskCache` — current pair first, then the legacy pairs (migrating
/// a legacy hit to the current file names; migration failure only debug-logs
/// and the legacy snapshot is still used in memory).
async fn read_disk_cache() -> Option<CacheSnapshot> {
    if let Some(current) = try_read_pair(&cache_file_path(), &cache_meta_file_path()).await {
        return Some(current);
    }
    let cache_dir = get_codex_cache_dir();
    for (legacy_content, legacy_meta) in LEGACY_CACHE_FILES {
        let Some(legacy_cache) =
            try_read_pair(&cache_dir.join(legacy_content), &cache_dir.join(legacy_meta)).await
        else {
            continue;
        };
        if let Err(error) =
            write_cache_files_atomically(&legacy_cache.content, &legacy_cache.meta).await
        {
            log_debug(
                "Failed to migrate legacy host-codex prompt cache; using legacy cache in memory",
                Some(&json!({ "error": error.to_string() })),
            );
        }
        return Some(legacy_cache);
    }
    None
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// TS `saveDiskCache`.
async fn save_disk_cache(
    content: &str,
    etag: &str,
    source_url: &str,
) -> Result<HostPromptCacheMeta, std::io::Error> {
    let meta = HostPromptCacheMeta {
        etag: etag.to_string(),
        last_fetch: Some(now_iso()),
        last_checked: now_ms(),
        source_key: Some(source_cache_key(source_url)),
        source_url: None,
    };
    write_cache_files_atomically(content, &meta).await?;
    Ok(meta)
}

/// TS `refreshPrompt(cachedMeta, cachedContent)` — walk the source list;
/// conditional requests only against the source that produced the cached
/// etag; 304 re-serves the cached content and refreshes only the meta file;
/// a guarded 200 body persists atomically. All sources failing yields
/// `"Failed to fetch codex prompt from all sources (...)"`.
async fn refresh_prompt(
    cached_meta: Option<&HostPromptCacheMeta>,
    cached_content: Option<&str>,
) -> Result<String, String> {
    let sources = resolve_prompt_sources();
    let mut last_failure: Option<String> = None;

    for source_url in sources {
        let current_source_key = source_cache_key(&source_url);
        let cached_source_key: Option<String> = cached_meta.and_then(|meta| {
            meta.source_key.clone().or_else(|| {
                meta.source_url
                    .as_deref()
                    .map(source_cache_key)
            })
        });
        let cached_etag = cached_meta
            .map(|meta| meta.etag.as_str())
            .filter(|etag| !etag.is_empty());
        let can_use_conditional_request = cached_etag.is_some()
            && cached_source_key
                .as_deref()
                .is_none_or(|key| key == current_source_key);
        let mut headers: Vec<(String, String)> = Vec::new();
        if can_use_conditional_request
            && let Some(etag) = cached_etag
        {
            headers.push(("If-None-Match".to_string(), etag.to_string()));
        }

        let response = match fetch_with_timeout(
            &source_url,
            &PromptFetchOptions {
                headers,
                ..Default::default()
            },
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                last_failure = Some(format!("{}: {error}", redact_source_for_log(&source_url)));
                log_debug(
                    "Codex prompt source fetch failed",
                    Some(&json!({
                        "sourceUrl": redact_source_for_log(&source_url),
                        "error": error.to_string(),
                    })),
                );
                continue;
            }
        };

        if response.status() == reqwest::StatusCode::NOT_MODIFIED
            && let Some(content) = cached_content
        {
            let refreshed_meta = HostPromptCacheMeta {
                etag: cached_meta.map(|meta| meta.etag.clone()).unwrap_or_default(),
                last_fetch: cached_meta
                    .and_then(|meta| meta.last_fetch.clone())
                    .or_else(|| Some(now_iso())),
                last_checked: now_ms(),
                source_key: Some(current_source_key),
                source_url: None,
            };
            *MEMORY_CACHE.lock().expect("host prompt cache poisoned") = Some(CacheSnapshot {
                content: content.to_string(),
                meta: refreshed_meta.clone(),
            });
            // 304 refreshes only the meta file (lastChecked), like the TS.
            let _ = tokio::fs::create_dir_all(get_codex_cache_dir()).await;
            write_file_with_retry(&cache_meta_file_path(), &stringify_pretty2(&refreshed_meta))
                .await
                .map_err(|error| error.to_string())?;
            return Ok(content.to_string());
        }

        if !response.status().is_success() {
            let status = response.status().as_u16();
            last_failure = Some(format!(
                "{}: HTTP {status}",
                redact_source_for_log(&source_url)
            ));
            log_debug(
                "Codex prompt source returned non-OK response",
                Some(&json!({
                    "sourceUrl": redact_source_for_log(&source_url),
                    "status": status,
                })),
            );
            continue;
        }

        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        // Size-cap + reject empty bodies (prompts-04/05): a truncated or
        // empty 200 must not be cached and served as instructions.
        let content = match read_body_text_guarded(response, None, None).await {
            Ok(content) => content,
            Err(error) => {
                last_failure = Some(format!("{}: {error}", redact_source_for_log(&source_url)));
                log_debug(
                    "Codex prompt source body rejected",
                    Some(&json!({
                        "sourceUrl": redact_source_for_log(&source_url),
                        "error": error.to_string(),
                    })),
                );
                continue;
            }
        };
        let meta = save_disk_cache(&content, &etag, &source_url)
            .await
            .map_err(|error| error.to_string())?;
        *MEMORY_CACHE.lock().expect("host prompt cache poisoned") = Some(CacheSnapshot {
            content: content.clone(),
            meta,
        });
        return Ok(content);
    }

    Err(match last_failure {
        Some(failure) => format!("Failed to fetch codex prompt from all sources ({failure})"),
        None => "Failed to fetch codex prompt from all sources".to_string(),
    })
}

/// TS `scheduleRefresh` — single-flight background refresh; failures only
/// debug-log.
fn schedule_refresh(cached_meta: Option<HostPromptCacheMeta>, cached_content: Option<String>) {
    {
        let mut in_flight = REFRESH_IN_FLIGHT.lock().expect("refresh flag poisoned");
        if *in_flight {
            return;
        }
        *in_flight = true;
    }
    tokio::spawn(async move {
        if let Err(error) = refresh_prompt(cached_meta.as_ref(), cached_content.as_deref()).await {
            log_debug(
                "Codex prompt background refresh failed",
                Some(&json!({ "error": error })),
            );
        }
        *REFRESH_IN_FLIGHT.lock().expect("refresh flag poisoned") = false;
    });
}

/// TS `getHostCodexPrompt()` — cache ladder: fresh memory → disk (fresh
/// serve / stale-while-revalidate with a bumped in-memory `lastChecked`) →
/// foreground refresh → stale memory → error
/// `"Failed to fetch codex.txt and no cache available: {error}"`.
pub async fn get_host_codex_prompt() -> Result<String, String> {
    {
        let memory = MEMORY_CACHE.lock().expect("host prompt cache poisoned");
        if let Some(snapshot) = memory.as_ref()
            && is_fresh(snapshot.meta.last_checked)
        {
            return Ok(snapshot.content.clone());
        }
    }

    if let Some(disk_cache) = read_disk_cache().await {
        if is_fresh(disk_cache.meta.last_checked) {
            *MEMORY_CACHE.lock().expect("host prompt cache poisoned") = Some(disk_cache.clone());
            return Ok(disk_cache.content);
        }
        // Serve stale content immediately and refresh in the background.
        *MEMORY_CACHE.lock().expect("host prompt cache poisoned") = Some(CacheSnapshot {
            content: disk_cache.content.clone(),
            meta: HostPromptCacheMeta {
                last_checked: now_ms(),
                ..disk_cache.meta.clone()
            },
        });
        schedule_refresh(Some(disk_cache.meta.clone()), Some(disk_cache.content.clone()));
        return Ok(disk_cache.content);
    }

    let (memory_meta, memory_content) = {
        let memory = MEMORY_CACHE.lock().expect("host prompt cache poisoned");
        (
            memory.as_ref().map(|snapshot| snapshot.meta.clone()),
            memory.as_ref().map(|snapshot| snapshot.content.clone()),
        )
    };
    match refresh_prompt(memory_meta.as_ref(), memory_content.as_deref()).await {
        Ok(content) => Ok(content),
        Err(error) => {
            let stale_content = MEMORY_CACHE
                .lock()
                .expect("host prompt cache poisoned")
                .as_ref()
                .map(|snapshot| snapshot.content.clone());
            if let Some(stale) = stale_content {
                return Ok(stale);
            }
            Err(format!(
                "Failed to fetch codex.txt and no cache available: {error}"
            ))
        }
    }
}

/// TS `getCachedPromptPrefix(chars = 50)` — first N characters of the cached
/// prompt for verification, `None` when not cached.
pub async fn get_cached_prompt_prefix(chars: usize) -> Option<String> {
    let content = tokio::fs::read_to_string(cache_file_path()).await.ok()?;
    Some(content.chars().take(chars).collect())
}

/// TS `prewarmHostCodexPrompt()` — prewarm the cache without blocking
/// startup. Must be called from within a tokio runtime.
pub fn prewarm_host_codex_prompt() {
    tokio::spawn(async {
        if let Err(error) = get_host_codex_prompt().await {
            log_debug(
                "Codex prompt prewarm failed",
                Some(&json!({ "error": error })),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn reset() {
        reset_host_prompt_cache_for_testing();
    }

    #[test]
    #[serial(env)]
    fn parses_and_redacts_source_overrides() {
        let _sandbox = EnvSandbox::new();
        assert_eq!(
            parse_source_url(Some("  https://example.com/a.txt?x=1  ")),
            Some("https://example.com/a.txt?x=1".to_string())
        );
        assert_eq!(parse_source_url(Some("ftp://example.com/a.txt")), None);
        assert_eq!(parse_source_url(Some("not a url")), None);
        assert_eq!(parse_source_url(Some("   ")), None);
        assert_eq!(parse_source_url(None), None);
        assert_eq!(
            redact_source_for_log("https://user:pw@example.com/a.txt?secret=1"),
            "https://example.com/a.txt"
        );
        assert_eq!(redact_source_for_log("nope"), "<invalid-url>");
        assert_eq!(
            source_cache_key("https://example.com/a.txt?x=1"),
            "https://example.com/a.txt"
        );
        assert_eq!(source_cache_key(" raw-key "), "raw-key");
    }

    #[test]
    #[serial(env)]
    fn env_override_wins_and_dedupes() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var(CODEX_PROMPT_URL_OVERRIDE_ENV, "https://override.example/codex.txt");
        sandbox.set_var(
            LEGACY_HOST_CODEX_URL_OVERRIDE_ENV,
            "https://override.example/codex.txt",
        );
        let sources = resolve_prompt_sources();
        assert_eq!(sources[0], "https://override.example/codex.txt");
        // Deduped: the legacy env duplicate is dropped; defaults follow.
        assert_eq!(
            sources.len(),
            1 + DEFAULT_HOST_CODEX_PROMPT_URLS.len(),
            "sources: {sources:?}"
        );
        assert_eq!(sources[1], DEFAULT_HOST_CODEX_PROMPT_URLS[0]);
    }

    #[tokio::test]
    #[serial(env)]
    async fn fetches_persists_and_serves_within_ttl() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/codex.txt"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("host prompt body")
                    .insert_header("etag", "\"h-1\""),
            )
            .expect(1)
            .mount(&server)
            .await;
        set_default_sources_for_testing(vec![format!("{}/codex.txt", server.uri())]);

        let first = get_host_codex_prompt().await.expect("fetch ok");
        assert_eq!(first, "host prompt body");

        // Disk cache written (content + pretty-2 meta, no trailing newline).
        let disk = tokio::fs::read_to_string(cache_file_path())
            .await
            .expect("content file");
        assert_eq!(disk, "host prompt body");
        let meta_raw = tokio::fs::read_to_string(cache_meta_file_path())
            .await
            .expect("meta file");
        assert!(!meta_raw.ends_with('\n'));
        let meta: HostPromptCacheMeta = serde_json::from_str(&meta_raw).expect("meta parses");
        assert_eq!(meta.etag, "\"h-1\"");
        assert!(meta.source_key.as_deref().unwrap().ends_with("/codex.txt"));
        assert!(meta.last_checked > 0);

        // Second call is memory-served (expect(1) enforces no refetch).
        let second = get_host_codex_prompt().await.expect("memory hit");
        assert_eq!(second, "host prompt body");

        // Prefix helper reads the cache file.
        assert_eq!(
            get_cached_prompt_prefix(4).await.as_deref(),
            Some("host")
        );
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn revalidates_stale_cache_with_304_and_keeps_content() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/codex.txt"))
            .and(header("if-none-match", "\"h-cached\""))
            .respond_with(ResponseTemplate::new(304))
            .mount(&server)
            .await;
        let source = format!("{}/codex.txt", server.uri());
        set_default_sources_for_testing(vec![source.clone()]);

        let stale_meta = HostPromptCacheMeta {
            etag: "\"h-cached\"".to_string(),
            last_fetch: Some("2026-01-01T00:00:00.000Z".to_string()),
            last_checked: now_ms() - CACHE_TTL_MS - 1_000,
            source_key: Some(source_cache_key(&source)),
            source_url: None,
        };
        write_cache_files_atomically("cached host prompt", &stale_meta)
            .await
            .expect("seed cache");

        // Foreground refresh path (no memory): 304 re-serves the cached body.
        let refreshed = refresh_prompt(Some(&stale_meta), Some("cached host prompt"))
            .await
            .expect("304 revalidation");
        assert_eq!(refreshed, "cached host prompt");
        let meta: HostPromptCacheMeta = serde_json::from_str(
            &tokio::fs::read_to_string(cache_meta_file_path())
                .await
                .expect("meta"),
        )
        .expect("parses");
        assert!(meta.last_checked > stale_meta.last_checked);
        assert_eq!(meta.etag, "\"h-cached\"");
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn cross_source_etag_is_not_sent_conditionally() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        // A conditional request would 304 here; the full fetch must happen
        // because the cached etag belongs to a DIFFERENT source.
        Mock::given(method("GET"))
            .and(path("/other.txt"))
            .and(header("if-none-match", "\"h-cached\""))
            .respond_with(ResponseTemplate::new(304))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/other.txt"))
            .respond_with(ResponseTemplate::new(200).set_body_string("fresh other"))
            .mount(&server)
            .await;
        let source = format!("{}/other.txt", server.uri());
        set_default_sources_for_testing(vec![source]);

        let cached_meta = HostPromptCacheMeta {
            etag: "\"h-cached\"".to_string(),
            last_fetch: None,
            last_checked: 1,
            source_key: Some("https://elsewhere.example/codex.txt".to_string()),
            source_url: None,
        };
        let content = refresh_prompt(Some(&cached_meta), Some("old body"))
            .await
            .expect("full fetch");
        assert_eq!(content, "fresh other");
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn empty_bodies_are_rejected_and_fall_through_sources() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/empty.txt"))
            .respond_with(ResponseTemplate::new(200).set_body_string("   "))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/good.txt"))
            .respond_with(ResponseTemplate::new(200).set_body_string("good body"))
            .mount(&server)
            .await;
        set_default_sources_for_testing(vec![
            format!("{}/empty.txt", server.uri()),
            format!("{}/good.txt", server.uri()),
        ]);

        let content = get_host_codex_prompt().await.expect("second source wins");
        assert_eq!(content, "good body");
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn all_sources_failing_without_cache_is_an_error() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        set_default_sources_for_testing(vec![format!("{}/codex.txt", server.uri())]);

        let error = get_host_codex_prompt().await.expect_err("no cache");
        assert!(
            error.starts_with("Failed to fetch codex.txt and no cache available:"),
            "unexpected: {error}"
        );
        assert!(error.contains("HTTP 500"), "unexpected: {error}");
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn migrates_legacy_cache_pairs() {
        let _sandbox = EnvSandbox::new();
        reset();
        // No network needed: the legacy disk cache is fresh.
        set_default_sources_for_testing(vec![]);
        let cache_dir = get_codex_cache_dir();
        tokio::fs::create_dir_all(&cache_dir).await.expect("mkdir");
        tokio::fs::write(cache_dir.join("opencode-codex-prompt.txt"), "legacy prompt")
            .await
            .expect("legacy content");
        tokio::fs::write(
            cache_dir.join("opencode-codex-prompt-meta.json"),
            format!(
                r#"{{"etag":"\"legacy\"","lastChecked":{},"sourceUrl":"https://old.example/codex.txt"}}"#,
                now_ms()
            ),
        )
        .await
        .expect("legacy meta");

        let content = get_host_codex_prompt().await.expect("legacy served");
        assert_eq!(content, "legacy prompt");
        // Migrated to the current file names.
        assert_eq!(
            tokio::fs::read_to_string(cache_file_path())
                .await
                .expect("migrated content"),
            "legacy prompt"
        );
        let migrated: HostPromptCacheMeta = serde_json::from_str(
            &tokio::fs::read_to_string(cache_meta_file_path())
                .await
                .expect("migrated meta"),
        )
        .expect("parses");
        assert_eq!(migrated.etag, "\"legacy\"");
        assert_eq!(
            migrated.source_url.as_deref(),
            Some("https://old.example/codex.txt")
        );
        reset();
    }
}
