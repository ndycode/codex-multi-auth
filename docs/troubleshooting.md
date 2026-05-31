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
| Codex Desktop history disappears after app bind | Current Codex Desktop builds can filter local threads by the active provider, and app bind switches the real config to `codex-multi-auth-runtime-proxy` | The data is normally still under `~/.codex`; run `codex-multi-auth rotation unbind-app` or `codex-multi-auth rotation disable` to restore the original provider/config before browsing old history |
| Model speed controls are not visible with rotation | Speed/reasoning controls remain owned by Codex config or CLI flags; the app bind only routes Responses traffic | Set `model_reasoning_effort` in `~/.codex/config.toml` or pass `-c model_reasoning_effort=<level>` for wrapper-launched CLI sessions |
| App bind needs to be removed | You want the official app config restored | Run `codex-multi-auth rotation unbind-app` or `codex-multi-auth rotation disable` |

The runtime proxy is loopback-only and default-on. It routes Responses traffic only for forwarded request-bearing official Codex sessions and supported app launches.

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
