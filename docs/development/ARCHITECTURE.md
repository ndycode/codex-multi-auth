# Architecture

Runtime architecture for the Codex CLI wrapper, local OAuth account manager, default-on Responses rotation proxy, optional local bridge, local governance (usage/budget/policy), and optional plugin-host bridge.

* * *

## Design Goals

1. Keep account management simple for end users (`codex-multi-auth ...`).
2. Preserve official Codex CLI behavior for non-auth commands.
3. Route live account rotation by default while keeping explicit opt-out controls.
4. Keep runtime rotation local, reversible, and compatible with official Codex state files.
5. Preserve stateless backend request compatibility (`store: false`) unless explicit background-response compatibility is enabled.
6. Keep plugin-host integration available without making it the default user path.
7. Keep local governance (usage ledger, budgets, account policies, routing profiles) file-backed and opt-in at the operator command surface.

* * *

## System Diagram

```text
Terminal user
  |
  | codex-multi-auth ...
  v
scripts/codex-multi-auth.js
  |- normalizes bare manager subcommands to auth subcommands
  |- handles account-manager subcommands through lib/codex-manager.ts
  |- runs first-run setup once (app bind / launcher self-heal)
  |- writes/reads ~/.codex/multi-auth/*
  |- syncs active account to official Codex CLI files

Terminal user
  |
  | mcodex ...  (optional convenience launcher)
  v
scripts/mcodex.js
  |- forwards to scripts/codex.js by default
  |- optional --monitor (watch + codex-multi-auth list)
  |- optional --tmux / -t session helper

Terminal user
  |
  | codex-multi-auth-codex exec/review/resume/app/...
  v
scripts/codex.js
  |- handles auth subcommands locally
  |- discovers official Codex binary
  |- injects file-backed auth store unless caller opted out
  |- resolves --account / FORCE_ACCOUNT to ephemeral pin
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
  |- evaluates runtime policy (budget / tags / model allow-deny)
  |- selects/refreshes managed account
  |- forwards Responses/model requests to official backend
  |- rotates on rate limit/auth/network/server failure
  |- records usage ledger rows
  |- persists runtime observability and selected-account mirrors

Optional local bridge
  |
  v
lib/local-bridge.ts + local-client-tokens.ts
  |- loopback Hono server: /health, /v1/models, /v1/responses
  |- bearer token auth (hashed store)
  |- forwards to a runtime proxy base URL

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
| Standalone package CLI | `scripts/codex-multi-auth.js`, `scripts/codex-routing.js` | Primary account-manager entrypoint, bare-subcommand normalization, version surface |
| Convenience launcher | `scripts/mcodex.js` | Cross-platform `mcodex` bin: forwards to the Codex wrapper; optional live monitor (`watch`) and tmux session helpers |
| Optional forwarding wrapper | `scripts/codex.js`, `scripts/codex-routing.js`, `scripts/codex-bin-resolver.js` | Local auth routing, official Codex discovery, file-store forwarding, shadow-home setup, ephemeral `--account` pin |
| Auth flow | `lib/auth/auth.ts`, `lib/auth/server.ts`, `lib/auth/browser.ts` | PKCE OAuth flow, callback handling, browser/manual/device auth path |
| Account manager | `lib/codex-manager.ts`, `lib/codex-manager/commands/`, `lib/accounts.ts` | Dashboard actions, account selection, health operations, repair commands |
| Manager command surface | `lib/codex-manager/commands/*` | Focused modules: `account`, `best`, `bridge`, `budget`, `check`, `config-explain`, `debug-bundle`, `forecast`, `history`, `init-config`, `integrations`, `models`, `monitor`, `report`, `rotation`, `status`, `switch`, `uninstall`, `unpin`, `usage`, `verify`, `why-selected`, `workspace` (plus repair helpers in `repair-commands.ts`) |
| Runtime rotation proxy | `lib/runtime-rotation-proxy.ts`, `lib/runtime-constants.ts`, `lib/runtime/config-toml.ts` | Loopback Responses/model proxy, provider config rewrite, local client auth, rotation/failover |
| Account selection runtime | `lib/runtime/rotation-account-selection.ts`, `lib/rotation.ts`, `lib/accounts.ts` | Pin → sequential/affinity → hybrid → scan selection order |
| Shadow Codex home | `scripts/codex.js` | Temporary provider config, state copy, sync-back, stale lock cleanup |
| Codex app bind | `lib/runtime/app-bind.ts`, `scripts/codex-app-router.js` | Persistent localhost router, config backup/restore, startup entry |
| App launcher helper | `scripts/codex-app-launcher.js` | User-level Windows shortcut/taskbar routing and macOS wrapper app helper |
| First-run setup | `lib/runtime/first-run.ts` | One-time durable-install self-heal for app bind + launcher; marker at `first-run-setup.json` |
| Local bridge | `lib/local-bridge.ts`, `lib/local-client-tokens.ts` | Loopback OpenAI-compatible forwarder over the runtime proxy; hashed client token store |
| Usage ledger | `lib/usage/` (`ledger.ts`, `pricing.ts`, `redaction.ts`, `types.ts`) | Append-only local request metadata; redacted rows; archives; budget/usage summaries |
| Budget guard | `lib/budget-guard.ts` | File-backed request/token/cost limits evaluated against usage summaries |
| Account policy | `lib/account-policy.ts` | Tags, weights, pause/drain, notes keyed by hashed account identity |
| Routing profiles | `lib/routing-profiles.ts` | Project-aware preferred/avoid tags, model allow/deny, per-account weights, budget key |
| Capability policy / model matrix | `lib/capability-policy.ts`, `lib/model-capability-matrix.ts`, `lib/entitlement-cache.ts` | Unsupported-model suppression, per-account model capability matrix, entitlement blocks |
| Runtime policy | `lib/policy/runtime-policy.ts` | Composes account policies, budgets, routing profiles, and capability boosts into a per-request decision |
| Settings hub | `lib/codex-manager/settings-hub/`, `lib/codex-manager/settings-hub.ts` | Split interactive settings panels; Q = cancel without save; stub retained for compatibility |
| Storage/runtime paths | `lib/storage.ts`, `lib/storage/`, `lib/runtime-paths.ts` | Account/settings persistence, migration, backup/restore, path resolution |
| Worktree resolution | `lib/storage/paths.ts` | `resolveProjectStorageIdentityRoot`, linked worktree identity via commondir/gitdir, forged pointer rejection, Windows UNC support |
| Unified settings | `lib/unified-settings.ts`, `lib/dashboard-settings.ts`, `lib/config.ts`, `lib/schemas.ts` | Shared settings persistence, config defaults, environment overrides, config explain report |
| Forecast + quota | `lib/forecast.ts`, `lib/quota-probe.ts`, `lib/quota-cache.ts`, `lib/preemptive-quota-scheduler.ts` | Readiness scoring, live quota probe, cached quota view, quota deferral |
| Resilience runtime | `lib/live-account-sync.ts`, `lib/session-affinity.ts`, `lib/refresh-guardian.ts`, `lib/refresh-lease.ts`, `lib/refresh-queue.ts` | No-restart sync, sticky sessions, proactive refresh, cross-process refresh dedupe |
| Failure handling | `lib/request/failure-policy.ts`, `lib/request/stream-failover.ts`, `lib/request/rate-limit-backoff.ts` | Controlled retry, stream failover, cooldown/backoff |
| Plugin-host request bridge | `index.ts`, `lib/request/fetch-helpers.ts`, `lib/request/request-transformer.ts`, `lib/request/response-handler.ts` | Optional host request shaping, headers, response parsing, retry/rotation |
| Runtime observability | `lib/runtime/runtime-observability.ts`, `lib/codex-manager/commands/status.ts`, `lib/codex-manager/commands/report.ts`, `lib/codex-manager/commands/rotation.ts` | Persisted counters and diagnostic summaries |
| Repo hygiene | `scripts/repo-hygiene.js` | Deterministic cleanup (`clean --mode aggressive`) and validation (`check`), CI-gated |

* * *

## Account Selection Order

Runtime proxy account selection is implemented in `lib/runtime/rotation-account-selection.ts` (`chooseAccount`). Order of precedence:

1. **Pin** — manual pin from `codex-multi-auth switch <index>` (persisted `pinnedAccountIndex`), or ephemeral force pin from `codex-multi-auth-codex --account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT` resolved to `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX`. A pin overrides every other signal. The proxy does not call `markSwitched` for a manual pin so it does not clobber the CLI pin.
2. **Sequential \| affinity**
   - When `schedulingStrategy === "sequential"` (drain-first): stick to the active account until it is fully exhausted, then scan forward; **session affinity is skipped** so all new requests follow the single active account.
   - Otherwise, if session affinity is enabled and a preferred account exists for the session key, use that account when it is still eligible.
3. **Hybrid** — weighted health + token-bucket + freshness selection (`selectHybridAccount` / `getCurrentOrNextForFamilyHybrid`), including optional PID offset and policy score boosts.
4. **Scan** — linear pool walk for the next eligible account (not already attempted, not policy-blocked, not rate-limited / cooling down / circuit-open). Sequential mode uses this fallback without advancing the drain-first active pointer unless true exhaustion occurred.

Policy evaluation (`lib/policy/runtime-policy.ts`) can block paused/drained accounts, apply tag/model routing-profile constraints, apply score boosts, and soft-block requests that exceed budget guards before selection proceeds.

* * *

## Runtime Rotation Flow

1. The wrapper checks `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` and `codexRuntimeRotationProxy`.
2. If disabled, the command forwards to the official Codex CLI unchanged except for normal wrapper compatibility settings.
3. If enabled and the forwarded command is request-bearing, the wrapper starts `lib/runtime-rotation-proxy.ts` on `127.0.0.1` with a per-process client API key.
4. The wrapper creates a temporary shadow `CODEX_HOME`, copies relevant official Codex state, and rewrites `config.toml` to select `codex-multi-auth-runtime-proxy`.
5. The official Codex CLI sends Responses/model traffic to the local provider.
6. The proxy validates the client token, evaluates runtime policy, selects a managed account, refreshes tokens if needed, and forwards to the official backend.
7. The proxy rotates to another account before streaming response bytes when it sees retryable auth refresh failures, 429s, 5xx responses, or network errors (subject to pin and min-rotation-interval throttling).
8. Successful responses stream back to the local Codex client with hop-by-hop/private/stale decoded headers removed.
9. Usage ledger rows and runtime counters are persisted for status/report/usage/budget commands.
10. On exit, the wrapper syncs refreshed official state files back from the shadow home and cleans up the temporary directory.

* * *

## Local Bridge Flow

1. Operator creates a local client token via `codex-multi-auth bridge token create` (plaintext shown once; store keeps SHA-256 hash + prefix + label).
2. Bridge listens on loopback only and requires a bearer token by default.
3. Allowed routes: `/health`, `/v1/models`, `/v1/responses`.
4. Authenticated requests forward to a configured runtime proxy base URL (also loopback-only).
5. When the runtime proxy requires a client API key, the bridge rewrites outbound `Authorization` after inbound verification.
6. Usage rows may be appended with source `local-bridge`.

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
5. Select candidate account with health + quota + affinity logic (same selection family as the runtime proxy where applicable).
6. Execute request with timeout/retry/failover policy.
7. Update cooldown/rate-limit/session-affinity state.
8. Persist updated account/cache state.

* * *

## First-Run Setup

Package install scripts stay side-effect-free. On the first durable CLI invocation after install, `lib/runtime/first-run.ts`:

- Claims a one-time marker at `~/.codex/multi-auth/first-run-setup.json` (exclusive create; concurrent claims race safely).
- Best-effort self-heals packaged Codex app bind and user-level launcher routing when rotation is enabled and the environment is not CI/`npx`/project-local.
- Records step outcomes (`completed` / `skipped` / `failed`) without secrets.
- Failures are debug-logged and never block the requested command.

Explicit repair remains `codex-multi-auth rotation enable` / `bind-app` / launcher install helpers.

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
| `first-run-setup.json` | One-time durable-install setup claim marker |
| `account-policies.json` | Tags, weights, pause/drain, notes (hashed account keys) |
| `routing-profiles.json` | Project-aware routing preferences |
| `budget-guards.json` | Local request/token/cost limits |
| `local-client-tokens.json` | Local bridge token hashes (no plaintext) |
| `usage/usage-ledger.jsonl` | Append-only local usage metadata (+ rotated archives) |
| `runtime-rotation-app-helper.json` | Wrapper-launched Codex app helper status |
| `app-bind/` | Packaged app bind state, backup metadata, router status/log |
| `logs/` | Diagnostics when logging is enabled |
| `cache/` | Prompt/cache artifacts |
| `projects/<key>/` | Per-project account pools keyed by repo identity root |
| `backups/` | Named operator-exported account-pool backups |

Official Codex-owned files remain under `~/.codex`, including `auth.json`, `accounts.json`, and `config.toml`.

* * *

## Security Boundaries

1. **Loopback only** — runtime rotation proxy, app router, and local bridge bind to loopback hosts (`127.0.0.1` / `localhost` / `::1`). Non-loopback bases are rejected.
2. **Local client authentication** — runtime proxy uses a per-process client API key; local bridge uses operator-managed bearer tokens stored as SHA-256 hashes.
3. **No account PII in client-facing proxy responses** — responses must not include account emails, auth tokens, or stale decoded content-encoding metadata.
4. **Reversible app bind** — packaged app bind edits user `config.toml` + startup metadata only; official app binaries are never patched; disable/unbind restores the backup.
5. **OAuth stays local** — callback server binds port `1455` on loopback; PKCE tokens land in local storage under the multi-auth root.
6. **Usage ledger redaction** — ledger rows store hashed identity fields and request metadata, not prompts, auth headers, or raw emails.
7. **Ephemeral force-account pins** — `--account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT` never mutate the persisted switch pin and fail hard when the proxy is disabled or the target is unavailable.
8. **Budget guards are soft under concurrency** — evaluations read a pre-request ledger snapshot; concurrent requests may briefly overshoot. This is intentional (best-effort, not a hard distributed quota).
9. **First-run marker is not a secret** — it only records that durable-install self-heal ran; opt-out via env remains available.

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
3. Non-auth `codex-multi-auth-codex` commands forward to official Codex unless the command is intentionally handled by the local auth manager.
4. Canonical account-management commands remain `codex-multi-auth ...`.
5. Runtime rotation is default-on and loopback-only.
6. Runtime proxy client authentication uses a local per-process token.
7. Runtime proxy client responses must not include account emails, auth tokens, or stale decoded content-encoding metadata.
8. Packaged app bind must be reversible and must not patch official app binaries.
9. Settings Q hotkey = cancel without save; theme live-preview restores baseline on cancel.
10. Email dedup is case-insensitive via `normalizeEmailKey()` (trim + lowercase).
11. Windows filesystem operations use retry helpers for transient `EBUSY`/`EPERM`/`ENOTEMPTY` behavior where lock-prone paths are touched.
12. Account selection order remains pin → sequential|affinity → hybrid → scan unless a release intentionally changes that contract.
13. `mcodex` is a convenience launcher only; it must not reimplement account-manager or Codex command logic.

* * *

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [TESTING.md](TESTING.md)
- [REPOSITORY_SCOPE.md](REPOSITORY_SCOPE.md)
- [../architecture.md](../architecture.md)
- [../features.md](../features.md)
