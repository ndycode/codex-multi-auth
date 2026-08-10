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
  |- reconciles top-level cli_auth_credentials_store on startup
  |- resolves --account / FORCE_ACCOUNT to ephemeral pin
  |- picks a runtime-rotation transport (see below)
  v
Official Codex CLI

Runtime rotation enabled -> one of three transports
  |
  |- interactive TUI (no forwarded subcommand), resume, fork, app-server
  |    canonical CODEX_HOME + ephemeral -c provider overrides
  |    (no shadow copy, no provider/transport rewrite of config.toml;
  |     the auth-store reconcile above still applies)
  |    detach on exit, except app-server: a resident server owns its
  |    proxy for its whole lifetime, so the helper stops with it
  |
  |- codex app
  |    app runtime helper process + shadow CODEX_HOME
  |
  |- every other request-bearing command
  |    shadow CODEX_HOME/config.toml
  |      |- model_provider = "codex-multi-auth-runtime-proxy"
  |      |- provider base_url = localhost proxy
  |
  |- (help and schema generation take no transport at all:
  |   --help/-h on any of these, and app-server help / generate-ts /
  |   generate-json-schema, forward without starting a proxy)
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
| Optional forwarding wrapper | `scripts/codex.js`, `scripts/codex-routing.js`, `scripts/codex-bin-resolver.js` | Local auth routing, official Codex discovery, file-store forwarding, canonical-home vs shadow-home transport selection, ephemeral `--account` pin |
| Official Codex CLI state | `lib/codex-cli/` (`state.ts`, `writer.ts`, `sync.ts`, `observability.ts`) | Reads/writes the official `~/.codex` auth + accounts + `config.toml` surface, active-selection sync, and the `cli_auth_credentials_store = "file"` reconcile |
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
3. If enabled, `createRuntimeRotationProxyContextIfEnabled` (`scripts/codex.js`) routes the forwarded argv onto one of three transports. More branches than transports: the interactive commands and `app-server` share the canonical-home helper, differing only in options.

   | Branch | Predicate | Transport |
   | --- | --- | --- |
   | Interactive TUI | `isCodexInteractiveTuiCommand` — no forwarded subcommand at all | App runtime helper with `useCanonicalHome: true` and `detachOnExit: true`. Runs against the **canonical** `CODEX_HOME`; the provider is passed as ephemeral `-c model_providers.*` overrides. No shadow copy and no state sync-back. Nothing **provider- or transport-related** is written into `config.toml` on this path — the only top-level key the wrapper still reconciles there is `cli_auth_credentials_store`, which is transport-independent (see step 4 note). |
   | Interactive `resume` / `fork` | `isCodexInteractiveResumeCommand` — forwarded command is `resume` or `fork` | Same transport and options as the interactive TUI above. These open a TUI against an existing thread, so they must see the canonical thread index. |
   | `codex app` | `isCodexAppCommand` — forwarded command is `app` | App runtime helper process with a shadow `CODEX_HOME`. |
   | `app-server` | `isCodexAppServerCommand` — forwarded command is `app-server` | Canonical-home app helper, but `detachOnExit: false`: a resident server owns its proxy for its whole lifetime. `account/read` rewriting stays on. |
   | Everything else | request-bearing forwarded command | Shadow `CODEX_HOME` created inline by the wrapper process. |

4. The wrapper starts `lib/runtime-rotation-proxy.ts` on `127.0.0.1` with a per-process client API key. Shadow-home branches copy relevant official Codex state and rewrite `config.toml` to select `codex-multi-auth-runtime-proxy`; the canonical-home branch instead injects the same provider through `-c` arguments and passes the client key via `OPENAI_API_KEY`.
5. The official Codex CLI sends Responses/model traffic to the local provider.
6. The proxy validates the client token, evaluates runtime policy, selects a managed account, refreshes tokens if needed, and forwards to the official backend.
7. The proxy rotates to another account before streaming response bytes when it sees retryable auth refresh failures, 429s, 5xx responses, or network errors (subject to pin and min-rotation-interval throttling).
8. Successful responses stream back to the local Codex client with hop-by-hop/private/stale decoded headers removed.
9. Usage ledger rows and runtime counters are persisted for status/report/usage/budget commands.
10. On exit, shadow-home branches sync refreshed official state files back and remove the temporary directory. The canonical-home branch has nothing to sync — it read and wrote official state in place.

Why the interactive branch is different: copying the Codex home into a shadow made the official CLI reindex its thread history and SQLite state on every TUI launch. Running interactive sessions against the canonical home keeps that state reusable.

