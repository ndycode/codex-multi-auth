# Config Fields Reference

Complete field inventory for runtime configuration and display settings.

* * *

## Canonical Settings File

Primary settings file:

- `~/.codex/multi-auth/settings.json`

Top-level shape:

```json
{
  "version": 1,
  "dashboardDisplaySettings": { "...": "..." },
  "pluginConfig": { "...": "..." }
}
```

* * *

## Provider Options (`provider.openai.options`)

Used in plugin-host runtime configuration.

| Key | Type | Common values | Effect |
| --- | --- | --- | --- |
| `reasoningEffort` | string | `none\|minimal\|low\|medium\|high\|xhigh` | Reasoning effort hint |
| `reasoningSummary` | string | `auto\|concise\|detailed` | Summary detail hint |
| `textVerbosity` | string | `low\|medium\|high` | Text verbosity target |
| `include` | string[] | `reasoning.encrypted_content` | Extra payload include |
| `store` | boolean | `false` | Required for stateless backend mode |

* * *

## `pluginConfig` Fields

### Core UX

| Key | Default |
| --- | --- |
| `codexMode` | `true` |
| `codexTuiV2` | `true` |
| `codexTuiColorProfile` | `truecolor` |
| `codexTuiGlyphMode` | `ascii` |

### Fast Session

| Key | Default |
| --- | --- |
| `fastSession` | `false` |
| `fastSessionStrategy` | `hybrid` |
| `fastSessionMaxInputItems` | `30` |

### Retry / Fallback / Rotation

| Key | Default |
| --- | --- |
| `retryAllAccountsRateLimited` | `true` |
| `retryAllAccountsMaxWaitMs` | `0` |
| `retryAllAccountsMaxRetries` | `Infinity` |
| `unsupportedCodexPolicy` | `strict` |
| `fallbackOnUnsupportedCodexModel` | `false` |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` |
| `unsupportedCodexFallbackChain` | `{}` |

### Token / Recovery

| Key | Default |
| --- | --- |
| `tokenRefreshSkewMs` | `60000` |
| `sessionRecovery` | `true` |
| `autoResume` | `true` |
| `proactiveRefreshGuardian` | `true` |
| `proactiveRefreshIntervalMs` | `60000` |
| `proactiveRefreshBufferMs` | `300000` |

### Storage / Sync

| Key | Default |
| --- | --- |
| `perProjectAccounts` | `true` |
| `storageBackupEnabled` | `true` |
| `liveAccountSync` | `true` |
| `liveAccountSyncDebounceMs` | `250` |
| `liveAccountSyncPollMs` | `2000` |

### Session Affinity

| Key | Default |
| --- | --- |
| `sessionAffinity` | `true` |
| `sessionAffinityTtlMs` | `1200000` |
| `sessionAffinityMaxEntries` | `512` |

### Reliability / Timeout / Probe

| Key | Default |
| --- | --- |
| `parallelProbing` | `false` |
| `parallelProbingMaxConcurrency` | `2` |
| `emptyResponseMaxRetries` | `2` |
| `emptyResponseRetryDelayMs` | `1000` |
| `pidOffsetEnabled` | `false` |
| `fetchTimeoutMs` | `60000` |
| `streamStallTimeoutMs` | `45000` |
| `networkErrorCooldownMs` | `6000` |
| `serverErrorCooldownMs` | `4000` |

### Quota Deferral

| Key | Default |
| --- | --- |
| `preemptiveQuotaEnabled` | `true` |
| `preemptiveQuotaRemainingPercent5h` | `5` |
| `preemptiveQuotaRemainingPercent7d` | `5` |
| `preemptiveQuotaMaxDeferralMs` | `7200000` |

### Notifications

| Key | Default |
| --- | --- |
| `rateLimitToastDebounceMs` | `60000` |
| `toastDurationMs` | `5000` |

* * *

## `dashboardDisplaySettings` Fields

### General Display

| Key | Default |
| --- | --- |
| `showPerAccountRows` | `true` |
| `showQuotaDetails` | `true` |
| `showForecastReasons` | `true` |
| `showRecommendations` | `true` |
| `showLiveProbeNotes` | `true` |

### Result Screen Behavior

| Key | Default |
| --- | --- |
| `actionAutoReturnMs` | `2000` |
| `actionPauseOnKey` | `true` |

### Dashboard Fetch and Sort

| Key | Default |
| --- | --- |
| `menuAutoFetchLimits` | `true` |
| `menuQuotaTtlMs` | `300000` |
| `menuSortEnabled` | `true` |
| `menuSortMode` | `ready-first` |
| `menuSortPinCurrent` | `false` |
| `menuSortQuickSwitchVisibleRow` | `true` |

### Account Row Content

| Key | Default |
| --- | --- |
| `menuShowStatusBadge` | `true` |
| `menuShowCurrentBadge` | `true` |
| `menuShowLastUsed` | `true` |
| `menuShowQuotaSummary` | `true` |
| `menuShowQuotaCooldown` | `true` |
| `menuShowFetchStatus` | `true` |
| `menuShowDetailsForUnselectedRows` | `false` |
| `menuStatuslineFields` | `last-used, limits, status` |

### Visual Style

| Key | Default |
| --- | --- |
| `uiThemePreset` | `green` |
| `uiAccentColor` | `green` |
| `menuLayoutMode` | `compact-details` |
| `menuFocusStyle` | `row-invert` |
| `menuHighlightCurrentRow` | `true` |

* * *

## Stable Environment Overrides

### Stable (User-Facing)

| Variable | Purpose |
| --- | --- |
| `CODEX_MULTI_AUTH_DIR` | Custom root for settings/accounts/cache/logs |
| `CODEX_MULTI_AUTH_CONFIG_PATH` | Alternate plugin config file input |
| `CODEX_HOME` | Override Codex home path used for default resolution |
| `CODEX_MODE` | Toggle Codex mode |
| `CODEX_TUI_V2` | Toggle TUI v2 |
| `CODEX_TUI_COLOR_PROFILE` | TUI color profile |
| `CODEX_TUI_GLYPHS` | TUI glyph mode |
| `CODEX_AUTH_FETCH_TIMEOUT_MS` | Request timeout override |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | Stream stall timeout override |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI` | Toggle Codex CLI state sync |
| `CODEX_CLI_ACCOUNTS_PATH` | Override Codex CLI accounts state path |
| `CODEX_CLI_AUTH_PATH` | Override Codex CLI auth state path |
| `CODEX_MULTI_AUTH_REAL_CODEX_BIN` | Force official Codex binary path for wrapper forwarding |
| `CODEX_MULTI_AUTH_BYPASS` | Bypass local auth handling in wrapper |
| `ENABLE_PLUGIN_REQUEST_LOGGING` | Enable request logging |
| `CODEX_PLUGIN_LOG_BODIES` | Include payload bodies in logs (sensitive) |
| `DEBUG_CODEX_PLUGIN` | Enable debug logging |
| `CODEX_PLUGIN_LOG_LEVEL` | Set log level (`debug`, `info`, `warn`, `error`) |
| `CODEX_CONSOLE_LOG` | Emit logs to console in addition to app logger |

