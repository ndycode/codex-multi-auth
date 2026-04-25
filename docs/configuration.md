# Configuration

Runtime configuration is resolved from unified settings, optional override files, and environment variables.

---

## Canonical Files

| Layer | Path | Purpose |
| --- | --- | --- |
| Unified settings | `~/.codex/multi-auth/settings.json` | Dashboard display and runtime `pluginConfig` |
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
    "codexRuntimeRotationProxy": true,
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

Runtime config source selection is resolved in this order. The persisted object is still named `pluginConfig` for compatibility with earlier releases.

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
| `CODEX_MULTI_AUTH_DIR` | Override root directory for multi-auth-managed runtime files |
| `CODEX_MULTI_AUTH_CONFIG_PATH` | Load configuration from alternate path |
| `CODEX_MODE=0/1` | Disable or enable Codex mode |
| `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0/1` | Opt out/in of live Codex Responses routing through the localhost account-rotation proxy |
| `CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS=<ms>` | Override idle shutdown for the wrapper-launched Codex app helper |
| `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0/1` | Opt out/in of packaged Codex app bind self-heal during install/update or rotation enable |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0/1` | Opt out/in of supported user-level launcher routing during install/update or rotation enable |
| `CODEX_MULTI_AUTH_AUTO_UPDATE=0/1` | Opt out/in of best-effort global package auto-update checks; enabled by default outside CI/test environments |
| `CODEX_MULTI_AUTH_AUTO_UPDATE_STARTUP_BUDGET_MS=<ms>` | Override the wrapper startup budget for auto-update checks before the forwarded Codex command continues |
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

`codexRuntimeRotationProxy` is enabled by default. When enabled through defaults, settings, `codex auth rotation enable`, or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=1`, the `codex` wrapper starts a localhost-only Responses proxy for forwarded official Codex sessions, including CLI request commands, `codex app-server`, and `codex app` launches through the wrapper. The wrapper writes a temporary shadow `CODEX_HOME/config.toml` that selects a custom provider named `codex-multi-auth-runtime-proxy`, launches the official Codex surface against that provider, and removes the shadow home after the owning process exits. Set `codexRuntimeRotationProxy=false`, run `codex auth rotation disable`, or set `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` to bypass the proxy.

The proxy preserves request bodies and streaming responses, replaces outbound auth headers with the selected managed account, and rotates to another account before response bytes are streamed when it sees rate limits, server errors, network failures, or refresh failures. It removes hop-by-hop headers, private account metadata headers, and stale decoded `content-encoding` from client responses. If every account is unavailable, the proxy returns a structured pool-exhaustion error that points to `codex auth rotation status`.

For `codex app` launches that go through the wrapper, the wrapper automatically starts a small internal helper so rotation can keep working if the desktop app launcher detaches. The helper stores only local runtime status, uses the same per-session proxy client key as the CLI path, and exits after an idle timeout.

`codex auth rotation enable` also binds the packaged desktop app to a persistent localhost router. This backs up the real Codex `config.toml`, writes the `codex-multi-auth-runtime-proxy` provider into the real Codex home, starts the router immediately, and installs a user login startup entry: a Startup `.cmd` on Windows or a LaunchAgent on macOS. The persistent provider is marked as not requiring OpenAI auth and uses a local app-bind client token, so the desktop runtime does not display the selected multi-auth account while codex-multi-auth status and quota views still read the router's last-account telemetry. `codex auth rotation disable` and `codex auth rotation unbind-app` stop that router, remove the startup entry, and restore the backed-up Codex config. The official app files are not patched.

Package install/update self-heals these defaults when runtime rotation is enabled:

- Packaged Codex app bind is repaired when a Codex desktop app is detected. Set `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` to skip install/update self-heal, or `CODEX_MULTI_AUTH_APP_BIND_INSTALL=1` to force it.
- Supported user-level launcher routing is installed for global installs. Set `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` to skip shortcut routing, or run `codex-multi-auth-app-launcher --remove` to restore backed-up Windows shortcuts or remove the managed macOS wrapper later.
- Installed packages outside CI/test environments run a best-effort daily auto-update check and run `npm update -g codex-multi-auth` when npm has a newer release. Set `CODEX_MULTI_AUTH_AUTO_UPDATE=0` to skip that behavior, or `CODEX_MULTI_AUTH_AUTO_UPDATE=1` to force it in controlled automation. The wrapper starts the check with a small startup budget and then continues launching Codex; progress banners are shown only on a TTY or when `CODEX_MULTI_AUTH_DEBUG=1`.

Some Windows installs expose Codex only as a packaged `shell:AppsFolder` app entry. Those entries cannot be retargeted like `.lnk` files, so the persistent app bind is the supported path for making the pinned packaged app use rotation automatically.

---

## Shipped Templates

The shipped config templates expose first-class GPT-5.5 model aliases:

- `config/codex-modern.json` includes `gpt-5.5` and `gpt-5.5-pro`
- `config/codex-legacy.json` includes `gpt-5.5-*` and `gpt-5.5-pro-*` entries
- the wrapper and optional plugin-host runtime try those models directly and only fall back to `gpt-5.4` after a real ChatGPT Codex unsupported-model response

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
