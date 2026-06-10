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
| `promptCacheRetention` | string | `5m\|1h\|24h\|7d` | Default server-side prompt cache retention when the request body omits `prompt_cache_retention` |
| `include` | string[] | `reasoning.encrypted_content` | Extra payload include |
| `store` | boolean | `false` | Required for stateless backend mode |

* * *

## `pluginConfig` Fields

`pluginConfig` is the persisted compatibility name for runtime settings. These fields are used by the wrapper/account manager, runtime rotation proxy, and optional plugin-host path depending on feature area.

### Core UX

| Key | Default |
| --- | --- |
| `codexMode` | `true` |
| `codexRuntimeRotationProxy` | `true` |
| `codexTuiV2` | `true` |
| `codexTuiColorProfile` | `truecolor` |
| `codexTuiGlyphMode` | `ascii` |

`codexRuntimeRotationProxy` enables the wrapper/app local Responses proxy path. It is enabled by default and can be overridden per process with `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY`.

### Fast Session

| Key | Default |
| --- | --- |
| `fastSession` | `false` |
| `fastSessionStrategy` | `hybrid` |
| `fastSessionMaxInputItems` | `30` |

### Retry / Fallback / Rotation

| Key | Default |
| --- | --- |
| `schedulingStrategy` | `hybrid` |
| `retryAllAccountsRateLimited` | `true` |
| `retryAllAccountsMaxWaitMs` | `0` |
| `retryAllAccountsMaxRetries` | `Infinity` |
| `unsupportedCodexPolicy` | `strict` |
| `fallbackOnUnsupportedCodexModel` | `false` |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` |
| `unsupportedCodexFallbackChain` | `{}` |

`schedulingStrategy` selects how the runtime proxy picks an account per request. `hybrid` (default) keeps the weighted health/token/freshness selection that spreads load across all available accounts. `sequential` (drain-first) sticks to one active account and only advances to the next available account once the current one is fully exhausted (rate-limited / cooling down / circuit-open); earlier accounts become eligible again as soon as their quota window recovers, staggering recovery across the pool. A manual pin still overrides this, and sequential mode intentionally ignores per-session affinity so all new requests follow the single active account. Overridable per-process via `CODEX_AUTH_SCHEDULING_STRATEGY`.

### Token / Recovery

| Key | Default |
| --- | --- |
| `tokenRefreshSkewMs` | `60000` |
| `sessionRecovery` | `true` |
| `autoResume` | `true` |
| `responseContinuation` | `false` |
| `backgroundResponses` | `false` |
| `proactiveRefreshGuardian` | `true` |
| `proactiveRefreshIntervalMs` | `60000` |
| `proactiveRefreshBufferMs` | `300000` |

`backgroundResponses` is an opt-in compatibility switch for Responses API `background: true` requests. When enabled, those requests become stateful (`store=true`) instead of following the default stateless Codex routing.

Upgrade note:
- Leave this disabled for existing stateless pipelines that do not intentionally send `background: true`.
- Enable it only for callers that need stateful background responses and can accept forced `store=true`, preserved input item IDs, and the loss of stateless-only defaults such as fast-session trimming.
- After enabling it, test one known `background: true` request end to end before rolling it across shared automation.

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
| `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` | Toggle localhost Responses proxy for forwarded Codex sessions (`1`/`true` to enable, `0`/`false` to disable) |
| `CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS` | Override idle timeout for the wrapper-launched Codex app runtime helper |
| `CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID` | Internal owner PID used by the wrapper-launched app helper |
| `CODEX_MULTI_AUTH_REAL_CODEX_HOME` | Internal original Codex home pointer used by runtime rotation helpers |
| `CODEX_MULTI_AUTH_APP_BIND_INSTALL` | Opt out/in of packaged Codex app bind self-heal on first CLI run or rotation enable |
| `CODEX_MULTI_AUTH_APP_BIND` | Legacy/manual app-bind override consumed by the first-run setup hook (`lib/runtime/first-run.ts`) |
| `CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME` | Override Codex home used by packaged app bind helpers |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL` | Opt out/in of user-level app launcher routing on first CLI run or rotation enable |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_WINDOWS_DESKTOP_DIR` | Override Windows desktop shortcut search root for launcher routing |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_MACOS_DIR` | Override macOS managed wrapper app install directory |
| `CODEX_TUI_V2` | Toggle TUI v2 |
| `CODEX_TUI_COLOR_PROFILE` | TUI color profile |
| `CODEX_TUI_GLYPHS` | TUI glyph mode |
| `CODEX_AUTH_FETCH_TIMEOUT_MS` | Request timeout override |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | Stream stall timeout override |
| `CODEX_AUTH_SCHEDULING_STRATEGY` | Account scheduling strategy override (`hybrid` or `sequential`/drain-first) |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI` | Toggle Codex CLI state sync |
| `CODEX_MULTI_AUTH_REAL_CODEX_BIN` | Force official Codex binary path |
| `CODEX_MULTI_AUTH_BYPASS` | Bypass local auth handling |
| `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE` | Opt out of wrapper-injected official Codex file-backed auth store when set to `0` |
| `CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP` | Opt out of best-effort active-account sync around forwarded Codex launches when set to `0` |
| `CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT` | Force or disable capture of forwarded Codex output for unsupported-model fallback handling |
| `CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD` | Install Windows shim guards when enabled |
| `CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD` | Install PowerShell profile guard when enabled |
| `CODEX_MULTI_AUTH_OVERWRITE_CUSTOM_BATCH_SHIM` | Allow Windows shim guard to overwrite custom shims when set to `1` |

* * *

## Runtime Rotation Architecture Fields

Runtime rotation is split between persisted config, wrapper-only process env, and app-bind helper env.

| Layer | Primary controls |
| --- | --- |
| Persisted settings | `pluginConfig.codexRuntimeRotationProxy` |
| Per-process override | `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` |
| Wrapper app helper | `CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS`, internal owner/original-home env |
| Packaged app bind | `CODEX_MULTI_AUTH_APP_BIND_INSTALL`, `CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME` |
| User launcher routing | `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL`, launcher directory overrides |

The proxy provider id is `codex-multi-auth-runtime-proxy`. It is generated through `lib/runtime-constants.ts` and the TOML rewrite helpers in `lib/runtime/config-toml.ts`.

* * *

## Concurrency and Windows Notes

- Storage writes use temp-file + rename semantics; Windows may surface transient `EPERM`/`EBUSY` during rename.
- Cross-process refresh coordination relies on lease/state files; avoid manually editing those files while the CLI is running.
- Live account sync combines `fs.watch` with polling fallback to handle Windows watcher edge cases.
- Backup/WAL artifacts may exist briefly during writes and recovery; they are part of normal safety behavior.
- Runtime rotation shadow-home sync uses a lock directory and state metadata to avoid overwriting newer official Codex state after concurrent helper sessions.
- If shadow-home lock owner metadata cannot be written, the wrapper removes the orphaned lock before surfacing the failure so later sync-back attempts are not skipped silently.

* * *

## Related

- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [../reference/settings.md](../reference/settings.md)