### Advanced (Runtime Tuning)

| Variable | Purpose | Stability |
| --- | --- | --- |
| `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` | Override unsupported-model policy (`strict`/`fallback`) | Advanced |
| `CODEX_AUTH_FAST_SESSION` | Toggle fast-session mode | Advanced |
| `CODEX_AUTH_FAST_SESSION_STRATEGY` | Override fast session strategy (`hybrid`/`always`) | Advanced |
| `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS` | Max fast-session input items retained | Advanced |
| `CODEX_AUTH_RETRY_ALL_RATE_LIMITED` | Toggle all-accounts retry loop on full rate-limit exhaustion | Advanced |
| `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS` | Max wait for all-accounts retry loop (`0` means unlimited) | Advanced |
| `CODEX_AUTH_RETRY_ALL_MAX_RETRIES` | Max retry rounds for all-accounts retry loop | Advanced |
| `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` | Legacy fallback policy toggle | Legacy |
| `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` | Legacy GPT-5.3 -> GPT-5.2 fallback toggle | Legacy |
| `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS` | Refresh token skew window | Advanced |
| `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS` | Rate-limit toast debounce interval | Advanced |
| `CODEX_AUTH_TOAST_DURATION_MS` | UI toast duration | Advanced |
| `CODEX_AUTH_PER_PROJECT_ACCOUNTS` | Toggle per-project account storage mode | Advanced |
| `CODEX_AUTH_SESSION_RECOVERY` | Toggle session recovery module | Advanced |
| `CODEX_AUTH_AUTO_RESUME` | Toggle automatic session resume in recovery | Advanced |
| `CODEX_AUTH_PARALLEL_PROBING` | Toggle parallel account probing | Advanced |
| `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY` | Max probe concurrency | Advanced |
| `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES` | Max retries for empty/malformed responses | Advanced |
| `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS` | Delay between empty-response retries | Advanced |
| `CODEX_AUTH_PID_OFFSET_ENABLED` | Toggle PID-based candidate offset | Advanced |
| `CODEX_AUTH_LIVE_ACCOUNT_SYNC` | Toggle file-watch account sync | Advanced |
| `CODEX_AUTH_LIVE_ACCOUNT_SYNC_DEBOUNCE_MS` | Live sync debounce interval | Advanced |
| `CODEX_AUTH_LIVE_ACCOUNT_SYNC_POLL_MS` | Live sync poll fallback interval | Advanced |
| `CODEX_AUTH_SESSION_AFFINITY` | Toggle session affinity | Advanced |
| `CODEX_AUTH_SESSION_AFFINITY_TTL_MS` | Session affinity ttl | Advanced |
| `CODEX_AUTH_SESSION_AFFINITY_MAX_ENTRIES` | Session affinity entry cap | Advanced |
| `CODEX_AUTH_PROACTIVE_GUARDIAN` | Toggle proactive refresh guardian | Advanced |
| `CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS` | Guardian tick interval | Advanced |
| `CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS` | Guardian pre-expiry buffer window | Advanced |
| `CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS` | Cooldown applied after network errors | Advanced |
| `CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS` | Cooldown applied after 5xx errors | Advanced |
| `CODEX_AUTH_STORAGE_BACKUP_ENABLED` | Toggle storage backup/WAL safety artifacts | Advanced |
| `CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED` | Toggle preemptive quota deferral | Advanced |
| `CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT` | 5h quota deferral threshold percent | Advanced |
| `CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT` | 7d quota deferral threshold percent | Advanced |
| `CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS` | Max quota deferral wait | Advanced |

