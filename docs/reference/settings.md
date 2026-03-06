# Settings Reference

Reference for dashboard and backend settings available from `codex auth login` -> `Settings`.

---

## Settings Location

Default file:

- `~/.codex/multi-auth/settings.json`

Top-level objects:

- `dashboardDisplaySettings`
- `pluginConfig`

When `CODEX_MULTI_AUTH_DIR` is set, this root moves accordingly.

---

## Dashboard Display Settings

### Account List View

Controls account-row display and sorting behavior:

- status badge visibility
- current badge visibility
- last-used visibility
- quota/cooldown visibility
- fetch status visibility
- current row highlighting
- smart sort enable and mode
- compact versus expanded layout mode

### Summary Fields

Controls detail-line fields and order:

- `last-used`
- `limits`
- `status`

### Behavior

Controls result-screen and fetch behavior:

- auto-return delay
- pause-on-key
- auto-fetch limits
- fetch TTL

### Theme

Controls display style:

- theme preset
- accent color
- focus style

---

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
- `telemetryEnabled`

### Rotation and Quota

Examples:

- `preemptiveQuotaEnabled`
- `preemptiveQuotaRemainingPercent5h`
- `preemptiveQuotaRemainingPercent7d`
- `preemptiveQuotaMaxDeferralMs`
- `retryAllAccountsRateLimited`
- `retryAllAccountsMaxWaitMs`
- `retryAllAccountsMaxRetries`
- `retryAllAccountsAbsoluteCeilingMs`
  Unit: milliseconds. Bounds: `0` to `24h`. `0` means unlimited.

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
- `CODEX_SECRET_STORAGE_MODE`
- `CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS`
  Rotation & Quota override for `retryAllAccountsAbsoluteCeilingMs` (ms, `0` to `24h`, `0` = unlimited).
- `CODEX_AUTH_FETCH_TIMEOUT_MS`
- `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS`
- `CODEX_AUTH_TELEMETRY_ENABLED`
- `CODEX_AUTH_ENCRYPTION_KEY`
- `CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY`
- `CODEX_AUTH_ROLE`

Encryption key variables must be high-entropy 32-byte key material (for example,
from a secret manager). Do not use passwords.

Enterprise recommendation:

- pin `CODEX_SECRET_STORAGE_MODE=keychain` for production.

---

## Advanced and Internal Overrides

Maintainer/debug-focused overrides include:

- `CODEX_MULTI_AUTH_SYNC_CODEX_CLI`
- `CODEX_MULTI_AUTH_REAL_CODEX_BIN`
- `CODEX_MULTI_AUTH_BYPASS`
- `CODEX_CLI_ACCOUNTS_PATH`
- `CODEX_CLI_AUTH_PATH`
- refresh lease controls (`CODEX_AUTH_REFRESH_LEASE*`)
- `CODEX_AUTH_BREAK_GLASS`
- `CODEX_AUTH_ABAC_READ_ONLY`
- `CODEX_AUTH_ABAC_DENY_ACTIONS`
- `CODEX_AUTH_ABAC_DENY_COMMANDS`
- `CODEX_AUTH_ABAC_REQUIRE_INTERACTIVE`
- `CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY`
- `CODEX_AUTH_REDACT_JSON_OUTPUT`
- retention controls (`CODEX_AUTH_RETENTION_*`)

Full inventory: [../development/CONFIG_FIELDS.md](../development/CONFIG_FIELDS.md)

---

## Recommended Defaults

For most environments:

- smart sort enabled
- auto-fetch limits enabled
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
