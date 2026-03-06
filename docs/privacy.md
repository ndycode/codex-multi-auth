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
| Background DLQ | `~/.codex/multi-auth/background-job-dlq.jsonl` | Failed background jobs after retry exhaustion |
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

Raw body logs may contain sensitive payload text. Treat logs as sensitive data and rotate/delete as needed.

`CODEX_AUTH_REDACT_JSON_OUTPUT=1` redacts sensitive values from JSON command output for automation logs.

---

## Secret Encryption and Rotation

- Account refresh/access tokens can be encrypted at rest when `CODEX_AUTH_ENCRYPTION_KEY` is set.
- Key rotation supports staged migration with `CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY`.
- Both key variables should be 32-byte high-entropy key material (not passwords).
- Rotation command:

```bash
codex auth rotate-secrets --json
```

Store encryption keys in a secret manager or CI secret store, not in repository files.

---

## Retention

Startup retention cleanup removes expired local artifacts based on:

- `CODEX_AUTH_RETENTION_LOG_DAYS`
- `CODEX_AUTH_RETENTION_CACHE_DAYS`
- `CODEX_AUTH_RETENTION_FLAGGED_DAYS`
- `CODEX_AUTH_RETENTION_QUOTA_CACHE_DAYS`
- `CODEX_AUTH_RETENTION_DLQ_DAYS`

Retention control:

```bash
npm run ops:retention-cleanup
npm run ops:retention-cleanup -- --days=30
```

Default retention window is 90 days.

Audit forwarding (for central SIEM ingestion):

```bash
npm run ops:audit-forwarder -- --dry-run
```

---

## Data Cleanup

Bash:

```bash
rm -f ~/.codex/multi-auth/settings.json
rm -f ~/.codex/multi-auth/openai-codex-accounts.json
rm -f ~/.codex/multi-auth/openai-codex-flagged-accounts.json
rm -f ~/.codex/multi-auth/quota-cache.json
rm -rf ~/.codex/multi-auth/logs/codex-plugin
rm -rf ~/.codex/multi-auth/cache
# Override-root cleanup examples (if overrides are set):
[ -n "${CODEX_MULTI_AUTH_DIR:-}" ] && [ -d "$CODEX_MULTI_AUTH_DIR/logs/codex-plugin" ] && rm -rf "$CODEX_MULTI_AUTH_DIR/logs/codex-plugin"
[ -n "${CODEX_MULTI_AUTH_CONFIG_PATH:-}" ] && [ -f "$CODEX_MULTI_AUTH_CONFIG_PATH" ] && rm -f "$CODEX_MULTI_AUTH_CONFIG_PATH"
```

PowerShell:

```powershell
Remove-Item "$HOME\.codex\multi-auth\settings.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\openai-codex-flagged-accounts.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\quota-cache.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\logs\codex-plugin" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\cache" -Recurse -Force -ErrorAction SilentlyContinue
# Override-root cleanup examples (if overrides are set):
if ($env:CODEX_MULTI_AUTH_DIR) { Remove-Item "$env:CODEX_MULTI_AUTH_DIR\\*" -Recurse -Force -ErrorAction SilentlyContinue }
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