### Advanced / Internal (Maintainers)

| Variable | Purpose | Stability |
| --- | --- | --- |
| `CODEX_AUTH_ACCOUNT_ID` | Force workspace/account id for login/request routing | Advanced |
| `CODEX_AUTH_FAILOVER_MODE` | Stream failover profile (`aggressive`/`balanced`/`conservative`) | Advanced |
| `CODEX_AUTH_STREAM_FAILOVER_MAX` | Max failover attempts for streaming requests | Advanced |
| `CODEX_AUTH_STREAM_STALL_SOFT_TIMEOUT_MS` | Soft timeout for stream failover decisions | Advanced |
| `CODEX_AUTH_STREAM_STALL_HARD_TIMEOUT_MS` | Hard timeout for stream failover abort | Advanced |
| `CODEX_AUTH_PREWARM` | Toggle startup prompt prewarm | Advanced |
| `CODEX_AUTH_REFRESH_LEASE` | Toggle cross-process refresh lease | Advanced |
| `CODEX_AUTH_REFRESH_LEASE_DIR` | Refresh lease state directory | Advanced |
| `CODEX_AUTH_REFRESH_LEASE_TTL_MS` | Refresh lease ttl | Advanced |
| `CODEX_AUTH_REFRESH_LEASE_WAIT_MS` | Refresh lease wait timeout | Advanced |
| `CODEX_AUTH_REFRESH_LEASE_POLL_MS` | Refresh lease poll interval | Advanced |
| `CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS` | Refresh lease result ttl | Advanced |
| `CODEX_AUTH_SYNC_CODEX_CLI` | Legacy Codex CLI sync toggle | Legacy |
| `CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS` | Expose advanced plugin tools (`codex-metrics`, `codex-import`, etc.) | Internal |
| `CODEX_SKIP_EMAIL_HYDRATE` | Skip email hydrate fallback for account metadata | Internal |
| `CODEX_THREAD_ID` | Request correlation seed | Internal |
| `CODEX_COLLABORATION_MODE` | Request transformer collaboration mode override | Internal |

### Tooling / Test-Only

| Variable | Purpose |
| --- | --- |
| `NODE_ENV`, `VITEST`, `VITEST_WORKER_ID` | Test/runtime mode toggles |
| `CODEX_BIN`, `CODEX_MATRIX_TIMEOUT_MS`, `CODEX_MODELS_TIMEOUT_MS` | Script-only benchmarking/model-matrix controls |

### Platform / Shell Detection (Informational)

These variables affect runtime detection behavior, not plugin features:

- `FORCE_INTERACTIVE_MODE`
- `CODEX_TUI`, `CODEX_DESKTOP`
- `TERM_PROGRAM`, `TERM`, `WT_SESSION`, `ELECTRON_RUN_AS_NODE`
- `PATH`, `PATHEXT`
- `APPDATA`, `XDG_DATA_HOME`

Notes:

- Non-plugin shell variables (`PATH`, `PATHEXT`, `TERM`, `WT_SESSION`, etc.) are intentionally excluded from user-facing guidance.
- Prefer stable overrides; advanced/internal variables may change across releases.

* * *

## Concurrency and Windows Notes

- Storage writes use temp-file + rename semantics; Windows may surface transient `EPERM`/`EBUSY` during rename.
- Cross-process refresh lease coordination relies on lease/state files; avoid manually editing those files while the CLI is running.
- Live account sync combines `fs.watch` with polling fallback to handle Windows watcher edge cases.
- Backup/WAL artifacts may exist briefly during writes and recovery; they are part of normal safety behavior.

* * *

## Related

- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [../reference/settings.md](../reference/settings.md)
