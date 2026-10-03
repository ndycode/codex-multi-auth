# Settings Reference

Reference for dashboard display settings and runtime `pluginConfig` values,
reachable from `codex-multi-auth login` → `Settings` (interactive TTY only —
six panels: Account List View, Summary Line, Menu Behavior, Color Theme,
Experimental, Backend Controls; `Q` cancels without saving on every panel, the
theme panel live-previews and restores the baseline on cancel, and edits
persist through a keyed merge into the settings file).

`pluginConfig` is the persisted compatibility name for runtime settings. It
covers wrapper/runtime rotation behavior and optional plugin-host behavior.
Defaults below match `DEFAULT_PLUGIN_CONFIG` in `lib/config.ts` (package `2.19.0`).

---

## Settings location

Default file: `~/.codex/multi-auth/settings.json` (moves with
`CODEX_MULTI_AUTH_DIR`; `.bak` sibling stores the last valid snapshot for
recovery).

Top-level objects:

- `dashboardDisplaySettings`
- `pluginConfig`

---

## Account List View

Controls account-row display and sort behavior.

- `menuShowStatusBadge`
- `menuShowCurrentBadge`
- `menuShowLastUsed`
- `menuShowQuotaSummary`
- `menuShowQuotaCooldown`
- `menuShowFetchStatus`
- `menuShowDetailsForUnselectedRows`
- `menuHighlightCurrentRow`
- `menuSortEnabled`
- `menuSortMode`
- `menuSortPinCurrent`
- `menuSortQuickSwitchVisibleRow`
- `menuLayoutMode`

| Key | Default | Effect |
| --- | --- | --- |
| `menuShowStatusBadge` | `true` | Show ready/cooldown/disabled status badges on account rows |
| `menuShowCurrentBadge` | `true` | Mark the current account row |
| `menuShowLastUsed` | `true` | Include last-used text in row details |
| `menuShowQuotaSummary` | `true` | Show compact quota usage summaries |
| `menuShowQuotaCooldown` | `true` | Show quota reset/cooldown details |
| `menuShowFetchStatus` | `true` | Show quota fetch/probe status text |
| `menuShowDetailsForUnselectedRows` | `false` | Expand details for unselected rows |
| `menuHighlightCurrentRow` | `true` | Emphasize the current account row |
| `menuSortEnabled` | `true` | Enable menu sorting |
| `menuSortMode` | `ready-first` | Sort rows by readiness/risk heuristic |
| `menuSortPinCurrent` | `false` | Keep the current account pinned while sorting |
| `menuSortQuickSwitchVisibleRow` | `true` | Keep quick-switch numbering aligned to visible sorted rows |
| `menuLayoutMode` | `compact-details` | Compact or expanded row layout |

## Summary Line

Controls the fields shown in the per-account summary line.

- `menuStatuslineFields`
- `last-used`
- `limits`
- `status`

| Key | Default | Effect |
| --- | --- | --- |
| `menuStatuslineFields` | `last-used, limits, status` | Which summary fields appear and in what order |

## Menu Behavior

Controls result-screen return behavior and menu quota refresh behavior.

| Key | Default | Effect |
| --- | --- | --- |
| `actionAutoReturnMs` | `2000` | Delay before returning from action/result screens |
| `actionPauseOnKey` | `true` | Pause on keypress before auto-return completes |
| `menuAutoFetchLimits` | `true` | Refresh quota snapshots automatically in the menu |
| `menuQuotaTtlMs` | `300000` | Reuse cached quota data before refetching |

## Color Theme

Controls display style.

| Key | Default | Effect |
| --- | --- | --- |
| `uiThemePreset` | `green` | Overall theme preset |
| `uiAccentColor` | `green` | Accent color for TUI elements |
| `uiColorMode` | `auto` | Terminal background mode: `auto` detects a light background via `COLORFGBG`, `dark`/`light` pin it explicitly (`CODEX_TUI_COLOR_MODE` overrides per process) |
| `menuFocusStyle` | `row-invert` | Focus/highlight style in selection menus |

