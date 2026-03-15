# Privacy and Data Handling

`codex-multi-auth` is local-first: account/session state is stored on your machine under the configured runtime root.

---

## Telemetry

- No custom analytics pipeline in this repository.
- No project-owned remote database.
- Network calls are limited to required OAuth/backend/update endpoints.

---

## Canonical Local Files

| Data | Default path | Purpose |
| --- | --- | --- |
| Unified settings | `~/.codex/multi-auth/settings.json` | Dashboard and backend configuration |
| Accounts | `~/.codex/multi-auth/openai-codex-accounts.json` | Primary saved account pool |
| Flagged accounts | `~/.codex/multi-auth/openai-codex-flagged-accounts.json` | Accounts with hard auth failures |
| Quota cache | `~/.codex/multi-auth/quota-cache.json` | Cached quota snapshots |
| Logs | `~/.codex/multi-auth/logs/codex-plugin/` | Optional diagnostics |
| Prompt/cache files | `~/.codex/multi-auth/cache/` | Cached prompt/template metadata |
| Codex CLI state | `~/.codex/accounts.json`, `~/.codex/auth.json` | Official Codex CLI files |

If `CODEX_MULTI_AUTH_DIR` is set, plugin-owned paths move under that root.
If `CODEX_MULTI_AUTH_CONFIG_PATH` is set, configuration file loading uses that path.
For cleanup, apply the same deletions to resolved override roots (including
Windows override locations).

---

## Network Destinations

Current external destinations:

- OpenAI OAuth endpoints (`auth.openai.com`)
- OpenAI Codex/ChatGPT backend endpoints
- GitHub raw/releases endpoints for prompt template sync

---

## Sensitive Logging

`ENABLE_PLUGIN_REQUEST_LOGGING=1` enables request logging metadata.
`CODEX_PLUGIN_LOG_BODIES=1` enables raw request/response body logging.

Raw body logs may contain sensitive payload text. Treat logs as sensitive data, redact tokens and sensitive payloads before sharing excerpts, and rotate/delete them as needed.

---

## Data Cleanup

These commands delete local state. Review the resolved paths before running them, and do not run them automatically from an agent unless the user explicitly asked for cleanup.

Bash:

```bash
rm -f -- ~/.codex/multi-auth/settings.json
rm -f -- ~/.codex/multi-auth/openai-codex-accounts.json
rm -f -- ~/.codex/multi-auth/openai-codex-flagged-accounts.json
rm -f -- ~/.codex/multi-auth/quota-cache.json
rm -rf -- ~/.codex/multi-auth/logs/codex-plugin
rm -f -- ~/.codex/multi-auth/logs/audit.log ~/.codex/multi-auth/logs/audit.*.log
rm -rf -- ~/.codex/multi-auth/cache
# Override-root cleanup examples (if overrides are set):
if [ -n "${CODEX_MULTI_AUTH_DIR:-}" ]; then
  rm -f -- "$CODEX_MULTI_AUTH_DIR/settings.json"
  rm -f -- "$CODEX_MULTI_AUTH_DIR/openai-codex-accounts.json"
  rm -f -- "$CODEX_MULTI_AUTH_DIR/openai-codex-flagged-accounts.json"
  rm -f -- "$CODEX_MULTI_AUTH_DIR/quota-cache.json"
  rm -rf -- "$CODEX_MULTI_AUTH_DIR/logs/codex-plugin"
  rm -f -- "$CODEX_MULTI_AUTH_DIR/logs/audit.log" "$CODEX_MULTI_AUTH_DIR/logs"/audit.*.log
  rm -rf -- "$CODEX_MULTI_AUTH_DIR/cache"
fi
[ -n "${CODEX_MULTI_AUTH_CONFIG_PATH:-}" ] && [ -f "$CODEX_MULTI_AUTH_CONFIG_PATH" ] && rm -f -- "$CODEX_MULTI_AUTH_CONFIG_PATH"
```

PowerShell:

```powershell
Remove-Item "$HOME\.codex\multi-auth\settings.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-flagged-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\quota-cache.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\logs\codex-plugin" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\logs\audit.log" -Force -ErrorAction SilentlyContinue
Get-ChildItem "$HOME\.codex\multi-auth\logs" -Filter "audit.*.log" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\cache" -Recurse -Force -ErrorAction SilentlyContinue
# Override-root cleanup examples (if overrides are set):
if ($env:CODEX_MULTI_AUTH_DIR) {
  foreach ($relativePath in @(
    "settings.json",
    "openai-codex-accounts.json",
    "openai-codex-flagged-accounts.json",
    "quota-cache.json"
  )) {
    Remove-Item (Join-Path $env:CODEX_MULTI_AUTH_DIR $relativePath) -Force -ErrorAction SilentlyContinue
  }

  foreach ($relativePath in @(
    "logs\codex-plugin",
    "cache"
  )) {
    Remove-Item (Join-Path $env:CODEX_MULTI_AUTH_DIR $relativePath) -Recurse -Force -ErrorAction SilentlyContinue
  }

  Remove-Item (Join-Path $env:CODEX_MULTI_AUTH_DIR "logs\audit.log") -Force -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $env:CODEX_MULTI_AUTH_DIR "logs") -Filter "audit.*.log" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}
if ($env:CODEX_MULTI_AUTH_CONFIG_PATH) { Remove-Item "$env:CODEX_MULTI_AUTH_CONFIG_PATH" -Force -ErrorAction SilentlyContinue }
```

---

## Policy Responsibility

Usage must comply with OpenAI policies:

- https://openai.com/policies/terms-of-use/
- https://openai.com/policies/privacy-policy/

---

## Related

- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [../SECURITY.md](../SECURITY.md)
