# Configuration

Configure behavior from one settings root and optional environment overrides.

* * *

## Config Files

| Layer | Path | Purpose |
| --- | --- | --- |
| Unified settings | `~/.codex/multi-auth/settings.json` | Dashboard display + backend `pluginConfig` |
| Optional config override file | `CODEX_MULTI_AUTH_CONFIG_PATH=<path>` | External config input compatibility |

If `CODEX_MULTI_AUTH_DIR` is set, replace `~/.codex/multi-auth` with that custom root.

* * *

## Unified Settings Structure

`settings.json` stores two top-level blocks:

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

* * *

## Recommended Presets

### Stable Default

```json
{
  "pluginConfig": {
    "liveAccountSync": true,
    "sessionAffinity": true,
    "proactiveRefreshGuardian": true,
    "preemptiveQuotaEnabled": true,
    "preemptiveQuotaRemainingPercent5h": 5,
    "preemptiveQuotaRemainingPercent7d": 5,
    "preemptiveQuotaMaxDeferralMs": 7200000,
    "fetchTimeoutMs": 60000,
    "streamStallTimeoutMs": 45000,
    "networkErrorCooldownMs": 6000,
    "serverErrorCooldownMs": 4000
  }
}
```

### More Conservative

```json
{
  "pluginConfig": {
    "preemptiveQuotaRemainingPercent5h": 10,
    "preemptiveQuotaRemainingPercent7d": 10,
    "fetchTimeoutMs": 90000,
    "streamStallTimeoutMs": 60000,
    "networkErrorCooldownMs": 8000,
    "serverErrorCooldownMs": 6000
  }
}
```

### More Aggressive

```json
{
  "pluginConfig": {
    "sessionAffinity": false,
    "preemptiveQuotaRemainingPercent5h": 3,
    "preemptiveQuotaRemainingPercent7d": 3,
    "preemptiveQuotaMaxDeferralMs": 1800000,
    "fetchTimeoutMs": 45000,
    "streamStallTimeoutMs": 25000,
    "networkErrorCooldownMs": 3000,
    "serverErrorCooldownMs": 2000
  }
}
```

* * *

## High-Impact Keys

| Key | Default | Why it matters |
| --- | --- | --- |
| `menuAutoFetchLimits` | `true` | Refreshes quota limits in menu automatically |
| `menuSortEnabled` | `true` | Enables readiness-based account ordering |
| `menuSortMode` | `ready-first` | Puts more available accounts higher |
| `liveAccountSync` | `true` | Picks up account file updates without restart |
| `sessionAffinity` | `true` | Keeps same conversation on same account when healthy |
| `proactiveRefreshGuardian` | `true` | Refreshes expiring tokens in background |
| `preemptiveQuotaEnabled` | `true` | Defers before quota hard exhaustion |
| `parallelProbing` | `false` | Enables parallel health probes |
| `fetchTimeoutMs` | `60000` | Total request timeout |
| `streamStallTimeoutMs` | `45000` | Stream inactivity failover trigger |

* * *

## Environment Variable Overrides

| Variable | Effect |
| --- | --- |
| `CODEX_MULTI_AUTH_DIR` | Override settings/accounts root directory |
| `CODEX_MULTI_AUTH_CONFIG_PATH` | Read config from alternate file |
| `CODEX_MODE=0/1` | Disable/enable Codex mode |
| `CODEX_TUI_V2=0/1` | Disable/enable TUI v2 |
| `CODEX_TUI_COLOR_PROFILE=truecolor\|ansi256\|ansi16` | TUI color profile |
| `CODEX_TUI_GLYPHS=ascii\|unicode\|auto` | TUI glyph style |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=<ms>` | Override request timeout |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=<ms>` | Override stream stall timeout |
| `DEBUG_CODEX_PLUGIN=1` | Enable debug logging |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | Enable request metadata logs |
| `CODEX_PLUGIN_LOG_BODIES=1` | Log raw payload bodies (sensitive) |

* * *

## Validate Current Configuration

```bash
codex auth status
codex auth list
codex auth report --json
```

* * *

## Related

- [reference/settings.md](reference/settings.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)
