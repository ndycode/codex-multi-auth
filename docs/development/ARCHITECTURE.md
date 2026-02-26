# Architecture

Technical architecture for `codex-multi-auth`.

## Design Goals

- Codex CLI-first user experience (`codex auth ...`).
- Multi-account OAuth with safe rotation and recovery.
- OpenCode compatibility without changing OpenCode core.
- Stateless Codex backend request handling (`store: false`).

## System Diagram

```text
Terminal user
  |
  | codex auth ...
  v
scripts/codex.js (CLI shim)
  |- handles supported auth subcommands locally
  |- forwards all other codex commands to @openai/codex
  v
lib/codex-manager.ts
  |- OAuth flow + account menu + fix/doctor/report
  |- writes ~/.opencode/openai-codex-accounts.json
  |- syncs active account to ~/.codex/accounts.json

OpenCode runtime (optional)
  |
  v
index.ts (plugin entry)
  |- loader(auth + provider config)
  |- request transform + retry + rotation
  |- live account sync + session affinity + refresh guardian
  v
OpenAI Codex/ChatGPT backend
```

## Core Subsystems

| Subsystem | Files | Responsibility |
| --- | --- | --- |
| CLI wrapper | `scripts/codex.js`, `scripts/codex-multi-auth.js` | Route auth commands to plugin CLI, forward others to official Codex CLI |
| Auth and OAuth | `lib/auth/auth.ts`, `lib/auth/server.ts` | PKCE flow, callback server on `localhost:1455`, token exchange/refresh |
| Account storage | `lib/storage.ts`, `lib/storage/paths.ts` | Atomic write, backup/WAL recovery, dedupe, project-scoped paths |
| Account selection | `lib/accounts.ts`, `lib/rotation.ts`, `lib/forecast.ts` | Health-aware selection, cooldowns, forecast scoring |
| Request transform | `lib/request/request-transformer.ts` | Model normalization, OpenCode prompt bridge, ID filtering, fast-session tuning |
| Fetch and retry | `lib/request/fetch-helpers.ts`, `lib/request/rate-limit-backoff.ts` | Header shaping, error mapping, account retry policies |
| Runtime resilience | `lib/live-account-sync.ts`, `lib/session-affinity.ts`, `lib/refresh-guardian.ts` | No-restart storage reloads, sticky sessions, proactive token refresh |
| TUI/auth menu | `lib/ui/*`, `lib/cli.ts` | Beginner-focused interactive auth dashboard and shortcuts |

## Request Pipeline (OpenCode)

`index.ts` delegates request shaping to `transformRequestBody()`.

1. Read provider config and plugin config.
2. Normalize model aliases to canonical API model.
3. Merge global + model + variant options.
4. Force Codex backend invariants:
   - `store: false`
   - `stream: true`
5. Remove unsupported `item_reference` input items.
6. Strip all input IDs (stateless mode).
7. Apply Codex bridge prompts when `codexMode=true`.
8. Normalize orphan tool outputs to avoid API errors.
9. Inject `reasoning.encrypted_content` include by default.
10. Send transformed payload to Codex backend.

## Account Runtime Flow

| Event | Behavior |
| --- | --- |
| Login | Add/update account by token/account/email keys |
| Switch | Set global and per-family active indices |
| Rate limit | Penalize account, may rotate or wait per policy |
| Hard refresh failure | Account may be disabled by fix/doctor logic |
| Storage file change | Live account sync reloads manager without restart |
| Session reuse | Session affinity tries to keep stable account choice |

## Storage Model

| File | Purpose |
| --- | --- |
| `~/.opencode/openai-codex-accounts.json` | Primary account storage (v3) |
| `~/.opencode/openai-codex-accounts.json.bak` | Last backup |
| `~/.opencode/openai-codex-accounts.json.wal` | Recovery journal |
| `~/.opencode/openai-codex-flagged-accounts.json` | Flagged account pool |
| `~/.opencode/projects/<project-key>/...` | Project-scoped storage |

## TUI Runtime Notes

- V2 UI is enabled by default.
- Color profile: `truecolor|ansi256|ansi16`.
- Glyph mode: `ascii|unicode|auto`.
- Auth menu hotkeys include account quick-set (`1-9`) and search (`/`).

## Invariants

- OAuth callback port remains `1455`.
- Stateless request mode stays enabled for ChatGPT backend compatibility.
- `dist/` is generated output and not source of truth.

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [REPOSITORY_SCOPE.md](REPOSITORY_SCOPE.md)

