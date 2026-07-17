# codex-multi-auth Architecture

Public overview of how `codex-multi-auth` fits around the official Codex CLI: account manager, optional forwarding wrappers, local storage, runtime Responses rotation, local governance, optional bridge, reversible app bind, and optional plugin-host path.

---

## The Short Version

`codex-multi-auth` is a multi-account OAuth manager for the official `@openai/codex` CLI.

- `codex-multi-auth ...` commands are handled locally by the account manager.
- `codex-multi-auth-codex ...` is the optional forwarding wrapper for official Codex CLI commands.
- `mcodex ...` is a convenience launcher over that wrapper (`--monitor`, `--tmux` / `-t`).
- The package does **not** publish a global `codex` binary; that name stays owned by the official Codex install path.
- Account, settings, quota, usage, policy, backup, and diagnostic state live under `~/.codex/multi-auth`.
- Runtime rotation is **default-on** for request-bearing sessions launched through this package's wrapper or app bind.
- When runtime rotation is enabled, forwarded Codex CLI/app sessions can send Responses traffic through a localhost-only proxy that selects managed accounts per request.
- Local governance (usage ledger, budgets, account pause/drain, routing profiles, capability matrix) is enforced at runtime via `evaluateRuntimePolicy` on the rotation path.
- The plugin-host entrypoint remains available for advanced host integrations, but it is not required for normal CLI use.

---

## Published Binaries

`package.json` publishes four bins:

| Binary | Script | Role |
| --- | --- | --- |
| `codex-multi-auth` | `scripts/codex-multi-auth.js` | Account manager only. Bare subcommands (`status`, `login`, …) normalize to the local auth manager. |
| `codex-multi-auth-codex` | `scripts/codex.js` | Wrapper: `auth ...` stays local; every other command forwards to official Codex with optional runtime rotation and a shadow `CODEX_HOME`. |
| `mcodex` | `scripts/mcodex.js` | Convenience over `codex.js`: default forward, `--monitor` (live `list` via `watch`), `--tmux` / `-t` (optional `--live-accounts`). |
| `codex-multi-auth-app-launcher` | `scripts/codex-app-launcher.js` | Desktop launcher helper for supported user-level shortcuts / managed macOS wrapper apps. |

The standalone manager normalizes bare account-manager commands, so both `codex-multi-auth status` and `codex-multi-auth auth status` reach the same local manager. The forwarding wrapper handles `auth ...` locally, forwards every other command to the official Codex CLI, and injects runtime-rotation provider settings when rotation is enabled.

---

## Main Components

### 1. Account manager

`lib/codex-manager.ts` and `lib/codex-manager/commands/` provide the local dashboard and CLI surface, including:

| Area | Examples |
| --- | --- |
| Accounts | `login`, `list`, `status`, `switch`, `unpin`, `workspace` |
| Health / selection | `check`, `forecast`, `best`, `report`, `why-selected` |
| Repair | `fix`, `doctor`, `verify` / `verify-flagged` |
| Rotation | `rotation status\|enable\|disable\|bind-app\|unbind-app\|…` |
| Governance | `usage`, `budget`, `account` (tag/weight/pause/drain), `models`, `monitor` |
| Bridge / integrations | `bridge token …`, `integrations` |
| Sessions | `history` (provider-agnostic local rollout browser) |
| Config / debug | `config`, `init-config`, `debug bundle`, `uninstall` |

### 2. Optional wrapper + shadow `CODEX_HOME`

`codex-multi-auth-codex` (`scripts/codex.js`):

- Resolves the real official Codex binary on `PATH`.
- Handles multi-auth `auth` subcommands locally.
- Forwards non-auth commands to official Codex.
- For request-bearing sessions with runtime rotation enabled, creates a temporary shadow `CODEX_HOME`, writes a local provider (`codex-multi-auth-runtime-proxy`), and starts a loopback proxy for that process.
- Keeps forwarded sessions on file-backed auth state unless the caller opts out.
- Supports ephemeral force-pin: `codex-multi-auth-codex --account <index|email|id>` (or `CODEX_MULTI_AUTH_FORCE_ACCOUNT`) for a single invocation only — never mutates the persisted `switch` pin.

`mcodex` is a thin convenience entry over the same wrapper script (spawned via `node` + sibling `codex.js`, not via a PATH shim).

### 3. Runtime rotation proxy

When `codexRuntimeRotationProxy` is enabled (default), the wrapper starts a loopback Responses-compatible proxy and points a temporary shadow config at the local provider:

`codex-multi-auth-runtime-proxy`

The proxy:

- accepts only local authenticated client requests (per-process client token)
- forwards Responses API and model discovery requests
- replaces upstream auth headers with the selected managed account
- runs `evaluateRuntimePolicy` before account selection (pause/drain, budgets, routing profiles, capability matrix)
- rotates accounts on rate limits, auth refresh failures, network errors, and server errors before response bytes are streamed
- strips hop-by-hop and stale decoded response headers before returning data to the local Codex client
- records runtime status for `codex-multi-auth status`, `codex-multi-auth report`, and `codex-multi-auth rotation status`
- appends redacted usage ledger rows after request completion or failure

### 4. Local governance

Local-only controls under `~/.codex/multi-auth`:

| Concern | Storage / module | CLI |
| --- | --- | --- |
| Usage ledger | `usage/usage-ledger.jsonl` | `codex-multi-auth usage` |
| Budget guards | `budget-guards.json` | `codex-multi-auth budget` |
| Account policy (tags, weight, pause, drain, notes) | `account-policies.json` | `codex-multi-auth account …` |
| Routing profiles | `routing-profiles.json` | project-aware resolution + `monitor` |
| Model / account capability matrix | derived + capability policy cache | `codex-multi-auth models` |
| Aggregated operator view | runtime observability + above | `codex-multi-auth monitor` |

