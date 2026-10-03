# Config Fields Reference

Complete field and environment-variable inventory for runtime configuration, display settings, the wrapper, and the runtime rotation proxy. Every `pluginConfig` row lists the persisted field, its type, its `DEFAULT_PLUGIN_CONFIG` value, and the environment variable whose value overrides it at read time.

Boolean env overrides accept `1`/`0`, `true`/`false`, `yes`/`no` (case-insensitive); unparseable values are ignored with a one-time warning. Enum env overrides accept only the listed values (trimmed, lowercased). Numeric env overrides are clamped to the bounds shown in the default column.

Maintainer walkthrough of how these resolve: [CONFIG_FLOW.md](CONFIG_FLOW.md). User-facing guide: [../configuration.md](../configuration.md).

* * *

## Paths and roots

| Variable | Purpose |
| --- | --- |
| `CODEX_MULTI_AUTH_DIR` | Override the multi-auth root directory (`~/.codex/multi-auth` by default). Settings, accounts, cache, logs, governance state, and the app-helper status files all resolve under it |
| `CODEX_HOME` | Official Codex home. When set to a non-default path, the multi-auth root resolves strictly to `$CODEX_HOME/multi-auth` — no cross-root scan for existing pools |
| `CODEX_MULTI_AUTH_CONFIG_PATH` | Alternate pluginConfig file. Load: used only when set **and the file exists**. Save: always the preferred target while set. `config explain` reports it as the active source |
| `CODEX_CLI_AUTH_PATH` | Override the official `auth.json` path (`lib/codex-cli/state.ts`) |
| `CODEX_CLI_ACCOUNTS_PATH` | Override the official `accounts.json` path |
| `CODEX_CLI_CONFIG_PATH` | Override the official `config.toml` path |
| `OC_CODEX_MULTI_AUTH_DIR` | Explicit root for the `~/.opencode`-style multi-auth account-store detection (`lib/oc-chatgpt-target-detection.ts`); overrides both the global and project-scoped candidate scan. Legacy `OC_CHATGPT_MULTI_AUTH_DIR` is still accepted as a fallback |
| `CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME` | Codex home used by packaged-app bind helpers instead of the resolved one |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_WINDOWS_DESKTOP_DIR` | Windows desktop shortcut search root for launcher routing |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_MACOS_DIR` | macOS managed wrapper app install directory |
| `CODEX_MULTI_AUTH_REAL_CODEX_HOME` | Internal: original Codex home pointer passed to runtime helpers when a shadow `CODEX_HOME` is in play |
| `CODEX_MULTI_AUTH_REAL_CODEX_BIN` | Force the official Codex binary path (absolute path required; relative values are rejected) |
| `CODEX_MULTI_AUTH_USAGE_CODEX_BIN` | Codex binary used for usage/native-rate-limit lookups; must be an absolute path that exists |
| `CODEX_BIN` | Benchmark scripts only (`scripts/bench-format/`, `scripts/test-model-matrix.js`): Codex binary under test |

### Settings file

Canonical settings file: `<multi-auth root>/settings.json` with a `.bak` sibling for recovery. Top-level shape:

```json
{
  "version": 1,
  "dashboardDisplaySettings": { "...": "..." },
  "pluginConfig": { "...": "..." }
}
```

