//! Port of `lib/prompts/codex.ts` — the per-family Codex instructions cache
//! (spec 06 / ARCHITECTURE §6.10).
//!
//! Fetches Codex system prompts from the latest `openai/codex` GitHub release
//! with ETag-based conditional requests, a 15-minute TTL,
//! stale-while-revalidate background refresh, sha256 cache integrity
//! (prompts-03), atomic two-rename cache writes (prompts-06), and a bundled
//! offline fallback embedded via `include_str!`.
//!
//! Divergence note (recorded in the port log): the TS bundled fallback read a
//! `codex-instructions.md` sibling of the compiled module, which is absent
//! from the published package — so the final fallback could itself fail. The
//! Rust port embeds the fallback at compile time, making
//! [`get_codex_instructions`] infallible.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use cma_core::fs_retry::with_file_operation_retry;
use cma_core::json_io::stringify_compact;
use cma_core::logger::{log_debug, log_error, log_warn};
use cma_core::model_family::{DEFAULT_MODEL, ModelFamily};
use cma_core::runtime_paths::get_codex_cache_dir;
use cma_core::temp_path::temp_file_nonce;
use cma_core::types::{CacheMetadata, GitHubRelease};
use cma_core::utils::now_ms;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::fetch_utils::{
    PromptFetchOptions, fetch_with_timeout, read_body_text_guarded, with_body_timeout,
};

/// Bundled offline fallback (`assets/codex-instructions.md`): the upstream
/// `codex-rs/core/gpt_5_codex_prompt.md` snapshot vendored into this crate.
const BUNDLED_INSTRUCTIONS: &str = include_str!("../../assets/codex-instructions.md");

const DEFAULT_GITHUB_API_RELEASES: &str =
    "https://api.github.com/repos/openai/codex/releases/latest";
const DEFAULT_GITHUB_HTML_RELEASES: &str = "https://github.com/openai/codex/releases/latest";
/// `{raw_base}/{tag}/codex-rs/core/{prompt_file}`.
const DEFAULT_RAW_BASE: &str = "https://raw.githubusercontent.com/openai/codex";

const CACHE_TTL_MS: i64 = 15 * 60 * 1000;
const RELEASE_TAG_TTL_MS: i64 = 5 * 60 * 1000;
/// TS `MAX_CACHE_SIZE` — insertion-order eviction cap on the memory cache.
/// (With only 5 model families the cap is unreachable; kept for parity.)
const MAX_CACHE_SIZE: usize = 50;

/// SHA-256 of cache content for integrity verification (prompts-03).
fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[derive(Clone, Debug)]
struct MemoryEntry {
    content: String,
    timestamp: i64,
}

#[derive(Clone, Debug)]
struct ReleaseTagCache {
    tag: String,
    checked_at: i64,
}

#[derive(Clone, Debug)]
struct PromptSourceUrls {
    api_releases: String,
    html_releases: String,
    raw_base: String,
}

impl PromptSourceUrls {
    fn defaults() -> Self {
        Self {
            api_releases: DEFAULT_GITHUB_API_RELEASES.to_string(),
            html_releases: DEFAULT_GITHUB_HTML_RELEASES.to_string(),
            raw_base: DEFAULT_RAW_BASE.to_string(),
        }
    }
}

// Insertion-ordered memory cache (JS Map semantics for the eviction rule).
static MEMORY_CACHE: Mutex<Vec<(ModelFamily, MemoryEntry)>> = Mutex::new(Vec::new());
static REFRESHING_FAMILIES: Mutex<Option<HashSet<ModelFamily>>> = Mutex::new(None);
static LATEST_RELEASE_TAG_CACHE: Mutex<Option<ReleaseTagCache>> = Mutex::new(None);
static SOURCE_URL_OVERRIDES: Mutex<Option<PromptSourceUrls>> = Mutex::new(None);

fn source_urls() -> PromptSourceUrls {
    SOURCE_URL_OVERRIDES
        .lock()
        .expect("prompt source urls poisoned")
        .clone()
        .unwrap_or_else(PromptSourceUrls::defaults)
}

#[cfg(test)]
fn set_source_urls_for_testing(api: &str, html: &str, raw_base: &str) {
    *SOURCE_URL_OVERRIDES
        .lock()
        .expect("prompt source urls poisoned") = Some(PromptSourceUrls {
        api_releases: api.to_string(),
        html_releases: html.to_string(),
        raw_base: raw_base.to_string(),
    });
}

