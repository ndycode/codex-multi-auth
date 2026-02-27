# Configuration

Configure behavior from one settings root with stable env overrides and optional advanced toggles.

---

## Config Files

| Layer | Path | Purpose |
| --- | --- | --- |
| Unified settings | `~/.codex/multi-auth/settings.json` | Dashboard display + backend `pluginConfig` |
| Optional override file | `CODEX_MULTI_AUTH_CONFIG_PATH=<path>` | External config file override |

If `CODEX_MULTI_AUTH_DIR` is set, replace `~/.codex/multi-auth` with that custom root.

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

## Recommended Defaults

Keep these enabled for most users:

- `menuAutoFetchLimits`
- `menuSortEnabled`
- `liveAccountSync`
- `sessionAffinity`
- `proactiveRefreshGuardian`
- `preemptiveQuotaEnabled`

---

## Stable Environment Overrides

These overrides are stable and intended for day-to-day use:

| Variable | Effect |
| --- | --- |
| `CODEX_MULTI_AUTH_DIR` | Override settings/accounts/cache/log root |
| `CODEX_MULTI_AUTH_CONFIG_PATH` | Read plugin config from alternate file |
| `CODEX_HOME` | Change Codex home used for default path resolution |
| `CODEX_MODE=0/1` | Disable/enable Codex mode |
| `CODEX_TUI_V2=0/1` | Disable/enable TUI v2 |
| `CODEX_TUI_COLOR_PROFILE=truecolor\|ansi256\|ansi16` | TUI color profile |
| `CODEX_TUI_GLYPHS=ascii\|unicode\|auto` | TUI glyph style |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=<ms>` | Override request timeout |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=<ms>` | Override stream stall timeout |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI=0/1` | Disable/enable Codex CLI state sync |
| `CODEX_CLI_ACCOUNTS_PATH=<path>` | Override Codex CLI accounts file path |
| `CODEX_CLI_AUTH_PATH=<path>` | Override Codex CLI auth file path |
| `CODEX_MULTI_AUTH_REAL_CODEX_BIN=<path>` | Force official Codex binary used by wrapper |
| `CODEX_MULTI_AUTH_BYPASS=1` | Bypass local auth handling and forward all commands |

---

## Advanced/Internal Overrides

Advanced runtime controls (failover policy, refresh lease internals, testing toggles) are documented in:

- [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md)

Treat those settings as maintainers-only unless explicitly advised.

---

## Validate Configuration

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
