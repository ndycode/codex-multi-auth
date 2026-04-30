# Troubleshooting

Recovery guide for install, login, switching, worktree storage, and stale local auth state.

---

## Start Here

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

Check which `codex` executable is running:

```bash
where codex
codex --version
codex-multi-auth --version
codex-multi-auth status
codex-multi-auth status
npm ls -g codex-multi-auth
```

If an old scoped package is still active:

```bash
npm uninstall -g @ndycode/codex-multi-auth
npm i -g codex-multi-auth
```

`codex-multi-auth status` is a compatibility alias. The canonical command family remains `codex-multi-auth ...`.

---

## Browser And OAuth Problems

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Browser opens unexpectedly | Normal browser-first OAuth flow | Complete the auth step and return to the terminal |
| OAuth callback port `1455` is in use | Another local process owns the port | Stop the conflicting process and rerun `codex-multi-auth login` |
| Browser or callback handoff is unavailable | Remote, SSH, container, or headless shell | Run `codex-multi-auth login --device-auth`; use `codex-multi-auth login --manual` only if device auth is unavailable |
| `missing field id_token` | Stale or malformed auth payload | Re-login the affected account |
| `refresh_token_reused` | The token pair rotated in another context | Re-login the affected account |
| `token_expired` | The refresh token is no longer valid | Re-login the affected account |

---

## Switching And State Problems

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
| Forwarded Codex session does not show the local provider | Command is help/non-requesting, rotation is disabled, or the official CLI was not launched through the wrapper | Check `where codex`, then run `codex-multi-auth rotation status` |
| Pool exhausted error from the proxy | Every managed account is unavailable for that model/family | Run `codex-multi-auth rotation status`, then `codex-multi-auth forecast --live` |
| Packaged app still uses normal Codex routing | App bind was not installed or was removed | Run `codex-multi-auth rotation bind-app`, then reopen the app |
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