`light` darkens text painted directly on the terminal background (title, row
labels, section labels, help) while badges and the focused-row chip keep pale
text on their own dark backgrounds. `CODEX_TUI_COLOR_MODE=auto|dark|light`
overrides the persisted value for the current process; `auto` falls back to
`dark` when the terminal does not advertise its background.

---

## Experimental

Experimental settings currently cover:

- one-way sync preview/apply into `oc-codex-multi-auth` (formerly `oc-chatgpt-multi-auth`)
- named local pool backup export with filename prompt
- refresh guard controls (`proactiveRefreshGuardian`,
  `proactiveRefreshIntervalMs`)
- context budget guard (`contextBudgetGuardEnabled`) — pause a session before
  it hits the model's context window; see
  [Context Budget Guard](../features.md#context-budget-guard-experimental)

Panel shortcuts:

| Key | Action |
| --- | --- |
| `1` | Sync preview |
| `2` | Named backup export |
| `3` | Toggle refresh guard |
| `4` | Toggle context budget guard |
| `[` / `-` | Decrease refresh interval |
| `]` / `+` | Increase refresh interval |
| `A` | Apply (inside sync review) |
| `S` | Save and return |
| `Q` | Back |

Sync behavior:

- preview is always shown before apply
- blocked target states do not apply changes
- destination active selection is preserved
- destination-only accounts are preserved by the merge preview/apply path

Named backup behavior:

- prompts for a filename
- appends `.json` when omitted
- rejects separators, traversal (`..`), `.rotate.`, `.tmp`, and `.wal` suffixes
- fails safely on collisions instead of overwriting by default

Context budget guard fields (ship **disabled**; thresholds and overrides are
settings/env-only — the only interactive control is the on/off toggle):

| Key | Default | Effect |
| --- | --- | --- |
| `contextBudgetGuardEnabled` | `false` | Pause the next request on a session once it crosses `contextBudgetGuardHardPercent` of the model's context window |
| `contextBudgetGuardSoftPercent` | `65` | Attach a non-blocking `x-codex-context-budget-percent` header once usage crosses this percent |
| `contextBudgetGuardHardPercent` | `69` | Pause threshold, `10`–`100` — see [Context Budget Guard](../features.md#context-budget-guard-experimental) |
| `contextBudgetGuardModelWindowOverrides` | `{}` | `{ "<model>": <tokens> }` — a real observed ceiling always overrides the built-in estimate |

## Backend Controls

### Session & Sync

| Key | Default | Effect |
| --- | --- | --- |
| `liveAccountSync` | `true` | Watch account storage for external changes |
| `liveAccountSyncDebounceMs` | `250` | Debounce live-sync reloads |
| `liveAccountSyncPollMs` | `2000` | Poll interval for live-sync fallback |
| `sessionAffinity` | `true` | Keep sessions sticky to a recent account |
| `sessionAffinityTtlMs` | `1200000` | Session affinity retention window (20 minutes) |
| `sessionAffinityMaxEntries` | `512` | Maximum affinity cache entries |
| `perProjectAccounts` | `true` | Scope account pools per project when CLI sync is off |
| `responseContinuation` | `false` | Auto-fill `previous_response_id` from plugin continuation state |
| `backgroundResponses` | `false` | Allow the stateful Responses `background: true` path (`store=true`) |

### Rotation & Quota

| Key | Default | Effect |
| --- | --- | --- |
| `codexRuntimeRotationProxy` | `true` | Enable the default-on localhost Responses proxy for forwarded official Codex CLI/app sessions |
| `schedulingStrategy` | `hybrid` | `hybrid` spreads load across available accounts; `sequential` (drain-first) keeps one active account until exhausted, then advances |
| `routingMutex` | `legacy` | `legacy` (default) or `enabled` to serialize account selection **within a single process** |
| `pidOffsetEnabled` | `true` | Bias parallel processes toward different accounts under high concurrency (no-op for single-account pools; pin + health still win) |
| `minRotationIntervalMs` | `60000` | Minimum bias window toward the last-served account before free hybrid switch (`0` disables) |
| `tokenInvalidationCooldownMs` | `300000` | Cooldown after explicit OAuth token invalidation/revocation (5 minutes) |
| `preemptiveQuotaEnabled` | `true` | Defer requests before remaining quota is critically low |
| `preemptiveQuotaRemainingPercent5h` | `5` | 5-hour quota threshold |
| `preemptiveQuotaRemainingPercent7d` | `5` | 7-day quota threshold |
| `preemptiveQuotaMaxDeferralMs` | `7200000` | Maximum quota-based deferral window |
| `retryAllAccountsRateLimited` | `false` | When every account is rate-limited, wait for the soonest quota window and retry instead of failing — enable with a bounded `retryAllAccountsMaxRetries`/`retryAllAccountsMaxWaitMs` for high-parallelism workloads (see [High parallelism / agent swarms](../troubleshooting.md#high-parallelism--agent-swarms)) |
| `retryAllAccountsMaxWaitMs` | `0` | Maximum wait budget for all-accounts-rate-limited retries (`0` = no wait) |
| `retryAllAccountsMaxRetries` | `0` | Maximum retry attempts for all-accounts-rate-limited loops (`0` = no retry) |
| `rateLimitDedupWindowMs` | `2000` | Deduplicate near-identical rate-limit observations within this window |
| `rateLimitStateResetMs` | `120000` | How long rate-limit state is retained before reset |
| `rateLimitMaxBackoffMs` | `60000` | Cap for rate-limit backoff calculations |
| `rateLimitShortRetryThresholdMs` | `5000` | Threshold under which short retries are preferred over long cooldowns |

### Refresh & Recovery

| Key | Default | Effect |
| --- | --- | --- |
| `tokenRefreshSkewMs` | `60000` | Refresh tokens before expiry |
| `proactiveRefreshGuardian` | `true` | Run background proactive refresh checks |
| `proactiveRefreshIntervalMs` | `60000` | Refresh guardian polling interval |
| `proactiveRefreshBufferMs` | `300000` | Refresh-before-expiry buffer |
| `storageBackupEnabled` | `true` | Write rotating account-storage backups |
| `sessionRecovery` | `true` | Restore recoverable conversation state |
| `autoResume` | `true` | Automatically resume recoverable sessions |

### Performance & Timeouts

| Key | Default | Effect |
| --- | --- | --- |
| `parallelProbing` | `false` | Probe multiple accounts concurrently |
| `parallelProbingMaxConcurrency` | `2` | Concurrency cap for parallel probing |
| `fastSession` | `false` | Enable fast-session request trimming |
| `fastSessionStrategy` | `hybrid` | Fast-session trimming strategy |
| `fastSessionMaxInputItems` | `30` | Cap history items in fast-session mode |
| `emptyResponseMaxRetries` | `2` | Retries for empty/invalid responses |
| `emptyResponseRetryDelayMs` | `1000` | Delay between empty-response retries |
| `fetchTimeoutMs` | `60000` | Request timeout |
| `streamStallTimeoutMs` | `45000` | Stream stall timeout |
| `networkErrorCooldownMs` | `6000` | Cooldown after network failures |
| `serverErrorCooldownMs` | `4000` | Cooldown after server failures |

### Codex mode & TUI

`pluginConfig` fields commonly overridden via environment variables rather than
the dashboard panels:

| Key | Default | Effect |
| --- | --- | --- |
| `codexMode` | `true` | Prefer Codex-oriented defaults and host integration paths |
| `codexTuiV2` | `true` | Enable TUI v2 rendering path |
| `codexTuiColorProfile` | `truecolor` | `truecolor`, `ansi256`, or `ansi16` |
| `codexTuiGlyphMode` | `ascii` | `ascii`, `unicode`, or `auto` |
| `unsupportedCodexPolicy` | `strict` | How unsupported Codex model requests are handled (`strict` \| `fallback`) |
| `fallbackOnUnsupportedCodexModel` | `false` | Whether to fall back when a Codex model is unsupported |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` | No effect; kept for config compatibility — it gated a retired `gpt-5.3-codex` → `gpt-5.2-codex` hop |
| `unsupportedCodexFallbackChain` | `{}` | Per-model ordered fallback chain consulted before the generic unsupported-model policy; keys are model ids, values ordered candidate lists |
| `rateLimitToastDebounceMs` | `60000` | Debounce window for rate-limit toast spam |
| `toastDurationMs` | `5000` | Dashboard toast display duration |

---

## Stable environment overrides

Common operator overrides (aligned with
[../configuration.md](../configuration.md)):

- `CODEX_MULTI_AUTH_DIR` — move the whole multi-auth root
- `CODEX_MULTI_AUTH_CONFIG_PATH` — load config from an explicit file
- `CODEX_MODE`
- `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` — `0` disables the proxy for the current process
- `CODEX_MULTI_AUTH_FORCE_ACCOUNT` — force one account for a single forwarded `codex-multi-auth-codex` run (selector: index/email/id); `--account` wins when both are set
- `CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS`
- `CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS` — absolute ceiling on a helper's life regardless of activity (default 24h; `0` disables)
- `CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS` — idle window once the helper's launcher is confirmed gone, nothing is connected, and the helper never served a request (default 15m; `0` keeps the full idle timeout)
- `CODEX_MULTI_AUTH_APP_BIND` / `CODEX_MULTI_AUTH_APP_BIND_INSTALL` — app-bind first-run gates (`0` skips, `1` forces the install self-heal)
- `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL` — `0` skips user-level launcher routing
- `CODEX_MULTI_AUTH_NATIVE_OPENAI` — `1` makes new app binds default to the native OpenAI provider
- `CODEX_TUI_V2`, `CODEX_TUI_COLOR_PROFILE`, `CODEX_TUI_COLOR_MODE`, `CODEX_TUI_GLYPHS`
- `CODEX_AUTH_FETCH_TIMEOUT_MS`, `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS`
- `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS` — default `60000`; `0` disables last-served bias
- `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS` — default `300000`
- `CODEX_AUTH_PID_OFFSET_ENABLED` — default on; `0` disables per-process selection bias
- `CODEX_AUTH_ROUTING_MUTEX` — `legacy` (default) or `enabled`
- `CODEX_AUTH_SCHEDULING_STRATEGY` — `hybrid` (default) or `sequential`
- `CODEX_AUTH_BACKGROUND_RESPONSES` — enable the stateful background Responses path
- `CODEX_AUTH_NO_BROWSER` — `1` suppresses browser launch for automation/headless

Installed wrappers may perform a best-effort daily npm version check during
normal forwarded Codex startup; if a newer package exists they only print
`npm install -g codex-multi-auth@latest` — they never mutate the installed
package.

## Advanced and internal overrides

Maintainer/debug-focused overrides and the full per-field env matrix live in
[../development/CONFIG_FIELDS.md](../development/CONFIG_FIELDS.md). Common
advanced names:

- `CODEX_MULTI_AUTH_SYNC_CODEX_CLI`
- `CODEX_MULTI_AUTH_REAL_CODEX_BIN`
- `CODEX_MULTI_AUTH_BYPASS`
- `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` — internal: set by the wrapper after it resolves `--account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT` to a 0-based index for the runtime proxy; not intended to be set by hand
- `CODEX_MULTI_AUTH_STATUSLINE` / `CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP` / `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE` / `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE` / `CODEX_MULTI_AUTH_DEBUG`
- Fast session: `CODEX_AUTH_FAST_SESSION`, `CODEX_AUTH_FAST_SESSION_STRATEGY`, `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS`
- Retry-all: `CODEX_AUTH_RETRY_ALL_RATE_LIMITED`, `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS`, `CODEX_AUTH_RETRY_ALL_MAX_RETRIES`
- Unsupported-model policy: `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY`, `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL`, `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52`
- `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS` / `CODEX_AUTH_SESSION_RECOVERY` / `CODEX_AUTH_AUTO_RESUME`
- `CODEX_AUTH_PER_PROJECT_ACCOUNTS` / `CODEX_AUTH_PARALLEL_PROBING` / `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY`
- `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES` / `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS`
- `CODEX_AUTH_RESPONSE_CONTINUATION` / `CODEX_AUTH_PROACTIVE_GUARDIAN` / `CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS` / `CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS`
- `CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED` / `CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT` / `CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT` / `CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS`
- `CODEX_AUTH_CONTEXT_BUDGET_GUARD_ENABLED` / `CODEX_AUTH_CONTEXT_BUDGET_SOFT_PCT` / `CODEX_AUTH_CONTEXT_BUDGET_HARD_PCT`
- Rate-limit state: `CODEX_AUTH_RATE_LIMIT_DEDUP_WINDOW_MS`, `CODEX_AUTH_RATE_LIMIT_STATE_RESET_MS`, `CODEX_AUTH_RATE_LIMIT_MAX_BACKOFF_MS`, `CODEX_AUTH_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS`, `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS`
- Live sync / affinity: `CODEX_AUTH_LIVE_ACCOUNT_SYNC` (+`_DEBOUNCE_MS`, `_POLL_MS`), `CODEX_AUTH_SESSION_AFFINITY` (+`_TTL_MS`, `_MAX_ENTRIES`)
- `CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS` / `CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS`
- `CODEX_AUTH_STORAGE_BACKUP_ENABLED` / `CODEX_AUTH_STORAGE_BACKUP_MIN_INTERVAL_MS` / `CODEX_AUTH_TOAST_DURATION_MS`
- `CODEX_CLI_ACCOUNTS_PATH` / `CODEX_CLI_AUTH_PATH` / `CODEX_CLI_CONFIG_PATH`
- Refresh lease controls: `CODEX_AUTH_REFRESH_LEASE`, `CODEX_AUTH_REFRESH_LEASE_DIR`, `CODEX_AUTH_REFRESH_LEASE_TTL_MS`, `CODEX_AUTH_REFRESH_LEASE_WAIT_MS`, `CODEX_AUTH_REFRESH_LEASE_POLL_MS`, `CODEX_AUTH_REFRESH_LEASE_RESULT_TTL_MS`
- `CODEX_MULTI_AUTH_UPDATE_NOTICE_STARTUP_BUDGET_MS`, `CODEX_MULTI_AUTH_STATUS_QUOTA_REFRESH_INTERVAL_MS`, `CODEX_MULTI_AUTH_STATUS_REFRESH_CHILD` (internal), `CODEX_MULTI_AUTH_USAGE_CODEX_BIN`, `CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME`, `CODEX_MULTI_AUTH_APP_ROTATION_DETACH_GRACE_MS`, `CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL`, `CODEX_MULTI_AUTH_MODEL_CAPACITY_RETRY_MS`
- `CODEX_AUTH_ACCOUNT_ID` — login org binding override (`--org` wins)
- `MCODEX_MONITOR_INTERVAL` / `MCODEX_TMUX_SESSION` / `MCODEX_TMUX_HISTORY_LIMIT`
- `OC_CODEX_MULTI_AUTH_DIR` — override root for the experimental `oc-codex-multi-auth` sync target (legacy name `OC_CHATGPT_MULTI_AUTH_DIR` is still accepted)

Full inventory: [../development/CONFIG_FIELDS.md](../development/CONFIG_FIELDS.md)

---

## Recommended defaults

For most environments:

- smart sort enabled
- auto-fetch limits enabled
- live sync enabled
- session affinity enabled
- preemptive quota deferral enabled
- proactive refresh guardian enabled
- `pidOffsetEnabled` left on for multi-process swarms
- `backgroundResponses` left off unless callers intentionally send `background: true`

---

## Validation

After changes:

```bash
codex-multi-auth status
codex-multi-auth check
codex-multi-auth forecast --live
codex-multi-auth config explain
```

---

## Related

- [commands.md](commands.md)
- [storage-paths.md](storage-paths.md)
- [../configuration.md](../configuration.md)
