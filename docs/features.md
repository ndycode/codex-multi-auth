# codex-multi-auth Features

What `codex-multi-auth` gives you, grouped by job. Everything listed is a `codex-multi-auth` subcommand; the flag-level reference lives in [reference/commands.md](reference/commands.md).

---

## Manage Accounts

| Feature | Command |
| --- | --- |
| Add accounts by browser OAuth (PKCE), device code, or manual callback | `codex-multi-auth login [--device-auth \| --manual]` |
| Re-authenticate one account in place | `codex-multi-auth login --account <index\|email\|id>` |
| Bind a login to a specific org/workspace | `codex-multi-auth login --org <id>` |
| List the pool, quota windows, and runtime markers | `codex-multi-auth list`, `status`, `limits --json` |
| Luna Reserve | First-class `gpt-reserve`, automatic Luna quota fallback, independent cooldowns, and live Reserve percentage via `limits --json --refresh` |
| Pin the active account | `codex-multi-auth switch <index>` (`unpin` clears it) |
| Pick a workspace under an account | `codex-multi-auth workspace <account> [workspace]` |
| Health and quota checks | `codex-multi-auth check` |
| Recover flagged (sidelined) accounts | `codex-multi-auth verify-flagged` |
| Restore a named backup into an empty pool | `codex-multi-auth login` → restore menu |

Email dedup is case-insensitive, so the same account can't land in the pool twice under different casing.

---

## Pick The Right Account

| Feature | Command |
| --- | --- |
| Forecast the best next account | `codex-multi-auth forecast [--live]` |
| Forecast and pin in one step | `codex-multi-auth best` |
| Explain the current or last selection | `codex-multi-auth why-selected` |
| Full diagnostic report | `codex-multi-auth report --live --json` |

`--live` reads real quota headers. Probes lead with `gpt-5.6-sol` and fall through a model chain for accounts without entitlement; general routing defaults to `gpt-6.1-sol`.

Luna Reserve is a backend-controlled, separately metered allowance, not the normal Codex quota and not the router's internal 5% quota-reserve threshold. When `gpt-6-luna` or `gpt-5.6-luna` receives a genuine quota 429, routing retries the request as `gpt-reserve`; a manual account pin remains a hard account constraint. Reserve 429s are stored only on the Reserve model key, and ordinary quota headers do not preemptively exhaust Reserve. `limits --json --refresh` asks the native Codex app-server for `account/rateLimits/read` with Luna Reserve support and reports its own used/remaining percentage when the backend exposes the bucket. An absent bucket means "not currently offered/unknown", not 0% remaining. Luna Reserve is not unlimited.

---

## Rotate Live Requests

On by default for request-bearing Codex sessions launched through `codex-multi-auth-codex`, `mcodex`, or an installed app bind. A loopback-only proxy (`codex-multi-auth-runtime-proxy`) sits between the official CLI and the ChatGPT backend and picks a managed account per request.

| Feature | Notes |
| --- | --- |
| Per-request rotation | Moves to another account on rate limits, token expiry, network, or server failures — before response bytes stream |
| Selection scoring | Weighs account health, quota headroom, time since last use, and model capability |
| Session affinity | The same conversation stays on one account where it can |
| Per-run force-pin | `codex-multi-auth-codex --account <index\|email\|id>` — ephemeral, fail-hard |
| Token refresh | One in-flight refresh per token; short-lived cross-process leases prevent duplicate refreshes |
| Status and control | `codex-multi-auth rotation status\|enable\|disable\|bind-app\|unbind-app\|reset-runtime` |
| Reversible desktop app bind | Routes packaged-app traffic without patching app files |
| Launcher routing | `codex-multi-auth-app-launcher` retargets user-level shortcuts or builds a macOS wrapper app |

The proxy also forwards model discovery and image generation/edits. See [reference/image-routes.md](reference/image-routes.md) and [reference/imagegen-provider-compatibility.md](reference/imagegen-provider-compatibility.md) for image-specific behavior.

---

## Local Governance

All of this is file-backed under `~/.codex/multi-auth`. Nothing is a hosted or multi-user service.

