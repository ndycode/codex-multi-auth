# Troubleshooting

Recovery guide for install, login, switching, worktree storage, and stale local auth state.

---

## Start Here

```bash
codex auth doctor --fix
codex auth check
codex auth forecast --live
```

If the account pool is still not usable:

```bash
codex auth login
```

If `codex auth login` starts with no saved accounts and named backups are present, you will be prompted to restore before OAuth. This prompt only appears in interactive terminals and is skipped after intentional reset flows.

---

## Verify Install And Routing

Check which `codex` executable is running:

```bash
where codex
codex --version
codex auth status
codex multi auth status
npm ls -g codex-multi-auth
```

If an old scoped package is still active:

```bash
npm uninstall -g @ndycode/codex-multi-auth
npm i -g codex-multi-auth
```

`codex multi auth status` is a compatibility alias. The canonical command family remains `codex auth ...`.

---

## Browser And OAuth Problems

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Browser opens unexpectedly | Normal browser-first OAuth flow | Complete the auth step and return to the terminal |
| OAuth callback port `1455` is in use | Another local process owns the port | Stop the conflicting process and rerun `codex auth login` |
| `missing field id_token` | Stale or malformed auth payload | Re-login the affected account |
| `refresh_token_reused` | The token pair rotated in another context | Re-login the affected account |
| `token_expired` | The refresh token is no longer valid | Re-login the affected account |

---

## Switching And State Problems

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Switch succeeds but the wrong account stays active | Stale Codex CLI sync state | Re-run `codex auth switch <index>` and restart the session |
| All accounts look unhealthy | The entire pool is stale or damaged | Run `codex auth doctor --fix`, then add at least one fresh account |
| The dashboard shows old account state | Local files were updated outside the current session | Run `codex auth list`, then `codex auth check` |

---

## Worktrees And Project Storage

| Symptom | Likely cause | Action |
| --- | --- | --- |
| A worktree asks for login again | The worktree still points at a legacy path key | Run `codex auth list` once in the worktree to trigger migration into repo-shared storage |
| A repo should not share accounts with another repo | Project-scoped storage is not enabled or not in use | Review the project storage rules in [reference/storage-paths.md](reference/storage-paths.md) |

---

## Diagnostics Pack

```bash
codex auth list
codex auth status
codex auth check
codex auth verify-flagged --json
codex auth forecast --live
codex auth fix --dry-run
codex auth report --live --json
codex auth doctor --json
```

---

## Reset Options

- Delete a single saved account: `codex auth login` → pick account → **Delete Account**
- Delete saved accounts: `codex auth login` → Danger Zone → **Delete Saved Accounts**
- Reset local state: `codex auth login` → Danger Zone → **Reset Local State**

Exact effects:

| Action | Saved accounts | Flagged/problem accounts | Settings | Codex CLI sync state | Quota cache |
| --- | --- | --- | --- | --- | --- |
| Delete Account | Delete the selected saved account | Delete the matching flagged/problem entry for that refresh token | Keep | Keep | Keep |
| Delete Saved Accounts | Delete all saved accounts | Keep | Keep | Keep | Keep |
| Reset Local State | Delete all saved accounts | Delete all flagged/problem accounts | Keep | Keep | Clear |

To perform the same actions manually:

Delete saved accounts only:

```powershell
Remove-Item "$HOME\.codex\multi-auth\openai-codex-accounts.json" -Force -ErrorAction SilentlyContinue
```

```bash
rm -f ~/.codex/multi-auth/openai-codex-accounts.json
```

Reset local state (also clears flagged/problem accounts and quota cache; preserves settings and Codex CLI sync state):

```powershell
Remove-Item "$HOME\.codex\multi-auth\openai-codex-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-flagged-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\quota-cache.json" -Force -ErrorAction SilentlyContinue
```

```bash
rm -f ~/.codex/multi-auth/openai-codex-accounts.json
rm -f ~/.codex/multi-auth/openai-codex-flagged-accounts.json
rm -f ~/.codex/multi-auth/quota-cache.json
```

---

## Issue Report Checklist

Attach these outputs when opening a bug report:

- `codex auth report --json`
- `codex auth doctor --json`
- `codex --version`
- `npm ls -g codex-multi-auth`
- the failing command and full terminal output

---

## Related

- [getting-started.md](getting-started.md)
- [faq.md](faq.md)
- [reference/commands.md](reference/commands.md)
- [reference/storage-paths.md](reference/storage-paths.md)
