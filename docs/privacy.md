# Privacy And Data Handling

`codex-multi-auth` is local-first. Every file it owns lives under `~/.codex/multi-auth` (or `CODEX_MULTI_AUTH_DIR` if you override it), with `0600`/`0700` permissions on credential material. There is no telemetry pipeline and no project-run remote service — nothing reports home, because there is no home.

---

## Telemetry

- No analytics, no crash reporting, no usage phone-home.
- No project-owned remote database or dashboard.
- Network calls go only to the endpoints listed below.

---

## What It Stores, And Where

| Data | Default path | Notes |
| --- | --- | --- |
| Account pool | `~/.codex/multi-auth/openai-codex-accounts.json` | V3 JSON, mode `0600`; holds OAuth tokens. Backed by a WAL and rotating `.bak` snapshots |
| Flagged accounts | `~/.codex/multi-auth/openai-codex-flagged-accounts.json` | Accounts sidelined by hard auth failures |
| Settings | `~/.codex/multi-auth/settings.json` | Dashboard + backend config, `.bak` fallback |
| Quota cache | `~/.codex/multi-auth/quota-cache.json` | Cached quota snapshots for fast forecasts |
| Runtime observability | `~/.codex/multi-auth/runtime-observability.json` | Local request counters; feeds `status`/`report` |
| Usage ledger | `~/.codex/multi-auth/usage/usage-ledger.jsonl` | Redacted request metadata: hashed account/email identifiers, no prompts, no auth headers |
| Account policies | `~/.codex/multi-auth/account-policies.json` | Tags, weights, pause/drain, notes — keyed by hashed account identity |
| API routes | `~/.codex/multi-auth/api-routes.json` | Optional non-OAuth route definitions; holds raw `apiKey` values — treat as credential material |
| Reset credits | `~/.codex/multi-auth/reset-credits.json` | Reset-credit availability snapshots, keyed by account identity; per-credit expiry and title only (no credit IDs) |
| Budget guards | `~/.codex/multi-auth/budget-guards.json` | Local request/token/cost limits |
| Routing profiles | `~/.codex/multi-auth/routing-profiles.json` | Project-aware preferences, keyed by project identity |
| Bridge client tokens | `~/.codex/multi-auth/local-client-tokens.json` | SHA-256 hashes + prefixes only; plaintext `cma_local_*` tokens show once at creation |
| Refresh leases | `~/.codex/multi-auth/refresh-leases/` | Short-lived cross-process refresh locks |
| Named backups | `~/.codex/multi-auth/backups/` | Operator-exported pool backups |
| Per-project pools | `~/.codex/multi-auth/projects/<project-key>/` | Repo-keyed account pools |
| App bind state | `~/.codex/multi-auth/app-bind/` | Reversible router state, backup metadata, local log |
| App helper status | `~/.codex/multi-auth/runtime-rotation-app-helper*.<pid>.json` | Per-helper status + owner files; cleaned on exit |
| First-run marker | `~/.codex/multi-auth/first-run-setup.json` | One-time setup claim; not a secret |
| Logs | `~/.codex/multi-auth/logs/codex-plugin/` | Optional diagnostics |
| Prompt cache | `~/.codex/multi-auth/cache/` | Cached prompt/template metadata |
| Official Codex state | `~/.codex/auth.json`, `~/.codex/accounts.json`, `~/.codex/config.toml` | Owned by the official CLI; `codex-multi-auth` syncs the active account into `auth.json` |

`CODEX_MULTI_AUTH_DIR` moves every `multi-auth` path above. `CODEX_MULTI_AUTH_CONFIG_PATH` overrides where configuration loads from.

---

## What Leaves The Machine

| Destination | Why |
| --- | --- |
| `auth.openai.com` | OAuth sign-in, device-code flow, token refresh |
| ChatGPT/Codex backend | The requests you make through Codex, carrying the selected account's token |
| GitHub (raw/releases) | Prompt-template sync with ETag caching |
| npm registry | Optional best-effort daily version check during forwarded wrapper startup |

Local listeners — the OAuth callback on `localhost:1455`, the rotation proxy, the app router, and the optional local bridge — are loopback-only. The proxy and router authenticate local clients with a per-process random token and forward upstream; the bridge requires a bearer token.

---

## Tokens And Logs

- Access and refresh tokens exist only in the pool file and the official `~/.codex/auth.json` they sync to.
- Tokens are **never** written to logs. Where a log must identify a token, it prints an 8-character SHA-256 fingerprint — never the value.
- OAuth URLs printed to the terminal redact `state`, `code`, and PKCE parameters. The exception is `--manual` mode, which must print the full URL for you to copy.
- The device-code flow's PKCE verifier is never persisted — it goes straight to the token exchange.
- Usage-ledger rows carry hashed identifiers only: no prompts, no auth headers, no raw account ids.

Optional debug logging:

