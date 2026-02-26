# Privacy and Data Handling

`codex-multi-auth` is local-first by design.

## Telemetry

The plugin does not run a custom analytics pipeline.

- No external telemetry service owned by this project.
- No project-hosted remote database.

## Local Files

| Data | Path | Notes |
| --- | --- | --- |
| Plugin config | `~/.codex/multi-auth/config.json` | Runtime behavior toggles |
| Global accounts | `~/.codex/multi-auth/openai-codex-accounts.json` | Main account pool |
| Per-project accounts | `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json` | Optional project isolation |
| Flagged accounts | `~/.codex/multi-auth/openai-codex-flagged-accounts.json` | Accounts with hard failures |
| Logs | `~/.codex/multi-auth/logs/codex-plugin/` | Created when logging is enabled |
| Prompt cache | `~/.codex/multi-auth/cache/` | Cached instructions and metadata |
| Codex CLI account state | `~/.codex/accounts.json` and `~/.codex/auth.json` | Read/sync integration paths |

## Network Destinations

This plugin communicates with:

- OpenAI OAuth endpoints (`auth.openai.com`)
- Codex/ChatGPT backend endpoints (OpenAI APIs)
- GitHub releases/raw endpoints for prompt template cache refresh

## Sensitive Logging Warning

If you enable raw body logging:

```bash
CODEX_PLUGIN_LOG_BODIES=1
```

prompt/response payload content may be written to local logs. Treat logs as sensitive data.

## Data Cleanup

Linux/macOS:

```bash
rm -rf ~/.codex/multi-auth
```

Windows PowerShell:

```powershell
Remove-Item "$HOME\.codex\multi-auth" -Recurse -Force -ErrorAction SilentlyContinue
```

## Policy Responsibility

Usage must follow OpenAI policy documents:

- https://openai.com/policies/terms-of-use/
- https://openai.com/policies/privacy-policy/

## Related

- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