`resume` and `fork` belong to that same branch for a stronger reason. The shadow mirror deliberately omits the runtime SQLite state (`isRuntimeRotationShadowHomeOmittedEntry`), so a shadow home only ever holds a partial thread index rebuilt from the linked `sessions` directory. Resuming a thread that the shadow index does not contain left the TUI on a blank screen forever, while the same command worked under the official CLI and with the proxy disabled. Routing both commands to the canonical home is what makes the thread visible (#647).

`app-server` joins them for both reasons at once, and one of its own. It is a resident server rather than a one-shot forwarded command: clients attach for the life of the process and drive whole threads through it, so a shadow home would hand every attached client the mirror's frozen snapshot of the thread index. It also cannot start there at all — Codex refuses when `<CODEX_HOME>/app-server-control` exists and is not a directory, and the shadow mirror symlinks that directory like any other, so `codex app-server` exits with `socket directory path exists and is not a directory` on any home that has already run one. Because the server is resident, its branch sets `detachOnExit: false`: the helper stops when the server does, instead of idling on for its full timeout and stranding one proxy per supervised restart. `proxyAppServerAccountRead` stays on across the move, so stdio clients still see the `codex-multi-auth` identity from `account/read`, `getAuthStatus`, and `account/rateLimits/read`.

Helper shutdown is bounded rather than best-effort. `stopRuntimeRotationAppHelper` sends `SIGTERM`, waits out the graceful window, escalates to `SIGKILL` if the helper is still running, and then unconditionally destroys the helper's stdio streams and unrefs the child. That last step is the load-bearing one: the helper is spawned with piped stdio, so a helper that outlives the window — or any process that inherited those pipes — keeps the wrapper's event loop referenced and the shell prompt never returns. On Windows the signals are emulated as unconditional termination, so the stream teardown is the only part that reliably frees the wrapper there.

Two interactive sessions can therefore run concurrently against the same home — the same as running the official CLI twice — and **no lock is taken over session state**: neither session copies or syncs it, so there is nothing to clobber. Regression coverage lives in `test/codex-bin-wrapper.test.ts`.

Scope that guarantee to session state only. It does **not** extend to `config.toml`: `ensureCodexCliFileAuthStore` (`lib/codex-cli/writer.ts`) still read-modify-writes the canonical file when the store is not already `"file"`, and the atomic write does not serialize cross-process writers. That is safe in practice rather than by locking — the operation is idempotent, converges on a single value, and lands via atomic rename, so concurrent invocations agree instead of interleaving. Anything added to that write path that is *not* idempotent would need a real lock.

Internal env used by these branches (not operator-facing): `CODEX_MULTI_AUTH_APP_ROTATION_USE_CANONICAL_HOME`, `CODEX_MULTI_AUTH_APP_SERVER_CONFIG_ARGS_JSON`, `CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID`, `CODEX_MULTI_AUTH_REAL_CODEX_HOME`.

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
- Runs three best-effort steps, each recording `completed` / `skipped` / `failed` without secrets:
  1. **App bind** — packaged Codex app bind, when rotation is enabled and the environment is not CI/`npx`/project-local.
  2. **Launcher** — user-level launcher routing, under the same gate.
  3. **Auth store** — `ensureCodexCliFileAuthStore()` pins the top-level `cli_auth_credentials_store = "file"` in `~/.codex/config.toml` (`lib/codex-cli/writer.ts`).
- Failures are debug-logged and never block the requested command.

The marker is versioned (`FIRST_RUN_MARKER_VERSION = 2`). Because `ensureFirstRunSetup` short-circuits on marker existence, a marker written before the auth-store step existed (`version: 1`, or any unreadable/truncated marker) is **migrated in place** on the next manager CLI run: only the auth-store step is replayed. App bind and launcher install are deliberately not rerun, so shortcuts the user removed stay removed. The migration takes no exclusive claim — both `ensureCodexCliFileAuthStore` and the atomic marker write are idempotent, so concurrent invocations converge instead of racing.

A **failed** auth-store step deliberately records the pre-v2 version so the next run retries it; otherwise one transient Windows `EPERM`/`EBUSY` on a locked `config.toml` would strand the install on keychain mode permanently. A `skipped` result does advance the version, since that is the normal outcome both for a config already pinned to `"file"` and for an explicit `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0` opt-out.

Explicit repair remains `codex-multi-auth rotation enable` / `bind-app` / launcher install helpers, plus `codex-multi-auth doctor --fix` for the auth-store pin.

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
10. **The keychain is never touched** — the `cli_auth_credentials_store` reconcile only rewrites a top-level TOML assignment in `~/.codex/config.toml`. No keychain item and no `security` CLI is ever read or written, and credentials saved by an earlier official `codex login` are left in place (unread once the store is pinned to `"file"`). Opt out of the per-invocation `-c` override with `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0`, or of every persisted rewrite with `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0`.
11. **Canonical-home overrides carry no secret on disk** — the interactive path passes provider config as `-c` arguments and the per-process client key through `OPENAI_API_KEY` in the child environment, so no credential is persisted into the user's `config.toml`.

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
14. Interactive TUI sessions run against the canonical `CODEX_HOME`. They must not be moved back onto a shadow copy: doing so reintroduces per-launch thread-history reindexing, and the no-lock concurrency guarantee depends on neither session copying or syncing state.
15. The rotation provider is never written into the real `~/.codex/config.toml` on the interactive path. The only top-level key this project reconciles there is `cli_auth_credentials_store`.
16. The keychain is never read or written. Reading a keychain item would raise the prompt the auth-store pin exists to eliminate; a `[profiles.*]` credential-store value is left as authored.

* * *

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [TESTING.md](TESTING.md)
- [REPOSITORY_SCOPE.md](REPOSITORY_SCOPE.md)
- [../architecture.md](../architecture.md)
- [../features.md](../features.md)
