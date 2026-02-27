# codex-multi-auth

[![npm version](https://img.shields.io/npm/v/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)
[![npm downloads](https://img.shields.io/npm/dw/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)

Codex CLI-first multi-account OAuth manager for the official Codex CLI.

* * *

## Quick Start

Install from source (current project workflow):

```bash
npm install -g @openai/codex
git clone https://github.com/ndycode/codex-multi-auth.git
cd codex-multi-auth
npm install
npm run build
npm link
```

Add and verify accounts:

```bash
codex auth login
codex auth list
codex auth check
```

If browser opens during `codex auth login`, that is expected. Complete OAuth and return to the same terminal.

* * *

## What You Get

- `codex auth ...` commands for multi-account management.
- Interactive beginner-friendly dashboard with hotkeys.
- Health checks, forecasting, safe auto-fix, and diagnostics.
- Live account sync and Codex CLI active-account state sync.

* * *

## Most-Used Commands

| Command | Use it for |
| --- | --- |
| `codex auth login` | Add/manage accounts in the dashboard |
| `codex auth list` | See saved accounts and current account |
| `codex auth switch <index>` | Switch current account |
| `codex auth check` | Quick health + live session checks |
| `codex auth forecast --live` | Choose the best next account |
| `codex auth fix --dry-run` | Preview safe fixes |
| `codex auth fix` | Apply safe fixes |
| `codex auth doctor --fix` | Diagnose and auto-repair common issues |
| `codex auth report --live --json` | Full machine-readable report |
| `codex auth features` | Print all implemented feature areas |

Complete command reference: [docs/reference/commands.md](docs/reference/commands.md)

* * *

## Dashboard Hotkeys

Main dashboard:

- `Up` / `Down`: move
- `Enter`: select
- `1-9`: quick switch account
- `/`: search
- `?` or `H`: help
- `Q`: back

Account detail menu:

- `S`: set current
- `R`: refresh login
- `E`: enable/disable
- `D`: delete account

* * *

## Settings and Advanced Backend

Open:

```bash
codex auth login
# Settings
```

Settings are persisted in:

- `~/.codex/multi-auth/settings.json`
- or `CODEX_MULTI_AUTH_DIR/settings.json` when custom root is set

Reference:

- [docs/reference/settings.md](docs/reference/settings.md)

* * *

## Documentation Map

Start here:

- Docs portal: [docs/README.md](docs/README.md)
- Beginner setup: [docs/getting-started.md](docs/getting-started.md)
- Full feature matrix: [docs/features.md](docs/features.md)
- Configuration: [docs/configuration.md](docs/configuration.md)
- Troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md)
- Storage/path reference: [docs/reference/storage-paths.md](docs/reference/storage-paths.md)
- Upgrade guide: [docs/upgrade.md](docs/upgrade.md)
- Privacy/data handling: [docs/privacy.md](docs/privacy.md)

Maintainer docs:

- Architecture: [docs/development/ARCHITECTURE.md](docs/development/ARCHITECTURE.md)
- Config fields: [docs/development/CONFIG_FIELDS.md](docs/development/CONFIG_FIELDS.md)
- Config flow: [docs/development/CONFIG_FLOW.md](docs/development/CONFIG_FLOW.md)
- Testing: [docs/development/TESTING.md](docs/development/TESTING.md)
- TUI parity checklist: [docs/development/TUI_PARITY_CHECKLIST.md](docs/development/TUI_PARITY_CHECKLIST.md)

* * *

## Quick Troubleshooting

```bash
codex auth doctor --fix
codex auth list
codex auth forecast --live
```

If command routing is broken:

```bash
where codex
codex --version
codex auth status
codex multi auth status
```

* * *

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

* * *

## Security and Usage Notice

This project is for personal development workflows. You are responsible for compliance with OpenAI policies.

- Security policy: [SECURITY.md](SECURITY.md)
- License: [LICENSE](LICENSE)

