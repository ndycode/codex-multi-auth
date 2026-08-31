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
| `retryAllAccountsRateLimited` | `false` |
| `retryAllAccountsMaxWaitMs` | `0` |
| `retryAllAccountsMaxRetries` | `0` |
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
| `tokenInvalidationCooldownMs` | `300000` |
| `minRotationIntervalMs` | `60000` |

`tokenRefreshSkewMs` refreshes access tokens this many milliseconds before expiry so cross-process refresh coordination has headroom. Cross-process refresh uses lease/state files (`lib/refresh-lease.ts`, `lib/refresh-queue.ts`) so concurrent processes do not stampede the same refresh token.

`tokenInvalidationCooldownMs` is the cooldown applied when an OAuth token is explicitly invalidated by upstream (distinct from a generic 401). The longer default (5 minutes) reduces cascades where rapid rotation invalidates successive tokens. Overridable via `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS`.

`minRotationIntervalMs` is the minimum time that must elapse between global account switches. When the last served account is still within this window and available, it receives a large selection-score boost so the proxy stays on it rather than rotating to a fresher idle account. `0` disables the throttle. Overridable via `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS`.

`backgroundResponses` is an opt-in compatibility switch for Responses API `background: true` requests. When enabled, those requests become stateful (`store=true`) instead of following the default stateless Codex routing. Overridable via `CODEX_AUTH_BACKGROUND_RESPONSES`.

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
| `pidOffsetEnabled` | `true` |
| `fetchTimeoutMs` | `60000` |
| `streamStallTimeoutMs` | `45000` |
| `networkErrorCooldownMs` | `6000` |
| `serverErrorCooldownMs` | `4000` |
| `tokenInvalidationCooldownMs` | `300000` |
| `minRotationIntervalMs` | `60000` |
| `routingMutex` | `legacy` |
| `rateLimitDedupWindowMs` | `2000` |
| `rateLimitStateResetMs` | `120000` |
| `rateLimitMaxBackoffMs` | `60000` |
| `rateLimitShortRetryThresholdMs` | `5000` |

`pidOffsetEnabled` adds a small deterministic PID-based score offset so parallel wrapper processes bias toward different accounts under high concurrency. Manual pins and health/quota scoring still take precedence. Overridable via `CODEX_AUTH_PID_OFFSET_ENABLED`.

`routingMutex` controls whether account selection + cursor advance on the runtime proxy hot path is serialized. `"legacy"` (default) runs selection inline for historical performance. `"enabled"` acquires a process-local reentrant async mutex around selection commits. Overridable via `CODEX_AUTH_ROUTING_MUTEX` (`legacy` or `enabled`).

`tokenInvalidationCooldownMs` / `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS` and `minRotationIntervalMs` / `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS` are the anti-abuse knobs used by the runtime rotation proxy (see configuration guide).

### Quota Deferral

| Key | Default |
| --- | --- |
| `preemptiveQuotaEnabled` | `true` |
| `preemptiveQuotaRemainingPercent5h` | `5` |
| `preemptiveQuotaRemainingPercent7d` | `5` |
| `preemptiveQuotaMaxDeferralMs` | `7200000` |

`preemptiveQuotaMaxDeferralMs` is the fallback delay when a near-exhausted window has
missing, invalid, or stale reset data. A trusted future reset may schedule through the
reset time, subject to the scheduler's seven-day safety ceiling.

### Context Budget Guard (experimental)

| Key | Default |
| --- | --- |
| `contextBudgetGuardEnabled` | `false` |
| `contextBudgetGuardSoftPercent` | `65` |
| `contextBudgetGuardHardPercent` | `69` |
| `contextBudgetGuardModelWindowOverrides` | `{}` |

