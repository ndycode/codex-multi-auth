# Troubleshooting

Deterministic recovery guide for login, switching, quota, and command-routing issues.

---

## 60-Second Recovery

```bash
codex auth doctor --fix
codex auth check
codex auth forecast --live
```

If unresolved:

```bash
codex auth login
```

---

## Symptom to Action

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `codex auth` not recognized | Wrapper path conflict | Run `where codex`, then `codex multi auth status` |
| Browser opens unexpectedly | Normal OAuth browser-first flow | Complete auth and return to terminal |
| Switch succeeded but wrong account used | Stale Codex CLI state | Re-run `codex auth switch <index>`, restart session |
| `missing field id_token` | Stale auth payload | Re-login the affected account |
| `refresh_token_reused` | Token pair rotated elsewhere | Re-login the affected account |
| `token_expired` | Refresh token no longer valid | Re-login the affected account |
| All accounts unhealthy | Entire account pool stale | `codex auth doctor --fix`, then add at least one fresh account |
| OAuth callback port `1455` in use | Local port conflict | Stop conflicting process and retry login |

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

If an old scoped package is still active:

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

## Issue Report Checklist

Attach these outputs:

- `codex auth report --json`
- `codex auth doctor --json`
- `codex --version`
- `npm ls -g codex-multi-auth`
- failing command and full terminal output
