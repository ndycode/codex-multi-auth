# Settings Reference

Reference for dashboard display settings and backend `pluginConfig` values available from `codex auth login` -> `Settings`.

---

## Settings Location

Default file:

- `~/.codex/multi-auth/settings.json`

Top-level objects:

- `dashboardDisplaySettings`
- `pluginConfig`

When `CODEX_MULTI_AUTH_DIR` is set, this root moves accordingly.

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
| `menuLayoutMode` | `compact-details` | Choose compact or expanded row layout |

## Summary Line

Controls the fields shown in the per-account summary line.

- `menuStatuslineFields`
- `last-used`
- `limits`
- `status`

| Key | Default | Effect |
| --- | --- | --- |
| `menuStatuslineFields` | `last-used, limits, status` | Controls which summary fields appear and in what order |

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
| `menuFocusStyle` | `row-invert` | Focus/highlight style in selection menus |

---

## Experimental

Experimental settings currently cover:

- one-way sync preview/apply into `oc-chatgpt-multi-auth`
- named local pool backup export with filename prompt
- refresh guard controls (`proactiveRefreshGuardian`, `proactiveRefreshIntervalMs`)

Experimental shortcuts:

- `1` sync preview
- `2` named backup export
- `3` toggle refresh guard
- `[` or `-` decrease refresh interval
- `]` or `+` increase refresh interval
- `S` save and return
- `Q` back
- sync review also supports `A` apply

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

## Backend Controls

### Session & Sync

| Key | Default | Effect |
| --- | --- | --- |
| `liveAccountSync` | `true` | Watch account storage for external changes |
| `liveAccountSyncDebounceMs` | `250` | Debounce live-sync reloads |
| `liveAccountSyncPollMs` | `2000` | Poll interval for live-sync fallback |
| `sessionAffinity` | `true` | Keep sessions sticky to a recent account |
| `sessionAffinityTtlMs` | `1200000` | Session affinity retention window |
| `sessionAffinityMaxEntries` | `512` | Maximum affinity cache entries |
| `perProjectAccounts` | `true` | Scope account pools per project when CLI sync is off |

### Rotation & Quota

| Key | Default | Effect |
| --- | --- | --- |
| `preemptiveQuotaEnabled` | `true` | Defer requests before remaining quota is critically low |
| `preemptiveQuotaRemainingPercent5h` | `5` | 5-hour quota threshold |
| `preemptiveQuotaRemainingPercent7d` | `5` | 7-day quota threshold |
| `preemptiveQuotaMaxDeferralMs` | `7200000` | Maximum quota-based deferral window |
| `retryAllAccountsRateLimited` | `true` | Retry across the whole pool when all accounts are rate-limited |
| `retryAllAccountsMaxWaitMs` | `0` | Maximum wait budget for all-accounts-rate-limited retries |
| `retryAllAccountsMaxRetries` | `Infinity` | Maximum retry attempts for all-accounts-rate-limited loops |

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
| `fastSessionStrategy` | `hybrid` | Choose fast-session trimming strategy |
| `fastSessionMaxInputItems` | `30` | Cap history items in fast-session mode |
| `emptyResponseMaxRetries` | `2` | Retries for empty/invalid responses |
| `emptyResponseRetryDelayMs` | `1000` | Delay between empty-response retries |
| `fetchTimeoutMs` | `60000` | Request timeout |
| `streamStallTimeoutMs` | `45000` | Stream stall timeout |
| `networkErrorCooldownMs` | `6000` | Cooldown after network failures |
| `serverErrorCooldownMs` | `4000` | Cooldown after server failures |

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
