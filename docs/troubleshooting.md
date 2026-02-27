# Troubleshooting

Use this page when login, switching, quota checks, or command routing fails.

* * *

## 60-Second Recovery Flow

```bash
codex auth doctor --fix
codex auth check
codex auth forecast --live
```

If still broken:

```bash
codex auth login
```

* * *

## Symptom -> Action

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Browser opens during login | Expected OAuth behavior | Complete auth in browser and return to same terminal |
| `codex auth` unrecognized | Wrapper command path conflict | Run `where codex`, then `codex multi auth status` |
| Account switch says success but wrong account in Codex | Stale Codex auth state sync | Run `codex auth switch <index>`, then restart `codex` session |
| `missing field id_token` | Old/stale auth state payload | Re-login account with `codex auth login` |
| `refresh_token_reused` | Refresh token already rotated by newer token pair | Re-login that account |
| `token_expired` | Token no longer valid | Re-login that account |
| All accounts unhealthy | Entire pool stale/invalid | `codex auth doctor --fix`, then add one fresh account |
| Menu feels stale or delayed | Limits not refreshed yet | Wait for auto-fetch or run `codex auth check` |
| OAuth callback port `1455` busy | Another process is using callback port | Stop conflicting process and retry |

* * *

## Useful Diagnostics

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

* * *

## Verify Command Routing

```bash
where codex
codex --version
codex auth status
codex multi auth status
```

Expected:

- `codex auth ...` works.
- `codex multi auth ...` alias works.
- Non-auth `codex` commands open official Codex CLI.

* * *

## Logging

Use this only for plugin-host request debugging (not required for normal `codex auth ...` dashboard usage).

Bash:

```bash
DEBUG_CODEX_PLUGIN=1 ENABLE_PLUGIN_REQUEST_LOGGING=1 CODEX_PLUGIN_LOG_BODIES=1 <run-your-host-request-command>
```

PowerShell:

```powershell
$env:DEBUG_CODEX_PLUGIN='1'
$env:ENABLE_PLUGIN_REQUEST_LOGGING='1'
$env:CODEX_PLUGIN_LOG_BODIES='1'
<run-your-host-request-command>
```

cmd.exe:

```bat
set DEBUG_CODEX_PLUGIN=1
set ENABLE_PLUGIN_REQUEST_LOGGING=1
set CODEX_PLUGIN_LOG_BODIES=1
<run-your-host-request-command>
```

Default log location:

- `~/.codex/multi-auth/logs/codex-plugin/`

* * *

## Soft Reset

1. Backup account and settings files.
2. Remove stale local state.
3. Re-login one known-good account first.

Bash:

```bash
rm -f ~/.codex/multi-auth/openai-codex-accounts.json
rm -f ~/.codex/multi-auth/openai-codex-flagged-accounts.json
rm -f ~/.codex/multi-auth/settings.json
codex auth login
```

PowerShell:

```powershell
Remove-Item "$HOME\.codex\multi-auth\openai-codex-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-flagged-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\settings.json" -Force -ErrorAction SilentlyContinue
codex auth login
```

* * *

## Before Opening an Issue

Include:

- `codex auth report --json`
- `codex auth doctor --json`
- `codex --version`
- `npm ls -g codex-multi-auth`
- failing command and full output

