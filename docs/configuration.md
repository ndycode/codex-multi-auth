# Configuration

Runtime configuration is resolved from one canonical settings file, an optional env-pointed override file, legacy compatibility files, and per-setting environment overrides. This guide covers what a user needs day to day; the complete field-by-field inventory (including every internal env name) lives in [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md), and the maintainer-level resolution walkthrough lives in [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md).

---

## Resolution order

`pluginConfig` (the persisted name for runtime settings) resolves in this order:

```text
CODEX_MULTI_AUTH_CONFIG_PATH set AND the file exists?
  │  yes → load that file as the config source (also the save target)
  │  no
  ▼
<multi-auth root>/settings.json → pluginConfig section valid?
  │  yes → load it
  │  no / absent
  ▼
legacy config ladder (config.json, codex-multi-auth-config.json,
openai-codex-auth-config.json under the Codex home roots)
  │  none found
  ▼
DEFAULT_PLUGIN_CONFIG (hardcoded defaults)
```

After a source is selected, each field is schema-validated, merged over `DEFAULT_PLUGIN_CONFIG`, and then **environment variables apply per-setting overrides** — env wins over the file, the file wins over the default. Numeric values are clamped to their documented bounds.

Two behaviors worth knowing:

- A `CODEX_MULTI_AUTH_CONFIG_PATH` that is set but does not exist yet is skipped on load; the next config save still creates/writes that path while the variable remains set.
- `CODEX_MULTI_AUTH_DIR` re-homes every multi-auth-owned file. When `CODEX_HOME` points at a non-default directory, the multi-auth root resolves strictly to `$CODEX_HOME/multi-auth` — no other roots are scanned for an existing account pool.

Dashboard display settings (`dashboardDisplaySettings` in the same `settings.json`) are resolved separately: persisted values first, then normalized defaults.

---

## Where the files live

| Layer | Path | Purpose |
| --- | --- | --- |
| Multi-auth root | `~/.codex/multi-auth/` (override with `CODEX_MULTI_AUTH_DIR`) | Accounts, settings, cache, logs, governance state |
| Unified settings | `<multi-auth root>/settings.json` | `pluginConfig` + `dashboardDisplaySettings`; a `.bak` sibling is kept for recovery |
| Optional config file | `CODEX_MULTI_AUTH_CONFIG_PATH=<path>` | Standalone config source and save target |
| Global account pool | `<multi-auth root>/openai-codex-accounts.json` | Managed OAuth accounts |
| Per-project pools | `<multi-auth root>/projects/<project-key>/` | Project-scoped accounts when `perProjectAccounts` is on and CLI sync is off |
| Official Codex state | `~/.codex/auth.json`, `~/.codex/accounts.json`, `~/.codex/config.toml` | Synced by `CODEX_MULTI_AUTH_SYNC_CODEX_CLI`; paths overridable via `CODEX_CLI_*_PATH` |

Full path reference: [reference/storage-paths.md](reference/storage-paths.md).

## Settings shape

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

Boolean env overrides accept `1`/`0`, `true`/`false`, `yes`/`no` (case-insensitive). Unparseable env values are ignored with a one-time warning rather than disabling the setting.

---

## Stable environment overrides

These are safe for most operators and cover the common day-to-day adjustments.