#[cfg(test)]
fn clear_source_urls_for_testing() {
    *SOURCE_URL_OVERRIDES
        .lock()
        .expect("prompt source urls poisoned") = None;
}

/// TS `__clearCacheForTesting` — clear the memory cache, in-flight refresh
/// registry, and the release-tag cache.
pub fn clear_cache_for_testing() {
    MEMORY_CACHE.lock().expect("memory cache poisoned").clear();
    if let Some(set) = REFRESHING_FAMILIES
        .lock()
        .expect("refresh registry poisoned")
        .as_mut()
    {
        set.clear();
    }
    *LATEST_RELEASE_TAG_CACHE
        .lock()
        .expect("release tag cache poisoned") = None;
}

fn memory_get(family: ModelFamily) -> Option<MemoryEntry> {
    MEMORY_CACHE
        .lock()
        .expect("memory cache poisoned")
        .iter()
        .find(|(key, _)| *key == family)
        .map(|(_, entry)| entry.clone())
}

/// TS `setCacheEntry` — evict the OLDEST insertion when at capacity and the
/// key is new (JS `Map.keys().next()`).
fn memory_set(family: ModelFamily, content: String, timestamp: i64) {
    let mut cache = MEMORY_CACHE.lock().expect("memory cache poisoned");
    let existing = cache.iter().position(|(key, _)| *key == family);
    if existing.is_none() && cache.len() >= MAX_CACHE_SIZE {
        cache.remove(0);
    }
    match existing {
        Some(index) => cache[index].1 = MemoryEntry { content, timestamp },
        None => cache.push((family, MemoryEntry { content, timestamp })),
    }
}

/// TS `PROMPT_FILES` — prompt file for each model family (based on
/// `codex-rs/core/src/model_family.rs` logic).
fn prompt_file(family: ModelFamily) -> &'static str {
    match family {
        ModelFamily::Gpt5Codex => "gpt_5_codex_prompt.md",
        ModelFamily::CodexMax => "gpt-5.1-codex-max_prompt.md",
        ModelFamily::Codex => "gpt_5_codex_prompt.md",
        ModelFamily::Gpt5_2 => "gpt_5_2_prompt.md",
        ModelFamily::Gpt5_1 => "gpt_5_1_prompt.md",
    }
}

/// TS `CACHE_FILES` — cache file for each model family.
fn cache_file_name(family: ModelFamily) -> &'static str {
    match family {
        ModelFamily::Gpt5Codex => "gpt-5-codex-instructions.md",
        ModelFamily::CodexMax => "codex-max-instructions.md",
        ModelFamily::Codex => "codex-instructions.md",
        ModelFamily::Gpt5_2 => "gpt-5.2-instructions.md",
        ModelFamily::Gpt5_1 => "gpt-5.1-instructions.md",
    }
}

/// TS `CACHE_FILES[family].replace(".md", "-meta.json")`.
fn cache_meta_file_name(family: ModelFamily) -> String {
    cache_file_name(family).replacen(".md", "-meta.json", 1)
}

/// TS `getModelFamily(normalizedModel)` — the prompt family of the effective
/// model. GPT-5.4/5.5-era general-purpose models intentionally stay on the
/// GPT-5.2 prompt family until upstream releases a newer general prompt file.
pub fn get_model_family(normalized_model: &str) -> ModelFamily {
    crate::model_map::get_model_profile(Some(normalized_model)).prompt_family
}

async fn read_file_or_null(path: &Path) -> Option<String> {
    tokio::fs::read_to_string(path).await.ok()
}

