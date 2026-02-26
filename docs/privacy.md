# Privacy and Data Handling

`codex-multi-auth` is local-first by design.

## Telemetry

The plugin does not run a custom analytics pipeline.

- No external telemetry service owned by this project.
- No project-hosted remote database.

## Local Files

| Data | Path | Notes |
| --- | --- | --- |
| Plugin config | `~/.opencode/codex-multi-auth-config.json` | Runtime behavior toggles |
| Global accounts | `~/.opencode/openai-codex-accounts.json` | Main account pool |
| Per-project accounts | `~/.opencode/projects/<project-key>/openai-codex-accounts.json` | Optional project isolation |
| Flagged accounts | `~/.opencode/openai-codex-flagged-accounts.json` | Accounts with hard failures |
| Logs | `~/.opencode/logs/codex-plugin/` | Created when logging is enabled |
| Prompt cache | `~/.opencode/cache/` | Cached instructions and metadata |
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
rm -f ~/.opencode/codex-multi-auth-config.json
rm -f ~/.opencode/openai-codex-accounts.json ~/.opencode/openai-codex-flagged-accounts.json ~/.opencode/openai-codex-auth-config.json
find ~/.opencode/projects -name openai-codex-accounts.json -delete 2>/dev/null
rm -rf ~/.opencode/logs/codex-plugin
```

Windows PowerShell:

```powershell
Remove-Item "$HOME\.opencode\codex-multi-auth-config.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.opencode\openai-codex-accounts.json","$HOME\.opencode\openai-codex-flagged-accounts.json","$HOME\.opencode\openai-codex-auth-config.json" -Force -ErrorAction SilentlyContinue
Get-ChildItem "$HOME\.opencode\projects" -Filter "openai-codex-accounts.json" -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.opencode\logs\codex-plugin" -Recurse -Force -ErrorAction SilentlyContinue
```

## Policy Responsibility

Usage must follow OpenAI policy documents:

- https://openai.com/policies/terms-of-use/
- https://openai.com/policies/privacy-policy/

## Related

- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)

