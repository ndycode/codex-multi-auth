# Privacy and Data Handling

`codex-multi-auth` is local-first: account/session data is stored on your machine.

* * *

## Telemetry

- No custom hosted analytics pipeline in this project.
- No project-owned remote database.
- Network calls only go to required OAuth/backend/update endpoints.

* * *

## Local Files (Current Canonical)

| Data | Path | Why it exists |
| --- | --- | --- |
| Unified settings | `~/.codex/multi-auth/settings.json` | Dashboard + backend behavior settings |
| Accounts | `~/.codex/multi-auth/openai-codex-accounts.json` | Saved account pool |
| Flagged accounts | `~/.codex/multi-auth/openai-codex-flagged-accounts.json` | Accounts with hard auth failures |
| Quota cache | `~/.codex/multi-auth/quota-cache.json` | Cached 5h/7d limit snapshots |
| Logs | `~/.codex/multi-auth/logs/codex-plugin/` | Optional diagnostic logs |
| Prompt/cache files | `~/.codex/multi-auth/cache/` | Cached prompt/template metadata |
| Codex CLI auth state | `~/.codex/accounts.json`, `~/.codex/auth.json` | Official Codex CLI account/auth files |

Legacy compatibility files from older versions may still be read during migration-only compatibility checks.

* * *

## Network Destinations

This project communicates with:

- OpenAI OAuth endpoints (`auth.openai.com`)
- OpenAI Codex/ChatGPT backend endpoints
- GitHub raw/releases endpoints for prompt-template sync cache

* * *

## Sensitive Logging Warning

If you enable raw body logging:

```bash
CODEX_PLUGIN_LOG_BODIES=1
```

prompt/response payload text can be written to local logs. Treat those logs as sensitive.

* * *

## Data Cleanup

Bash:

```bash
rm -f ~/.codex/multi-auth/settings.json
rm -f ~/.codex/multi-auth/openai-codex-accounts.json
rm -f ~/.codex/multi-auth/openai-codex-flagged-accounts.json
rm -f ~/.codex/multi-auth/quota-cache.json
rm -rf ~/.codex/multi-auth/logs/codex-plugin
rm -rf ~/.codex/multi-auth/cache
```

PowerShell:

```powershell
Remove-Item "$HOME\.codex\multi-auth\settings.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-flagged-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\quota-cache.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\logs\codex-plugin" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\cache" -Recurse -Force -ErrorAction SilentlyContinue
```

* * *

## Policy Responsibility

Usage must comply with OpenAI policy documents:

- https://openai.com/policies/terms-of-use/
- https://openai.com/policies/privacy-policy/

* * *

## Related

- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/storage-paths.md](reference/storage-paths.md)
