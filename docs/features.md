# Features

Complete feature matrix for `codex-multi-auth`.

This page is the authoritative index of implemented feature areas.

* * *

## Account and Auth Core

| ID | Feature | What it gives you | Entry point |
| --- | --- | --- | --- |
| 1 | Multi-account OAuth login dashboard | Add/manage multiple accounts in one UI | `codex auth login` |
| 2 | Account add/update dedupe by token/id/email | Prevent duplicate account records | Login flow |
| 3 | Set current account command | Explicit active-account control | `codex auth switch <index>` |
| 4 | Per-family active index handling | Model-family aware active account mapping | Runtime selection |
| 5 | Quick health check command | Fast account session check | `codex auth check` |
| 6 | Full refresh check command | Deeper refresh-based validation | Dashboard advanced check |
| 7 | Flagged account verification command | Re-test flagged account health | `codex auth verify-flagged` |
| 8 | Flagged account restore flow | Move healthy flagged accounts back to active pool | `codex auth verify-flagged` |

* * *

## Forecast, Fix, and Diagnostics

| ID | Feature | What it gives you | Entry point |
| --- | --- | --- | --- |
| 9 | Best account forecast engine | Picks best account by risk/readiness | `codex auth forecast` |
| 10 | Forecast live quota probing | Uses live quota headers for forecast quality | `codex auth forecast --live` |
| 11 | Auto-fix command (safe mode) | Applies safe repairs to account state | `codex auth fix` |
| 12 | Doctor diagnostics command | Structured diagnostics + optional repair | `codex auth doctor` |
| 13 | JSON outputs for machine automation | Stable machine-readable command outputs | `--json` flags |
| 14 | Report generation command | Full health summary for tooling/support | `codex auth report` |

* * *

## Storage and Data Safety

| ID | Feature | What it gives you | Entry point |
| --- | --- | --- | --- |
| 15 | Storage v3 normalization and migration | Normalized account format + migration handling | Storage loader |
| 16 | Storage backup and recovery journal | Backup/WAL durability protections | Storage writer |
| 17 | Project-scoped and global storage paths | Per-project isolation option | `pluginConfig.perProjectAccounts` |
| 18 | Quota cache storage | Cached quota summaries for dashboard/forecast | `quota-cache.json` |

* * *

## Runtime Reliability and Sync

| ID | Feature | What it gives you | Entry point |
| --- | --- | --- | --- |
| 19 | Live account sync watcher | Reload account state without restart | `pluginConfig.liveAccountSync` |
| 20 | Session affinity store | Keep session on stable account | `pluginConfig.sessionAffinity` |
| 21 | Refresh queue dedupe (in-process) | Avoid duplicate refresh calls in one process | Refresh queue |
| 22 | Refresh lease dedupe (cross-process) | Avoid duplicate refresh calls across processes | Refresh lease |
| 23 | Token rotation mapping in refresh queue | Handles rotating token pairs safely | Refresh flow |
| 24 | Refresh guardian (proactive refresh) | Refresh near-expiry accounts in background | `pluginConfig.proactiveRefreshGuardian` |
| 25 | Preemptive quota scheduler | Delay before hard quota exhaustion | `pluginConfig.preemptiveQuotaEnabled` |
| 26 | Entitlement cache for unsupported models | Temporarily suppress unsupported account/model paths | Entitlement cache |
| 27 | Capability policy scoring store | Boost/penalty memory per account+model | Capability policy |
| 28 | Failure policy evaluation module | Centralized retry/rotate/cooldown decisions | Failure policy |
| 29 | Streaming failover pipeline | Recover from stream stalls via fallback | Stream failover |
| 30 | Rate-limit backoff and cooldown handling | Controlled wait/rotation under rate limit | Backoff runtime |

* * *

## Request and Prompt Integration

| ID | Feature | What it gives you | Entry point |
| --- | --- | --- | --- |
| 31 | Plugin-host request transformer bridge | Converts incoming requests to Codex-safe shape | Plugin request pipeline |
| 32 | Prompt template sync with cache | Cached prompt templates with sync/ETag strategy | Prompt subsystem |
| 33 | Codex CLI active-account state sync | Aligns active account with official Codex state | Codex writer/sync |

* * *

## TUI and UX

| ID | Feature | What it gives you | Entry point |
| --- | --- | --- | --- |
| 34 | TUI quick-switch hotkeys (1-9) | Immediate account switch from dashboard | Auth dashboard |
| 35 | TUI search and help toggles | Fast filtering and keyboard help | `/`, `?`, `H` |
| 36 | TUI account detail hotkeys (S/R/E/D) | Fast per-account actions | Account detail menu |
| 37 | TUI settings hub (list/summary/behavior/theme) | In-dashboard customization | Settings menu |
| 38 | Dashboard display customization | Toggle/sort/layout/field options | Dashboard settings |
| 39 | Unified color/theme runtime (v2 UI) | Consistent colors/focus styles across menus | UI runtime/theme |
| 40 | OAuth browser-first flow with manual callback fallback | Works with default browser or manual/incognito flow | Add account flow |

* * *

## Related

- [reference/commands.md](reference/commands.md)
- [reference/settings.md](reference/settings.md)
- [troubleshooting.md](troubleshooting.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
