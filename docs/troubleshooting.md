# codex-multi-auth Troubleshooting

Fixes for install, login, account-pool, rotation, and storage problems. All commands below use the canonical `codex-multi-auth` family.

---

## First Try: 60 Seconds

```bash
codex-multi-auth doctor --fix   # diagnose and repair common local issues
codex-multi-auth check          # re-check pool health
```

Still broken? Re-auth the affected account, or the whole pool:

```bash
codex-multi-auth login --account <index|email|id>
codex-multi-auth login
```

---

## Install And PATH

| Symptom | Fix |
| --- | --- |
| `codex-multi-auth`: command not found | Confirm `npm ls -g codex-multi-auth`; check npm's global bin directory is on `PATH` (`which codex-multi-auth` on macOS/Linux, `where codex-multi-auth` on Windows) |
| `codex-multi-auth-codex` or `mcodex` missing | Same install provides them — reinstall with `npm i -g codex-multi-auth` |
| `codex` resolves to something this package installed | It doesn't any more. `codex` belongs to the official install; reinstall `npm i -g @openai/codex` |

**Legacy note:** the prerelease package `@ndycode/codex-multi-auth` is superseded by the unscoped name. If it is still installed, remove it and reinstall — see [upgrade.md](upgrade.md#migrate-from-the-legacy-package).

---

## Login Problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| Callback port `1455` in use / `EADDRINUSE` | Another process holds the port. The listener needs **both** `127.0.0.1` and `::1` — a holder on either family is fatal | Stop the process (see below), or use `codex-multi-auth login --device-auth`, which binds nothing |
| Login appears to hang, callback never arrives | Remote shell, blocked redirect, or Windows/WSL contention | The callback poll caps at 5 minutes, then offers manual paste. Ctrl+C earlier if you like; prefer `--device-auth` |
| Headless / SSH / container, no browser | Expected | `codex-multi-auth login --device-auth` — the code is valid for 15 minutes |
| `missing field id_token` | Stale or malformed auth payload | Re-login the affected account |
| `refresh_token_reused` | The token pair was rotated in another context | Re-login the affected account |
| `token_expired` | The refresh token is no longer valid | Re-login the affected account |

Find what holds port `1455`:

```bash
# macOS / Linux
lsof -i :1455
# WSL
ss -lptn 'sport = :1455'
```

```powershell
# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 1455
```

### Windows And WSL Side By Side

Installing on Windows **and** inside WSL is supported, but the OAuth redirect URI is fixed at `http://localhost:1455/auth/callback`, so only one side can run a browser login at a time. A browser launched from WSL runs on Windows, and Windows resolves `localhost:1455` against its own loopback first — a port holder on the Windows side silently receives the redirect the WSL listener waits for.

The WSL listener binds cleanly and simply waits (up to the 5-minute cap), so the failure looks like a hang. Check both sides, close the holder, or sidestep the port entirely:

```bash
codex-multi-auth login --device-auth
```

Accounts are stored per environment — the Windows and WSL installs keep separate state directories. Sign in on each side independently.

---

## Account Pool Problems

| Symptom | Fix |
| --- | --- |
| Pool looks stale or damaged | `codex-multi-auth doctor --fix`, then `codex-multi-auth check` |
| `switch` succeeded but the wrong account stays active | Re-run `codex-multi-auth switch <index>`; inspect with `codex-multi-auth why-selected --json` |
| An account is never selected | Check policy state: `codex-multi-auth account policy list`; lift with `account unpause <index>` / `account undrain <index>` |
| Requests blocked by budget | `codex-multi-auth budget list --json` and `budget check <key>` — raise or clear the limit |
| Suspect a corrupted pool file | `codex-multi-auth fix --dry-run` previews repairs, `codex-multi-auth fix` applies them, `codex-multi-auth verify --all` confirms |
| Pool lost entirely | Every save keeps `.bak` snapshots and a WAL; named backups under `~/.codex/multi-auth/backups/` restore from the `login` menu on an empty pool |

---

## Token Refresh

Refresh is automatic and coordinated, so refresh problems usually mean the upstream credential is dead — not a local bug.

- One in-flight refresh per token, deduplicated; short-lived cross-process leases under `~/.codex/multi-auth/refresh-leases/` stop two wrapper processes from refreshing the same account twice.
- A failed refresh applies a cooldown — ~30 seconds for generic failures, 5 minutes when the server reports the token invalidated. The cooldown only lengthens.
- `codex-multi-auth check` shows which accounts are cooling down or invalidated. Re-login cures an invalidated account; nothing else does.

---

## Rotation Problems

| Symptom | Fix |
| --- | --- |
| `rotation status` says disabled | `codex-multi-auth rotation enable`; remove `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` from the environment |
| `codex_runtime_rotation_pool_exhausted` | Every managed account is unavailable. `codex-multi-auth rotation status` shows per-account skip reasons and `retry_after_ms`; `codex-multi-auth forecast --live` finds what is usable |
| `codex_pinned_account_unavailable` | The pinned account is cooling down, disabled, or policy-blocked — the error names the reason and remedy. Wait out the cooldown, then `codex-multi-auth unpin` clears a `switch` pin; a pin set by `codex-multi-auth-codex --account`/`CODEX_MULTI_AUTH_FORCE_ACCOUNT` belongs to that launch — relaunch with a different account instead |
| Accounts lose OAuth tokens while the proxy is active | Upstream invalidated them — rapid rotation can trip anti-abuse detection. The proxy stops on explicit invalidation and applies the 5-minute cooldown; re-login the affected accounts and keep `minRotationIntervalMs` at `60000` (default) or higher |
| Microsoft/SSO account invalidated on first proxied request | Its tokens can be bound to the issuing network context. Keep that account out of the rotation pool, or raise `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS` and re-login |
| Desktop app ignores rotation | The app bind is missing — `codex-multi-auth rotation bind-app`, then restart the app |
| `/resume` or history shows fewer sessions after binding the app | Codex filters sessions by provider name; the rollout files are all still under `~/.codex/sessions`. `codex-multi-auth history` lists everything across providers (`history show <id>` for one). `rotation unbind-app` restores the native view |
| Cascading `429`s under many parallel agents | More agents than accounts — see below |
| `Provider response headers timed out after 10000ms` | That message comes from your host client's own provider timeout, not this package (its timeouts are `fetchTimeoutMs` 60 s / `streamStallTimeoutMs` 45 s). Raise the host client's timeout and spread load — see below |

### High Parallelism / Agent Swarms

Each wrapper-launched agent is a separate process with its own rotation state, so the levers that help are the ones that spread load across accounts:

- **Add accounts.** The only structural fix — with 2 accounts and 20 agents, roughly 10 agents share each account and `429`s are inevitable.
- **Keep `pidOffsetEnabled` on** (default). It gives each process a small account-selection bias so processes lean toward different accounts instead of the same one.
- **`retryAllAccountsRateLimited: true`** with bounded `retryAllAccountsMaxRetries` / `retryAllAccountsMaxWaitMs` — when every account is rate-limited, the proxy waits for the soonest quota window instead of failing immediately. Keep the wait short; a long block can trip a host client's own timeout.
- **`routingMutex: "enabled"`** serializes selection *within* one process; it does not coordinate separate agent processes.

---

### Successful Requests With Zero Usage

Responses streams can omit or mislabel `Content-Type`. The usage scanner checks
up to the first 4 KiB for SSE field/comment prefixes, then processes events
incrementally. The proxy uses that same format decision to require a terminal
event. Normal JSON responses still use the bounded JSON parser.

To investigate a successful Responses request with zero or missing usage, enable
`DEBUG_CODEX_PLUGIN=1`, `CODEX_PLUGIN_LOG_LEVEL=debug`, and `CODEX_CONSOLE_LOG=1`
in the proxy process environment. The debug diagnostic records only source and
operation, without account identities, credentials, or response content. It also
covers genuinely empty responses, so inspect the upstream usage before treating
the diagnostic as proof of a parsing failure.

## macOS Keychain Prompts

`codex-multi-auth` never uses the keychain — its state is plain JSON under `~/.codex/multi-auth`. Repeated "unlock login keychain" prompts come from the *official* CLI when `~/.codex/config.toml` still has `cli_auth_credentials_store = "keychain"`.

`codex-multi-auth doctor --fix` pins that key to `"file"` (first-run setup and wrapper startup do the same automatically). Credentials an earlier `codex login` saved to the keychain are simply never read again — delete them manually in Keychain Access if you want them gone. To keep the keychain store deliberately, set `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0`.

---

## Worktrees And Project Pools

| Symptom | Fix |
| --- | --- |
| A worktree asks for login again | Run `codex-multi-auth list` once inside it — legacy worktree-keyed files migrate into the repo-shared pool automatically |
| A repo must not share a pool with another repo | Pools key by repository identity, not path — see [reference/storage-paths.md](reference/storage-paths.md) |

---

## Diagnostics For A Bug Report

```bash
codex-multi-auth report --live --json
codex-multi-auth doctor --json
codex-multi-auth debug bundle --json
codex --version
codex-multi-auth --version
npm ls -g codex-multi-auth
```

Attach those outputs plus the failing command and its full terminal output.

---

## Soft Reset (Pool + Settings Only)

```bash
rm -f ~/.codex/multi-auth/openai-codex-accounts.json
rm -f ~/.codex/multi-auth/openai-codex-flagged-accounts.json
rm -f ~/.codex/multi-auth/settings.json
codex-multi-auth login
```

```powershell
Remove-Item "$HOME\.codex\multi-auth\openai-codex-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-flagged-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\settings.json" -Force -ErrorAction SilentlyContinue
codex-multi-auth login
```

This keeps the usage ledger, budgets, policies, quota cache, and backups. For a full wipe, see [privacy.md](privacy.md#data-cleanup).

---

## Uninstall Completely

`npm uninstall -g codex-multi-auth` alone leaves residue — the shipped `preuninstall.js` is **not** wired as an npm lifecycle hook on modern npm, so it never runs by itself. Run the package's own cleanup first:

```bash
codex-multi-auth uninstall          # add --dry-run to preview, --clear-accounts to wipe credentials too
npm uninstall -g codex-multi-auth
```

The cleanup unbinds the app router, removes OS launchers, strips the `Codex.json` entry, and clears the package's `node_modules` cache.

---

## Related

- [getting-started.md](getting-started.md)
- [faq.md](faq.md)
- [reference/commands.md](reference/commands.md)
- [reference/storage-paths.md](reference/storage-paths.md)
