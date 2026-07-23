# codex-multi-auth Features

User-facing capability map for Codex CLI multi-account OAuth, account switching, health checks, recovery tooling, project-scoped storage, runtime Responses rotation, local governance, and the optional local bridge.

---

## Manage Multiple Codex CLI Accounts

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Multi-account dashboard login | Add and manage multiple OAuth identities from one terminal flow | `codex-multi-auth login` |
| Onboarding backup restore | Restores the latest named backup or lets you choose a named backup when a fresh install or empty pool needs saved accounts | `codex-multi-auth login` |
| Account dedupe and identity normalization | Avoid duplicate saved account rows | login flow |
| Explicit active-account switching | Persist a manual pin by index instead of relying on hidden state | `codex-multi-auth switch <index>` |
| Clear manual pin | Drop the persisted pin so hybrid rotation resumes | `codex-multi-auth unpin` |
| Workspace selection | List or set personal vs business/team workspaces under one account | `codex-multi-auth workspace <account> [workspace]` |
| Fast and deep health checks | See whether the current pool is usable before a coding session, including when each quota window resets | `codex-multi-auth check` |
| Flagged-account verification and restore | Recover accounts sidelined during prior failures | `codex-multi-auth verify-flagged` |

---

## Choose The Best Account Before A Session

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Readiness and risk forecast | Suggests the best next account | `codex-multi-auth forecast` |
| Live quota probe mode | Uses live headers for stronger decisions (probe leads with `gpt-5.6-sol`) | `codex-multi-auth forecast --live` |
| Best-account helper | Shortcut for selection-oriented workflows | `codex-multi-auth best` |
| JSON report output | Inspect account state in automation or support workflows | `codex-multi-auth report --live --json` |
| Why-selected explanation | Explains current routing/selection context | `codex-multi-auth why-selected` |
| Runtime rotation proxy (default-on) | Forwarded official Codex CLI/app sessions can rotate managed accounts between Responses requests without restarting the session | `codex-multi-auth rotation status` |

---

## Rotate Live Codex Runtime Requests

Runtime rotation is part of the current architecture. It is default-on and local-only.

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Local Responses proxy | Routes forwarded official Codex Responses/model traffic through a loopback provider named `codex-multi-auth-runtime-proxy` | `codex-multi-auth rotation status` |
| Per-request account rotation | Moves to another managed account on quota, auth refresh, network, or server failure before streaming response bytes | runtime proxy |
| Runtime policy gate | Applies pause/drain, budgets, routing profiles, and capability checks via `evaluateRuntimePolicy` before selection | runtime proxy |
| Per-invocation account force-pin | Forces one account for a single wrapper session (ephemeral, fail-hard; never touches the persisted `switch` pin) | `codex-multi-auth-codex --account <index\|email\|id>` |
| Shadow `CODEX_HOME` launch | Keeps temporary provider config isolated from normal official Codex state for wrapper-launched CLI sessions | `codex-multi-auth-codex` / `mcodex` |
| Runtime status telemetry | Shows setting state, app helper state, app bind state, account waits, cooldowns, and last-account proxy metadata | `codex-multi-auth rotation status` |
| Reversible desktop app bind | Lets packaged Codex app launches use the same local router without patching official app files | `codex-multi-auth rotation bind-app` |
| Launcher routing helper | Retargets supported user-level app shortcuts or creates a managed macOS wrapper app | `codex-multi-auth-app-launcher` |

---

## Local Governance

All governance data stays under `~/.codex/multi-auth`. Nothing here is a hosted multi-user service.

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Usage ledger | Redacted request/usage rows (no prompts or tokens) with summaries and rotation | `codex-multi-auth usage` |
| Budget guards | Local limits by window (hour/day/week/month) for requests, tokens, or cost | `codex-multi-auth budget` |
| Account policies | Tags, weights, notes, **pause**, and **drain** — pause/drain are **enforced at runtime** on the rotation path | `codex-multi-auth account …` |
| Routing profiles | Project-aware model allow/deny and account preference signals | profile store + runtime evaluation |
| Model capability matrix | Local view of model/account availability from profiles, quota cache, and capability policy | `codex-multi-auth models` |
| Operator monitor | One aggregate view of runtime, usage, policy, profile, model, quota, and project context | `codex-multi-auth monitor` |

