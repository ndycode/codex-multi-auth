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
| Accounts | `~/.codex/multi-auth/openai-codex-accounts.json` | Primary saved account pool (V3 JSON) |
| Flagged accounts | `~/.codex/multi-auth/openai-codex-flagged-accounts.json` | Accounts with hard auth failures |
| Quota cache | `~/.codex/multi-auth/quota-cache.json` | Cached quota snapshots |
| Runtime observability | `~/.codex/multi-auth/runtime-observability.json` | Local request counters and last-account metadata for status/report output |
| First-run setup marker | `~/.codex/multi-auth/first-run-setup.json` | One-time durable-install app bind / launcher setup claim; not secrets |
| Cross-process refresh leases | `~/.codex/multi-auth/refresh-leases/` | Short-lived lease files that dedupe concurrent token refresh |
| Usage ledger | `~/.codex/multi-auth/usage/usage-ledger.jsonl` | Local request metadata summaries; email stored hashed; no prompts, auth headers, or raw sensitive account ids |
| Account policies | `~/.codex/multi-auth/account-policies.json` | Local tags, weights, pause/drain state, and notes keyed by hashed account identity |
| Routing profiles | `~/.codex/multi-auth/routing-profiles.json` | Project-aware local routing preferences keyed by project identity |
| Budget guards | `~/.codex/multi-auth/budget-guards.json` | Local request/token/cost limits for runtime blocking |
| Local bridge client tokens | `~/.codex/multi-auth/local-client-tokens.json` | SHA-256 token hashes plus prefixes and labels; plaintext tokens are shown only on create/rotate |
| Named backups | `~/.codex/multi-auth/backups/` | Operator-exported named account-pool backups |
| Project account pools | `~/.codex/multi-auth/projects/<project-key>/` | Per-repo account pools when project scope is enabled |
| Runtime app helper status | `~/.codex/multi-auth/runtime-rotation-app-helper.json` | Local helper status for wrapper-launched Codex app sessions |
| Persistent app bind state/logs | `~/.codex/multi-auth/app-bind/` | Reversible packaged-app router state, backup metadata, and local router log |
| Logs | `~/.codex/multi-auth/logs/codex-plugin/` | Optional diagnostics |
| Prompt/cache files | `~/.codex/multi-auth/cache/` | Cached prompt/template metadata |
| Codex CLI state | `~/.codex/accounts.json`, `~/.codex/auth.json`, `~/.codex/config.toml` | Official Codex CLI files |

If `CODEX_MULTI_AUTH_DIR` is set, multi-auth-owned paths move under that root.
If `CODEX_MULTI_AUTH_CONFIG_PATH` is set, configuration file loading uses that path.
For cleanup, apply the same deletions to resolved override roots (including
Windows override locations).

Runtime rotation uses loopback-only local HTTP listeners. The per-session proxy and persistent app router forward requests to the official Codex backend with the selected managed account token, but the project does not operate a remote telemetry service.

The optional local bridge is also loopback-only and exposes only `/health`,
`/v1/models`, and `/v1/responses`. It requires a local bearer token by default.
The token file stores SHA-256 hashes, not plaintext tokens.

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

---

## Data Cleanup

Bash:

```bash
rm -f ~/.codex/multi-auth/settings.json
rm -f ~/.codex/multi-auth/openai-codex-accounts.json
rm -f ~/.codex/multi-auth/openai-codex-flagged-accounts.json
rm -f ~/.codex/multi-auth/quota-cache.json
rm -f ~/.codex/multi-auth/runtime-observability.json
rm -f ~/.codex/multi-auth/first-run-setup.json
rm -f ~/.codex/multi-auth/config.json
rm -f ~/.codex/multi-auth/account-policies.json
rm -f ~/.codex/multi-auth/routing-profiles.json
rm -f ~/.codex/multi-auth/budget-guards.json
rm -f ~/.codex/multi-auth/local-client-tokens.json
rm -rf ~/.codex/multi-auth/refresh-leases
rm -rf ~/.codex/multi-auth/usage
rm -rf ~/.codex/multi-auth/backups
rm -rf ~/.codex/multi-auth/projects
rm -f ~/.codex/multi-auth/runtime-rotation-app-helper.json
rm -rf ~/.codex/multi-auth/app-bind
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
Remove-Item "$HOME\.codex\multi-auth\runtime-observability.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\first-run-setup.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\config.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\account-policies.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\routing-profiles.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\budget-guards.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\local-client-tokens.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\refresh-leases" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\usage" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\backups" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\projects" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\runtime-rotation-app-helper.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$HOME\.codex\multi-auth\app-bind" -Recurse -Force -ErrorAction SilentlyContinue
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