| Feature | Command |
| --- | --- |
| Usage ledger — redacted rows, no prompts or tokens | `codex-multi-auth usage [--since] [--by model\|account\|project\|outcome\|day]` |
| Budget limits per window | `codex-multi-auth budget limit <key> --window hour\|day\|week\|month` |
| Pause/drain/tag/weight/note accounts — enforced at runtime | `codex-multi-auth account …` |
| Reset-credit management | `codex-multi-auth resets list\|redeem\|auto` |
| Model capability matrix | `codex-multi-auth models` |
| Operator snapshot across runtime, usage, policy, and quota | `codex-multi-auth monitor` |

Paused and drained accounts are skipped during proxy selection — these are enforced policy, not dashboard labels.

---

## Repair And Recovery

| Feature | Command |
| --- | --- |
| Diagnose, optionally repair | `codex-multi-auth doctor [--fix]` |
| Storage repair workflow (`--live` also fixes stale workspace ids) | `codex-multi-auth fix [--dry-run] [--live]` |
| Path and storage self-checks | `codex-multi-auth verify --paths\|--flagged\|--all` |
| Sanitized diagnostics bundle | `codex-multi-auth debug bundle --json` |
| Atomic writes | Every pool save goes through temp+rename with a WAL and rotating `.bak` snapshots |
| Named backups | Restore from `~/.codex/multi-auth/backups/` during empty-pool login |

---

## Storage

| Feature | Notes |
| --- | --- |
| Storage V3 | Canonical pool format; older layouts migrate on first load |
| Local root | `~/.codex/multi-auth`, overridable with `CODEX_MULTI_AUTH_DIR` |
| Per-project pools | `perProjectAccounts` defaults on but applies only when Codex CLI sync is off (`CODEX_MULTI_AUTH_SYNC_CODEX_CLI=0`) — under the default sync, wrapper sessions and manager commands both use the global pool. When active, each repo gets its own pool under `projects/<project-key>/` |
| Worktree identity | Linked worktrees share their repository's pool |
| Codex CLI sync | The active account mirrors into `~/.codex/auth.json` so plain `codex` uses it too |

---

## Day-To-Day Terminal

| Feature | Command |
| --- | --- |
| Interactive dashboard — account list, search, settings hub | `codex-multi-auth login` on a populated pool |
| Provider-agnostic local session history | `codex-multi-auth history [show <id>]` |
| Convenience launcher | `mcodex [--monitor \| --tmux]` |
| Show where every config value comes from | `codex-multi-auth config explain [--json]` |

The settings hub (inside the dashboard) tunes display and runtime behavior without editing files. `Q` always cancels without saving; theme changes preview before they apply and restore on cancel.

---

## Context Budget Guard (Experimental)

Ships disabled — enable it in the settings hub or via `contextBudgetGuardEnabled`.

A Responses session resends its history every turn, so each turn's token count reads how full the context window already is. The guard tracks that per session and, past a hard threshold (default 69%), pauses the next request locally with a notice suggesting `/compact` — instead of letting the turn die upstream on `context_length_exceeded`. A soft threshold (default 65%) only adds a response header. The pause is one-shot per measurement, so it can never dead-end a session.

See [reference/settings.md](reference/settings.md) and the design doc [development/CONTEXT_BUDGET_GUARD_PLAN.md](development/CONTEXT_BUDGET_GUARD_PLAN.md).

---

## Local Bridge

An optional loopback-only HTTP surface (`/health`, `/v1/models`, `/v1/responses`) for local tools that need an OpenAI-compatible endpoint. Bearer tokens are `cma_local_*`; only SHA-256 hashes and prefixes are stored, and the plaintext shows once at creation.

```bash
codex-multi-auth bridge token create --label my-tool
codex-multi-auth integrations          # ready-made client snippets
```

---

## Plugin-Host Runtime

An optional library surface — documented in [reference/public-api.md](reference/public-api.md) — reuses the same account pool for host-side request transforms, token refresh, stream failover, and the same runtime policy evaluation the proxy uses. Most users never touch it.

`codex-multi-auth features` prints a numbered built-in checklist used by smoke tests; it is a subset of this page, not the full product map.

---

## Related

- [getting-started.md](getting-started.md)
- [faq.md](faq.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/commands.md](reference/commands.md)
