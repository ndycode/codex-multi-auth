# Settings Reference

Reference for dashboard and backend settings available from `codex auth login` -> `Settings`.

* * *

## Where Settings Are Saved

- `~/.codex/multi-auth/settings.json`
- under:
  - `dashboardDisplaySettings`
  - `pluginConfig`

If `CODEX_MULTI_AUTH_DIR` is set, this root changes accordingly.

* * *

## Dashboard Settings (User-Facing)

### Account List View

Controls account-row content and layout:

- status badge visibility
- current badge visibility
- last-used visibility
- limit bars visibility
- cooldown visibility
- fetch-status visibility
- current-row highlighting
- smart sort enable/mode
- compact vs expanded layout

### Summary Fields

Controls detail-line fields and order:

- last-used
- limits
- status

### Behavior

Controls result-screen return and menu refresh behavior:

- auto-return delay
- pause-on-key behavior
- auto-fetch limits
- limit fetch TTL

### Theme

Controls color scheme:

- base theme preset
- accent color
- focus style

* * *

## Advanced Backend Categories

### 1) Session & Sync

Typical controls:

- `liveAccountSync`
- `liveAccountSyncDebounceMs`
- `liveAccountSyncPollMs`
- `sessionAffinity`
- `sessionAffinityTtlMs`
- `sessionAffinityMaxEntries`
- `perProjectAccounts`

### 2) Rotation & Quota

Typical controls:

- `preemptiveQuotaEnabled`
- `preemptiveQuotaRemainingPercent5h`
- `preemptiveQuotaRemainingPercent7d`
- `preemptiveQuotaMaxDeferralMs`
- `retryAllAccountsRateLimited`
- `retryAllAccountsMaxWaitMs`
- `retryAllAccountsMaxRetries`

### 3) Refresh & Recovery

Typical controls:

- `tokenRefreshSkewMs`
- `proactiveRefreshGuardian`
- `proactiveRefreshIntervalMs`
- `proactiveRefreshBufferMs`
- `sessionRecovery`
- `autoResume`

### 4) Performance & Timeouts

Typical controls:

- `parallelProbing`
- `parallelProbingMaxConcurrency`
- `fastSession`
- `fastSessionStrategy`
- `fastSessionMaxInputItems`
- `emptyResponseMaxRetries`
- `emptyResponseRetryDelayMs`
- `fetchTimeoutMs`
- `streamStallTimeoutMs`
- `networkErrorCooldownMs`
- `serverErrorCooldownMs`

* * *

## Stable Environment Overrides

Important stable overrides that supersede file settings:

- `CODEX_MULTI_AUTH_DIR`
- `CODEX_MULTI_AUTH_CONFIG_PATH`
- `CODEX_HOME`
- `CODEX_MODE`
- `CODEX_TUI_V2`
- `CODEX_TUI_COLOR_PROFILE`
- `CODEX_TUI_GLYPHS`
- `CODEX_AUTH_FETCH_TIMEOUT_MS`
- `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS`
- `CODEX_MULTI_AUTH_SYNC_CODEX_CLI`
- `CODEX_CLI_ACCOUNTS_PATH`
- `CODEX_CLI_AUTH_PATH`
- `CODEX_MULTI_AUTH_REAL_CODEX_BIN`
- `CODEX_MULTI_AUTH_BYPASS`

Advanced/internal toggles are documented in maintainer docs:

- [../development/CONFIG_FIELDS.md](../development/CONFIG_FIELDS.md)

* * *

## Recommended Defaults

For most users, keep:

- smart sort enabled
- auto-fetch limits enabled
- live sync enabled
- session affinity enabled
- preemptive quota deferral enabled
- proactive refresh guardian enabled

* * *

## Validation

After changing settings:

```bash
codex auth status
codex auth check
codex auth forecast --live
```

* * *

## Related

- [commands.md](commands.md)
- [storage-paths.md](storage-paths.md)
- [../configuration.md](../configuration.md)
