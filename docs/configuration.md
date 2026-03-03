# Configuration

Runtime configuration is resolved from unified settings, optional override files, and environment variables.

---

## Canonical Files

| Layer | Path | Purpose |
| --- | --- | --- |
| Unified settings | `~/.codex/multi-auth/settings.json` | Dashboard display and backend `pluginConfig` |
| Optional config override | `CODEX_MULTI_AUTH_CONFIG_PATH=<path>` | External config file source |
| Root override | `CODEX_MULTI_AUTH_DIR=<path>` | Re-home settings/accounts/cache/log directories |

---

## Settings Shape

```json
{
  "version": 1,
  "dashboardDisplaySettings": {
    "menuAutoFetchLimits": true,
    "menuSortEnabled": true,
    "menuSortMode": "ready-first",
    "menuShowQuotaSummary": true,
    "menuShowQuotaCooldown": true,
    "menuLayoutMode": "compact-details"
  },
  "pluginConfig": {
    "codexMode": true,
    "liveAccountSync": true,
    "sessionAffinity": true,
    "proactiveRefreshGuardian": true,
    "preemptiveQuotaEnabled": true,
    "fetchTimeoutMs": 60000,
    "streamStallTimeoutMs": 45000
  }
}
```

---

## Resolution Precedence

Plugin runtime config source selection is resolved in this order:

1. Unified settings `pluginConfig` from `settings.json` (when present and valid).
2. Fallback file config from `CODEX_MULTI_AUTH_CONFIG_PATH` (or legacy compatibility path) when unified settings are absent/invalid.
3. Hardcoded defaults.

After a config source is selected, environment variables override individual runtime settings.
Dashboard display values are resolved from persisted `dashboardDisplaySettings` and then normalized defaults.

---

## Stable Environment Overrides

These are safe for most operators and frequently used in day-to-day workflows.

| Variable | Effect |
| --- | --- |
| `CODEX_MULTI_AUTH_DIR` | Override root directory for plugin-managed runtime files |
| `CODEX_MULTI_AUTH_CONFIG_PATH` | Load configuration from alternate path |
| `CODEX_MODE=0/1` | Disable or enable Codex mode |
| `CODEX_TUI_V2=0/1` | Disable or enable TUI v2 |
| `CODEX_TUI_COLOR_PROFILE=truecolor|ansi256|ansi16` | Color profile selection |
| `CODEX_TUI_GLYPHS=ascii|unicode|auto` | Glyph mode selection |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=<ms>` | HTTP request timeout override |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=<ms>` | Stream stall timeout override |
| `CODEX_AUTH_ENCRYPTION_KEY=<32-byte-random-key>` | Enable at-rest encryption for stored account secrets (high-entropy key material only) |
| `CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY=<32-byte-random-key>` | Previous high-entropy key used during staged secret rotation |
| `CODEX_AUTH_ROLE=admin|operator|viewer` | CLI authorization role baseline |

For `CODEX_AUTH_ENCRYPTION_KEY` and `CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY`, use 32-byte
random key material from a secret manager. Do not use user-memorable passwords.

---

## Advanced and Internal Overrides

Use these only when debugging, controlled benchmarking, or maintainer workflows.

- `CODEX_MULTI_AUTH_SYNC_CODEX_CLI`
- `CODEX_MULTI_AUTH_REAL_CODEX_BIN`
- `CODEX_MULTI_AUTH_BYPASS`
- `CODEX_CLI_ACCOUNTS_PATH`
- `CODEX_CLI_AUTH_PATH`
- refresh lease tuning variables (`CODEX_AUTH_REFRESH_LEASE*`)
- `CODEX_AUTH_BREAK_GLASS`
- `CODEX_AUTH_ABAC_READ_ONLY`
- `CODEX_AUTH_ABAC_DENY_ACTIONS`
- `CODEX_AUTH_ABAC_DENY_COMMANDS`
- `CODEX_AUTH_ABAC_REQUIRE_INTERACTIVE`
- `CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY`
- `CODEX_AUTH_REDACT_JSON_OUTPUT`
- retention tuning variables (`CODEX_AUTH_RETENTION_*`)

Full inventory: [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md)

---

## Recommended Defaults

Keep these enabled for most environments:

- `menuAutoFetchLimits`
- `menuSortEnabled`
- `liveAccountSync`
- `sessionAffinity`
- `proactiveRefreshGuardian`
- `preemptiveQuotaEnabled`

---

## Validate Effective Configuration

```bash
codex auth status
codex auth list
codex auth check
codex auth forecast --live
```

---

## Related

- [reference/settings.md](reference/settings.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [upgrade.md](upgrade.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)
