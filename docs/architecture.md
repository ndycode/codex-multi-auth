# Architecture

Public overview of how `codex-multi-auth` fits around the official Codex CLI.

---

## The Short Version

`codex-multi-auth` is a `codex` wrapper plus a local multi-account manager.

- `codex auth ...` is handled locally
- all other `codex` commands are forwarded to `@openai/codex`
- account state is stored under `~/.codex/multi-auth`
- an optional plugin runtime can reuse the same account pool for request handling

---

## Main Components

### 1. Wrapper entrypoint

`scripts/codex.js` is the command entrypoint installed as `codex`.

It decides whether the current command should:

- stay local as a `codex auth ...` command
- forward to the official `@openai/codex` binary

### 2. Local account manager

`lib/codex-manager.ts` provides the account dashboard and account-management commands:

- `login`
- `list`
- `status`
- `switch`
- `check`
- `forecast`
- `report`
- `fix`
- `doctor`

### 3. Local storage

Account and settings data live under `~/.codex/multi-auth`, with optional project-scoped account pools under `projects/<project-key>/`.

### 4. Optional plugin runtime

If you use the plugin-host path, `index.ts` can use the same account pool for:

- request transformation
- token refresh
- retry and failover
- session affinity
- live account sync
- quota-aware selection

That advanced path is configured separately from the default account-manager install. See [advanced-plugin-install.md](advanced-plugin-install.md).

---

## Request Flow

```text
Terminal user
  |
  | codex auth ...
  v
codex-multi-auth wrapper
  |- handles auth commands locally
  |- forwards non-auth commands to @openai/codex
  v
Official Codex CLI
```

Optional advanced path:

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

- The official OAuth flow remains the source of authentication
- The canonical command family is `codex auth ...`
- The OAuth callback port remains `1455`
- Local storage and repair tooling are designed for predictable operator workflows, not multi-tenant services
- Browser login, repair, and plugin-install steps are operator actions and should not be auto-run by agents without user approval

---

## Related

- [getting-started.md](getting-started.md)
- [advanced-plugin-install.md](advanced-plugin-install.md)
- [features.md](features.md)
- [reference/commands.md](reference/commands.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
