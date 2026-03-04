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

## Plugin-Host Provider Options (`provider.openai.options`)

Used only for host plugin mode through the host runtime config file.

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
| `retryAllAccountsAbsoluteCeilingMs` | `0` |
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

## Environment Overrides

| Variable | Purpose |
| --- | --- |
| `CODEX_MULTI_AUTH_DIR` | Custom root for settings/accounts/cache/logs |
| `CODEX_MULTI_AUTH_CONFIG_PATH` | Alternate config file input |
| `CODEX_MODE` | Toggle Codex mode |
| `CODEX_TUI_V2` | Toggle TUI v2 |
| `CODEX_TUI_COLOR_PROFILE` | TUI color profile |
| `CODEX_TUI_GLYPHS` | TUI glyph mode |
| `CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS` | Absolute wait ceiling for retry-all-on-rate-limit loop |
| `CODEX_AUTH_FETCH_TIMEOUT_MS` | Request timeout override |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | Stream stall timeout override |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI` | Toggle Codex CLI state sync |
| `CODEX_MULTI_AUTH_REAL_CODEX_BIN` | Force official Codex binary path |
| `CODEX_MULTI_AUTH_BYPASS` | Bypass local auth handling |

* * *

## Concurrency and Windows Notes

- Storage writes use temp-file + rename semantics; Windows may surface transient `EPERM`/`EBUSY` during rename.
- Cross-process refresh coordination relies on lease/state files; avoid manually editing those files while the CLI is running.
- Live account sync combines `fs.watch` with polling fallback to handle Windows watcher edge cases.
- Backup/WAL artifacts may exist briefly during writes and recovery; they are part of normal safety behavior.

* * *

## Related

- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [../reference/settings.md](../reference/settings.md)