async fn retry_fs<T, F, Fut>(op: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::io::Result<T>>,
{
    with_file_operation_retry(op)
        .await
        .map_err(|error: std::io::Error| error.to_string())
}

/// TS `writeCacheAtomically` (prompts-06): write content + meta each to a
/// temp sibling then rename — content BEFORE meta so the meta's sha always
/// describes a content file already on disk. A crash between the renames
/// self-heals on the next read via the sha256 integrity check. Every fs step
/// retries transient Windows EBUSY/EPERM/ENOTEMPTY/EACCES; temp cleanup is
/// best-effort and never masks a successful write.
async fn write_cache_atomically(
    cache_file: &Path,
    cache_meta_file: &Path,
    content: &str,
    meta: &CacheMetadata,
) -> Result<(), String> {
    let cache_dir = get_codex_cache_dir();
    retry_fs(|| tokio::fs::create_dir_all(&cache_dir)).await?;
    let nonce = temp_file_nonce();
    let content_tmp = PathBuf::from(format!("{}.{nonce}.tmp", cache_file.display()));
    let meta_tmp = PathBuf::from(format!("{}.{nonce}.tmp", cache_meta_file.display()));
    let meta_json = stringify_compact(meta);

    let result: Result<(), String> = async {
        retry_fs(|| tokio::fs::write(&content_tmp, content.as_bytes())).await?;
        retry_fs(|| tokio::fs::write(&meta_tmp, meta_json.as_bytes())).await?;
        retry_fs(|| tokio::fs::rename(&content_tmp, cache_file)).await?;
        retry_fs(|| tokio::fs::rename(&meta_tmp, cache_meta_file)).await?;
        Ok(())
    }
    .await;

    // `finally`: remove temp siblings; missing files are a no-op and a
    // persistent failure is swallowed so cleanup never masks the write result.
    let _ = retry_fs(|| async {
        match tokio::fs::remove_file(&content_tmp).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    })
    .await;
    let _ = retry_fs(|| async {
        match tokio::fs::remove_file(&meta_tmp).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    })
    .await;

    result
}

/// TS `getLatestReleaseTag()` — 5-minute-cached release tag, resolved via the
/// GitHub API with an HTML redirect/scrape fallback.
async fn get_latest_release_tag() -> Result<String, String> {
    if let Some(cache) = LATEST_RELEASE_TAG_CACHE
        .lock()
        .expect("release tag cache poisoned")
        .clone()
        && now_ms() - cache.checked_at < RELEASE_TAG_TTL_MS
    {
        return Ok(cache.tag);
    }
    let urls = source_urls();

    // API path — every failure falls through to the HTML fallback.
    let api_attempt: Result<Option<String>, ()> = async {
        let response = fetch_with_timeout(
            &urls.api_releases,
            &PromptFetchOptions {
                json: true,
                ..Default::default()
            },
        )
        .await
        .map_err(|_| ())?;
        if !response.status().is_success() {
            return Ok(None);
        }
        // Guard the body read: the fetch timeout only covers connect+headers,
        // so a release API response that stalls mid-body must not hang this
        // request-blocking path (prompts-02).
        let data: GitHubRelease = with_body_timeout(response.json::<GitHubRelease>(), None)
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        Ok((!data.tag_name.is_empty()).then_some(data.tag_name))
    }
    .await;
    if let Ok(Some(tag)) = api_attempt {
        *LATEST_RELEASE_TAG_CACHE
            .lock()
            .expect("release tag cache poisoned") = Some(ReleaseTagCache {
            tag: tag.clone(),
            checked_at: now_ms(),
        });
        return Ok(tag);
    }

    let html_response = fetch_with_timeout(&urls.html_releases, &PromptFetchOptions::default())
        .await
        .map_err(|error| error.to_string())?;
    if !html_response.status().is_success() {
        return Err(format!(
            "Failed to fetch latest release: {}",
            html_response.status().as_u16()
        ));
    }

    // Redirect-following resolves the final /releases/tag/<tag> URL.
    let final_url = html_response.url().to_string();
    if !final_url.is_empty() {
        let last = final_url.split("/tag/").last().unwrap_or("");
        if last != final_url && !last.is_empty() && !last.contains('/') {
            let tag = last.to_string();
            *LATEST_RELEASE_TAG_CACHE
                .lock()
                .expect("release tag cache poisoned") = Some(ReleaseTagCache {
                tag: tag.clone(),
                checked_at: now_ms(),
            });
            return Ok(tag);
        }
    }

    // Same mid-body-stall guard as the JSON path for the HTML fallback.
    let html = with_body_timeout(html_response.text(), None)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let pattern = regex::Regex::new(r#"/openai/codex/releases/tag/([^"]+)"#).expect("static regex");
    if let Some(captures) = pattern.captures(&html)
        && let Some(tag) = captures.get(1).map(|m| m.as_str().to_string())
        && !tag.is_empty()
    {
        *LATEST_RELEASE_TAG_CACHE
            .lock()
            .expect("release tag cache poisoned") = Some(ReleaseTagCache {
            tag: tag.clone(),
            checked_at: now_ms(),
        });
        return Ok(tag);
    }

    Err("Failed to determine latest release tag from GitHub".to_string())
}

/// TS `fetchAndPersistInstructions` — conditional fetch from the latest
/// release tag, sha256-verified 304 revalidation, guarded body read, atomic
/// content+meta persist.
async fn fetch_and_persist_instructions(
    family: ModelFamily,
    prompt_file_name: &str,
    cache_file: &Path,
    cache_meta_file: &Path,
    cached_metadata: Option<&CacheMetadata>,
) -> Result<String, String> {
    let mut cached_etag: Option<String> = cached_metadata.and_then(|meta| meta.etag.clone());
    let cached_tag: Option<&str> = cached_metadata.map(|meta| meta.tag.as_str());
    let latest_tag = get_latest_release_tag().await?;
    let instructions_url = format!(
        "{}/{latest_tag}/codex-rs/core/{prompt_file_name}",
        source_urls().raw_base
    );

    if cached_tag != Some(latest_tag.as_str()) {
        cached_etag = None;
    }

    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(etag) = &cached_etag {
        headers.push(("If-None-Match".to_string(), etag.clone()));
    }

    let response = fetch_with_timeout(
        &instructions_url,
        &PromptFetchOptions {
            headers,
            ..Default::default()
        },
    )
    .await
    .map_err(|error| error.to_string())?;

    // A 304 is only meaningful if we actually sent a conditional request.
    // When the caller cleared the metadata (e.g. an sha256 mismatch forced a
    // full refetch), no If-None-Match was sent, so a 304 cannot be trusted to
    // describe our disk content.
    if response.status() == reqwest::StatusCode::NOT_MODIFIED && cached_etag.is_some() {
        let disk_content = read_file_or_null(cache_file).await;
        // Require a prior sha to trust a 304: without one the on-disk bytes
        // are unverified, and re-serving them while minting a fresh digest
        // would launder un-vetted content.
        let prior_sha = cached_metadata.and_then(|meta| meta.sha256.as_deref());
        let disk_integrity_ok = matches!(
            (&disk_content, prior_sha),
            (Some(content), Some(sha)) if sha == sha256_hex(content)
        );
        if let Some(content) = disk_content
            && disk_integrity_ok
        {
            memory_set(family, content.clone(), now_ms());
            // Refresh the meta (lastChecked) atomically and re-affirm the
            // content sha so the integrity record stays in sync.
            write_cache_atomically(
                cache_file,
                cache_meta_file,
                &content,
                &CacheMetadata {
                    etag: cached_etag,
                    tag: latest_tag,
                    last_checked: now_ms(),
                    url: instructions_url,
                    sha256: Some(sha256_hex(&content)),
                },
            )
            .await?;
            return Ok(content);
        }
        return Err("304 revalidation failed integrity check".to_string());
    }

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    // Size-cap + reject empty bodies (prompts-04/05) before caching/serving.
    let new_etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let instructions = read_body_text_guarded(response, None, None)
        .await
        .map_err(|error| error.to_string())?;
    // prompts-03/06: write content + meta atomically with a content sha256 so
    // the cache cannot tear and can be integrity-checked on the next read.
    write_cache_atomically(
        cache_file,
        cache_meta_file,
        &instructions,
        &CacheMetadata {
            etag: new_etag,
            tag: latest_tag,
            last_checked: now_ms(),
            url: instructions_url,
            sha256: Some(sha256_hex(&instructions)),
        },
    )
    .await?;
    memory_set(family, instructions.clone(), now_ms());
    Ok(instructions)
}

/// TS `refreshInstructionsInBackground` — deduped background refresh per
/// family; failures are debug-logged and never surface.
fn refresh_instructions_in_background(
    family: ModelFamily,
    prompt_file_name: &'static str,
    cache_file: PathBuf,
    cache_meta_file: PathBuf,
    cached_metadata: Option<CacheMetadata>,
) {
    {
        let mut guard = REFRESHING_FAMILIES
            .lock()
            .expect("refresh registry poisoned");
        let set = guard.get_or_insert_with(HashSet::new);
        if !set.insert(family) {
            return;
        }
    }
    tokio::spawn(async move {
        let result = fetch_and_persist_instructions(
            family,
            prompt_file_name,
            &cache_file,
            &cache_meta_file,
            cached_metadata.as_ref(),
        )
        .await;
        if let Err(error) = result {
            log_debug(
                &format!(
                    "Background prompt refresh failed for {}",
                    family.as_str()
                ),
                Some(&json!({ "error": error })),
            );
        }
        if let Some(set) = REFRESHING_FAMILIES
            .lock()
            .expect("refresh registry poisoned")
            .as_mut()
        {
            set.remove(&family);
        }
    });
}

/// TS `getCodexInstructions(normalizedModel = DEFAULT_MODEL)`.
///
/// Per-family cache ladder: fresh memory → disk (sha256-verified; fresh
/// serve / stale-while-revalidate) → stale memory (SWR) → network fetch →
/// usable disk fallback → bundled fallback. Rate-limit protection: GitHub is
/// only consulted when the cache is older than 15 minutes.
///
/// Infallible in Rust: the bundled fallback is embedded via `include_str!`
/// (see the module-level divergence note).
pub async fn get_codex_instructions(normalized_model: Option<&str>) -> String {
    let model = match normalized_model {
        Some(value) if !value.is_empty() => value,
        _ => DEFAULT_MODEL,
    };
    let model_family = get_model_family(model);
    let now = now_ms();
    if let Some(cached) = memory_get(model_family)
        && now - cached.timestamp < CACHE_TTL_MS
    {
        return cached.content;
    }

    let prompt_file_name = prompt_file(model_family);
    let cache_dir = get_codex_cache_dir();
    let cache_file = cache_dir.join(cache_file_name(model_family));
    let cache_meta_file = cache_dir.join(cache_meta_file_name(model_family));

    let meta_content = read_file_or_null(&cache_meta_file).await;
    let disk_content = read_file_or_null(&cache_file).await;
    let mut cached_metadata: Option<CacheMetadata> =
        meta_content.and_then(|raw| serde_json::from_str(&raw).ok());

    // prompts-03: once disk content fails its sha256 it must not be trusted
    // anywhere downstream — not served, not the 304 revalidation body, and
    // not the offline fallback. Track a "usable" view separately.
    let mut usable_disk_content = disk_content.clone();

    if let Some(disk) = &disk_content
        && cached_metadata
            .as_ref()
            .is_some_and(|meta| meta.last_checked != 0)
    {
        let meta = cached_metadata.as_ref().expect("checked above").clone();
        match meta.sha256.as_deref() {
            None => {
                // Unverified legacy entry: clear meta so no If-None-Match is
                // sent and the cache isn't fast-path served; retain the bytes
                // as an offline fallback for a failed full fetch.
                cached_metadata = None;
            }
            Some(prior_sha) if prior_sha != sha256_hex(disk) => {
                log_warn(
                    &format!(
                        "Discarding corrupt prompt cache for {} (sha256 mismatch)",
                        model_family.as_str()
                    ),
                    None,
                );
                // Force a full refetch: the corrupt body must not be served,
                // used as the catch fallback, or re-blessed via a 304.
                usable_disk_content = None;
                cached_metadata = None;
            }
            Some(_) if now - meta.last_checked < CACHE_TTL_MS => {
                memory_set(model_family, disk.clone(), now);
                return disk.clone();
            }
            Some(_) => {
                // Stale-while-revalidate: serve stale immediately, refresh in
                // the background.
                memory_set(model_family, disk.clone(), now);
                refresh_instructions_in_background(
                    model_family,
                    prompt_file_name,
                    cache_file,
                    cache_meta_file,
                    Some(meta),
                );
                return disk.clone();
            }
        }
    }

    if let Some(cached) = memory_get(model_family)
        && now - cached.timestamp >= CACHE_TTL_MS
    {
        // Keep session latency stable by serving stale memory cache while
        // refreshing.
        memory_set(model_family, cached.content.clone(), now);
        refresh_instructions_in_background(
            model_family,
            prompt_file_name,
            cache_file,
            cache_meta_file,
            cached_metadata,
        );
        return cached.content;
    }

    match fetch_and_persist_instructions(
        model_family,
        prompt_file_name,
        &cache_file,
        &cache_meta_file,
        cached_metadata.as_ref(),
    )
    .await
    {
        Ok(content) => content,
        Err(error) => {
            log_error(
                &format!(
                    "Failed to fetch {} instructions from GitHub: {error}",
                    model_family.as_str()
                ),
                None,
            );
            if let Some(disk) = usable_disk_content {
                log_warn(
                    &format!("Using cached {} instructions", model_family.as_str()),
                    None,
                );
                memory_set(model_family, disk.clone(), now);
                return disk;
            }
            log_warn(
                &format!(
                    "Falling back to bundled instructions for {}",
                    model_family.as_str()
                ),
                None,
            );
            memory_set(model_family, BUNDLED_INSTRUCTIONS.to_string(), now);
            BUNDLED_INSTRUCTIONS.to_string()
        }
    }
}

/// TS `prewarmCodexInstructions(models = [])` — prewarm instruction caches
/// for the provided models (default `[DEFAULT_MODEL, "gpt-5.3-codex",
/// "gpt-5.1"]`), deduped per prompt family (first model wins). Must be called
/// from within a tokio runtime; failures cannot occur (the fetch ladder ends
/// in the bundled fallback), so the TS prewarm catch has no analogue.
pub fn prewarm_codex_instructions(models: &[&str]) {
    let candidates: Vec<String> = if models.is_empty() {
        vec![
            DEFAULT_MODEL.to_string(),
            "gpt-5.3-codex".to_string(),
            "gpt-5.1".to_string(),
        ]
    } else {
        models.iter().map(|model| model.to_string()).collect()
    };
    let mut prewarm_targets: Vec<(ModelFamily, String)> = Vec::new();
    for model in candidates {
        let prompt_family = get_model_family(&model);
        if !prewarm_targets
            .iter()
            .any(|(family, _)| *family == prompt_family)
        {
            prewarm_targets.push((prompt_family, model));
        }
    }
    for (_, model) in prewarm_targets {
        tokio::spawn(async move {
            let _ = get_codex_instructions(Some(&model)).await;
        });
    }
}

/// TS `TOOL_REMAP_MESSAGE` — tool remapping instructions for host runtime
/// tools. Byte-identical to the TS export (extracted from the template
/// literal into `assets/tool-remap-message.txt`).
pub const TOOL_REMAP_MESSAGE: &str = include_str!("../../assets/tool-remap-message.txt");

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;
    use wiremock::matchers::{header, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn reset() {
        clear_cache_for_testing();
        clear_source_urls_for_testing();
    }

    /// Route the module at a wiremock server hosting both the release API and
    /// the raw prompt files.
    async fn mount_release_api(server: &MockServer, tag: &str) {
        Mock::given(method("GET"))
            .and(path("/releases/latest"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "tag_name": tag })),
            )
            .mount(server)
            .await;
    }

    fn point_at(server: &MockServer) {
        let base = server.uri();
        set_source_urls_for_testing(
            &format!("{base}/releases/latest"),
            &format!("{base}/releases/html-latest"),
            &format!("{base}/raw"),
        );
    }

    #[test]
    fn tool_remap_message_matches_frozen_shape() {
        assert!(TOOL_REMAP_MESSAGE.starts_with("<user_instructions priority=\"0\">"));
        assert!(TOOL_REMAP_MESSAGE.contains("UPDATE_PLAN DOES NOT EXIST -> USE \"todowrite\" INSTEAD"));
        // The TS `\${TARGET_SNIPPET}` escape resolves to a literal `${…}`.
        assert!(TOOL_REMAP_MESSAGE.contains("${TARGET_SNIPPET}"));
        assert!(TOOL_REMAP_MESSAGE.ends_with("</user_instructions>"));
        assert_eq!(TOOL_REMAP_MESSAGE.len(), 3266);
    }

    #[test]
    fn bundled_fallback_is_nonempty_instructions_text() {
        assert!(BUNDLED_INSTRUCTIONS.starts_with("You are Codex"));
        assert!(BUNDLED_INSTRUCTIONS.len() > 1_000);
    }

    #[test]
    #[serial(env)]
    fn family_file_mappings_match_ts_tables() {
        assert_eq!(prompt_file(ModelFamily::Gpt5Codex), "gpt_5_codex_prompt.md");
        assert_eq!(prompt_file(ModelFamily::CodexMax), "gpt-5.1-codex-max_prompt.md");
        assert_eq!(prompt_file(ModelFamily::Codex), "gpt_5_codex_prompt.md");
        assert_eq!(prompt_file(ModelFamily::Gpt5_2), "gpt_5_2_prompt.md");
        assert_eq!(prompt_file(ModelFamily::Gpt5_1), "gpt_5_1_prompt.md");
        assert_eq!(cache_file_name(ModelFamily::Codex), "codex-instructions.md");
        assert_eq!(
            cache_meta_file_name(ModelFamily::Codex),
            "codex-instructions-meta.json"
        );
        assert_eq!(
            cache_meta_file_name(ModelFamily::Gpt5_2),
            "gpt-5.2-instructions-meta.json"
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn fetches_persists_and_serves_from_memory_within_ttl() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        mount_release_api(&server, "rust-v9.9.9").await;
        Mock::given(method("GET"))
            .and(path("/raw/rust-v9.9.9/codex-rs/core/gpt_5_2_prompt.md"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("prompt body v1")
                    .insert_header("etag", "\"etag-1\""),
            )
            .expect(1)
            .mount(&server)
            .await;
        point_at(&server);

        let first = get_codex_instructions(Some("gpt-5.5")).await;
        assert_eq!(first, "prompt body v1");

        // Disk cache written atomically with sha256 meta.
        let cache_dir = get_codex_cache_dir();
        let disk = tokio::fs::read_to_string(cache_dir.join("gpt-5.2-instructions.md"))
            .await
            .expect("cache file");
        assert_eq!(disk, "prompt body v1");
        let meta: CacheMetadata = serde_json::from_str(
            &tokio::fs::read_to_string(cache_dir.join("gpt-5.2-instructions-meta.json"))
                .await
                .expect("meta file"),
        )
        .expect("meta parses");
        assert_eq!(meta.etag.as_deref(), Some("\"etag-1\""));
        assert_eq!(meta.tag, "rust-v9.9.9");
        assert_eq!(meta.sha256.as_deref(), Some(sha256_hex("prompt body v1").as_str()));

        // Second call inside the TTL is served from memory (expect(1) above
        // fails the test if another raw fetch happens).
        let second = get_codex_instructions(Some("gpt-5.5")).await;
        assert_eq!(second, "prompt body v1");
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn corrupt_disk_cache_is_discarded_and_refetched() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        mount_release_api(&server, "rust-v1.0.0").await;
        Mock::given(method("GET"))
            .and(path("/raw/rust-v1.0.0/codex-rs/core/gpt_5_2_prompt.md"))
            .respond_with(ResponseTemplate::new(200).set_body_string("fresh body"))
            .expect(1)
            .mount(&server)
            .await;
        point_at(&server);

        // Seed a tampered cache: content no longer matches the recorded sha.
        let cache_dir = get_codex_cache_dir();
        tokio::fs::create_dir_all(&cache_dir).await.expect("mkdir");
        tokio::fs::write(cache_dir.join("gpt-5.2-instructions.md"), "tampered")
            .await
            .expect("seed content");
        let meta = CacheMetadata {
            etag: Some("\"old\"".to_string()),
            tag: "rust-v1.0.0".to_string(),
            last_checked: now_ms(),
            url: "u".to_string(),
            sha256: Some(sha256_hex("original body")),
        };
        tokio::fs::write(
            cache_dir.join("gpt-5.2-instructions-meta.json"),
            stringify_compact(&meta),
        )
        .await
        .expect("seed meta");

        // Despite a FRESH lastChecked, the sha mismatch forces a refetch and
        // the tampered bytes are never served.
        let served = get_codex_instructions(Some("gpt-5.5")).await;
        assert_eq!(served, "fresh body");
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn stale_cache_revalidates_with_304_and_reserves_disk_content() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        mount_release_api(&server, "rust-v2.0.0").await;
        Mock::given(method("GET"))
            .and(path("/raw/rust-v2.0.0/codex-rs/core/gpt_5_2_prompt.md"))
            .and(header("if-none-match", "\"etag-cached\""))
            .respond_with(ResponseTemplate::new(304))
            .mount(&server)
            .await;
        point_at(&server);

        let cache_dir = get_codex_cache_dir();
        tokio::fs::create_dir_all(&cache_dir).await.expect("mkdir");
        tokio::fs::write(cache_dir.join("gpt-5.2-instructions.md"), "cached body")
            .await
            .expect("seed content");
        let stale_checked = now_ms() - CACHE_TTL_MS - 1_000;
        let meta = CacheMetadata {
            etag: Some("\"etag-cached\"".to_string()),
            tag: "rust-v2.0.0".to_string(),
            last_checked: stale_checked,
            url: "u".to_string(),
            sha256: Some(sha256_hex("cached body")),
        };
        tokio::fs::write(
            cache_dir.join("gpt-5.2-instructions-meta.json"),
            stringify_compact(&meta),
        )
        .await
        .expect("seed meta");

        // Stale disk cache: served immediately (SWR) while the background
        // refresh 304-revalidates.
        let served = get_codex_instructions(Some("gpt-5.5")).await;
        assert_eq!(served, "cached body");

        // Drive the revalidation deterministically (the background task from
        // the SWR path may or may not have completed; the direct call
        // exercises the 304 + sha-verified re-serve path).
        let revalidated = fetch_and_persist_instructions(
            ModelFamily::Gpt5_2,
            "gpt_5_2_prompt.md",
            &cache_dir.join("gpt-5.2-instructions.md"),
            &cache_dir.join("gpt-5.2-instructions-meta.json"),
            Some(&meta),
        )
        .await
        .expect("304 revalidation");
        assert_eq!(revalidated, "cached body");
        // lastChecked refreshed on disk.
        let refreshed: CacheMetadata = serde_json::from_str(
            &tokio::fs::read_to_string(cache_dir.join("gpt-5.2-instructions-meta.json"))
                .await
                .expect("meta"),
        )
        .expect("parses");
        assert!(refreshed.last_checked > stale_checked);
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn falls_back_to_bundled_instructions_when_offline_with_no_cache() {
        let _sandbox = EnvSandbox::new();
        reset();
        // Point at a server that always errors.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        point_at(&server);

        let served = get_codex_instructions(Some("gpt-5.3-codex")).await;
        assert_eq!(served, BUNDLED_INSTRUCTIONS);
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn legacy_meta_without_sha_forces_full_fetch_but_keeps_offline_fallback() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        mount_release_api(&server, "rust-v3.0.0").await;
        // The full fetch fails; the legacy (unverified) disk bytes remain the
        // offline fallback.
        Mock::given(method("GET"))
            .and(path("/raw/rust-v3.0.0/codex-rs/core/gpt_5_2_prompt.md"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        point_at(&server);

        let cache_dir = get_codex_cache_dir();
        tokio::fs::create_dir_all(&cache_dir).await.expect("mkdir");
        tokio::fs::write(cache_dir.join("gpt-5.2-instructions.md"), "legacy body")
            .await
            .expect("seed content");
        // Pre-upgrade meta: fresh lastChecked but NO sha256 field.
        tokio::fs::write(
            cache_dir.join("gpt-5.2-instructions-meta.json"),
            format!(
                r#"{{"etag":"\"legacy\"","tag":"rust-v3.0.0","lastChecked":{},"url":"u"}}"#,
                now_ms()
            ),
        )
        .await
        .expect("seed meta");

        let served = get_codex_instructions(Some("gpt-5.5")).await;
        assert_eq!(served, "legacy body");
        reset();
    }

    #[tokio::test]
    #[serial(env)]
    async fn release_tag_falls_back_to_html_scrape() {
        let _sandbox = EnvSandbox::new();
        reset();
        let server = MockServer::start().await;
        // API broken.
        Mock::given(method("GET"))
            .and(path("/releases/latest"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        // HTML page (no /tag/ redirect) with the scrapeable link. The prompt
        // fetch also carries the mandatory User-Agent (prompts-08).
        Mock::given(method("GET"))
            .and(path("/releases/html-latest"))
            .and(header_exists("user-agent"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"<a href="/openai/codex/releases/tag/rust-v7.7.7">latest</a>"#,
            ))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/raw/rust-v7.7.7/codex-rs/core/gpt_5_1_prompt.md"))
            .respond_with(ResponseTemplate::new(200).set_body_string("g51 prompt"))
            .mount(&server)
            .await;
        point_at(&server);

        let served = get_codex_instructions(Some("gpt-5.1")).await;
        assert_eq!(served, "g51 prompt");
        reset();
    }
}
