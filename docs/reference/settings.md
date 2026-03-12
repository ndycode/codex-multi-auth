# Settings Reference

Reference for the settings surface available from `codex auth login` -> `Settings`.

---

## Settings Location

Default file:

- `~/.codex/multi-auth/settings.json`

Top-level objects:

- `dashboardDisplaySettings`
- `pluginConfig`

When `CODEX_MULTI_AUTH_DIR` is set, this root moves accordingly.

---

## Everyday Settings

The shipped settings menu starts with `Everyday Settings` and keeps the stable dashboard path separate from advanced operator controls. This is the default path for most users.

### List Appearance

Controls account-row display and sorting behavior:

- status badge visibility
- current badge visibility
- last-used visibility
- quota/cooldown visibility
- fetch status visibility
- current row highlighting
- smart sort enable and mode
- compact versus expanded layout mode

### Details Line

Controls detail-line fields and order:

- `last-used`
- `limits`
- `status`

### Results and Refresh

Controls result-screen and fetch behavior:

- auto-return delay
- pause-on-key
- auto-fetch limits
- fetch TTL

### Colors

Controls display style:

- theme preset
- accent color
- focus style

---

## Advanced and Operator Controls

The second top-level section is `Advanced & Operator`. It holds the sync workflow and backend tuning that are useful when you need to inspect or change lower-level behavior.

### Codex CLI Sync

`Codex CLI Sync` is a preview-first sync center for Codex CLI account sync.

Before applying sync, it shows:

- target path
- current source path when available
- last sync result for this session
- preview summary (adds, updates, destination-only preserved accounts)
- destination-only preservation behavior
- backup and rollback context (`.bak`, `.bak.1`, `.bak.2`, `.wal`)

Workflow notes:

- refresh recomputes the read-only preview from Codex CLI source files
- apply writes the preview result into the target path
- sync is one-way, it is not a bidirectional merge
- target-only accounts are preserved rather than deleted

---

### Advanced Backend Controls

`Advanced Backend Controls` stay available without changing the saved settings schema. They are grouped into categories so the everyday path can stay simpler for day-to-day use.

## Backend Categories

### Session and Sync

Examples:

- `liveAccountSync`
- `liveAccountSyncDebounceMs`
- `liveAccountSyncPollMs`
- `sessionAffinity`
- `sessionAffinityTtlMs`
- `sessionAffinityMaxEntries`
- `perProjectAccounts`

### Rotation and Quota

Examples:

- `preemptiveQuotaEnabled`
- `preemptiveQuotaRemainingPercent5h`
- `preemptiveQuotaRemainingPercent7d`
- `preemptiveQuotaMaxDeferralMs`
- `retryAllAccountsRateLimited`
- `retryAllAccountsMaxWaitMs`
- `retryAllAccountsMaxRetries`

### Refresh and Recovery

Examples:

- `tokenRefreshSkewMs`
- `proactiveRefreshGuardian`
- `proactiveRefreshIntervalMs`
- `proactiveRefreshBufferMs`
- `sessionRecovery`
- `autoResume`

### Performance and Timeouts

Examples:

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

---

## Stable Environment Overrides

Common operator overrides:

- `CODEX_MULTI_AUTH_DIR`
- `CODEX_MULTI_AUTH_CONFIG_PATH`
- `CODEX_MODE`
- `CODEX_TUI_V2`
- `CODEX_TUI_COLOR_PROFILE`
- `CODEX_TUI_GLYPHS`
- `CODEX_AUTH_FETCH_TIMEOUT_MS`
- `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS`

---

## Advanced and Internal Overrides

Maintainer/debug-focused overrides include:

- `CODEX_MULTI_AUTH_SYNC_CODEX_CLI`
- `CODEX_MULTI_AUTH_REAL_CODEX_BIN`
- `CODEX_MULTI_AUTH_BYPASS`
- `CODEX_CLI_ACCOUNTS_PATH`
- `CODEX_CLI_AUTH_PATH`
- refresh lease controls (`CODEX_AUTH_REFRESH_LEASE*`)

Full inventory: [../development/CONFIG_FIELDS.md](../development/CONFIG_FIELDS.md)

---

## Recommended Defaults

For most environments:

- smart sort enabled
- auto-fetch limits enabled
- storage backups enabled when you want rollback context for sync and recovery flows
- live sync enabled
- session affinity enabled
- preemptive quota deferral enabled
- proactive refresh guardian enabled

---

## Validation

After changes:

```bash
codex auth status
codex auth check
codex auth forecast --live
```

---

## Related

- [commands.md](commands.md)
- [storage-paths.md](storage-paths.md)
- [../configuration.md](../configuration.md)
