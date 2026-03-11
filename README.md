# codex-multi-auth

[![npm version](https://img.shields.io/npm/v/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)
[![npm downloads](https://img.shields.io/npm/dw/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/ndycode/codex-multi-auth/ci.yml?branch=main&label=ci)](https://github.com/ndycode/codex-multi-auth/actions/workflows/ci.yml?query=branch%3Amain)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Multi-account OAuth for the official `@openai/codex` CLI.

`codex-multi-auth` adds a local account manager, `codex auth ...` workflow, and recovery tooling on top of the official Codex CLI. It keeps the normal `codex` command path intact, makes account switching explicit, and can optionally power a plugin runtime with account rotation and failover.

- Uses the official `@openai/codex` CLI instead of replacing it
- Adds `codex auth login`, `list`, `switch`, `check`, `forecast`, `report`, `fix`, and `doctor`
- Stores accounts locally, including project-scoped account pools for repo-specific workflows
- Provides an interactive terminal dashboard for login, switching, and settings
- Includes recovery and health tooling for stale tokens, bad sync state, and routing problems

## Quick Example

```bash
npm i -g @openai/codex
npm i -g codex-multi-auth

codex auth login
codex auth list
codex auth check
codex auth switch 2
```

## Quick Start

Start using it in under 60 seconds:

```bash
npm i -g @openai/codex
npm i -g codex-multi-auth
codex auth login
codex auth list
codex auth check
```

If you want a live readiness check before a session:

```bash
codex auth forecast --live
```

## What This Project Does

This project wraps the official `codex` binary and intercepts the account-management path. `codex auth ...` commands are handled locally by `codex-multi-auth`, while all other `codex` commands continue to forward to `@openai/codex`.

That gives you a stable workflow for:

- signing into more than one ChatGPT-authenticated Codex account
- switching the active account by index instead of by hidden state
- checking account health before a session
- repairing common local auth and storage problems
- keeping separate project-level account pools when needed

## Why This Exists

The official Codex CLI is the right base tool, but a single opaque auth state is limiting when you use multiple ChatGPT accounts, switch between repositories, or need deterministic recovery after stale tokens or local sync issues. `codex-multi-auth` exists to make that state visible and operable without turning the workflow into custom shell glue.

## Features

- Multi-account OAuth login through the official browser-based flow
- Canonical `codex auth ...` command family for day-to-day account operations
- Interactive dashboard with quick switch, search, and settings
- Project-scoped storage under `~/.codex/multi-auth/projects/<project-key>/...`
- Health checks, flagged-account verification, live forecast, JSON reports, and safe repair commands
- Optional plugin runtime for request transformation, token refresh, retry, failover, session affinity, and quota-aware account selection

## Example Usage

Check your current state:

```bash
codex auth status
codex auth list
codex auth check
```

Pick the next account for a session:

```bash
codex auth forecast --live
codex auth switch 2
```

Diagnose and repair local issues:

```bash
codex auth fix --dry-run
codex auth fix --live --model gpt-5-codex
codex auth doctor --fix
```

## Architecture / How It Works

1. `scripts/codex.js` becomes the `codex` wrapper entrypoint.
2. `codex auth ...` commands are handled locally by the multi-account manager and dashboard.
3. Non-auth `codex` commands are forwarded to the real `@openai/codex` binary.
4. Account data is stored under `~/.codex/multi-auth`, with optional project-scoped storage.
5. If you enable plugin mode, the same account pool can drive request transformation, refresh, retry, and failover logic for Codex or ChatGPT-backed requests.

For a short public overview, see [docs/architecture.md](docs/architecture.md). For maintainer-level internals, see [docs/development/ARCHITECTURE.md](docs/development/ARCHITECTURE.md).

## Common Workflows

- First login: `codex auth login`
- Review the saved account pool: `codex auth list`
- Verify account health before coding: `codex auth check`
- Choose the best account for the next run: `codex auth forecast --live`
- Switch the active account explicitly: `codex auth switch <index>`
- Gather machine-readable diagnostics: `codex auth report --live --json`
- Repair local state safely: `codex auth fix --dry-run` or `codex auth doctor --fix`

## Installation

Prerequisites:

- Node.js `18+`
- The official `@openai/codex` CLI
- A ChatGPT plan with the models you intend to use

Standard install:

```bash
npm i -g @openai/codex
npm i -g codex-multi-auth
```

If you are migrating from the old scoped prerelease package:

```bash
npm uninstall -g @ndycode/codex-multi-auth
npm i -g codex-multi-auth
```

Verify the wrapper is active:

```bash
codex --version
codex auth status
```

## Configuration

The canonical data root is `~/.codex/multi-auth`.

Common files:

- `settings.json` for dashboard and runtime settings
- `openai-codex-accounts.json` for the main account pool
- `projects/<project-key>/openai-codex-accounts.json` for project-scoped storage

Useful environment overrides:

- `CODEX_MULTI_AUTH_DIR`
- `CODEX_MULTI_AUTH_CONFIG_PATH`
- `CODEX_MODE=0/1`
- `CODEX_AUTH_FETCH_TIMEOUT_MS=<ms>`
- `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=<ms>`

See [docs/configuration.md](docs/configuration.md) and [docs/reference/settings.md](docs/reference/settings.md) for the full configuration model.

## Troubleshooting

Fast recovery path:

```bash
codex auth doctor --fix
codex auth check
codex auth forecast --live
```

Common first-run issues:

- `codex auth` is not recognized: verify routing with `where codex` or `which codex`
- OAuth callback on port `1455` fails: free the port and retry `codex auth login`
- The wrong account stays active after a switch: rerun `codex auth switch <index>` and restart the session
- A worktree asks you to log in again: run `codex auth list` once in that worktree to trigger repo-shared storage migration

Full recovery guidance lives in [docs/troubleshooting.md](docs/troubleshooting.md).

## FAQ

### Does this replace `@openai/codex`?

No. It wraps the official CLI and forwards non-auth commands to it.

### Do I need an OpenAI Platform API key?

Not for the ChatGPT-authenticated multi-account workflow in this project. For production applications and API-based integrations, use the OpenAI Platform API instead.

### Is the plugin runtime required?

No. Many users only need the `codex` wrapper plus `codex auth ...` commands.

### Is this intended for teams or commercial multi-user services?

No. This repository is positioned for personal development workflows with your own accounts.

More questions: [docs/faq.md](docs/faq.md)

## Documentation

- Docs portal: [docs/README.md](docs/README.md)
- Getting started: [docs/getting-started.md](docs/getting-started.md)
- FAQ: [docs/faq.md](docs/faq.md)
- Public architecture: [docs/architecture.md](docs/architecture.md)
- Features: [docs/features.md](docs/features.md)
- Configuration: [docs/configuration.md](docs/configuration.md)
- Troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md)
- Commands reference: [docs/reference/commands.md](docs/reference/commands.md)
- Settings reference: [docs/reference/settings.md](docs/reference/settings.md)
- Storage paths: [docs/reference/storage-paths.md](docs/reference/storage-paths.md)
- Public API contract: [docs/reference/public-api.md](docs/reference/public-api.md)
- Error contracts: [docs/reference/error-contracts.md](docs/reference/error-contracts.md)
- Privacy: [docs/privacy.md](docs/privacy.md)
- Upgrade guide: [docs/upgrade.md](docs/upgrade.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## Terms and Usage Notice

> [!CAUTION]
> This project uses OAuth account credentials and is intended for personal development workflows.
>
> - This is an independent open-source project, not an official OpenAI product
> - You are responsible for your own usage and policy compliance
> - For production or commercial workloads, use the OpenAI Platform API

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, validation expectations, and pull request guidelines. Community expectations are in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT License. See [LICENSE](LICENSE).
