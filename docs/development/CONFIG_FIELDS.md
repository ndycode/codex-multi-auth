# Config Fields Reference

Complete reference for plugin runtime configuration and OpenCode provider options.

## Runtime Config File

Primary file:

- `~/.opencode/codex-multi-auth-config.json`

Override file path with:

- `CODEX_MULTI_AUTH_CONFIG_PATH=<absolute-path>`

## OpenCode Provider Options (passed via `provider.openai.options`)

| Key | Type | Common values | Effect |
| --- | --- | --- | --- |
| `reasoningEffort` | string | `none|minimal|low|medium|high|xhigh` | Reasoning intensity hint |
| `reasoningSummary` | string | `auto|concise|detailed` | Reasoning summary detail |
| `textVerbosity` | string | `low|medium|high` | Text length/verbosity target |
| `include` | string[] | `reasoning.encrypted_content` | Include extra encrypted reasoning payload |
| `store` | boolean | `false` | Required for stateless ChatGPT backend mode |

## Plugin Runtime Fields

### UI and Interaction

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `codexMode` | `true` | `CODEX_MODE` | Enables Codex bridge prompt mode |
| `codexTuiV2` | `true` | `CODEX_TUI_V2` | Enables highlighted auth dashboard |
| `codexTuiColorProfile` | `truecolor` | `CODEX_TUI_COLOR_PROFILE` | `truecolor|ansi256|ansi16` |
| `codexTuiGlyphMode` | `ascii` | `CODEX_TUI_GLYPHS` | `ascii|unicode|auto` |

### Fast Session Controls

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `fastSession` | `false` | `CODEX_AUTH_FAST_SESSION` | Low-latency mode |
| `fastSessionStrategy` | `hybrid` | `CODEX_AUTH_FAST_SESSION_STRATEGY` | `hybrid|always` |
| `fastSessionMaxInputItems` | `30` | `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS` | Stateless history trim cap |

### Rotation, Retry, Fallback

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `retryAllAccountsRateLimited` | `true` | `CODEX_AUTH_RETRY_ALL_RATE_LIMITED` | Rotate/wait across account pool |
| `retryAllAccountsMaxWaitMs` | `0` | `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS` | `0` means no extra cap |
| `retryAllAccountsMaxRetries` | `Infinity` | `CODEX_AUTH_RETRY_ALL_MAX_RETRIES` | Total retry cap |
| `unsupportedCodexPolicy` | `strict` | `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` | `strict|fallback` |
| `fallbackOnUnsupportedCodexModel` | `false` | `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` | Legacy fallback toggle |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` | `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` | Legacy compatibility behavior |
| `unsupportedCodexFallbackChain` | `{}` | none | Custom fallback chain map |

### Tokens and Session Recovery

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `tokenRefreshSkewMs` | `60000` | `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS` | Refresh early window |
| `sessionRecovery` | `true` | `CODEX_AUTH_SESSION_RECOVERY` | Session recovery feature toggle |
| `autoResume` | `true` | `CODEX_AUTH_AUTO_RESUME` | Auto-resume behavior |
| `proactiveRefreshGuardian` | `true` | `CODEX_AUTH_PROACTIVE_GUARDIAN` | Background refresh watcher |
| `proactiveRefreshIntervalMs` | `60000` | `CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS` | Guardian poll interval |
| `proactiveRefreshBufferMs` | `300000` | `CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS` | Expiry buffer before refresh |

### Storage and Account Scope

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `perProjectAccounts` | `true` | `CODEX_AUTH_PER_PROJECT_ACCOUNTS` | Project-scoped account pools |
| `storageBackupEnabled` | `true` | `CODEX_AUTH_STORAGE_BACKUP_ENABLED` | Backup file writes |
| `liveAccountSync` | `true` | `CODEX_AUTH_LIVE_ACCOUNT_SYNC` | No-restart account reload |
| `liveAccountSyncDebounceMs` | `250` | `CODEX_AUTH_LIVE_ACCOUNT_SYNC_DEBOUNCE_MS` | Reload debounce |
| `liveAccountSyncPollMs` | `2000` | `CODEX_AUTH_LIVE_ACCOUNT_SYNC_POLL_MS` | Poll fallback interval |

### Session Affinity

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `sessionAffinity` | `true` | `CODEX_AUTH_SESSION_AFFINITY` | Sticky account selection by session |
| `sessionAffinityTtlMs` | `1200000` | `CODEX_AUTH_SESSION_AFFINITY_TTL_MS` | Entry lifetime |
| `sessionAffinityMaxEntries` | `512` | `CODEX_AUTH_SESSION_AFFINITY_MAX_ENTRIES` | Cache bound |

### Reliability and Timeouts

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `parallelProbing` | `false` | `CODEX_AUTH_PARALLEL_PROBING` | Parallel account probes |
| `parallelProbingMaxConcurrency` | `2` | `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY` | Probe fan-out cap |
| `emptyResponseMaxRetries` | `2` | `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES` | Retry empty responses |
| `emptyResponseRetryDelayMs` | `1000` | `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS` | Delay between empty retries |
| `pidOffsetEnabled` | `false` | `CODEX_AUTH_PID_OFFSET_ENABLED` | PID-based offset mode |
| `fetchTimeoutMs` | `60000` | `CODEX_AUTH_FETCH_TIMEOUT_MS` | Request timeout |
| `streamStallTimeoutMs` | `45000` | `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | Stall timeout for streams |
| `networkErrorCooldownMs` | `6000` | `CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS` | Cooldown after network errors |
| `serverErrorCooldownMs` | `4000` | `CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS` | Cooldown after 5xx errors |

### Notification Controls

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `rateLimitToastDebounceMs` | `60000` | `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS` | Rate-limit toast debounce |
| `toastDurationMs` | `5000` | `CODEX_AUTH_TOAST_DURATION_MS` | Toast duration |

## Additional Runtime Env Controls

| Variable | Purpose |
| --- | --- |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI=0/1` | Disable/enable sync with Codex CLI account state |
| `CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS=1` | Expose advanced maintenance tools |
| `CODEX_MULTI_AUTH_REAL_CODEX_BIN=<path>` | Force explicit official Codex CLI binary path |
| `CODEX_MULTI_AUTH_BYPASS=1` | Bypass local auth handling and forward to official CLI |

## Related

- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [../configuration.md](../configuration.md)

