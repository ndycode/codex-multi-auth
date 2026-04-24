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
    "codexRuntimeRotationProxy": false,
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
| `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0/1` | Opt in to live Codex Responses routing through the localhost account-rotation proxy |
| `CODEX_TUI_V2=0/1` | Disable or enable TUI v2 |
| `CODEX_TUI_COLOR_PROFILE=truecolor|ansi256|ansi16` | Color profile selection |
| `CODEX_TUI_GLYPHS=ascii|unicode|auto` | Glyph mode selection |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=<ms>` | HTTP request timeout override |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=<ms>` | Stream stall timeout override |

---

## Advanced and Internal Overrides

Use these only when debugging, controlled benchmarking, or maintainer workflows.

- `CODEX_MULTI_AUTH_SYNC_CODEX_CLI`
- `CODEX_MULTI_AUTH_REAL_CODEX_BIN`
- `CODEX_MULTI_AUTH_BYPASS`
- `CODEX_CLI_ACCOUNTS_PATH`
- `CODEX_CLI_AUTH_PATH`
- refresh lease tuning variables (`CODEX_AUTH_REFRESH_LEASE*`)

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

## Runtime Rotation Proxy

`codexRuntimeRotationProxy` is disabled by default. When enabled through settings, `codex auth rotation enable`, or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=1`, the `codex` wrapper starts a localhost-only Responses proxy for forwarded official Codex sessions, including CLI request commands, `codex app-server`, and `codex app` launches through the wrapper. The wrapper writes a temporary shadow `CODEX_HOME/config.toml` that selects a custom provider named `codex-multi-auth-runtime-proxy`, launches the official Codex surface against that provider, and removes the shadow home after the owning process exits.

The proxy preserves request bodies and streaming responses, replaces outbound auth headers with the selected managed account, and rotates to another account before response bytes are streamed when it sees rate limits, server errors, network failures, or refresh failures. If every account is unavailable, the proxy returns a structured pool-exhaustion error that points to `codex auth rotation status`.

For `codex app`, the wrapper automatically starts a small internal helper so rotation can keep working if the desktop app launcher detaches. The helper stores only local runtime status, uses the same per-session proxy client key as the CLI path, and exits after an idle timeout.

---

## Shipped Templates

The shipped config templates expose first-class GPT-5.5 model aliases:

- `config/codex-modern.json` includes `gpt-5.5` and `gpt-5.5-pro`
- `config/codex-legacy.json` includes `gpt-5.5-*` and `gpt-5.5-pro-*` entries
- the wrapper and plugin now try those models directly and only fall back to `gpt-5.4` after a real ChatGPT Codex unsupported-model response

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
