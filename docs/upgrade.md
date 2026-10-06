# Upgrade Guide

How to move an older install to the canonical `codex-multi-auth` package on the current `2.x` release line, and what changed along the way that you need to know about.

---

## What's Current

| Item | Value |
| --- | --- |
| Package | `codex-multi-auth` (npm, unscoped) |
| Command family | `codex-multi-auth …` |
| Wrapper | `codex-multi-auth-codex`, `mcodex` |
| Data root | `~/.codex/multi-auth` |
| Official CLI | `codex`, owned by `@openai/codex` — this package no longer publishes that name |

---

## Upgrade

This release requires Node.js `22.19.0` or later. If you run Node.js 18 or 20, upgrade Node.js first — the package will not install on older runtimes.

```bash
npm i -g @openai/codex        # if the official CLI isn't installed yet
npm i -g codex-multi-auth
codex-multi-auth status       # runs one-time first-run setup (see below)
```

Then rebuild a health baseline:

```bash
codex-multi-auth check
codex-multi-auth forecast --live
```

No storage migration step is needed — the account pool upgrades in place on first load, and older layouts migrate automatically.

### Migrate From The Legacy Package

The prerelease was published under the scoped name `@ndycode/codex-multi-auth`. If it is still installed:

```bash
npm uninstall -g @ndycode/codex-multi-auth
npm i -g codex-multi-auth
```

The account pool under `~/.codex/multi-auth` carries over.

---

## Changes To Know About

### `codex` Is No Longer Ours (v2.1.2)

The package stopped publishing a global `codex` binary — that name belongs to the official Codex install path (npm, Homebrew, or a release binary). Use `codex-multi-auth …` for account management, and `codex-multi-auth-codex`/`mcodex` when you intentionally want the forwarding wrapper. If a stale shim still answers to `codex`, reinstall the official CLI.

### First-Run Setup Moved Out Of `npm install`

Postinstall is notice-only — installing the package no longer touches your desktop or config. The first `codex-multi-auth` command from a durable global install performs the one-time setup instead, then claims the marker at `~/.codex/multi-auth/first-run-setup.json`:

- best-effort bind of a detected Codex desktop app to the local rotation router
- user-level app launcher routing where supported
- `cli_auth_credentials_store="file"` enforcement in `~/.codex/config.toml`

A failure never blocks the command. `npx` runs, project-local installs, and CI always skip this. Opt-outs, set before first run:

| Variable | Effect |
| --- | --- |
| `CODEX_MULTI_AUTH_APP_BIND=0` / `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` | Skip the packaged-app bind |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` | Skip launcher routing install |

### Runtime Rotation Is Default-On

On the current `2.x` release line, request-bearing sessions launched through `codex-multi-auth-codex`, `mcodex`, or an installed app bind route through the loopback rotation proxy. Official app binaries are never patched, and pause/drain/budget policies are enforced on this path.

- `codex-multi-auth rotation disable` turns the proxy off and removes the app bind; `rotation enable` restores both.
- `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` disables it per environment.

Validate after upgrading:

```bash
codex-multi-auth rotation status
codex-multi-auth forecast --live
```

### Model Defaults

- General routing default (`DEFAULT_MODEL`): `gpt-6.1-sol`. The `gpt-5` alias targets `gpt-5.6-sol`, the newest 5.x generation still served.
- Retired ids are rewritten before the request is sent: `gpt-5.5` → `gpt-6-sol`, `gpt-5.5-pro` → `gpt-6-astra`, `gpt-6-astra-aeon` → `gpt-6-astra`. The replacement's reasoning ladder and rate card apply, so `none` coerces to `low`, and new ledger rows are priced at the replacement rate.
- Live diagnostic probes (`check`, `report`, `forecast`, `best`, `fix`) lead with `gpt-5.6-sol`, then fall through a chain for accounts without entitlement.

```bash
codex-multi-auth forecast --live --model gpt-5.6-sol
codex-multi-auth fix --live --model gpt-6.1-sol
```

### Login Flow

- `codex-multi-auth login` stays browser-first. `--device-auth` is the headless path (prints `https://auth.openai.com/codex/device` and a code valid 15 minutes); `--manual` / `--no-browser` paste the callback by hand. `CODEX_AUTH_NO_BROWSER=1` suppresses the browser launch.
- Codex CLI now refuses workspaces the backend doesn't authorize. `login` verifies its automatic workspace pick against `wham/accounts/check` (one extra request; fails open) and swaps an unauthorized auto-pick for the backend's default. Accounts saved before this check need one pass of `codex-multi-auth fix --live` to rebind org-sourced ids.
- `login` on an empty pool opens the sign-in menu directly; when a valid named backup exists under `~/.codex/multi-auth/backups/`, the menu offers to restore it.