---

## Recover From Local Auth And Storage Problems

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Safe repair workflow | Detects and repairs known local storage inconsistencies | `codex-multi-auth fix` |
| Diagnostics with optional repair | One command to inspect and optionally fix common failures | `codex-multi-auth doctor` |
| Backup and WAL recovery | Safer persistence when local writes are interrupted or partially applied | storage runtime |
| Named backup export / restore | Recover account pools during empty-pool onboarding | login restore menu |

---

## Keep Account State Local And Predictable

| Capability | What it gives you |
| --- | --- |
| Storage V3 | Canonical account pool format with migrations from older layouts |
| Canonical local data root | Consistent storage under `~/.codex/multi-auth` |
| Project-scoped account pools | Repo-specific account state when you need separation |
| Linked-worktree identity sharing | The same repository can share account state across worktrees |
| Quota cache persistence | Faster forecast and dashboard visibility between runs |
| Selected-account sync | Active account can be written into official `~/.codex` auth files for plain Codex use |

---

## Improve Day-To-Day Terminal Use

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Interactive TUI dashboard | Account list, actions, search, and settings hub | `codex-multi-auth` (no args / interactive) |
| Quick switch and search hotkeys | Faster navigation in the dashboard | dashboard |
| Account action hotkeys | Per-account set, refresh, toggle, and delete shortcuts | dashboard |
| In-dashboard settings hub | Runtime and display tuning without editing files directly | dashboard settings |
| Experimental settings hotkeys | Keyboard shortcuts for sync preview, backup export, and refresh-guard tuning | dashboard experimental |
| Browser-first OAuth with device/manual fallback | Browser-first login; `--device-auth` for remote/headless; `--manual`, `--no-browser`, and `CODEX_AUTH_NO_BROWSER=1` as callback-paste fallbacks | `codex-multi-auth login` |
| Provider-agnostic history | Lists local Codex rollout sessions regardless of active model provider (avoids `/resume` provider-filter gaps when rotation is on) | `codex-multi-auth history` |
| `mcodex` convenience launcher | Default-forwards to the wrapper; `--monitor` live-lists accounts; `--tmux` / `-t` opens a tmux session (optional `--live-accounts`) | `mcodex` |

Device auth prints `https://auth.openai.com/codex/device` plus a one-time code and does not rely on a local browser or callback server. Manual/non-TTY login accepts the full callback URL on stdin for environments where device auth is unavailable.

---

## Local Bridge And Integrations

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Loopback bridge | Optional local HTTP surface for `/health`, `/v1/models`, and `/v1/responses` | `startLocalBridge` API + `bridge token` / `integrations` (see [commands.md](reference/commands.md#starting-the-local-bridge-hostapi)) |
| Hashed client tokens | Plain tokens are `cma_local_*`; only hashes/prefixes are stored | `codex-multi-auth bridge token create` |
| Token lifecycle | List, rotate, revoke without re-exposing old secrets | `codex-multi-auth bridge token …` |
| Integration snippets | Deterministic local client snippets (env, curl, Python, and other local tools) | `codex-multi-auth integrations` |

---

## `codex-multi-auth features` checklist

`codex-multi-auth features` prints a numbered **built-in checklist** of core
capabilities used by automation and smoke tests. It is **not** the full product
map: prefer this page and [reference/commands.md](reference/commands.md) for the
complete surface (rotation, governance, bridge, history, mcodex, app bind, and
newer diagnostics). The checklist was extended through feature id 54 to cover
device auth, runtime rotation, governance, bridge, history, and mcodex.

---

## Optional Plugin-Host Runtime

Some users only need the manager, wrapper, and `codex-multi-auth ...` commands. If you also run the plugin-host path, `codex-multi-auth` can use the same account pool for:

- request transformation for Codex or ChatGPT-backed flows
- token refresh and refresh deduplication
- retry, cooldown, and stream failover handling
- session affinity and live account sync
- capability and quota-aware account selection
- the same runtime policy evaluation used by the rotation proxy

---

## Related

- [getting-started.md](getting-started.md)
- [faq.md](faq.md)
- [architecture.md](architecture.md)
- [reference/commands.md](reference/commands.md)
- [troubleshooting.md](troubleshooting.md)
