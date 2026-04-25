# Architecture

Public overview of how `codex-multi-auth` fits around the official Codex CLI.

---

## The Short Version

`codex-multi-auth` is a local `codex` wrapper plus a multi-account OAuth manager.

- `codex auth ...` commands are handled locally by the account manager.
- All other `codex` commands are forwarded to the official Codex CLI.
- Account, settings, quota, backup, and diagnostic state lives under `~/.codex/multi-auth`.
- Runtime rotation is optional and enabled by default.
- When runtime rotation is enabled, forwarded Codex sessions can send Responses traffic through a localhost-only proxy that selects managed accounts per request.
- The plugin-host entrypoint remains available for advanced host integrations, but it is not required for normal CLI use.

---

## Main Components

### 1. Wrapper entrypoint

`scripts/codex.js` is installed as `codex`.

It decides whether the current command should:

- stay local as `codex auth ...`
- forward to the official Codex CLI
- add runtime-rotation provider settings before forwarding, when rotation is enabled

The wrapper also keeps forwarded official Codex sessions on file-backed auth state unless the caller explicitly opts out.

### 2. Local account manager

`lib/codex-manager.ts` and `lib/codex-manager/commands/` provide the account dashboard and commands:

- `login`
- `list`
- `status`
- `switch`
- `check`
- `forecast`
- `best`
- `report`
- `fix`
- `doctor`
- `rotation`

### 3. Local storage and sync

Account and settings data live under `~/.codex/multi-auth`, with optional project-scoped pools under `projects/<project-key>/`.

The account manager can sync the selected account into the official Codex CLI files under `~/.codex` so regular forwarded Codex commands keep using the intended account.

### 4. Runtime rotation proxy

When `codexRuntimeRotationProxy` is enabled, the wrapper starts a loopback Responses-compatible proxy and writes a temporary shadow `CODEX_HOME/config.toml` that selects the local provider:

`codex-multi-auth-runtime-proxy`

The proxy:

- accepts only local authenticated client requests
- forwards Responses API and model discovery requests
- replaces upstream auth headers with the selected managed account
- rotates accounts on rate limits, auth refresh failures, network errors, and server errors before response bytes are streamed
- strips hop-by-hop and stale decoded response headers before returning data to the local Codex client
- records runtime status for `codex auth status`, `codex auth report`, and `codex auth rotation status`

### 5. Codex desktop app support

`codex auth rotation enable` can bind a packaged Codex desktop app to the same local runtime-rotation path.

This is reversible:

- the real Codex `config.toml` is backed up before modification
- a localhost router is started for the app
- a user login startup entry keeps the router available
- `codex auth rotation disable` or `codex auth rotation unbind-app` restores the backup and removes the startup entry
- official app binaries are not patched

`scripts/codex-app-launcher.js` also supports user-level shortcut routing for environments where shortcuts can be retargeted safely.

### 6. Optional plugin-host runtime

The package root still exports the plugin-host entrypoint for integrations that load `index.ts`.

That path reuses the same account pool for:

- request transformation
- token refresh
- retry and failover
- session affinity
- live account sync
- quota-aware selection

Normal `codex auth ...` usage and wrapper forwarding do not require this host mode.

---

## Request Flow

Default CLI path:

```text
Terminal user
  |
  | codex auth ...
  v
codex-multi-auth wrapper
  |
  v
local account manager
```

Forwarded official Codex path:

```text
Terminal user
  |
  | codex exec/review/resume/app/...
  v
codex-multi-auth wrapper
  |
  | forwards non-auth command
  v
Official Codex CLI
```

Default runtime rotation path:

```text
Terminal user or Codex app
  |
  v
codex-multi-auth wrapper/app bind
  |
  | local provider: codex-multi-auth-runtime-proxy
  v
localhost Responses proxy
  |
  | selected managed account token
  v
Official Codex backend
```

Optional plugin-host path:

```text
Plugin host
  |
  v
codex-multi-auth plugin runtime
  |
  v
Codex or ChatGPT-backed request flow with refresh, retry, and failover
```

---

## Design Constraints

- The official OAuth flow remains the source of authentication.
- The canonical command family is `codex auth ...`.
- The OAuth callback port remains `1455`.
- Runtime rotation is default-on and localhost-only.
- The desktop app bind is reversible and does not patch official app files.
- Local storage and repair tooling are designed for personal operator workflows, not hosted multi-user services.

---

## Related

- [getting-started.md](getting-started.md)
- [features.md](features.md)
- [configuration.md](configuration.md)
- [reference/commands.md](reference/commands.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