### Config Precedence

1. File from `CODEX_MULTI_AUTH_CONFIG_PATH`, when set and present.
2. `pluginConfig` inside `~/.codex/multi-auth/settings.json`.
3. Legacy config paths (one-time migrate warning).
4. Built-in defaults — then environment variables override individual settings.

`codex-multi-auth config explain [--json]` shows where each live value came from. See [configuration.md](configuration.md) for stable overrides and [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md) for the full resolution flow.

### Governance Commands Shipped On 2.x

`usage`, `budget`, `account` (pause/drain/tag/weight/note/priority/auto-prime), `models`, `monitor`, `resets`, `bridge token`, `history`, plus the `mcodex` launcher. All local and file-backed under `~/.codex/multi-auth` — no hosted service was added.

### Uninstall Behavior

`preuninstall.js` ships in the package but is **not** an npm lifecycle hook on modern npm, so `npm uninstall -g` alone leaves residue. Run `codex-multi-auth uninstall` *before* removing the package — see [troubleshooting.md](troubleshooting.md#uninstall-completely).

### Subscription Status And Pro Max Priming

Unused Pro Max (Pro 500) subscriptions now qualify for opted-in first-use priming. `status` and `check accounts` show the observed plan, selected workspace, auto-prime setting, and first-use state; `status --json` adds a per-account `subscription` object (`planType`, `planLabel`, `selectedWorkspace`, `autoPrime`, `primingState`, `primingFailure`, `automaticBlock`, `freshness`, `observedAt`). Policy read failures show an unknown auto-prime setting rather than off.

- Checks use the saved selected workspace; disabled or invalid selections do not fall back to the stored binding.
- Status reads cached observations without network calls. Observations older than 30 minutes are stale, and 0% usage can still have a running reset timer.
- Use `check accounts` to refresh observations, or add `--prime` to allow first-use completion. Existing priming policies are preserved.

No new npm scripts or manual storage migration are required.

---

## Downgrading Past 2.17.0

Account priority tiers (`codex-multi-auth account priority <index> <0..9>`) are stored as a `priority` field in `account-policies.json`. Versions before 2.17.0 drop the unknown field on their next policy write, returning every account to the default tier — re-run `account priority` after upgrading again. The newer `api-routes.json`, `reset-credits.json`, and model-discovery files are ignored by older versions and left in place.

---

## Worktree Storage Migration

Automatic on first load: legacy worktree-keyed pools merge into the repo-shared `projects/<project-key>/` file. Legacy files are removed only after a successful canonical write; if the write fails, they stay in place to avoid data loss.

---

## Common Upgrade Problems

| Problem | Fix |
| --- | --- |
| `codex-multi-auth` not found | `npm ls -g codex-multi-auth`; check npm's global bin is on `PATH` |
| Old scoped package still active | Uninstall `@ndycode/codex-multi-auth`, reinstall `codex-multi-auth` |
| Pool looks stale | `codex-multi-auth doctor --fix`, then re-login affected accounts |
| Still expecting this package to own `codex` | Use `codex-multi-auth-codex`/`mcodex`; `codex` is the official CLI |
| Newest models missing from the app model picker after upgrade | Re-run the config install you originally used (it merges new template models into your config), restart the app, then `codex-multi-auth rotation bind-app` if you use the bind |
| Residue after `npm uninstall -g` | Run `codex-multi-auth uninstall` before removing the package next time; see [troubleshooting.md](troubleshooting.md#uninstall-completely) |

---

## Related

- [getting-started.md](getting-started.md)
- [troubleshooting.md](troubleshooting.md)
- [features.md](features.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)
