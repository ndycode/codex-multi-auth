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
| `CODEX_TUI_V2=0/1` | Disable or enable TUI v2 |
| `CODEX_TUI_COLOR_PROFILE=truecolor|ansi256|ansi16` | Color profile selection |
| `CODEX_TUI_GLYPHS=ascii|unicode|auto` | Glyph mode selection |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=<ms>` | HTTP request timeout override |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=<ms>` | Stream stall timeout override |
| `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS=<ms>` | Minimum time between global account switches (default `60000`). The proxy biases selection toward the last-served account within this window to reduce the rate at which different OAuth tokens appear from the same IP. Set to `0` to disable. |
| `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS=<ms>` | Cooldown applied to an account when the upstream or token-refresh endpoint explicitly revokes its OAuth token (default `300000`, 5 minutes). Raise this if accounts continue to be re-invalidated after re-login. |

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

`codexRuntimeRotationProxy` is enabled by default. When enabled through defaults, settings, `codex-multi-auth rotation enable`, or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=1`, the `codex-multi-auth-codex` wrapper starts a localhost-only Responses proxy for forwarded official Codex sessions, including CLI request commands, `codex app-server`, and `codex app` launches through the wrapper. The wrapper writes a temporary shadow `CODEX_HOME/config.toml` that selects a custom provider named `codex-multi-auth-runtime-proxy`, launches the official Codex surface against that provider, and removes the shadow home after the owning process exits. Set `codexRuntimeRotationProxy=false`, run `codex-multi-auth rotation disable`, or set `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` to bypass the proxy.

The proxy preserves request bodies and streaming responses, replaces outbound auth headers with the selected managed account, and rotates to another account before response bytes are streamed when it sees rate limits, server errors, network failures, or refresh failures. It removes hop-by-hop headers, private account metadata headers, and stale decoded `content-encoding` from client responses. If every account is unavailable, the proxy returns a structured pool-exhaustion error that points to `codex-multi-auth rotation status`.

**Anti-abuse protection.** Rapidly switching OAuth tokens from the same IP can trigger OpenAI's anti-abuse detection and cause accounts to be invalidated in sequence. The proxy includes two mitigations:

- **Token-invalidation detection**: when the upstream or the token-refresh endpoint returns an explicit OAuth revocation message, the proxy returns the error directly to the client instead of rotating to the next account. The affected account receives a 5-minute cooldown (`tokenInvalidationCooldownMs`, default `300000`) instead of the generic 30-second auth-failure cooldown. Configure via `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS`.
- **Rotation-rate throttle**: the proxy biases account selection toward the last-served account for a configurable window (default 60 seconds, `minRotationIntervalMs`). Accounts that are rate-limited or cooling down are still rotated around. Configure via `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS` or set to `0` to disable.

Microsoft/Outlook SSO accounts may be more sensitive to proxy-mediated token use. If an Outlook-linked account is invalidated on every first request through the proxy but works normally on ChatGPT web, the root cause is likely IP or device binding on the Microsoft side. Raising `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS` and re-logging in the affected account typically resolves the cascade. If the problem persists, consider excluding the Microsoft account from the rotation pool via `codex-multi-auth switch`.

For `codex app` launches that go through the wrapper, the wrapper automatically starts a small internal helper so rotation can keep working if the desktop app launcher detaches. The helper stores only local runtime status, uses the same per-session proxy client key as the CLI path, and exits after an idle timeout.

`codex-multi-auth rotation enable` also binds the packaged desktop app to a persistent localhost router. This backs up the real Codex `config.toml`, writes the `codex-multi-auth-runtime-proxy` provider into the real Codex home, starts the router immediately, and installs a user login startup entry: a Startup `.cmd` on Windows or a LaunchAgent on macOS. The persistent provider is marked as not requiring OpenAI auth and uses a local app-bind client token, so the desktop runtime does not display the selected multi-auth account while codex-multi-auth status and quota views still read the router's last-account telemetry. `codex-multi-auth rotation disable` and `codex-multi-auth rotation unbind-app` stop that router, remove the startup entry, and restore the backed-up Codex config. The official app files are not patched.

Package install/update self-heals these defaults when runtime rotation is enabled:

- Packaged Codex app bind is repaired when a Codex desktop app is detected. Set `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` to skip install/update self-heal, or `CODEX_MULTI_AUTH_APP_BIND_INSTALL=1` to force it.
- Supported user-level launcher routing is installed for global installs. Set `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` to skip shortcut routing, or run `codex-multi-auth-app-launcher --remove` to restore backed-up Windows shortcuts or remove the managed macOS wrapper later.
- Installed wrappers may perform a best-effort daily npm version check during normal forwarded Codex startup. When npm has a newer release, the wrapper only prints a manual notice: `npm install -g codex-multi-auth@latest`. It never runs npm install or update commands for you. Notices are shown only on a TTY or when `CODEX_MULTI_AUTH_DEBUG=1`.

Some Windows installs expose Codex only as a packaged `shell:AppsFolder` app entry. Those entries cannot be retargeted like `.lnk` files, so the persistent app bind is the supported path for making the pinned packaged app use rotation automatically.

---

## Shipped Templates

The shipped config templates expose first-class current OpenAI model aliases:

- `config/codex-modern.json` includes `gpt-5.5` and `gpt-5.5-pro`
- `config/codex-modern.json` and `config/codex-legacy.json` expose current documented GPT-5.5, GPT-5.4, and GPT-5.3 Codex model IDs
- deprecated Codex selectors such as `gpt-5-codex` and `gpt-5.1-codex*` are treated as compatibility aliases and retried on the current documented Codex model when the ChatGPT Codex surface rejects them
- the wrapper and optional plugin-host runtime try those models directly and only fall back to `gpt-5.4` after a real ChatGPT Codex unsupported-model response

---

## Validate Effective Configuration

```bash
codex-multi-auth status
codex-multi-auth list
codex-multi-auth check
codex-multi-auth forecast --live
```

---

## Related

- [reference/settings.md](reference/settings.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [upgrade.md](upgrade.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)
