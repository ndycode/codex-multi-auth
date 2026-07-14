# codex-multi-auth Troubleshooting

Recovery guide for Codex CLI multi-account install issues, OAuth login failures, account switching problems, runtime rotation routing, project/worktree storage, and stale local auth state.

---

## Start Here: 60-Second Recovery

```bash
codex-multi-auth doctor --fix
codex-multi-auth check
codex-multi-auth forecast --live
```

If the account pool is still not usable:

```bash
codex-multi-auth login
```

---

## Verify Install And Routing

Check the official CLI and the multi-auth package bins. On Windows use `where`; on macOS/Linux use `which`.

```bash
where codex
where codex-multi-auth
where codex-multi-auth-codex
codex --version
codex-multi-auth --version
codex-multi-auth-codex --version
codex-multi-auth status
npm ls -g codex-multi-auth
```

If an old scoped package is still active:

```bash
npm uninstall -g @ndycode/codex-multi-auth
npm i -g codex-multi-auth
```

The package does not publish a global `codex` binary. `codex-multi-auth ...` is the canonical account-manager family, and `codex-multi-auth-codex ...` is the optional forwarding wrapper.

---

## Browser, Device Auth, And OAuth Problems

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Browser opens unexpectedly | Normal browser-first OAuth flow | Complete the auth step and return to the terminal |
| OAuth callback port `1455` is in use | Another local process owns the port | Stop the conflicting process and rerun `codex-multi-auth login` |
| Browser or callback handoff is unavailable | Remote, SSH, container, or headless shell | Run `codex-multi-auth login --device-auth`; use `codex-multi-auth login --manual` only if device auth is unavailable |
| `missing field id_token` | Stale or malformed auth payload | Re-login the affected account |
| `refresh_token_reused` | The token pair rotated in another context | Re-login the affected account |
| `token_expired` | The refresh token is no longer valid | Re-login the affected account |
| Login hangs in WSL, or breaks after installing on both Windows and WSL | Windows and WSL contend for callback port `1455` | See [Windows And WSL Side By Side](#windows-and-wsl-side-by-side) |

### Windows And WSL Side By Side

Installing `codex-multi-auth` on a Windows host **and** inside WSL is supported, but
only one of them can run a browser login at a time.

The OAuth redirect URI is registered with the provider as
`http://localhost:1455/auth/callback`, so the callback port is fixed and cannot be
changed. A browser launched from WSL still runs on the Windows host, and Windows
resolves `localhost:1455` against its own loopback first. If anything on the Windows
side is holding that port — an in-progress login, a leftover callback server, a
running proxy — it will receive the redirect that the WSL listener is waiting for.

The failure is silent from inside the distro: the WSL listener binds cleanly and
simply never sees the callback, so login appears to hang. It is waiting — the
callback poll runs for five minutes before giving up, and `codex-multi-auth` then
explains the likely conflict and drops you into the manual-paste fallback. If you
would rather not wait it out, press Ctrl+C and use `--device-auth` below.

To find the listener, check **both** sides:

```powershell
# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 1455
```

```bash
# WSL
ss -lptn 'sport = :1455'
```

Close the login or proxy on the other side, then retry. If you need both environments
signed in without coordinating the port, use the device-code flow, which never binds
a callback port:

```bash
codex-multi-auth login --device-auth
```

Accounts are stored per environment: the Windows and WSL installs keep separate state
directories and do not share saved accounts. Sign in to each one independently.

---

## Account Switching And State Problems

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Switch succeeds but the wrong account stays active | Stale Codex CLI sync state | Re-run `codex-multi-auth switch <index>` and restart the session |
| All accounts look unhealthy | The entire pool is stale or damaged | Run `codex-multi-auth doctor --fix`, then add at least one fresh account |
| The dashboard shows old account state | Local files were updated outside the current session | Run `codex-multi-auth list`, then `codex-multi-auth check` |

---

## Runtime Rotation Problems

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `codex-multi-auth rotation status` says disabled | Stored setting or env override is off | Run `codex-multi-auth rotation enable`, remove `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0`, or set `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=1` for one process |
| Forwarded Codex session does not show the local provider | Command is help/non-requesting, rotation is disabled, or the official CLI was not launched through the wrapper | Check `where codex-multi-auth-codex`, then run `codex-multi-auth rotation status` |
| Pool exhausted error from the proxy | Every managed account is unavailable for that model/family | Run `codex-multi-auth rotation status`, then `codex-multi-auth forecast --live` |
| Accounts progressively lose OAuth tokens while the proxy is active | Rapid account rotation triggers OpenAI's anti-abuse detection, which invalidates tokens in sequence | The proxy detects explicit token-invalidation responses and stops rotating; re-login any invalidated accounts and ensure `minRotationIntervalMs` is at least `60000` (default) |
| Microsoft/Outlook SSO account gets invalidated on every first request through the proxy | Microsoft OAuth tokens may be invalidated when the proxy presents them from a different IP or device context than where they were issued | The proxy now detects invalidation at both the upstream request and the token-refresh stage; if the problem persists, set `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS=600000` (10 min) and re-login, or keep the Microsoft account disabled from the rotation pool via `codex-multi-auth rotation status` |
| Packaged app still uses normal Codex routing | App bind was not installed or was removed | Run `codex-multi-auth rotation bind-app`, then reopen the app |
| Codex history disappears after app bind, or `/resume` shows only some sessions | Current Codex Desktop and CLI builds filter local threads by the active `model_provider`; app bind / runtime rotation switch the real config to `codex-multi-auth-runtime-proxy`, so threads recorded under the native `openai` provider (or vice versa) are hidden. The split is by provider name, not by account — sessions are not actually scattered per account | The rollout files are all still under `~/.codex/sessions`. Run `codex-multi-auth history` to list every local session across all providers (and `codex-multi-auth history show <id>` for details), then `codex resume <id>` to reopen one. To restore the native `/resume` view, run `codex-multi-auth rotation unbind-app` or `codex-multi-auth rotation disable` |
| Model speed controls are not visible with rotation | Speed/reasoning controls remain owned by Codex config or CLI flags; the app bind only routes Responses traffic | Set `model_reasoning_effort` in `~/.codex/config.toml` or pass `-c model_reasoning_effort=<level>` for wrapper-launched CLI sessions |
| App bind needs to be removed | You want the official app config restored | Run `codex-multi-auth rotation unbind-app` or `codex-multi-auth rotation disable` |
| Newest models (e.g. GPT-5.6) are missing from the Codex CLI/VS Code model picker after an upgrade, even though `codex-multi-auth check` and CLI requests resolve them | The picker lists the models in your installed Codex config (`Codex.json` / `config.toml`), and an existing config is preserved across upgrades rather than wholly replaced. Older configs written before a model shipped do not contain it, so the picker omits it while code-level model resolution still works | Re-run the config install step you originally used to write the template (it now merges newly shipped template models on top of your existing config while preserving your customizations), then restart the Codex app/extension. If you use app bind, run `codex-multi-auth rotation bind-app` afterwards to refresh the router. See [config templates](../config/README.md) |
| Cascading `429` / rate-limit errors under many parallel agents | Too many concurrent requests for the number of accounts, all leaning on the same account | See [High parallelism / swarms of agents](#high-parallelism--swarms-of-agents) below: add more accounts, keep `pidOffsetEnabled` on (the default), and optionally enable `retryAllAccountsRateLimited` with a bounded `retryAllAccountsMaxRetries` |
| `Provider response headers timed out after 10000ms` (subagents pause until you press OK) | This message comes from **your host client's own provider header timeout (~10s)** — the tool that forwards requests through this plugin — not from this plugin. This plugin's request timeout is `fetchTimeoutMs` (default `60000`) and emits a different message. Under heavy concurrency the upstream is slow enough to trip the host client's 10s header guard | Raise the header/response timeout in your host client's provider configuration (users report `60000` resolves it), and reduce upstream slowness by spreading load — see [High parallelism / swarms of agents](#high-parallelism--swarms-of-agents) |

The runtime proxy is loopback-only and default-on. It routes Responses traffic only for forwarded request-bearing official Codex sessions and supported app launches.

### High parallelism / swarms of agents

Running many parallel agents (for example a swarm of 10-20 deep agents) against a small number of accounts concentrates rate-limit pressure. Each agent is typically a separate `codex-multi-auth-codex` process with its own in-process rotation state, so the levers that help are the ones that coordinate *across processes* and reduce per-account contention:

- **Add more accounts.** This is the only structural fix. With 2 accounts and ~20 agents, ~10 agents share each account, so `429`s are inevitable no matter how you tune. Contention falls roughly linearly as you add accounts.
- **`pidOffsetEnabled`** (on by default) — gives each process a small deterministic account-selection bias so different processes lean toward different accounts instead of all hammering the same one. This is the primary knob for the multi-process swarm case; leave it enabled. Set it `false` only if you deliberately want every process to score accounts identically.
- **`retryAllAccountsRateLimited: true`** with a bounded **`retryAllAccountsMaxRetries`** and **`retryAllAccountsMaxWaitMs`** — when every account is momentarily rate-limited, the proxy waits for the soonest quota window and retries instead of returning pool-exhaustion immediately (which otherwise cascades into agent failures). Keep the wait bounded: a long blocking wait can itself trip the host client's 10s header timeout.
- **`routingMutex: "enabled"`** — serializes account selection *within a single process*. Useful when one process issues many concurrent requests, but it does **not** coordinate across separate agent processes.
- **`fetchTimeoutMs` / `streamStallTimeoutMs`** are this plugin's own request and stream-stall timeouts (defaults `60000` / `45000`). They are unrelated to the host client's 10s header timeout above; raise them only if you see this plugin's own `Request timeout` errors.

The `Provider response headers timed out after 10000ms` message specifically is emitted by the host client, not this plugin, and cannot be changed from this plugin's config — only made less frequent by spreading load with the levers above and by raising the host client's own provider header timeout.

---

## Worktrees And Project Storage

| Symptom | Likely cause | Action |
| --- | --- | --- |
| A worktree asks for login again | The worktree still points at a legacy path key | Run `codex-multi-auth list` once in the worktree to trigger migration into repo-shared storage |
| A repo should not share accounts with another repo | Project-scoped storage is not enabled or not in use | Review the project storage rules in [reference/storage-paths.md](reference/storage-paths.md) |

---

## Diagnostics Pack

```bash
codex-multi-auth list
codex-multi-auth status
codex-multi-auth check
codex-multi-auth verify-flagged --json
codex-multi-auth forecast --live
codex-multi-auth fix --dry-run
codex-multi-auth report --live --json
codex-multi-auth doctor --json
```

---

## Soft Reset

PowerShell:

```powershell
Remove-Item "$HOME\.codex\multi-auth\openai-codex-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-flagged-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\settings.json" -Force -ErrorAction SilentlyContinue
codex-multi-auth login
```

Bash:

```bash
rm -f ~/.codex/multi-auth/openai-codex-accounts.json
rm -f ~/.codex/multi-auth/openai-codex-flagged-accounts.json
rm -f ~/.codex/multi-auth/settings.json
codex-multi-auth login
```

---

## Complete Uninstall

`npm@7+` no longer fires `preuninstall` lifecycle scripts, so `npm uninstall -g codex-multi-auth` on its own leaves residual artifacts (a stale plugin entry in `Codex.json`, the cached `node_modules/codex-multi-auth` directory, an OS launcher, and the runtime app-bind state).

To uninstall completely, run the manager's own cleanup **before** you remove the npm package:

```bash
codex-multi-auth uninstall
npm uninstall -g codex-multi-auth
```

Useful flags on the cleanup step:

- `--dry-run` previews what would be removed without touching the filesystem.
- `--json` prints a machine-readable summary.
- `--clear-accounts` also wipes stored credentials (irreversible — use only when you are leaving the package permanently).

The cleanup unbinds Codex app runtime rotation, removes OS launchers, strips `codex-multi-auth` from `Codex.json`, and clears the plugin's `node_modules` cache. It conservatively preserves the shared `bun.lock` when other Codex plugins remain installed, and only deletes it when this is the sole plugin or `Codex.json` does not exist.

---

## Issue Report Checklist

Attach these outputs when opening a bug report:

- `codex-multi-auth report --json`
- `codex-multi-auth doctor --json`
- `codex --version`
- `codex-multi-auth --version`
- `npm ls -g codex-multi-auth`
- the failing command and full terminal output

---

## Related

- [getting-started.md](getting-started.md)
- [faq.md](faq.md)
- [reference/commands.md](reference/commands.md)
- [reference/storage-paths.md](reference/storage-paths.md)
