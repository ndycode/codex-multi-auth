# codex-multi-auth Overview

`codex-multi-auth` is a multi-account OAuth manager for the official Codex CLI. It stores a pool of ChatGPT sign-ins on your machine and gives you commands to switch, inspect, forecast, and repair them — plus a default-on, loopback-only proxy that rotates accounts across live Codex requests when you run Codex through its wrapper.

## Who needs it

- You hit Codex rate limits or quota windows and want a second (or fifth) account ready to serve.
- You belong to multiple organizations or workspaces and switch between them.
- You want per-project account pools scoped to one repository.
- You run unattended agents and need JSON diagnostics, budgets, and safe repair commands instead of an opaque auth file.

If a single Codex account covers your work and you never think about quota, the official `codex` CLI alone is enough — this package wraps management around it, it does not replace it.

## What it does at runtime

Two paths, always kept distinct:

1. **Management commands run locally.** `codex-multi-auth <command>` (equivalently `codex-multi-auth auth <command>`) reads and writes the local account pool — 31 subcommands covering login, switching, health probes, quota forecasts, budgets, usage, repair, and JSON reporting. They never proxy Codex traffic. A few do make their own outbound calls: `login` talks to `auth.openai.com`, and `check` plus `--live`/`--refresh` flags (`forecast`, `best`, `report`, `fix`, `limits`, `resets`) send authenticated quota probes to the ChatGPT backend and refresh OAuth tokens when needed — the full endpoint list is in [privacy.md](privacy.md#what-leaves-the-machine).
2. **Codex commands forward through the wrapper — only when you ask.** `codex-multi-auth-codex <args>` and `mcodex <args>` pass non-management commands to the real Codex binary. `codex-ma` is a short alias for the account manager, including its local web dashboard. For request-bearing commands (`exec`, `review`, `resume`, `fork`, `app`, and the bare TUI) the wrapper starts a loopback rotation proxy and points a temporary provider config at it; `help`, `login`, `mcp`, and other non-request commands pass through untouched.

The rotation proxy is on by default. It binds loopback only, authenticates its own clients with a per-process token, forwards only Responses API, model-discovery, image, transcription, web search, voice, and thread-goal calls, picks the healthiest account per request, refreshes tokens, and fails over on rate limits within a bounded retry budget. Inspect it with `codex-multi-auth rotation status`; turn it off with `codex-multi-auth rotation disable` or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0`.

OAuth sign-in uses a loopback callback on `localhost:1455` (the listener binds both `127.0.0.1` and `::1`), or `codex-multi-auth login --device-auth` for headless shells with no callback port at all.

## What it owns — and what it never touches

| `codex-multi-auth` owns | The official install keeps |
| --- | --- |
| `~/.codex/multi-auth/` — pool, settings, quota cache, usage ledger, policies, observability (files `0600`, directories `0700`) | `~/.codex/` — `auth.json`, `accounts.json`, `config.toml`, session history |
| Five binaries: `codex-multi-auth`, `codex-ma`, `codex-multi-auth-codex`, `mcodex`, `codex-multi-auth-app-launcher` | The `codex` command — no `codex` bin is ever published or shadowed |
| A temporary provider config inside a shadow `CODEX_HOME` for rotated sessions | The real Codex binary and your real home state (wrapper changes sync back on exit) |
| An opt-in, reversible desktop-app bind and user-level launcher shortcuts | App binaries — never patched |

## First five minutes

```bash
npm i -g codex-multi-auth
codex-multi-auth login            # add an account (repeat for more)
codex-multi-auth status           # inspect the pool
codex-ma web --no-open            # open the local real-time pool dashboard without launching a browser
codex-multi-auth forecast --live  # preview the next-serving account
mcodex                            # run Codex with rotation on
```

## Where to go next

| I want to... | Read |
| --- | --- |
| Install and sign in | [getting-started.md](getting-started.md) |
| Tour every feature | [features.md](features.md) |
| Understand the components and request flow | [architecture.md](architecture.md) |
| Look up a command or flag | [reference/commands.md](reference/commands.md) |
| Change settings or environment overrides | [configuration.md](configuration.md) |
| Recover from a problem | [troubleshooting.md](troubleshooting.md) |
| Browse the full doc set | [README.md](README.md) — the complete portal |
