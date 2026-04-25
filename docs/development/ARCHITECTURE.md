# Architecture

Runtime architecture for the Codex CLI wrapper, local OAuth account manager, default-on Responses rotation proxy, and optional plugin-host bridge.

* * *

## Design Goals

1. Keep account management simple for end users (`codex auth ...`).
2. Preserve official Codex CLI behavior for non-auth commands.
3. Route live account rotation by default while keeping explicit opt-out controls.
4. Keep runtime rotation local, reversible, and compatible with official Codex state files.
5. Preserve stateless backend request compatibility (`store: false`) unless explicit background-response compatibility is enabled.
6. Keep plugin-host integration available without making it the default user path.

* * *

## System Diagram

```text
Terminal user
  |
  | codex auth ...
  v
scripts/codex.js
  |- normalizes auth aliases
  |- handles auth subcommands through lib/codex-manager.ts
  |- writes/reads ~/.codex/multi-auth/*
  |- syncs active account to official Codex CLI files

Terminal user
  |
  | codex exec/review/resume/app/...
  v
scripts/codex.js
  |- discovers official Codex binary
  |- injects file-backed auth store unless caller opted out
  |- optionally creates shadow CODEX_HOME for runtime rotation
  v
Official Codex CLI

Runtime rotation enabled
  |
  v
shadow CODEX_HOME/config.toml
  |- model_provider = "codex-multi-auth-runtime-proxy"
  |- provider base_url = localhost proxy
  v
lib/runtime-rotation-proxy.ts
  |- validates local client token
  |- selects/refreshes managed account
  |- forwards Responses/model requests to official backend
  |- rotates on rate limit/auth/network/server failure
  |- persists runtime observability and selected-account mirrors

Packaged Codex app bind
  |
  v
lib/runtime/app-bind.ts + scripts/codex-app-router.js
  |- backs up real ~/.codex/config.toml
  |- writes provider config for persistent localhost router
  |- installs user startup entry
  |- restores backup on disable/unbind

Plugin-host runtime (optional)
  |
  v
index.ts
  |- account loading + live sync + session affinity + proactive refresh
  |- request transformation + retry + rotation + failover
  v
Codex or ChatGPT-backed request flow
```

* * *

## Core Subsystems

| Subsystem | Key files | Responsibility |
| --- | --- | --- |
| CLI wrapper | `scripts/codex.js`, `scripts/codex-routing.js`, `scripts/codex-bin-resolver.js` | Command routing, official Codex discovery, file-store forwarding, shadow-home setup |
| Standalone package CLI | `scripts/codex-multi-auth.js` | Direct package entrypoint and version surface |
| Auth flow | `lib/auth/auth.ts`, `lib/auth/server.ts`, `lib/auth/browser.ts` | PKCE OAuth flow, callback handling, browser/manual auth path |
| Account manager | `lib/codex-manager.ts`, `lib/codex-manager/commands/`, `lib/accounts.ts` | Dashboard actions, account selection, health operations, repair commands |
| Runtime rotation proxy | `lib/runtime-rotation-proxy.ts`, `lib/runtime-constants.ts`, `lib/runtime/config-toml.ts` | Loopback Responses/model proxy, provider config rewrite, local client auth, rotation/failover |
| Shadow Codex home | `scripts/codex.js` | Temporary provider config, state copy, sync-back, stale lock cleanup |
| Codex app bind | `lib/runtime/app-bind.ts`, `scripts/codex-app-router.js` | Persistent localhost router, config backup/restore, startup entry |
| App launcher helper | `scripts/codex-app-launcher.js` | User-level Windows shortcut/taskbar routing and macOS wrapper app helper |
| Settings hub | `lib/codex-manager/settings-hub/`, `lib/codex-manager/settings-hub.ts` | Split interactive settings panels; Q = cancel without save; stub retained for compatibility |
| Storage/runtime paths | `lib/storage.ts`, `lib/storage/`, `lib/runtime-paths.ts` | Account/settings persistence, migration, backup/restore, path resolution |
| Worktree resolution | `lib/storage/paths.ts` | `resolveProjectStorageIdentityRoot`, linked worktree identity via commondir/gitdir, forged pointer rejection, Windows UNC support |
| Unified settings | `lib/unified-settings.ts`, `lib/dashboard-settings.ts`, `lib/config.ts`, `lib/schemas.ts` | Shared settings persistence, config defaults, environment overrides, config explain report |
| Forecast + quota | `lib/forecast.ts`, `lib/quota-probe.ts`, `lib/quota-cache.ts`, `lib/preemptive-quota-scheduler.ts` | Readiness scoring, live quota probe, cached quota view, quota deferral |
| Resilience runtime | `lib/live-account-sync.ts`, `lib/session-affinity.ts`, `lib/refresh-guardian.ts`, `lib/refresh-lease.ts`, `lib/refresh-queue.ts` | No-restart sync, sticky sessions, proactive refresh, cross-process refresh dedupe |
| Failure handling | `lib/request/failure-policy.ts`, `lib/request/stream-failover.ts`, `lib/request/rate-limit-backoff.ts` | Controlled retry, stream failover, cooldown/backoff |
| Capability/entitlement | `lib/capability-policy.ts`, `lib/entitlement-cache.ts` | Unsupported-model suppression, policy scoring |
| Plugin-host request bridge | `index.ts`, `lib/request/fetch-helpers.ts`, `lib/request/request-transformer.ts`, `lib/request/response-handler.ts` | Optional host request shaping, headers, response parsing, retry/rotation |
| Runtime observability | `lib/runtime/runtime-observability.ts`, `lib/codex-manager/commands/status.ts`, `lib/codex-manager/commands/report.ts`, `lib/codex-manager/commands/rotation.ts` | Persisted counters and diagnostic summaries |
| Repo hygiene | `scripts/repo-hygiene.js` | Deterministic cleanup (`clean --mode aggressive`) and validation (`check`), CI-gated |

