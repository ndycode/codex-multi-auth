# Features

User-facing capability map for `codex-multi-auth`.

---

## Manage More Than One Account

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Multi-account dashboard login | Add and manage multiple OAuth identities from one terminal flow | `codex auth login` |
| Onboarding backup restore | Restores the latest named backup or lets you choose a named backup manually when a fresh install or empty pool needs to recover saved accounts fast | `codex auth login` |
| Account dedupe and identity normalization | Avoid duplicate saved account rows | login flow |
| Explicit active-account switching | Pick the current account by index instead of relying on hidden state | `codex auth switch <index>` |
| Fast and deep health checks | See whether the current pool is usable before a coding session | `codex auth check` |
| Flagged-account verification and restore | Recover accounts that were sidelined during prior failures | `codex auth verify-flagged` |

---

## Decide Which Account To Use

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Readiness and risk forecast | Suggests the best next account | `codex auth forecast` |
| Live quota probe mode | Uses live headers for stronger decisions | `codex auth forecast --live` |
| JSON report output | Lets you inspect account state in automation or support workflows | `codex auth report --live --json` |
| Runtime rotation proxy (default-on) | Lets forwarded official Codex CLI/app sessions rotate managed accounts between Responses requests without restarting the session. Disable per install when needed. | `codex auth rotation status` |

---

## Rotate Live Codex Runtime Requests

Runtime rotation is the current 2.x architecture addition. It is default-on and local-only.

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Local Responses proxy | Routes forwarded official Codex Responses/model traffic through a loopback provider named `codex-multi-auth-runtime-proxy` | `codex auth rotation status` |
| Per-request account rotation | Moves to another managed account on quota, auth refresh, network, or server failure before streaming response bytes | runtime proxy |
| Shadow `CODEX_HOME` launch | Keeps temporary provider config isolated from normal official Codex state for wrapper-launched CLI sessions | `codex` wrapper |
| Runtime status telemetry | Shows setting state, app helper state, app bind state, account waits, cooldowns, and last-account proxy metadata | `codex auth rotation status` |
| Reversible desktop app bind | Lets packaged Codex app launches use the same local router without patching official app files | `codex auth rotation bind-app` |
| Launcher routing helper | Retargets supported user-level app shortcuts or creates a managed macOS wrapper app | `codex-multi-auth-app-launcher` |

---

## Recover From Local State Problems

| Capability | What it gives you | Primary entry |
| --- | --- | --- |
| Safe repair workflow | Detects and repairs known local storage inconsistencies | `codex auth fix` |
| Diagnostics with optional repair | One command to inspect and optionally fix common failures | `codex auth doctor` |
| Backup and WAL recovery | Safer persistence when local writes are interrupted or partially applied | storage runtime |

---

## Keep Account State Local And Predictable

| Capability | What it gives you |
| --- | --- |
| Canonical local data root | Consistent storage under `~/.codex/multi-auth` |
| Project-scoped account pools | Repo-specific account state when you need separation |
| Linked-worktree identity sharing | The same repository can share account state across worktrees |
| Quota cache persistence | Faster forecast and dashboard visibility between runs |

---

## Improve Day-To-Day Terminal Use

| Capability | What it gives you |
| --- | --- |
| Quick switch and search hotkeys | Faster navigation in the dashboard |
| Account action hotkeys | Per-account set, refresh, toggle, and delete shortcuts |
| In-dashboard settings hub | Runtime and display tuning without editing files directly |
| Experimental settings hotkeys | Keyboard shortcuts for sync preview, backup export, and refresh-guard tuning |
| Browser-first OAuth with device/manual fallback | `codex auth login` stays browser-first, while `--device-auth` is preferred for remote/headless shells and `--manual`, `--no-browser`, and `CODEX_AUTH_NO_BROWSER=1` remain callback-paste fallbacks |

Device auth prints `https://auth.openai.com/codex/device` plus a one-time code and does not rely on a local browser or callback server. Manual/non-TTY login accepts the full callback URL on stdin for environments where device auth is unavailable.

---

## Optional Plugin-Host Runtime

Some users only need the wrapper and `codex auth ...` commands. If you also run the plugin-host path, `codex-multi-auth` can use the same account pool for:

- request transformation for Codex or ChatGPT-backed flows
- token refresh and refresh deduplication
- retry, cooldown, and stream failover handling
- session affinity and live account sync
- capability and quota-aware account selection

---

## Related

- [getting-started.md](getting-started.md)
- [faq.md](faq.md)
- [architecture.md](architecture.md)
- [reference/commands.md](reference/commands.md)
- [troubleshooting.md](troubleshooting.md)
