# codex-multi-auth

[![npm version](https://img.shields.io/npm/v/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)
[![npm downloads](https://img.shields.io/npm/dw/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)

Codex CLI-first multi-account OAuth manager for the official Codex CLI.

* * *

## Quick Start

```bash
npm i -g @openai/codex
npm i -g codex-multi-auth
codex --version
codex auth status
```

If you previously installed the scoped prerelease package:

```bash
npm uninstall -g @ndycode/codex-multi-auth
```

Add and verify accounts:

```bash
codex auth login
codex auth list
codex auth check
```

* * *

## What You Get

- `codex auth ...` commands for multi-account management.
- Interactive dashboard with beginner-friendly hotkeys.
- Health checks, forecasting, safe fixes, and diagnostics.
- Live sync, quota-aware routing, and resilience controls.

* * *

## Most-Used Commands

| Command | Use it for |
| --- | --- |
| `codex auth login` | Add/manage accounts in dashboard |
| `codex auth list` | List saved accounts and current account |
| `codex auth switch <index>` | Switch active account |
| `codex auth check` | Quick health + live session checks |
| `codex auth forecast --live` | Choose best next account |
| `codex auth fix --dry-run` | Preview safe fixes |
| `codex auth fix --live --model gpt-5-codex` | Run fix with live probe on a specific model |
| `codex auth fix` | Apply safe fixes |
| `codex auth doctor --fix` | Diagnose + repair common issues |
| `codex auth report --live --json` | Export machine-readable status |

Full command reference: [docs/reference/commands.md](docs/reference/commands.md)

* * *

## Dashboard Hotkeys

Main dashboard:

- `Up` / `Down`: move
- `Enter`: select
- `1-9`: quick switch
- `/`: search
- `?`: toggle help
- `Q`: back/cancel

Account detail menu:

- `S`: set current
- `R`: refresh login
- `E`: enable/disable
- `D`: delete account

* * *

## Settings

Open settings from dashboard:

```bash
codex auth login
# choose Settings
```

Settings location:

- `~/.codex/multi-auth/settings.json`
- or `CODEX_MULTI_AUTH_DIR/settings.json` when custom root is set

Reference: [docs/reference/settings.md](docs/reference/settings.md)

* * *

## Stable Env Overrides

Use these stable overrides first:

| Variable | Purpose |
| --- | --- |
| `CODEX_MULTI_AUTH_DIR` | Override the multi-auth root (`settings`, accounts, cache, logs) |
| `CODEX_MULTI_AUTH_CONFIG_PATH` | Load plugin config from an alternate file |
| `CODEX_HOME` | Override Codex home used to resolve default paths |
| `CODEX_MODE` | Toggle Codex mode |
| `CODEX_TUI_V2` | Toggle TUI v2 |
| `CODEX_TUI_COLOR_PROFILE` | Set TUI color profile (`truecolor`, `ansi256`, `ansi16`) |
| `CODEX_TUI_GLYPHS` | Set glyph mode (`ascii`, `unicode`, `auto`) |
| `CODEX_AUTH_FETCH_TIMEOUT_MS` | Override upstream request timeout |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | Override stream stall timeout |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI` | Toggle Codex CLI state synchronization |
| `CODEX_CLI_ACCOUNTS_PATH` / `CODEX_CLI_AUTH_PATH` | Override Codex CLI state file locations |
| `CODEX_MULTI_AUTH_REAL_CODEX_BIN` | Force forwarded Codex binary path |
| `CODEX_MULTI_AUTH_BYPASS` | Disable local auth interception and always forward |

Advanced/internal toggles are documented in [docs/development/CONFIG_FIELDS.md](docs/development/CONFIG_FIELDS.md).

* * *

## Documentation

Start here:

- Docs portal: [docs/README.md](docs/README.md)
- Getting started: [docs/getting-started.md](docs/getting-started.md)
- Features: [docs/features.md](docs/features.md)
- Configuration: [docs/configuration.md](docs/configuration.md)
- Troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md)
- Storage paths: [docs/reference/storage-paths.md](docs/reference/storage-paths.md)
- Upgrade guide: [docs/upgrade.md](docs/upgrade.md)
- Privacy: [docs/privacy.md](docs/privacy.md)
- Stable release notes: [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md)

Maintainer docs:

- Architecture: [docs/development/ARCHITECTURE.md](docs/development/ARCHITECTURE.md)
- Config fields: [docs/development/CONFIG_FIELDS.md](docs/development/CONFIG_FIELDS.md)
- Config flow: [docs/development/CONFIG_FLOW.md](docs/development/CONFIG_FLOW.md)
- Testing: [docs/development/TESTING.md](docs/development/TESTING.md)

* * *

## Support Checklist

```bash
codex auth doctor --fix
codex auth list
codex auth forecast --live
```

If account data looks stale, run `codex auth check` first.
