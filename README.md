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
- `?` or `H`: help
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