| Variable | Effect |
| --- | --- |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | Log request metadata |
| `CODEX_PLUGIN_LOG_BODIES=1` | Also log raw request/response bodies — these can contain sensitive text; treat the logs as secrets and rotate or delete them as needed |

---

## Data Cleanup

`codex-multi-auth uninstall --clear-accounts` wipes stored credentials as part of a full uninstall. For a manual wipe, run the recipe below — it resolves the same root the code does (`CODEX_MULTI_AUTH_DIR`, then `$CODEX_HOME/multi-auth`, then `~/.codex/multi-auth`) and deletes only the artifacts multi-auth owns, so an override pointing at a shared directory leaves unrelated files alone. Run `codex-multi-auth verify --paths` first to see the resolved root — with no overrides, an existing install under `~/DevTools/config/codex/multi-auth` (or very old installs storing files directly in `~/.codex`) is preferred over an empty `~/.codex/multi-auth`:

```bash
# If verify --paths reported a different root, set ROOT to that path instead.
ROOT="${CODEX_MULTI_AUTH_DIR:-${CODEX_HOME:-$HOME/.codex}/multi-auth}"
rm -rf "$ROOT"/openai-codex-accounts.json*          # pool + .wal/.bak.*/.pending-auth/.lock sidecars
rm -rf "$ROOT"/codex-accounts.json*                 # legacy pool filename (pre-rename installs)
rm -rf "$ROOT"/openai-codex-flagged-accounts.json*
rm -rf "$ROOT"/openai-codex-blocked-accounts.json*  # legacy flagged filename
rm -rf "$ROOT"/settings.json*
rm -rf "$ROOT"/quota-cache.json*
rm -rf "$ROOT"/runtime-observability.json*
rm -f "$ROOT/first-run-setup.json"
rm -rf "$ROOT"/config.json*
rm -rf "$ROOT"/dashboard-settings.json*
rm -rf "$ROOT"/account-policies.json*
rm -rf "$ROOT"/routing-profiles.json*
rm -rf "$ROOT"/budget-guards.json*
rm -rf "$ROOT"/local-client-tokens.json*
rm -rf "$ROOT"/api-routes.json*
rm -rf "$ROOT"/reset-credits.json*
rm -rf "$ROOT"/api-capability-probes.json*
rm -rf "$ROOT"/api-probe-locks*
rm -rf "$ROOT"/automatic-api-checks.json*
rm -rf "$ROOT"/model-discovery.json*
rm -rf "$ROOT/refresh-leases"
rm -rf "$ROOT/usage"
rm -rf "$ROOT/backups"
rm -rf "$ROOT/projects"
rm -f "$ROOT"/runtime-rotation-app-helper*.json
rm -rf "$ROOT/app-bind"
rm -rf "$ROOT/inference-activity"
rm -rf "$ROOT/logs"                               # audit.log rotations + codex-plugin request logs
rm -rf "$ROOT/cache"
rm -rf "$ROOT/tmp"
rm -f "$ROOT/.gitignore"
# Standalone config override (only if set):
[ -n "${CODEX_MULTI_AUTH_CONFIG_PATH:-}" ] && rm -f "$CODEX_MULTI_AUTH_CONFIG_PATH"
```

```powershell
# If verify --paths reported a different root, set $root to that path instead.
$root = $env:CODEX_MULTI_AUTH_DIR
if (-not $root) { $root = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME "multi-auth" } else { "$HOME\.codex\multi-auth" } }
Remove-Item "$root\openai-codex-accounts.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\codex-accounts.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\openai-codex-flagged-accounts.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\openai-codex-blocked-accounts.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\settings.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\quota-cache.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\runtime-observability.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\first-run-setup.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$root\config.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\dashboard-settings.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\account-policies.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\routing-profiles.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\budget-guards.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\local-client-tokens.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\api-routes.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\reset-credits.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\api-capability-probes.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\api-probe-locks*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\automatic-api-checks.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\model-discovery.json*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\refresh-leases" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\usage" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\backups" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\projects" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\runtime-rotation-app-helper*.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$root\app-bind" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\inference-activity" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\logs" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\cache" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\tmp" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$root\.gitignore" -Force -ErrorAction SilentlyContinue
# Standalone config override (only if set):
if ($env:CODEX_MULTI_AUTH_CONFIG_PATH) { Remove-Item "$env:CODEX_MULTI_AUTH_CONFIG_PATH" -Force -ErrorAction SilentlyContinue }
```

For a lighter reset that keeps the ledger, budgets, policies, and backups, see [troubleshooting.md](troubleshooting.md#soft-reset-pool--settings-only).

---

## Policy Responsibility

Your use of OpenAI services is governed by OpenAI's policies:

- https://openai.com/policies/terms-of-use/
- https://openai.com/policies/privacy-policy/

---

## Related

- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [../SECURITY.md](../SECURITY.md)