`version` is forced to `1` on write. The two sections are independent; unknown top-level keys survive a save. Reads fall back to `.bak` when the primary is unreadable; writes take a queue + `wx` lockfile, snapshot a backup, then temp-write + rename with `EBUSY`/`EPERM` retries (see [Concurrency and Windows notes](#concurrency-and-windows-notes)).

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

## `pluginConfig` fields

`pluginConfig` is the persisted compatibility name for runtime settings, stored in the `pluginConfig` section of `settings.json` (or in the `CODEX_MULTI_AUTH_CONFIG_PATH` file / a legacy config file). Every field has a `get*` accessor in `lib/config.ts` that resolves **env → config value → hardcoded default → clamp**, so the env column below is the per-process override that wins over the file.

### Core UX

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `codexMode` | boolean | `true` | `CODEX_MODE` |
| `codexRuntimeRotationProxy` | boolean | `true` | `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` |
| `codexTuiV2` | boolean | `true` | `CODEX_TUI_V2` |
| `codexTuiColorProfile` | enum | `truecolor` | `CODEX_TUI_COLOR_PROFILE` (`truecolor`\|`ansi16`\|`ansi256`) |
| `codexTuiGlyphMode` | enum | `ascii` | `CODEX_TUI_GLYPHS` (`ascii`\|`unicode`\|`auto`; `auto` resolves via `WT_SESSION`/`TERM_PROGRAM`/`TERM`) |

`codexRuntimeRotationProxy` enables the wrapper/app local Responses proxy path — see [../configuration.md](../configuration.md#runtime-rotation-proxy).

### Fast session

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `fastSession` | boolean | `false` | `CODEX_AUTH_FAST_SESSION` |
| `fastSessionStrategy` | enum | `hybrid` | `CODEX_AUTH_FAST_SESSION_STRATEGY` (`hybrid`\|`always`) |
| `fastSessionMaxInputItems` | number | `30` | `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS` (min `8`; schema range 8–200) |

### Retry, fallback, and scheduling

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `schedulingStrategy` | enum | `hybrid` | `CODEX_AUTH_SCHEDULING_STRATEGY` (`hybrid`\|`sequential`) |
| `retryAllAccountsRateLimited` | boolean | `false` | `CODEX_AUTH_RETRY_ALL_RATE_LIMITED` |
| `retryAllAccountsMaxWaitMs` | number | `0` | `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS` (min `0`) |
| `retryAllAccountsMaxRetries` | number | `0` | `CODEX_AUTH_RETRY_ALL_MAX_RETRIES` (min `0`) |
| `unsupportedCodexPolicy` | enum | `strict` | `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` (`strict`\|`fallback`); legacy boolean `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` still honored (`true`→`fallback`, `false`→`strict`) |
| `fallbackOnUnsupportedCodexModel` | boolean | `false` | Legacy companion to `unsupportedCodexPolicy`; effective value resolves through the same policy chain (env policy → config policy → legacy env → legacy bool → `strict`) |
| `fallbackToGpt52OnUnsupportedGpt53` | boolean | `true` | `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` |
| `unsupportedCodexFallbackChain` | record | `{}` | none (per-model map; no env override) |
| `routingMutex` | enum | `legacy` | `CODEX_AUTH_ROUTING_MUTEX` (`legacy`\|`enabled`) |

`schedulingStrategy` picks how the runtime proxy selects an account per request. `hybrid` keeps the weighted health/token/freshness selection that spreads load across accounts. `sequential` (drain-first) sticks to one active account until it is fully exhausted, then advances; earlier accounts become eligible again as soon as their quota window recovers. A manual pin still wins, and sequential mode ignores per-session affinity.

`routingMutex` serializes account selection + cursor advance on the proxy hot path *within one process*. `"legacy"` (default) runs selection inline for historical performance; `"enabled"` takes a process-local reentrant async mutex around selection commits. It does nothing across separate processes — see [Concurrency and Windows notes](#concurrency-and-windows-notes).

### Token refresh and recovery

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `tokenRefreshSkewMs` | number | `60000` | `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS` (min `0`) |
| `sessionRecovery` | boolean | `true` | `CODEX_AUTH_SESSION_RECOVERY` |
| `autoResume` | boolean | `true` | `CODEX_AUTH_AUTO_RESUME` |
| `responseContinuation` | boolean | `false` | `CODEX_AUTH_RESPONSE_CONTINUATION` |
| `backgroundResponses` | boolean | `false` | `CODEX_AUTH_BACKGROUND_RESPONSES` |
| `proactiveRefreshGuardian` | boolean | `true` | `CODEX_AUTH_PROACTIVE_GUARDIAN` |
| `proactiveRefreshIntervalMs` | number | `60000` | `CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS` (min `5000`) |
| `proactiveRefreshBufferMs` | number | `300000` | `CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS` (min `30000`) |

`tokenRefreshSkewMs` refreshes access tokens this many milliseconds before expiry so cross-process refresh coordination has headroom. Cross-process refresh itself uses lease/state files (`lib/refresh-lease.ts`, `lib/refresh-queue.ts`) so concurrent processes do not stampede the same refresh token — its env knobs are in the [internal env](#internal-and-test-environment-variables) section.

`backgroundResponses` is an opt-in compatibility switch for Responses API `background: true` requests. When enabled, those requests become stateful (`store=true`) instead of following the default stateless Codex routing. Leave it off for stateless pipelines; enabling it forces `store=true`, preserves input item IDs, and loses stateless-only defaults such as fast-session trimming. Test one known `background: true` request end to end before rolling it across shared automation.

### Storage and sync

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `perProjectAccounts` | boolean | `true` | `CODEX_AUTH_PER_PROJECT_ACCOUNTS` |
| `storageBackupEnabled` | boolean | `true` | `CODEX_AUTH_STORAGE_BACKUP_ENABLED` |
| `liveAccountSync` | boolean | `true` | `CODEX_AUTH_LIVE_ACCOUNT_SYNC` |
| `liveAccountSyncDebounceMs` | number | `250` | `CODEX_AUTH_LIVE_ACCOUNT_SYNC_DEBOUNCE_MS` (min `50`) |
| `liveAccountSyncPollMs` | number | `2000` | `CODEX_AUTH_LIVE_ACCOUNT_SYNC_POLL_MS` (min `500`) |

### Session affinity

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `sessionAffinity` | boolean | `true` | `CODEX_AUTH_SESSION_AFFINITY` |
| `sessionAffinityTtlMs` | number | `1200000` | `CODEX_AUTH_SESSION_AFFINITY_TTL_MS` (min `1000`) |
| `sessionAffinityMaxEntries` | number | `512` | `CODEX_AUTH_SESSION_AFFINITY_MAX_ENTRIES` (min `8`) |

### Reliability, timeouts, and probes

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `parallelProbing` | boolean | `false` | `CODEX_AUTH_PARALLEL_PROBING` |
| `parallelProbingMaxConcurrency` | number | `2` | `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY` (min `1`; schema range 1–5) |
| `emptyResponseMaxRetries` | number | `2` | `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES` (min `0`) |
| `emptyResponseRetryDelayMs` | number | `1000` | `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS` (min `0`) |
| `pidOffsetEnabled` | boolean | `true` | `CODEX_AUTH_PID_OFFSET_ENABLED` |
| `fetchTimeoutMs` | number | `60000` | `CODEX_AUTH_FETCH_TIMEOUT_MS` (min `1000`) |
| `streamStallTimeoutMs` | number | `45000` | `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` (min `1000`) |
| `networkErrorCooldownMs` | number | `6000` | `CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS` (min `0`) |
| `serverErrorCooldownMs` | number | `4000` | `CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS` (min `0`) |
| `tokenInvalidationCooldownMs` | number | `300000` | `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS` (min `0`) |
| `minRotationIntervalMs` | number | `60000` | `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS` (min `0`) |
| `rateLimitDedupWindowMs` | number | `2000` | `CODEX_AUTH_RATE_LIMIT_DEDUP_WINDOW_MS` (min `0`) |
| `rateLimitStateResetMs` | number | `120000` | `CODEX_AUTH_RATE_LIMIT_STATE_RESET_MS` (min `1000`) |
| `rateLimitMaxBackoffMs` | number | `60000` | `CODEX_AUTH_RATE_LIMIT_MAX_BACKOFF_MS` (min `1000`) |
| `rateLimitShortRetryThresholdMs` | number | `5000` | `CODEX_AUTH_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS` (min `0`) |

`pidOffsetEnabled` adds a small deterministic PID-based score offset so parallel wrapper processes bias toward different accounts under high concurrency. Manual pins and health/quota scoring still take precedence. (The getter's hardcoded fallback is `false`, but the shipped `DEFAULT_PLUGIN_CONFIG` value is `true`, so the effective default is on.)

`tokenInvalidationCooldownMs` (explicit upstream revocation, 5-minute default) and `minRotationIntervalMs` (last-served bias window, `0` disables) are the anti-abuse knobs used by the runtime rotation proxy — see [../configuration.md](../configuration.md#runtime-rotation-proxy).

### Quota deferral

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `preemptiveQuotaEnabled` | boolean | `true` | `CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED` |
| `preemptiveQuotaRemainingPercent5h` | number | `5` | `CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT` (0–100) |
| `preemptiveQuotaRemainingPercent7d` | number | `5` | `CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT` (0–100) |
| `preemptiveQuotaMaxDeferralMs` | number | `7200000` | `CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS` (min `1000`) |

`preemptiveQuotaMaxDeferralMs` is the fallback delay when a near-exhausted window has missing, invalid, or stale reset data. A trusted future reset may schedule through the reset time, subject to the scheduler's seven-day safety ceiling.

### Context Budget Guard (experimental)

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `contextBudgetGuardEnabled` | boolean | `false` | `CODEX_AUTH_CONTEXT_BUDGET_GUARD_ENABLED` |
| `contextBudgetGuardSoftPercent` | number | `65` | `CODEX_AUTH_CONTEXT_BUDGET_SOFT_PCT` (0–100) |
| `contextBudgetGuardHardPercent` | number | `69` | `CODEX_AUTH_CONTEXT_BUDGET_HARD_PCT` (10–100) |
| `contextBudgetGuardModelWindowOverrides` | record | `{}` | none (per-model map; no env override) |

Ships disabled. When enabled, pauses the next forwarded request on a session once its context usage crosses `contextBudgetGuardHardPercent` of the model's context window, before the request reaches upstream — see [features.md](../features.md#context-budget-guard-experimental). `contextBudgetGuardSoftPercent` only attaches a non-blocking `x-codex-context-budget-percent` header; it never pauses a request. Window sizes come from `lib/context-budget/model-context-windows.ts`'s best-effort estimates, which are NOT verified against the ChatGPT Codex backend — set `contextBudgetGuardModelWindowOverrides` (`{ "<model>": <tokens> }`) to the real ceiling once observed; an override always wins over the built-in estimate.

`contextBudgetGuardHardPercent` accepts `10`–`100`. A hard threshold below that is cleared by every measurement, which would pause every session from its first turn, so lower values are rejected by the schema and clamped by the runtime. A hard pause is one-shot per measurement: it is emitted, then the tracked usage for that session is dropped so the next request is forwarded and re-measured.

### Notifications

| Field | Type | Default | Env override |
| --- | --- | --- | --- |
| `rateLimitToastDebounceMs` | number | `60000` | `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS` (min `0`) |
| `toastDurationMs` | number | `5000` | `CODEX_AUTH_TOAST_DURATION_MS` (min `1000`) |

* * *

## Runtime proxy and wrapper environment

Read by `scripts/codex.js` (the `codex-multi-auth-codex` wrapper) or the runtime rotation proxy it starts. Operator-facing rows come first; internal rows are set by the wrapper for its own child processes and are not meant to be set by hand.

### Operator-facing

| Variable | Purpose |
| --- | --- |
| `CODEX_MULTI_AUTH_BYPASS` | `1` skips local auth handling and forwards everything to official Codex |
| `CODEX_MULTI_AUTH_FORCE_ACCOUNT` | Force one account for a single forwarded run (`index`, email, or id). Ephemeral and fail-hard; equivalent to `--account` (flag wins when both are set). Requires the runtime rotation proxy |
| `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` | Per-process override of `pluginConfig.codexRuntimeRotationProxy` |
| `CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL` | Pin the proxy upstream to an explicit-port `http://<numeric-loopback>:<port>` URL. Setting it when the forwarded command does not route through the proxy fails closed rather than silently ignoring it |
| `CODEX_MULTI_AUTH_MODEL_CAPACITY_RETRY_MS` | Wait-and-retry window when every account signals model capacity pressure (default `600000`, cap `3600000`, `0` disables; unparseable values fall back to the default rather than disabling) |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI` | `0`/`1` toggle for active-account sync into official Codex CLI files (default on). Legacy `CODEX_AUTH_SYNC_CODEX_CLI` is read only when the canonical name is unset and logs a deprecation warning |
| `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE` | `0` opts out of every persisted `cli_auth_credentials_store = "file"` rewrite in `~/.codex/config.toml` (first-run, switch/login sync, `doctor --fix`; `lib/codex-cli/writer.ts`) |
| `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE` | `0` skips the wrapper-injected `-c` file auth store override and the wrapper-startup `config.toml` reconcile |
| `CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP` | `0` skips best-effort active-account sync around forwarded Codex launches |
| `CODEX_MULTI_AUTH_STATUSLINE` | `0`/`1` toggles the forwarded-session status line (TTY default) |
| `CODEX_MULTI_AUTH_STATUS_QUOTA_REFRESH_INTERVAL_MS` | Minimum age before the wrapper refreshes quota cache for status displays (default `600000`; `0` always refreshes) |
| `CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT` | `1`/`0` forces capture of forwarded Codex output for unsupported-model fallback handling (default: on when not a TTY or `CODEX_CI=1`) |
| `CODEX_CI` | `1` marks CI runs for the wrapper: forces forward-output capture and silences known noisy `codex_core` log targets via `RUST_LOG` when unset |
| `CODEX_MULTI_AUTH_DEBUG` | `1` enables verbose wrapper/debug notices (also shows the npm update notice off-TTY) |
| `CODEX_MULTI_AUTH_UPDATE_NOTICE_STARTUP_BUDGET_MS` | Total ms budget for the daily best-effort npm version check (default `3000`; ~80% becomes the fetch timeout) |
| `CODEX_MULTI_AUTH_CLI_VERSION` | Version string the manager publishes for the dashboard header (set by `scripts/codex-multi-auth.js --version` path) |
| `CODEX_MULTI_AUTH_APP_BIND` | Live first-run gate: explicit `0`/`1` for the packaged Codex app bind, checked **before** `CODEX_MULTI_AUTH_APP_BIND_INSTALL` (`lib/runtime/first-run.ts`) |
| `CODEX_MULTI_AUTH_APP_BIND_INSTALL` | `0`/`1` second gate for the packaged app bind self-heal on first durable CLI run or `rotation enable` |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL` | `0`/`1` gate for user-level launcher routing on first durable CLI run or `rotation enable` |
| `CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS` | Idle shutdown for the wrapper-launched app helper (default 12h, min `50`) |
| `CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS` | Absolute ceiling on a helper's life regardless of activity (default 24h; `0` disables). Backstop that bounds the leak if activity accounting is ever wrong |
| `CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS` | Idle window applied once a helper's launcher is confirmed dead, and only while no client connection is open and the helper has never served a request (default 15m; `0` keeps the full idle timeout) |
| `CODEX_MULTI_AUTH_APP_ROTATION_DETACH_GRACE_MS` | Grace window before a detached helper is treated as launcher-dead (default `5000`) |
| `CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD` | `1` installs Windows shim guards |
| `CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD` | `1` installs the PowerShell profile guard |
| `CODEX_MULTI_AUTH_OVERWRITE_CUSTOM_BATCH_SHIM` | `1` lets the Windows shim guard overwrite custom shims |
| `CODEX_AUTH_ACCOUNT_ID` | Account-id override for login flows; the `--org` flag wins when both are set |
| `CODEX_AUTH_NO_BROWSER` | Suppress browser launch for automation/headless login |
| `CODEX_SKIP_EMAIL_HYDRATE` | `1` skips the post-login email hydration pass |
| `CODEX_AUTH_STORAGE_BACKUP_MIN_INTERVAL_MS` | Minimum interval between storage backups (default `30000`; `0` rotates on every save) |
| `MCODEX_MONITOR_INTERVAL` | `mcodex --monitor` refresh interval in seconds (default 5, regex-validated) |
| `MCODEX_TMUX_SESSION` | `mcodex --tmux` session name (default `mcodex`) |
| `MCODEX_TMUX_HISTORY_LIMIT` | `mcodex --tmux` pane history limit |

### Cross-process refresh lease

`lib/refresh-lease.ts` / `lib/refresh-queue.ts` coordinate OAuth token refreshes across concurrent processes with lease/state files so they do not stampede the same refresh token. All six knobs are live:

| Variable | Purpose |
| --- | --- |
| `CODEX_AUTH_REFRESH_LEASE` | `0`/`1` master toggle for the cross-process refresh lease path (default on) |
| `CODEX_AUTH_REFRESH_LEASE_DIR` | Lease directory override |
| `CODEX_AUTH_REFRESH_LEASE_TTL_MS` | Lease record TTL |
| `CODEX_AUTH_REFRESH_LEASE_WAIT_MS` | How long a non-holder waits for the holder's refresh result |
| `CODEX_AUTH_REFRESH_LEASE_POLL_MS` | Wait-loop poll interval |
| `CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS` | How long a completed refresh result stays readable by waiters |

### Internal transport variables (set by the wrapper, not by hand)

| Variable | Purpose |
| --- | --- |
| `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` | 0-based pin the wrapper publishes after resolving `--account`/`CODEX_MULTI_AUTH_FORCE_ACCOUNT`; consumed once by the runtime proxy |
| `CODEX_MULTI_AUTH_STATUS_REFRESH_CHILD` | Marks a spawned status-refresh child process |
| `CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID` | Owner PID the app helper uses to detect launcher death |
| `CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS` | Owner process start time (epoch ms) so the helper can tell its launcher from a PID that was recycled |
| `CODEX_MULTI_AUTH_APP_ROTATION_USE_CANONICAL_HOME` | `1` when the app helper must run against the canonical `CODEX_HOME` (interactive TUI, `resume`/`fork`, `app-server`) instead of a shadow home |
| `CODEX_MULTI_AUTH_APP_ROTATION_INSTALL_APP_SERVER_SHIM` | `0` suppresses the app-server CLI shim in the helper; a wrapper-invoked `app-server` already carries its overrides on the command line |
| `CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL` | Account label the app-server shim reports |
| `CODEX_MULTI_AUTH_APP_SERVER_CONFIG_ARGS_JSON` | JSON array of `-c` provider overrides the app-server preload replays on the canonical-home path |
| `CODEX_MULTI_AUTH_RUNTIME_SHADOW_COPY_GENERATED_DIRS` | `1`/`true`/`yes` allows copying generated runtime dirs into a shadow `CODEX_HOME` when they cannot be linked (off by default: the wrapper skips rather than duplicates active runtime data) |
| `CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY` | Import `scripts/codex.js` without running its main entrypoint (preload shim) |
| `CODEX_MULTI_AUTH_NATIVE_OPENAI` | `1` marks the bound packaged app provider as native OpenAI in app-bind status (`lib/runtime/app-bind.ts`) |
| `CODEX_CLI_PATH` | Propagated to helper children that spawn their own `codex app-server` |
| `NODE_OPTIONS` / `OPENAI_API_KEY` / `RUST_LOG` | Propagated to forwarded/helper processes (`OPENAI_API_KEY` is a random per-process proxy client key, not a real key) |

### Plugin-host-only variables

Used by `index.ts` / `lib/` on the optional plugin-host path, not by the wrapper:

| Variable | Purpose |
| --- | --- |
| `CODEX_AUTH_FAILOVER_MODE` | Failover posture (`conservative`/`balanced`/`aggressive`-style modes; sets the same-account retry budget and the stream-failover defaults below) |
| `CODEX_AUTH_STREAM_FAILOVER_MAX` | Max stream failovers per request (per-mode default) |
| `CODEX_AUTH_STREAM_STALL_SOFT_TIMEOUT_MS` | Soft stall timeout that triggers stream failover (min `1000`) |
| `CODEX_AUTH_STREAM_STALL_HARD_TIMEOUT_MS` | Hard stall timeout (defaults to `streamStallTimeoutMs`; never below the soft timeout) |
| `CODEX_AUTH_PREWARM` | `0` skips the startup prompt-template prewarm (also skipped under `VITEST`/`NODE_ENV=test`) |
| `CODEX_THREAD_ID` | Thread-id override used as the prompt-cache key |
| `CODEX_COLLABORATION_MODE` | `plan`\|`default` request collaboration mode (`lib/request/request-transformer.ts`) |
| `CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS` | `1` exposes admin tool surface in the plugin host |
| `CODEX_PROMPT_SOURCE_URL` / `CODEX_CODEX_PROMPT_URL` | Prompt-template source overrides (`lib/prompts/`) |
| `ENABLE_PLUGIN_REQUEST_LOGGING` | `1` enables request logging (`lib/logger.ts`) |
| `CODEX_PLUGIN_LOG_BODIES` | `1` logs request bodies (sensitive; see SECURITY.md) |
| `DEBUG_CODEX_PLUGIN` | `1` enables debug logging (implied by request logging) |
| `CODEX_PLUGIN_LOG_LEVEL` | Log level override |
| `CODEX_CONSOLE_LOG` | `1` mirrors logs to console |
| `FORCE_INTERACTIVE_MODE` | `1` forces non-interactive detection off (`lib/cli.ts`) |
| `CODEX_TUI` / `CODEX_DESKTOP` | `1` marks the session as TUI/desktop for interactive detection |
| `ELECTRON_RUN_AS_NODE` | `1` marks an Electron-as-node host for interactive detection |
| `TERM_PROGRAM` / `WT_SESSION` / `TERM` | Terminal detection inputs (also drive `codexTuiGlyphMode` `auto`) |

* * *

## Internal and test environment variables

### Test-only fault injectors

`CODEX_MULTI_AUTH_TEST_*` names are consumed only by tests and must never be set in normal use. The family includes `CODEX_MULTI_AUTH_TEST_FAULT_INJECTION`, `CODEX_MULTI_AUTH_TEST_STARTUP_UPDATE_NOTICE_BUDGET_MS` (update-notice budget alias read after `CODEX_MULTI_AUTH_UPDATE_NOTICE_STARTUP_BUDGET_MS`), `CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_DIR_COPY`, `CODEX_MULTI_AUTH_TEST_SHADOW_RETRY_MARKER_DIR`, `CODEX_MULTI_AUTH_TEST_SHADOW_LOCK_RECREATE_STALE_COUNT`, `CODEX_MULTI_AUTH_TEST_SHADOW_LOCK_OWNER_WRITE_FAILURES`, `CODEX_MULTI_AUTH_TEST_SHADOW_PREFLIGHT_READ_BUSY_FAILURES`, `CODEX_MULTI_AUTH_TEST_SHADOW_CLEANUP_BUSY_FAILURES`, `CODEX_MULTI_AUTH_TEST_SHADOW_SYNC_METADATA_BUSY_FAILURES`, `CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_SIDECAR_PLACEHOLDER_FAILURE`, `CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_SQLITE_SIDECAR_LINK_FAILURE`, `CODEX_MULTI_AUTH_TEST_APP_SERVER_SHIM_COPY_BUSY_FAILURES`, `CODEX_MULTI_AUTH_TEST_APP_SERVER_SHIM_FILE_CLEANUP_BUSY_FAILURES`, and `CODEX_MULTI_AUTH_TEST_HELPER_METADATA_CLEANUP_BUSY_FAILURES`.

Benchmark scripts additionally read `CODEX_MATRIX_TIMEOUT_MS` and `CODEX_MODELS_TIMEOUT_MS` (default `30000`).

### Platform and harness detection

These are read, not owned, by this project — they shape behavior but are not configuration:

- `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `XDG_DATA_HOME`, `PATH`, `PATHEXT` — home/config/data path resolution on Linux/macOS/Windows.
- `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `BUILDKITE`, `TF_BUILD`, `TEAMCITY_VERSION`, `JENKINS_URL`, `TRAVIS`, `APPVEYOR`, `BITBUCKET_BUILD_NUMBER`, `npm_config_ignore_scripts` — first-run setup skips CI and `npm --ignore-scripts` environments (`lib/runtime/first-run.ts`).
- `VITEST`, `NODE_ENV`, `VITEST_WORKER_ID` — test-mode gating (e.g. prewarm skip, per-worker temp roots).
- `WSL_DISTRO_NAME`, `WSL_INTEROP` — WSL detection for OAuth callback port/browser guidance (`lib/wsl.ts`).

* * *

## `dashboardDisplaySettings` fields

### General display

| Key | Default |
| --- | --- |
| `showPerAccountRows` | `true` |
| `showQuotaDetails` | `true` |
| `showForecastReasons` | `true` |
| `showRecommendations` | `true` |
| `showLiveProbeNotes` | `true` |

### Result screen behavior

| Key | Default |
| --- | --- |
| `actionAutoReturnMs` | `2000` |
| `actionPauseOnKey` | `true` |

### Dashboard fetch and sort

| Key | Default |
| --- | --- |
| `menuAutoFetchLimits` | `true` |
| `menuQuotaTtlMs` | `300000` |
| `menuSortEnabled` | `true` |
| `menuSortMode` | `ready-first` |
| `menuSortPinCurrent` | `false` |
| `menuSortQuickSwitchVisibleRow` | `true` |

### Account row content

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

### Visual style

| Key | Default |
| --- | --- |
| `uiThemePreset` | `green` |
| `uiAccentColor` | `green` |
| `uiColorMode` | `auto` |
| `menuLayoutMode` | `compact-details` |
| `menuFocusStyle` | `row-invert` |
| `menuHighlightCurrentRow` | `true` |

* * *

## Concurrency and Windows notes

- Config and settings reads retry transient `EBUSY`/`EPERM`/`EAGAIN` errors (`readFileSyncWithConfigRetry`, 5 immediate attempts) so a momentary Windows AV/indexer or editor lock does not silently fall back to defaults. On exhaustion the last error surfaces so the caller reports the source as unreadable instead of loading stale/empty content.
- `settings.json` writes take an in-process queue plus a cross-process `wx` lockfile, snapshot a `.bak` backup, then temp-write + rename with `EBUSY`/`EPERM` retries; the async path adds an mtime compare-and-swap loop with `ESTALE` re-read/re-merge.
- `CODEX_MULTI_AUTH_CONFIG_PATH` saves use the same queue + `wx` lockfile and an mtime CAS merge that preserves unknown keys; an unreadable target aborts with a `StorageError` (`UNREADABLE`) rather than clobbering the file.
- Cross-process refresh coordination (`CODEX_AUTH_REFRESH_LEASE*`) uses lease files with TTL + wait/poll so two processes refreshing the same account do not stampede the refresh token.
- `routingMutex` only serializes selection *within one process*; `pidOffsetEnabled` is the cross-process lever. Neither replaces a bigger account pool under a many-agent swarm.
- The app-helper lifecycle knobs (`CODEX_MULTI_AUTH_APP_ROTATION_*`) exist because Windows process-launcher detachment can strand helpers: detached idle, detach grace, owner PID + start-time, and the max-lifetime backstop bound how long an orphaned helper may live.
- Per-process env overrides apply at read time inside each `get*` accessor — a running process picks up a `process.env` change, but a separate process never sees another process's env.

* * *

## Related

- [CONFIG_FLOW.md](CONFIG_FLOW.md) — resolution order walkthrough
- [../configuration.md](../configuration.md) — user-facing configuration guide
- [../reference/settings.md](../reference/settings.md) — dashboard/settings-hub reference
- [../reference/storage-paths.md](../reference/storage-paths.md) — every file path the runtime touches
