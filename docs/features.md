# Features

Capability map for `codex-multi-auth` grouped by operational domain.

---

## Account and OAuth Operations

| Capability | Outcome | Primary entry |
| --- | --- | --- |
| Multi-account dashboard login | Add and manage multiple OAuth identities | `codex auth login` |
| Account dedupe and identity normalization | Avoid duplicate saved account records | login flow |
| Active account switching by index | Deterministic operator control | `codex auth switch <index>` |
| Quick and deep account checks | Fast and comprehensive health views | `codex auth check`, dashboard checks |
| Flagged account verification and restore | Recover previously failed accounts | `codex auth verify-flagged` |

---

## Forecasting, Repair, and Reporting

| Capability | Outcome | Primary entry |
| --- | --- | --- |
| Readiness/risk forecast engine | Recommends best next account | `codex auth forecast` |
| Live quota probe mode | Uses live headers for stronger decisions | `codex auth forecast --live` |
| Safe auto-fix workflow | Repairs known storage/account inconsistencies | `codex auth fix [--live]` |
| Structured diagnostics with optional fix | Detect and remediate common failures | `codex auth doctor` |
| JSON report output | Integrates with automation and support workflows | `--json`, `codex auth report` |

---

## Storage and Data Safety

| Capability | Outcome |
| --- | --- |
| Storage v3 normalization and migration | Backward compatibility with normalized current format |
| Backup and WAL write strategy | Safer persistence under interruption or partial writes |
| Global and project-scoped account paths | Supports multi-project isolation with shared defaults |
| Quota cache persistence | Improves forecast speed and dashboard visibility |

---

## Runtime Reliability

| Capability | Outcome |
| --- | --- |
| Live account sync | Reloads account state without process restart |
| Session affinity | Reduces account thrash across related requests |
| Refresh queue + refresh lease | Dedupe token refresh in-process and cross-process |
| Proactive refresh guardian | Refreshes near-expiry credentials ahead of hard failure |
| Preemptive quota scheduler | Defers away from near-exhausted quota windows |
| Failure policy + cooldown engine | Unified retry/rotate/backoff decisions |
| Stream failover handling | Recovers from stalled stream paths |
| Capability and entitlement scoring | Adapts account/model selection over time |

---

## Request and Prompt Integration

| Capability | Outcome |
| --- | --- |
| Request transformer bridge | Converts host requests to Codex backend compatible shape |
| Prompt template cache with ETag sync | Keeps prompts current with efficient refresh behavior |
| Codex CLI active-account sync | Keeps local manager and Codex CLI state aligned |

---

## Terminal UX

| Capability | Outcome |
| --- | --- |
| Quick switch and search hotkeys | Faster account navigation from dashboard |
| Account detail action hotkeys | Per-account set/refresh/toggle/delete shortcuts |
| In-dashboard settings hub | Runtime and display tuning without manual file edits |
| Configurable theme/focus style | Better readability in diverse terminal environments |
| Browser-first OAuth plus manual fallback | Supports standard and constrained browser environments |

---

## Related

- [reference/commands.md](reference/commands.md)
- [reference/settings.md](reference/settings.md)
- [troubleshooting.md](troubleshooting.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