* * *

## Runtime Rotation Flow

1. The wrapper checks `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` and `codexRuntimeRotationProxy`.
2. If disabled, the command forwards to the official Codex CLI unchanged except for normal wrapper compatibility settings.
3. If enabled and the forwarded command is request-bearing, the wrapper starts `lib/runtime-rotation-proxy.ts` on `127.0.0.1` with a per-process client API key.
4. The wrapper creates a temporary shadow `CODEX_HOME`, copies relevant official Codex state, and rewrites `config.toml` to select `codex-multi-auth-runtime-proxy`.
5. The official Codex CLI sends Responses/model traffic to the local provider.
6. The proxy validates the client token, selects a managed account, refreshes tokens if needed, and forwards to the official backend.
7. The proxy rotates to another account before streaming response bytes when it sees retryable auth refresh failures, 429s, 5xx responses, or network errors.
8. Successful responses stream back to the local Codex client with hop-by-hop/private/stale decoded headers removed.
9. Runtime counters and last-account metadata are persisted for status/report commands.
10. On exit, the wrapper syncs refreshed official state files back from the shadow home and cleans up the temporary directory.

* * *

## Plugin-Host Request Pipeline

High-level optional host flow:

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

Canonical multi-auth root: `~/.codex/multi-auth`.

| File | Purpose |
| --- | --- |
| `settings.json` | Unified dashboard + runtime config |
| `openai-codex-accounts.json` | Main account pool |
| `openai-codex-accounts.json.bak` / `.wal` | Backup and recovery journal |
| `openai-codex-flagged-accounts.json` | Flagged account pool |
| `quota-cache.json` | Cached quota snapshots |
| `runtime-observability.json` | Runtime request counters and last-account metadata |
| `runtime-rotation-app-helper.json` | Wrapper-launched Codex app helper status |
| `app-bind/` | Packaged app bind state, backup metadata, router status/log |
| `logs/` | Diagnostics when logging is enabled |
| `cache/` | Prompt/cache artifacts |
| `projects/<key>/` | Per-project account pools keyed by repo identity root |

Official Codex-owned files remain under `~/.codex`, including `auth.json`, `accounts.json`, and `config.toml`.

* * *

## TUI Runtime Notes

- TUI v2 is default.
- Palette and accent are configurable.
- Account rows support compact + details views.
- Hotkeys support quick-switch/search/help and per-account actions.
- Settings panels are split by responsibility and preview changes before persistence where applicable.

* * *

## Invariants

1. OAuth callback port remains `1455`.
2. Dist folder is generated output only.
3. Non-auth `codex` commands forward to official Codex unless the command is intentionally handled by the local auth manager.
4. Canonical account-management commands remain `codex auth ...`.
5. Runtime rotation is default-on and loopback-only.
6. Runtime proxy client authentication uses a local per-process token.
7. Runtime proxy client responses must not include account emails, auth tokens, or stale decoded content-encoding metadata.
8. Packaged app bind must be reversible and must not patch official app binaries.
9. Settings Q hotkey = cancel without save; theme live-preview restores baseline on cancel.
10. Email dedup is case-insensitive via `normalizeEmailKey()` (trim + lowercase).
11. Windows filesystem operations use retry helpers for transient `EBUSY`/`EPERM`/`ENOTEMPTY` behavior where lock-prone paths are touched.

* * *

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [TESTING.md](TESTING.md)
- [../architecture.md](../architecture.md)
- [../features.md](../features.md)