| Variable | Effect |
| --- | --- |
| `CODEX_MULTI_AUTH_DIR` | Re-home the multi-auth root (settings/accounts/cache/logs) |
| `CODEX_MULTI_AUTH_CONFIG_PATH` | Load config from an alternate file; becomes the save target while set |
| `CODEX_MODE=0/1` | Toggle Codex mode |
| `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0/1` | Opt out/in of routing forwarded Codex traffic through the localhost account-rotation proxy |
| `CODEX_MULTI_AUTH_FORCE_ACCOUNT=<index\|email\|id>` | Force one account for a single forwarded `codex-multi-auth-codex` run (equivalent to `--account`, which wins when both are set). Ephemeral and fail-hard; requires the runtime rotation proxy. See [Force an account for one invocation](reference/commands.md#force-an-account-for-one-invocation) |
| `CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS=<ms>` | Idle shutdown for the wrapper-launched Codex app helper (default 12h) |
| `CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS=<ms>` | Absolute ceiling on a helper's life regardless of activity (default 24h; `0` disables) |
| `CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS=<ms>` | Idle window once a helper's launcher is gone, nothing is connected, and the helper has never served a request (default 15m; `0` restores the full idle timeout) |
| `CODEX_MULTI_AUTH_APP_BIND=0/1` | Opt out/in of the first-run packaged Codex app bind (checked before `CODEX_MULTI_AUTH_APP_BIND_INSTALL`) |
| `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0/1` | Opt out/in of packaged Codex app bind self-heal on first durable CLI run or `rotation enable` |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0/1` | Opt out/in of user-level launcher routing on first durable CLI run or `rotation enable` |
| `CODEX_TUI_V2=0/1` | Toggle TUI v2 |
| `CODEX_TUI_COLOR_PROFILE=truecolor\|ansi256\|ansi16` | TUI color profile |
| `CODEX_TUI_COLOR_MODE=auto\|dark\|light` | TUI background mode; `auto` detects light backgrounds from `COLORFGBG` |
| `CODEX_TUI_GLYPHS=ascii\|unicode\|auto` | TUI glyph mode (`auto` detects from `WT_SESSION`/`TERM_PROGRAM`/`TERM`) |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=<ms>` | HTTP request timeout (default `60000`, min `1000`) |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=<ms>` | Stream stall timeout (default `45000`, min `1000`) |
| `CODEX_AUTH_SCHEDULING_STRATEGY=hybrid\|sequential` | Account scheduling strategy (default `hybrid`); see [Sequential / drain-first scheduling](#sequential--drain-first-scheduling) |
| `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS=<ms>` | Minimum time between global account switches (default `60000`; `0` disables the last-served bias) |
| `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS=<ms>` | Cooldown after an explicit upstream token revocation (default `300000`) |
| `CODEX_AUTH_PID_OFFSET_ENABLED=0/1` | Per-process account-selection bias for parallel agents (default on) |
| `CODEX_AUTH_ROUTING_MUTEX=legacy\|enabled` | Serialize account selection within a single process (default `legacy`) |
| `CODEX_AUTH_BACKGROUND_RESPONSES=0/1` | Stateful `background: true` Responses compatibility (default off) |
| `CODEX_AUTH_NO_BROWSER=1` | Suppress browser launch for headless login |

---

## Advanced and internal overrides

Use these only for debugging, controlled benchmarking, sandboxed tests, or maintainer workflows. The complete `pluginConfig` ↔ env matrix plus every wrapper/proxy/internal env name is in [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md).

| Variable | Effect |
| --- | --- |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI` | Force/disable active-account sync into official Codex CLI files (default on; legacy `CODEX_AUTH_SYNC_CODEX_CLI` still read with a warning) |
| `CODEX_MULTI_AUTH_REAL_CODEX_BIN` | Override official Codex binary discovery (absolute path required) |
| `CODEX_MULTI_AUTH_BYPASS=1` | Skip multi-auth intercept; forward everything to official Codex |
| `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` | Internal 0-based pin published by the wrapper after `--account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT` resolution — not meant to be set by hand |
| `CODEX_MULTI_AUTH_STATUSLINE=0/1` | Disable/enable the forwarded-session status line |
| `CODEX_MULTI_AUTH_AUTO_SYNC_ON_STARTUP=0` | Skip best-effort active-account sync around forwarded launches |
| `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0` | Skip the wrapper-injected `-c cli_auth_credentials_store="file"` and the startup `config.toml` reconcile |
| `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0` | Opt out of every persisted `cli_auth_credentials_store = "file"` rewrite in `~/.codex/config.toml` |
| `CODEX_MULTI_AUTH_DEBUG=1` | Verbose wrapper/debug notices |
| `CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL` | Pin the proxy upstream to an explicit-port `http://127.0.0.1:<port>` URL (numeric loopback only; fails closed when set but the command does not route) |
| `CODEX_CLI_AUTH_PATH` / `CODEX_CLI_ACCOUNTS_PATH` / `CODEX_CLI_CONFIG_PATH` | Override official Codex `auth.json` / `accounts.json` / `config.toml` paths (sandboxes and tests) |
| `CODEX_AUTH_*` per-field names | Every `pluginConfig` field has an env accessor — see the [full matrix](development/CONFIG_FIELDS.md#pluginconfig-fields) |
| `CODEX_AUTH_REFRESH_LEASE*` | Cross-process refresh coordination knobs |
| `MCODEX_MONITOR_INTERVAL` / `MCODEX_TMUX_SESSION` / `MCODEX_TMUX_HISTORY_LIMIT` | `mcodex` convenience launcher knobs |
| `CODEX_MULTI_AUTH_TEST_*` | Test-only fault injectors — never set in normal use |

---

## Debugging the effective config

```bash
codex-multi-auth config explain          # every field: value, default, source (env|unified|file|default)
codex-multi-auth config explain --json   # machine-readable form
codex-multi-auth config template         # print a starter config (modern|legacy|minimal)
codex-multi-auth status                  # pool + quota + runtime markers
codex-multi-auth rotation status         # runtime proxy state
```

`config explain` mirrors the real load precedence, so the file and source it reports are exactly what the wrapper resolves — including the `CODEX_MULTI_AUTH_CONFIG_PATH` env-path override. Use it before and after setting an env override to confirm the override landed.

---

## Runtime rotation proxy

`codexRuntimeRotationProxy` is enabled by default. When enabled through defaults, settings, `codex-multi-auth rotation enable`, or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=1`, the `codex-multi-auth-codex` wrapper starts a localhost-only Responses proxy for forwarded official Codex sessions, including CLI request commands, `codex app-server`, and `codex app` launches through the wrapper. For non-interactive request commands and `codex app`, the wrapper writes a temporary shadow `CODEX_HOME/config.toml` that selects a custom provider named `codex-multi-auth-runtime-proxy`, launches the official Codex surface against that provider, and removes the shadow home after the owning process exits. Interactive TUI sessions (with or without the optional initial prompt), `resume`/`fork`, and `codex app-server` instead stay on the canonical `CODEX_HOME` and receive the same provider through `-c` overrides, which avoids reindexing session history on every launch and leaves the real `config.toml` untouched. Set `codexRuntimeRotationProxy=false`, run `codex-multi-auth rotation disable`, or set `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` to bypass the proxy.

A single forwarded run can be pinned to one account with `codex-multi-auth-codex --account <selector>` (or `CODEX_MULTI_AUTH_FORCE_ACCOUNT`). The pin is applied per-invocation by that run's own proxy instance, so it never touches the persisted `switch` pin and cannot leak across concurrent sessions. Because the proxy is required for the pin to take effect, `--account` fails hard when the proxy is disabled rather than silently using a rotated account. See [Force an account for one invocation](reference/commands.md#force-an-account-for-one-invocation).

The proxy preserves request bodies and streaming responses, replaces outbound auth headers with the selected managed account, and rotates to another account before response bytes are streamed when it sees rate limits, server errors, network failures, or refresh failures. It removes hop-by-hop headers, private account metadata headers, and stale decoded `content-encoding` from client responses. If every account is unavailable, the proxy returns a structured pool-exhaustion error that points to `codex-multi-auth rotation status`.

**Anti-abuse protection.** Rapidly switching OAuth tokens from the same IP can trigger OpenAI's anti-abuse detection and cause accounts to be invalidated in sequence. The proxy includes two mitigations:

- **Token-invalidation detection**: when the upstream or the token-refresh endpoint returns an explicit OAuth revocation message, the proxy returns the error directly to the client instead of rotating to the next account. The affected account receives a 5-minute cooldown (`tokenInvalidationCooldownMs`, default `300000`) instead of the generic 30-second auth-failure cooldown. Configure via `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS`.
- **Rotation-rate throttle**: the proxy biases account selection toward the last-served account for a configurable window (default 60 seconds, `minRotationIntervalMs`). Accounts that are rate-limited or cooling down are still rotated around. Configure via `CODEX_AUTH_MIN_ROTATION_INTERVAL_MS` or set to `0` to disable.

### Sequential / drain-first scheduling

`schedulingStrategy` controls how the proxy picks an account for each request:

- `hybrid` (default) spreads load across all available accounts using a weighted health/token/freshness score. Both accounts tend to consume quota at a similar pace.
- `sequential` (drain-first) routes every new request to one active account and only advances to the next available account once the current one is fully exhausted (rate-limited, cooling down, or circuit-open). Because the scan wraps the pool, an earlier account that has recovered its quota window is reclaimed as soon as the current account drains. This staggers quota recovery across accounts for longer uninterrupted sessions.

In `sequential` mode a manual pin (`codex-multi-auth switch <index>`) still takes precedence and is never overridden. Sequential mode intentionally ignores per-session affinity: once the active account changes, all subsequent requests follow the new active account regardless of which account originally handled a conversation. Enable it with `schedulingStrategy: "sequential"` in settings or `CODEX_AUTH_SCHEDULING_STRATEGY=sequential` for a per-process trial.

### Many parallel agents / high concurrency

When you drive many agents in parallel (for example a swarm of deep agents), each is usually a separate `codex-multi-auth-codex` process with its own in-process rotation state. Concentrated load on a small pool causes cascading `429`s. The relevant knobs:

- `pidOffsetEnabled` (default `true`, env `CODEX_AUTH_PID_OFFSET_ENABLED`): gives each process a small deterministic account-selection bias so separate processes prefer different accounts instead of all selecting the same one. This is the primary lever for the multi-process swarm case and is on by default; it is a no-op for single-account pools, and a manual pin plus health/quota scoring still take precedence over the small offset. Set `false` (or `CODEX_AUTH_PID_OFFSET_ENABLED=0`) to force every process to score accounts identically.
- `retryAllAccountsRateLimited` (default `false`), with `retryAllAccountsMaxRetries` (default `0`) and `retryAllAccountsMaxWaitMs` (default `0`): when every account is momentarily rate-limited, wait for the soonest quota window and retry instead of returning pool-exhaustion immediately. Keep the retry/wait budgets bounded so a blocking wait does not exceed the host client's own request timeout.
- `routingMutex` (default `legacy`, env `CODEX_AUTH_ROUTING_MUTEX`): set to `enabled` to serialize account selection *within a single process*. It has no effect across separate agent processes.

The structural fix is more accounts: with N accounts and M ≫ N concurrent agents, roughly `M/N` agents share each account, so rate-limit pressure only drops as N grows. See [High parallelism / swarms of agents](troubleshooting.md#high-parallelism--agent-swarms) for the full playbook, including the host-client-side `Provider response headers timed out after 10000ms` timeout (which this plugin cannot change).

Microsoft/Outlook SSO accounts may be more sensitive to proxy-mediated token use. If an Outlook-linked account is invalidated on every first request through the proxy but works normally on ChatGPT web, the root cause is likely IP or device binding on the Microsoft side. Raising `CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS` and re-logging in the affected account typically resolves the cascade. If the problem persists, consider excluding the Microsoft account from the rotation pool via `codex-multi-auth switch`.

For `codex app` launches that go through the wrapper, the wrapper automatically starts a small internal helper so rotation can keep working if the desktop app launcher detaches. The helper stores only local runtime status, uses the same per-session proxy client key as the CLI path, and exits after an idle timeout.

`codex-multi-auth rotation enable` also binds the packaged desktop app to a persistent localhost router. This backs up the real Codex `config.toml`, writes the `codex-multi-auth-runtime-proxy` provider into the real Codex home, starts the router immediately, and installs a user login startup entry: a Startup `.cmd` on Windows or a LaunchAgent on macOS. The persistent provider is marked as not requiring OpenAI auth and uses a local app-bind client token, so the desktop runtime does not display the selected multi-auth account while codex-multi-auth status and quota views still read the router's last-account telemetry. `codex-multi-auth rotation disable` and `codex-multi-auth rotation unbind-app` stop that router, remove the startup entry, and restore the backed-up Codex config. The official app files are not patched.

Package install scripts stay side-effect-free (postinstall prints a short notice only). First-run self-heal of desktop defaults runs once on a durable global install when you invoke `codex-multi-auth ...`, and again as needed from `codex-multi-auth rotation enable`:

- The official CLI credential store is pinned to `cli_auth_credentials_store = "file"` in `~/.codex/config.toml`, so front-ends that exec the official binary directly stop triggering macOS login-keychain prompts. Set `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0` to skip.
- Packaged Codex app bind is repaired when a Codex desktop app is detected. Set `CODEX_MULTI_AUTH_APP_BIND=0` or `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` to skip, or `CODEX_MULTI_AUTH_APP_BIND_INSTALL=1` to force it.
- Supported user-level launcher routing is installed for global installs. Set `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` to skip shortcut routing, or run `codex-multi-auth-app-launcher --remove` to restore backed-up Windows shortcuts or remove the managed macOS wrapper later.
- The one-time claim is recorded at `~/.codex/multi-auth/first-run-setup.json`. `npx` and project-local installs skip first-run setup so they do not consume the marker. An existing marker from before the auth-store step is migrated in place, replaying only that step — app bind and launcher install are not rerun.
- Installed wrappers may perform a best-effort daily npm version check during normal forwarded Codex startup. When npm has a newer release, the wrapper only prints a manual notice: `npm install -g codex-multi-auth@latest`. It never runs npm install or update commands for you. Notices are shown only on a TTY or when `CODEX_MULTI_AUTH_DEBUG=1`.

Some Windows installs expose Codex only as a packaged `shell:AppsFolder` app entry. Those entries cannot be retargeted like `.lnk` files, so the persistent app bind is the supported path for making the pinned packaged app use rotation automatically.

---

## Recommended defaults

Keep these enabled for most environments:

- `menuAutoFetchLimits`
- `menuSortEnabled`
- `liveAccountSync`
- `sessionAffinity`
- `proactiveRefreshGuardian`
- `preemptiveQuotaEnabled`
- `pidOffsetEnabled`

---

## Shipped templates

The shipped config templates expose first-class current OpenAI model aliases:

- both templates lead with GPT-6.1 Sol (`gpt-6.1-sol`, the upstream catalog's default and priority-1 model), followed by GPT-6 Astra (`gpt-6-astra`). Bare `gpt-6.1` resolves to `gpt-6.1-sol`; bare `gpt-6` and `astra` resolve to the flagship Astra. The full current ladder — 6.1 Sol, Astra, Sol and Luna — takes `low` through `ultra` (Luna stops at `max`) and rejects `none`/`minimal`, which are coerced up to `low`
- both templates also list GPT-6 Sol (`gpt-6-sol`, the everyday workhorse) and GPT-6 Luna (`gpt-6-luna`, the small, cheap tier), added to the upstream Codex catalog on 2026-09-22. Sol takes `low` through `ultra`; Luna stops at `max`, the same split as the 5.6 tiers. There is no GPT-6 Terra: an id such as `gpt-6-terra` resolves to Sol, which is where upstream Codex migrates `gpt-5.6-terra` users. Bare `sol` and `luna` are not aliases for the GPT-6 tiers
- any GPT-6 id the alias table does not name resolves to Astra rather than falling back to the previous generation, unless it carries a `sol` or `luna` tier token, which picks that tier (`gpt-6-sol-2026-09-22` stays on Sol), or a `6.N` minor token other than `6.1` (`gpt-6.2` stays on Astra). That covers the `gpt-6-astra-pro` plan tier, dated snapshots such as `gpt-6-astra-2026-09-03`, and tiers added after this release. An id carrying `aeon` resolves to `gpt-6-astra` — the leaked `gpt-6-astra-aeon` slug was never a durable catalog model and is retired onto the flagship
- `gpt-5.5` and `gpt-5.5-pro` (including dated snapshot ids) resolve to `gpt-6-sol` and `gpt-6-astra` respectively — upstream's migration targets ahead of the 2026-10-14 OAuth retirement — rather than being sent to the backend verbatim
