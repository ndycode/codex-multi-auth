# Architecture

Runtime architecture for Codex CLI-first multi-account OAuth with optional plugin-host integration.

* * *

## Design Goals

1. Keep account management simple for end users (`codex auth ...`).
2. Preserve resilient request routing across multiple accounts.
3. Support plugin-host request flow without patching host core.
4. Keep stateless backend request compatibility (`store: false`).

* * *

## System Diagram

```text
Terminal user
  |
  | codex auth ...
  v
scripts/codex.js
  |- handles auth subcommands locally (codex-manager)
  |- forwards all other codex commands to @openai/codex
  v
lib/codex-manager.ts
  |- oauth login flow + dashboard + check/forecast/fix/doctor/report
  |- reads/writes ~/.codex/multi-auth/*
  |- syncs active account to Codex CLI state files

Plugin-host runtime (optional)
  |
  v
index.ts (plugin entry)
  |- account loading + live sync + session affinity + proactive refresh
  |- request transformation + retry + rotation + failover
  v
OpenAI OAuth + Codex/ChatGPT backend
```

* * *

## Core Subsystems

| Subsystem | Key files | Responsibility |
| --- | --- | --- |
| CLI wrapper | `scripts/codex.js`, `scripts/codex-multi-auth.js` | Command routing and alias normalization |
| Auth flow | `lib/auth/auth.ts`, `lib/auth/server.ts`, `lib/auth/browser.ts` | PKCE OAuth flow, callback handling, browser/manual auth path |
| Account manager | `lib/codex-manager.ts`, `lib/accounts.ts` | Dashboard actions, account selection, health operations |
| Storage/runtime paths | `lib/storage.ts`, `lib/storage/paths.ts`, `lib/runtime-paths.ts` | Account/settings persistence, migration, path resolution |
| Unified settings | `lib/unified-settings.ts`, `lib/dashboard-settings.ts`, `lib/config.ts` | Shared settings persistence + runtime config defaults/overrides |
| Forecast + quota | `lib/forecast.ts`, `lib/quota-probe.ts`, `lib/quota-cache.ts` | Readiness scoring, live quota probe, cached quota view |
| Resilience runtime | `lib/live-account-sync.ts`, `lib/session-affinity.ts`, `lib/refresh-guardian.ts`, `lib/refresh-lease.ts` | No-restart sync, sticky sessions, proactive refresh, cross-process refresh dedupe |
| Failure handling | `lib/request/failure-policy.ts`, `lib/request/stream-failover.ts`, `lib/request/rate-limit-backoff.ts` | Controlled retry, stream failover, cooldown/backoff |
| Capability/entitlement | `lib/capability-policy.ts`, `lib/entitlement-cache.ts`, `lib/preemptive-quota-scheduler.ts` | Unsupported-model suppression, policy scoring, quota deferral |
| Plugin-host request bridge | `index.ts`, `lib/request/fetch-helpers.ts`, `lib/request/request-transformer.ts` | Request shaping, headers, response handling, retry/rotation |

* * *

## Request Pipeline (Plugin Host)

High-level flow:

1. Load runtime config and account manager.
2. Normalize incoming model/provider request shape.
3. Enforce Codex backend invariants:
   - `stream: true`
   - `store: false`
   - include `reasoning.encrypted_content`
4. Strip unsupported payload forms for stateless behavior.
5. Select candidate account with health + quota + affinity logic.
6. Execute request with timeout/retry/failover policy.
7. Update cooldown/rate-limit/session-affinity state.
8. Persist updated account/cache state.

* * *

## Storage Model

Canonical root: `~/.codex/multi-auth`.

| File | Purpose |
| --- | --- |
| `settings.json` | Unified dashboard + plugin config |
| `openai-codex-accounts.json` | Main account pool |
| `openai-codex-accounts.json.bak` / `.wal` | Backup and recovery journal |
| `openai-codex-flagged-accounts.json` | Flagged account pool |
| `quota-cache.json` | Cached quota snapshots |
| `logs/` | Plugin logs when logging enabled |
| `cache/` | Prompt/cache artifacts |

* * *

## TUI Runtime Notes

- TUI v2 is default.
- Palette and accent are configurable.
- Account rows support compact + details views.
- Hotkeys support quick-switch/search/help and per-account actions.

* * *

## Invariants

1. OAuth callback port remains `1455`.
2. Dist folder is generated output only.
3. Non-auth `codex` commands are always forwarded to official Codex CLI.
4. Canonical account-management commands remain `codex auth ...`.

* * *

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [TESTING.md](TESTING.md)
- [../features.md](../features.md)
