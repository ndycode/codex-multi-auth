# Troubleshooting

Use this page when login, switching, quota checks, or command routing fails.

---

## 60-Second Recovery

```bash
codex auth doctor --fix
codex auth check
codex auth forecast --live
```

If still broken:

```bash
codex auth login
```

---

## Symptom -> Action

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Browser opens during login | Expected OAuth behavior | Complete auth and return to terminal |
| `codex auth` unrecognized | Wrapper command path conflict | Run `where codex`, then `codex multi auth status` |
| Switch says success but wrong account in Codex | Stale Codex auth state sync | Run `codex auth switch <index>`, restart `codex` session |
| Opening a PR worktree asks for login again | Worktree was using a different legacy path key | Run `codex auth list` once in the worktree to trigger migration into repo-shared storage |
| `missing field id_token` | Stale auth state payload | Re-login account with `codex auth login` |
| `refresh_token_reused` | Token pair already rotated | Re-login that account |
| `token_expired` | Token no longer valid | Re-login that account |
| All accounts unhealthy | Entire pool stale/invalid | `codex auth doctor --fix`, then add one fresh account |
| OAuth callback port `1455` busy | Port conflict | Stop conflicting process and retry |

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

## Verify Install and Routing

```bash
where codex
codex --version
codex auth status
codex multi auth status
npm ls -g codex-multi-auth
```

If you still have old scoped package installed:

```bash
npm uninstall -g @ndycode/codex-multi-auth
npm i -g codex-multi-auth
```

---

## Soft Reset

PowerShell:

```powershell
Remove-Item "$HOME\.codex\multi-auth\openai-codex-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-flagged-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\settings.json" -Force -ErrorAction SilentlyContinue
codex auth login
```

Bash:

```bash
rm -f ~/.codex/multi-auth/openai-codex-accounts.json
rm -f ~/.codex/multi-auth/openai-codex-flagged-accounts.json
rm -f ~/.codex/multi-auth/settings.json
codex auth login
```

---

## Before Opening an Issue

Include:

- `codex auth report --json`
- `codex auth doctor --json`
- `codex --version`
- `npm ls -g codex-multi-auth`
- failing command and full output