Ships disabled. When enabled, pauses the next forwarded request on a session once its
context usage crosses `contextBudgetGuardHardPercent` of the model's context window,
before the request reaches upstream — see [features.md](../features.md#context-budget-guard-experimental).
`contextBudgetGuardSoftPercent` only attaches a non-blocking
`x-codex-context-budget-percent` header; it never pauses a request. Window sizes come
from `lib/context-budget/model-context-windows.ts`'s best-effort estimates, which are
NOT verified against the ChatGPT Codex backend (see `docs/releases/v2.5.0.md`) — set
`contextBudgetGuardModelWindowOverrides` (`{ "<model>": <tokens> }`) to the real ceiling
once observed; an override always takes priority over the built-in estimate. No env var
overrides `contextBudgetGuardModelWindowOverrides` itself (a per-model map is not a
reasonable single env var), but the other three fields do:
`CODEX_AUTH_CONTEXT_BUDGET_GUARD_ENABLED`, `CODEX_AUTH_CONTEXT_BUDGET_SOFT_PCT`,
`CODEX_AUTH_CONTEXT_BUDGET_HARD_PCT`.

### Notifications

| Key | Default |
| --- | --- |
| `rateLimitToastDebounceMs` | `60000` |
| `toastDurationMs` | `5000` |

### Full env override matrix (pluginConfig accessors)

Every `pluginConfig` field above has a corresponding `get*` accessor in `lib/config.ts`. Common operator env names:

| Env | Field |
| --- | --- |
| `CODEX_MODE` | `codexMode` |
| `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` | `codexRuntimeRotationProxy` |
| `CODEX_TUI_V2` / `CODEX_TUI_COLOR_PROFILE` / `CODEX_TUI_GLYPHS` | TUI fields |
| `CODEX_AUTH_FAST_SESSION*` | fast-session fields |
| `CODEX_AUTH_RETRY_ALL_*` | all-accounts rate-limit retry fields |
| `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` / `CODEX_AUTH_FALLBACK_*` | unsupported-model policy |
| `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS` | `tokenRefreshSkewMs` |
| `CODEX_AUTH_SESSION_RECOVERY` / `CODEX_AUTH_AUTO_RESUME` | recovery |
| `CODEX_AUTH_PER_PROJECT_ACCOUNTS` | `perProjectAccounts` |
| `CODEX_AUTH_PARALLEL_PROBING*` | parallel probing |
| `CODEX_AUTH_EMPTY_RESPONSE_*` | empty-response retries |
| `CODEX_AUTH_RATE_LIMIT_*` | rate-limit windows / backoff / toast debounce |
| `CODEX_AUTH_LIVE_ACCOUNT_SYNC*` | live sync |
| `CODEX_AUTH_SESSION_AFFINITY*` | session affinity |
| `CODEX_AUTH_RESPONSE_CONTINUATION` / `CODEX_AUTH_BACKGROUND_RESPONSES` | response modes |
| `CODEX_AUTH_PROACTIVE_GUARDIAN*` | refresh guardian |
| `CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS` / `CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS` | failure cooldowns |
| `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS` / `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS` | anti-abuse |
| `CODEX_AUTH_STORAGE_BACKUP_ENABLED` | storage backups |
| `CODEX_AUTH_PREEMPTIVE_QUOTA_*` | preemptive quota |
| `CODEX_AUTH_PID_OFFSET_ENABLED` / `CODEX_AUTH_ROUTING_MUTEX` / `CODEX_AUTH_SCHEDULING_STRATEGY` | selection strategy |
| `CODEX_AUTH_FETCH_TIMEOUT_MS` / `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | timeouts |
| `CODEX_AUTH_TOAST_DURATION_MS` | toast duration |

Cross-process refresh lease knobs: `CODEX_AUTH_REFRESH_LEASE`, `CODEX_AUTH_REFRESH_LEASE_DIR`, `CODEX_AUTH_REFRESH_LEASE_TTL_MS`, `CODEX_AUTH_REFRESH_LEASE_WAIT_MS`, `CODEX_AUTH_REFRESH_LEASE_POLL_MS`, `CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS`.

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
| `CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS` | Absolute ceiling on a runtime helper's life regardless of activity (default 24h; `0` disables). The backstop that bounds the leak if activity accounting is ever wrong again |
| `CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS` | Idle window applied from the moment a helper's launcher is confirmed dead, and only while no client connection is open and the helper has never served a request (default 15m; `0` keeps the full idle timeout). Bounds helpers stranded by the detach grace; a helper that served traffic, or one with no recorded owner PID, stays on the idle timeout |
| `CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID` | Internal owner PID used by the wrapper-launched app helper |
| `CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS` | Internal owner process start time (epoch ms) the helper uses to tell its launcher from a later process that recycled the PID |
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
| `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS` | Cooldown after explicit upstream token invalidation (`tokenInvalidationCooldownMs`) |
| `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS` | Minimum interval between global account rotations (`minRotationIntervalMs`) |
| `CODEX_AUTH_ROUTING_MUTEX` | Routing mutex mode (`legacy` or `enabled`) |
| `CODEX_AUTH_PID_OFFSET_ENABLED` | Toggle PID-based hybrid selection offset (`pidOffsetEnabled`) |
| `CODEX_AUTH_BACKGROUND_RESPONSES` | Toggle background Responses compatibility (`backgroundResponses`) |
| `CODEX_MULTI_AUTH_FORCE_ACCOUNT` | Force one account for a single forwarded `codex-multi-auth-codex` run (`index`, email, or id). Ephemeral and fail-hard; equivalent to `--account` (flag wins when both are set). Requires the runtime rotation proxy |
| `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` | Internal: wrapper publishes a resolved 0-based index after `--account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT`. Runtime proxy consumes it as an ephemeral pin. Prefer `CODEX_MULTI_AUTH_FORCE_ACCOUNT` rather than setting this by hand |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI` | Toggle Codex CLI state sync |
| `CODEX_MULTI_AUTH_REAL_CODEX_BIN` | Force official Codex binary path |
| `CODEX_MULTI_AUTH_BYPASS` | Bypass local auth handling |
| `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE` | Opt out of wrapper-injected official Codex file-backed auth store when set to `0`; also skips the wrapper-startup `config.toml` reconcile (`scripts/codex.js`) |
| `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE` | Opt out of persisting `cli_auth_credentials_store = "file"` into `~/.codex/config.toml` when set to `0` (`lib/codex-cli/writer.ts`) |
| `CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP` | Opt out of best-effort active-account sync around forwarded Codex launches when set to `0` |
| `CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT` | Force or disable capture of forwarded Codex output for unsupported-model fallback handling |
| `CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD` | Install Windows shim guards when enabled |
| `CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD` | Install PowerShell profile guard when enabled |
| `CODEX_MULTI_AUTH_OVERWRITE_CUSTOM_BATCH_SHIM` | Allow Windows shim guard to overwrite custom shims when set to `1` |

### Official Codex CLI state paths

These point the Codex-CLI state layer (`lib/codex-cli/state.ts`) at non-default files. Useful for sandboxes and tests; rarely set by operators.

| Variable | Purpose |
| --- | --- |
| `CODEX_HOME` | Official Codex home. When set to a non-default path, multi-auth resolves strictly to `$CODEX_HOME/multi-auth` and does not scan `~/.codex/multi-auth` |
| `CODEX_CLI_AUTH_PATH` | Override the official `auth.json` path |
| `CODEX_CLI_ACCOUNTS_PATH` | Override the official `accounts.json` path |
| `CODEX_CLI_CONFIG_PATH` | Override the official `config.toml` path |
| `CODEX_AUTH_SYNC_CODEX_CLI` | Legacy alias for `CODEX_MULTI_AUTH_SYNC_CODEX_CLI`; read only when the canonical name is unset |

### Runtime rotation transport internals

Set by the wrapper for its own child processes. Not intended to be set by hand.

| Variable | Purpose |
| --- | --- |
| `CODEX_MULTI_AUTH_APP_ROTATION_USE_CANONICAL_HOME` | `1` when the app runtime helper must run against the canonical `CODEX_HOME` (interactive TUI, `resume`/`fork`, and `app-server` paths) instead of a shadow home |
| `CODEX_MULTI_AUTH_APP_ROTATION_INSTALL_APP_SERVER_SHIM` | `0` suppresses the app-server CLI shim in the helper. The shim only serves a Codex process that spawns its own `codex app-server` through `CODEX_CLI_PATH`; a wrapper-invoked `app-server` already carries the overrides on its command line and must not inherit the `CODEX_CLI_PATH` / `NODE_OPTIONS` / `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` environment the shim stamps |
| `CODEX_MULTI_AUTH_APP_SERVER_CONFIG_ARGS_JSON` | JSON array of `-c` provider overrides the app-server preload replays on the canonical-home path |
| `CODEX_MULTI_AUTH_RUNTIME_SHADOW_COPY_GENERATED_DIRS` | `1`/`true`/`yes` allows copying generated runtime directories into a shadow `CODEX_HOME` when they cannot be linked. Off by default: the wrapper skips such a directory rather than duplicating active runtime data |
| `CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY` | Import `scripts/codex.js` without running its main entrypoint (used by the preload shim) |
| `CODEX_MULTI_AUTH_CLI_VERSION` | Version string the manager publishes for the dashboard header |
| `CODEX_MULTI_AUTH_UPDATE_NOTICE_STARTUP_BUDGET_MS` | Time budget for the best-effort daily update check during wrapper startup |

### Auth flow

Consumed by the OAuth login path (`lib/auth/`, `lib/runtime/manual-oauth-flow.ts`) in both the CLI and the plugin host.

| Variable | Purpose |
| --- | --- |
| `CODEX_AUTH_ACCOUNT_ID` | Bind an OAuth login to an explicit ChatGPT account/workspace id. This is the override mechanism behind `codex-multi-auth login --org <org_id>`, which lets the same email register its personal and its business/team workspace as separate accounts |
| `CODEX_AUTH_NO_BROWSER` | Force the manual callback flow instead of launching a browser |

### Plugin-host request pipeline

Consumed by the optional plugin-host runtime (`index.ts`) rather than the CLI.

| Variable | Purpose |
| --- | --- |
| `CODEX_AUTH_FAILOVER_MODE` | `conservative`, `balanced` (default; also the fallback for any unrecognised value), or `aggressive`. Selects the per-mode defaults below. Same-account retries: conservative `2`, balanced `1`, aggressive `0`. Soft stall timeout: `20000` / `15000` / `10000` ms |
| `CODEX_AUTH_STREAM_FAILOVER_MAX` | Maximum stream failover attempts. The declared per-mode defaults are `2` / `2` / `1` (conservative / balanced / aggressive), but every value — default or override — passes through `capStreamFailoverMax`, which clamps to `0..1`. **Effective defaults are therefore `1` / `1` / `1`**, and the only override that changes behaviour is `0` (disable failover entirely); anything `>= 1` yields one failover |
| `CODEX_AUTH_STREAM_STALL_SOFT_TIMEOUT_MS` | Soft stream-stall threshold before failover is considered; overrides the per-mode default, floor `1000` ms |
| `CODEX_AUTH_STREAM_STALL_HARD_TIMEOUT_MS` | Hard stream-stall threshold that aborts the stream; never lower than the soft threshold, and defaults to `streamStallTimeoutMs` |
| `CODEX_AUTH_PREWARM` | Set `0` to disable connection prewarming |
| `CODEX_COLLABORATION_MODE` | Collaboration-mode hint applied by the request transformer |
| `CODEX_THREAD_ID` | Thread id used as the session-affinity key. Takes precedence over the host-supplied prompt cache key |
| `CODEX_SKIP_EMAIL_HYDRATE` | Set `1` to skip best-effort account email hydration |
| `CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS` | Set `1` to expose admin tools on the plugin-host tool surface |

### Benchmark and matrix scripts

Used only by `scripts/` tooling, not by the shipped runtime.

| Variable | Purpose |
| --- | --- |
| `CODEX_MATRIX_TIMEOUT_MS` | Per-probe timeout for `npm run test:model-matrix` |
| `CODEX_MODELS_TIMEOUT_MS` | Timeout for model listing in the edit-format benchmark harness |

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
