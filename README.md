# codex-multi-auth

[![npm version](https://img.shields.io/npm/v/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)
[![npm downloads](https://img.shields.io/npm/dw/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)

Codex CLI-first multi-account OAuth for ChatGPT accounts, with OpenCode plugin routing.

## Quick Start (Source Install)

```bash
npm install -g @openai/codex
git clone https://github.com/ndycode/codex-multi-auth.git
cd codex-multi-auth && npm install && npm run build && npm link
codex auth login
codex auth list
```

If `codex auth login` opens browser: that is expected. Finish OAuth in browser, then return to the same terminal.

`codex-multi-auth` is currently used from source in this repo workflow (not from npm registry).

## Upgrade Notes

If you are upgrading from older OpenCode-first docs/flows, read:

- [docs/upgrade.md](docs/upgrade.md)

It covers command changes, legacy path compatibility, and the recommended migration sequence.

## What This Project Adds

- `codex auth ...` multi-account commands.
- Codex-style terminal account dashboard with beginner hotkeys.
- Automatic account health checks, forecast, fix, and doctor diagnostics.
- OpenCode plugin path that uses your OAuth account pool.
- Live account sync (changes can apply without restarting your session).

## Command Cheat Sheet

| Command | Purpose |
| --- | --- |
| `codex auth login` | Add/manage accounts from one dashboard |
| `codex auth list` | Print account list and active index |
| `codex auth status` | Alias-style status summary |
| `codex auth switch <index>` | Set current account manually |
| `codex auth check` | Refresh-check all accounts |
| `codex auth forecast --live` | Forecast best account and quota risk |
| `codex auth report --live --json` | Full machine-readable health report |
| `codex auth fix --dry-run` | Preview safe account fixes |
| `codex auth fix` | Apply safe fixes |
| `codex auth doctor --fix --dry-run` | Preview diagnostics auto-fixes |
| `codex auth doctor --fix` | Apply diagnostics auto-fixes |

## Beginner Hotkeys In Auth Dashboard

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move selection |
| `Enter` | Open selected action/account |
| `Esc` or `Q` | Back/cancel |
| `1-9` | Set account as current immediately |
| `A` | Add account |
| `C` | Quick check |
| `P` | Forecast |
| `X` | Auto-fix |
| `/` | Search accounts |
| `H` | Toggle help panel |

Account detail menu keys:

| Key | Action |
| --- | --- |
| `S` | Set current |
| `R` | Refresh this account |
| `E` | Enable/disable this account |
| `D` | Delete this account |

## OpenCode Setup

Fast path:

```bash
codex-multi-auth --modern
```

Manual path: create/update `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["codex-multi-auth"]
}
```

Run a quick test:

```bash
opencode run "hello" --model=openai/gpt-5.1 --variant=medium
```

## File Locations

| Data | Path |
| --- | --- |
| Plugin config | `~/.opencode/codex-multi-auth-config.json` |
| Account storage (global) | `~/.opencode/openai-codex-accounts.json` |
| Account storage (per-project) | `~/.opencode/projects/<project-key>/openai-codex-accounts.json` |
| Plugin logs | `~/.opencode/logs/codex-plugin/` |
| Prompt cache | `~/.opencode/cache/` |
| Codex CLI account state | `~/.codex/accounts.json` |
| OpenCode config | `~/.config/opencode/opencode.json` |

Legacy `.opencode` paths are still read for migration compatibility where applicable.

## Troubleshooting (Fast)

```bash
codex auth doctor --fix
codex auth list
codex auth forecast --live
```

If account data looks wrong, run:

```bash
codex auth login
```

## Documentation Map

| You want to... | Read |
| --- | --- |
| Start from docs portal | [docs/README.md](docs/README.md) |
| Beginner setup flow | [docs/getting-started.md](docs/getting-started.md) |
| Configure plugin and env vars | [docs/configuration.md](docs/configuration.md) |
| Fix common problems | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Privacy and local data paths | [docs/privacy.md](docs/privacy.md) |
| Full docs architecture | [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md) |
| Runtime architecture internals | [docs/development/ARCHITECTURE.md](docs/development/ARCHITECTURE.md) |
| Config internals | [docs/development/CONFIG_FIELDS.md](docs/development/CONFIG_FIELDS.md), [docs/development/CONFIG_FLOW.md](docs/development/CONFIG_FLOW.md) |
| Repo ownership map | [docs/development/REPOSITORY_SCOPE.md](docs/development/REPOSITORY_SCOPE.md) |
| Testing strategy | [docs/development/TESTING.md](docs/development/TESTING.md) |
| TUI parity checklist | [docs/development/TUI_PARITY_CHECKLIST.md](docs/development/TUI_PARITY_CHECKLIST.md) |
| OpenCode upstream proposal | [docs/OPENCODE_PR_PROPOSAL.md](docs/OPENCODE_PR_PROPOSAL.md) |
| Benchmark usage | [docs/benchmarks/code-edit-format-benchmark.md](docs/benchmarks/code-edit-format-benchmark.md) |
| Migration and upgrade path | [docs/upgrade.md](docs/upgrade.md) |

## Development

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

## Security and Usage Notice

This tool is for personal development workflows. You are responsible for OpenAI Terms compliance.

- Security policy: [SECURITY.md](SECURITY.md)
- Not affiliated with OpenAI.

## License

MIT. See [LICENSE](LICENSE).

