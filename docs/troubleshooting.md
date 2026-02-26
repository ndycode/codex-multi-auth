# Troubleshooting

Use this page for quick issue-to-fix mapping.

## 60-Second Repair Flow

```bash
codex auth doctor --fix
codex auth list
codex auth forecast --live
```

If still broken:

```bash
codex auth login
```

## Symptom Chart

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Browser opens on login | Expected OAuth flow | Complete browser approval, return to same terminal |
| Placeholder/example emails | Old demo/stale metadata | `codex auth doctor --fix` |
| `401 Unauthorized` | Expired/invalid token | `codex auth login` |
| Frequent rate limits | Active account quota exhausted | `codex auth switch <index>` then `codex auth forecast --live` |
| All accounts fail | Duplicate/disabled/stale account pool | `codex auth doctor --fix` and re-login one healthy account |
| OAuth callback port 1455 conflict | Another process already using callback port | Stop conflicting process, retry login |
| Session does not pick account changes | Live sync disabled or delayed | Enable `liveAccountSync` and confirm storage path |

## Useful Diagnostics

```bash
codex auth list
codex auth check
codex auth fix --dry-run
codex auth doctor --json
codex auth report --live --json
```

## Logging

POSIX shell:

```bash
DEBUG_CODEX_PLUGIN=1 ENABLE_PLUGIN_REQUEST_LOGGING=1 CODEX_PLUGIN_LOG_BODIES=1 opencode run "test" --model=openai/gpt-5.2
```

PowerShell:

```powershell
$env:DEBUG_CODEX_PLUGIN='1'
$env:ENABLE_PLUGIN_REQUEST_LOGGING='1'
$env:CODEX_PLUGIN_LOG_BODIES='1'
opencode run "test" --model=openai/gpt-5.2
```

Command Prompt (`cmd.exe`):

```bat
set DEBUG_CODEX_PLUGIN=1
set ENABLE_PLUGIN_REQUEST_LOGGING=1
set CODEX_PLUGIN_LOG_BODIES=1
opencode run "test" --model=openai/gpt-5.2
```

Logs:

`~/.codex/multi-auth/logs/codex-plugin/`

## Soft Reset

1. Backup and remove `~/.codex/multi-auth/openai-codex-accounts.json`.
2. Run `codex auth login`.
3. Verify with `codex auth list`.

## Before Opening an Issue

Include:

- `codex auth report --json`
- `codex auth doctor --json`
- plugin version (`npm ls -g codex-multi-auth`)
- codex version (`codex --version`)
- exact failing command and full error text