**Pause and drain are enforced at runtime.** `evaluateRuntimePolicy` marks paused or drained accounts as blocked for rotation selection on the runtime proxy (and plugin-host) path. Budgets are best-effort guards (eventually consistent under concurrency); they are not a hard multi-process reservation system.

### 5. Local bridge + client tokens

Optional loopback bridge (`lib/local-bridge.ts`) exposes `/health`, `/v1/models`, and `/v1/responses`, forwarding to a configured runtime base URL.

- Client tokens are `cma_local_*` values; only SHA-256 hashes and prefixes are stored (`local-client-tokens.json`).
- Manage tokens with `codex-multi-auth bridge token create|list|rotate|revoke`.
- Plain token is shown only once at create/rotate.
- Integration snippet helpers: `codex-multi-auth integrations`.

### 6. Storage V3, project pools, worktree identity

Account storage uses the V3 on-disk format (`AccountStorageV3`).

- Default pool: `~/.codex/multi-auth/openai-codex-accounts.json`
- Optional project-scoped pools: `~/.codex/multi-auth/projects/<project-key>/…`
- Linked Git worktrees share repo identity so account pools are not split per worktree path
- WAL, `.bak` snapshots, named backups, and flagged-account recovery support repair flows
- Selected account can be synced into official Codex CLI files under `~/.codex` so plain forwarded Codex commands keep the intended account

### 7. Reversible app bind

`lib/runtime/app-bind.ts` and `scripts/codex-app-router.js` support packaged Codex desktop app routing:

- real Codex `config.toml` is backed up before modification
- a localhost router is started for the app
- a user login startup entry keeps the router available
- `codex-multi-auth rotation disable` or `codex-multi-auth rotation unbind-app` restores the backup and removes the startup entry
- official app binaries are **not** patched

`codex-multi-auth-app-launcher` retargets supported user-level shortcuts or creates a managed macOS wrapper app.

### 8. Lazy first-run setup (shipped)

`npm` postinstall is **notice-only** (no app detection or filesystem mutation). App bind and launcher setup run once on the first `codex-multi-auth` invocation from a durable global install, recorded in:

`~/.codex/multi-auth/first-run-setup.json`

- Skipped for CI, `npx`, and project-local installs (marker is not consumed in those cases).
- Opt-outs: `CODEX_MULTI_AUTH_APP_BIND` / `CODEX_MULTI_AUTH_APP_BIND_INSTALL`, `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL`.
- Failures are best-effort and never block the command.

### 9. Optional plugin-host runtime

The package root still exports the plugin-host entrypoint for integrations that load `index.ts`.

That path reuses the same account pool for:

- request transformation
- token refresh
- retry and failover
- session affinity
- live account sync
- quota-aware selection
- the same runtime policy evaluation surface as the rotation proxy

Normal `codex-multi-auth ...` usage and wrapper forwarding do not require this host mode.

---

## Request Flow

### Account manager

```text
Terminal user
  |
  | codex-multi-auth status|login|forecast|…
  v
scripts/codex-multi-auth.js
  |
  | bare cmds normalize to auth manager
  v
lib/codex-manager.ts + commands/
  |
  v
~/.codex/multi-auth (accounts, settings, caches, governance)
```

### Forwarding wrapper (no rotation / non-request path)

```text
Terminal user
  |
  | codex-multi-auth-codex …   or   mcodex …
  v
scripts/codex.js  (mcodex forwards here)
  |
  | auth … → local manager
  | else → official Codex CLI
  v
Official Codex CLI
```

### Default runtime rotation path

```text
Terminal user or Codex app
  |
  v
codex-multi-auth-codex wrapper / app bind / mcodex
  |
  | shadow CODEX_HOME + provider: codex-multi-auth-runtime-proxy
  v
localhost Responses proxy (client token)
  |
  | evaluateRuntimePolicy → select managed account
  | replace Authorization with account token
  v
Official Codex / ChatGPT-backed backend
  |
  | usage ledger row (redacted)
  v
Local client
```

### Optional local bridge

```text
Local client (curl / script / tool)
  |
  | Bearer cma_local_*
  v
local bridge (loopback: /health, /v1/models, /v1/responses)
  |
  | runtime client token
  v
runtime rotation proxy (or configured runtime base URL)
  |
  v
Official backend via selected managed account
```

### Optional plugin-host path

```text
Plugin host
  |
  v
codex-multi-auth plugin runtime (index.ts)
  |
  | same account pool + refresh / retry / failover / policy
  v
Codex or ChatGPT-backed request flow
```

---

## Design Constraints

- The official OAuth flow remains the source of authentication.
- The canonical command family is `codex-multi-auth ...`.
- The package does not publish a global `codex` binary.
- The OAuth callback port remains `1455` (provider-registered redirect URI).
- Runtime rotation is default-on and localhost-only.
- Credentials and governance state stay local under `~/.codex/multi-auth`.
- Pause/drain and other runtime policy checks apply on the rotation/proxy path via `evaluateRuntimePolicy`.
- The desktop app bind is reversible and does not patch official app files.
- First-run app integration is lazy (postinstall is notice-only).
- Local storage and repair tooling target personal operator workflows, not hosted multi-user services.
- Default general model routing uses `gpt-5.5`; diagnostic live/quota probes lead with `gpt-5.6-sol`.

---

## Related

- [getting-started.md](getting-started.md)
- [features.md](features.md)
- [faq.md](faq.md)
- [configuration.md](configuration.md)
- [reference/commands.md](reference/commands.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
