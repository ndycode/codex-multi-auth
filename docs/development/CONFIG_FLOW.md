# Configuration Flow

How configuration is resolved at runtime from files, env, and defaults. This is the maintainer-facing walkthrough; the complete field/env inventory is [CONFIG_FIELDS.md](CONFIG_FIELDS.md) and the user-facing guide is [../configuration.md](../configuration.md).

* * *

## 1) Root Directory Resolution

Runtime root priority (`getCodexMultiAuthDir` in `lib/runtime-paths.ts`):

1. `CODEX_MULTI_AUTH_DIR` when set — wins unconditionally.
2. If `CODEX_HOME` is an explicit non-default path: **only** `$CODEX_HOME/multi-auth` (no cross-root scan).
3. Otherwise probe ordered candidates — `$CODEX_HOME/multi-auth`, `~/DevTools/config/codex/multi-auth`, `~/.codex/multi-auth`, and the legacy dir — preferring any that already hold account storage (`openai-codex-accounts.json`/`codex-accounts.json` or rotated siblings), then any with weaker storage signals.
4. Fall back to `~/.codex/multi-auth` (canonical default).

Canonical target is `~/.codex/multi-auth` when no override is set. Everything the project owns — `settings.json`, account pools, `projects/`, `cache/`, `logs/`, `app-bind/`, `first-run-setup.json`, runtime-observability and app-helper status files — resolves under this root.

* * *

## 2) Unified Settings Resolution

`<multi-auth root>/settings.json` is read for two independent sections:

- `dashboardDisplaySettings`
- `pluginConfig`

A `settings.json.bak` sibling is kept for recovery: reads fall back to `.bak` when the primary is unreadable (transient errors are rethrown). Writes force `version: 1`, snapshot a backup, then temp-write + rename under an in-process queue and a `wx` lockfile, with `EBUSY`/`EPERM` retries and (async path) an mtime compare-and-swap re-read/re-merge loop. Unknown top-level keys survive a save.

If legacy config exists, compatibility load and migration path still apply (next section).

* * *

## 3) Runtime Value Precedence

For runtime values stored in `pluginConfig`, `loadPluginConfig` (`lib/config.ts`) selects a source in this order:

1. Fallback file from `CODEX_MULTI_AUTH_CONFIG_PATH` when set **and the file exists** (also the preferred save target when set; read with bounded `EBUSY`/`EPERM`/`EAGAIN` retry and a UTF-8 BOM strip)
2. Unified settings `pluginConfig` from `settings.json` (if present and valid)
3. Legacy compatibility ladder when the unified record is missing/invalid — first hit wins, each emits a one-time migrate warning:
   a. env path (set + exists — rechecked here so a set-but-uncreated path cannot mask a real file on disk)
   b. `<multi-auth root>/config.json`
   c. `$CODEX_HOME/codex-multi-auth-config.json` (custom `CODEX_HOME` only)
   d. `~/.codex/codex-multi-auth-config.json`
   e. `$CODEX_HOME/openai-codex-auth-config.json` (custom `CODEX_HOME` only)
   f. `~/.codex/openai-codex-auth-config.json`
4. Hardcoded default in `DEFAULT_PLUGIN_CONFIG`

The chosen record is sanitized per-field (each key is `safeParse`d against its zod schema; invalid fields are dropped with a one-time warning; unknown keys are dropped on the *load* path but preserved on the *save* path), then shallow-merged over `DEFAULT_PLUGIN_CONFIG`. A thrown error anywhere in load warns once and yields full defaults rather than a partial record.

After source selection, environment variables apply per-setting overrides.

Each `get*` accessor resolves `env → config value → hardcoded default → min/max clamp`, so env always wins over the persisted file and the file always wins over the default. Boolean envs accept `1`/`0`/`true`/`false`/`yes`/`no`; unparseable values warn once and are ignored.

A `CODEX_MULTI_AUTH_CONFIG_PATH` that is set but not yet created is ignored for load; the first save still creates/writes that path when the env var remains set.

Save path (`savePluginConfig`): when the env var is set, the patch is merged into that file under the same queue + `wx` lockfile with an mtime CAS retry that re-reads and re-merges on `ESTALE` and preserves unknown keys; otherwise the same lock wraps a merge into the `pluginConfig` section of `settings.json`. An unreadable save target aborts with `StorageError` (`UNREADABLE`) instead of clobbering the file.

For dashboard display values:

1. Persisted `dashboardDisplaySettings`
2. Normalization + fallback defaults

* * *

## 4) Account Storage Path Flow

1. Resolve root directory (§1).
2. Use global accounts file by default.
3. If project-scoped mode is active (`perProjectAccounts`), use the project-namespaced path under root, keyed by `resolveProjectStorageIdentityRoot` so linked worktrees share one pool.
4. Attempt legacy project-file migration when applicable.

* * *

## 5) Command Routing Flow

1. Standalone manager receives `codex-multi-auth ...` and normalizes bare subcommands to `auth ...` before dispatch.
2. Optional wrapper receives `codex-multi-auth-codex ...`, normalizes compatibility aliases, and runs auth-manager commands locally.
3. If a wrapper command is not in auth-manager scope, discover and forward to the official Codex CLI binary (`CODEX_MULTI_AUTH_REAL_CODEX_BIN` → npm resolve → prefix roots → `npm root -g` → PATH).
4. For forwarded request-bearing commands, check whether runtime rotation is enabled.

* * *

## 6) Runtime Rotation Flow

1. Resolve `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY`; if unset, read `pluginConfig.codexRuntimeRotationProxy`, which defaults to enabled.
2. If disabled or the forwarded command is help/non-requesting, forward directly to official Codex. This includes a help flag on a root launch that also carries a prompt (`codex "prompt" --help`): it prints help and exits clean, and the interactive branch detaches its helper on a clean exit, so a helper started just to print help would idle until its detached timeout. The scan stops at `--`, so help-looking text inside a forced prompt still routes normally (#673).
3. If enabled, start a loopback Responses proxy with a per-process client token.
4. Select a transport from the forwarded argv:
   - **No forwarded root subcommand (interactive TUI)** — bare `codex [OPTIONS]`, and `codex [OPTIONS] [PROMPT]` carrying the optional initial prompt (including one forced by `--`), whose provider overrides are injected ahead of that prompt rather than appended (#673). Keep the canonical `CODEX_HOME` and pass `codex-multi-auth-runtime-proxy` as ephemeral `-c model_providers.*` overrides. Nothing is copied, no provider or transport config is written into `config.toml`, and the helper detaches on exit. The transport-independent `cli_auth_credentials_store` reconcile below still applies.
   - **`resume` / `fork`** — the same canonical-home transport as the interactive TUI. These resume an existing thread, and the shadow home omits the runtime SQLite state, so the shadow transport could not see the requested thread (#647).
   - **`codex app`** — run the app runtime helper against a shadow `CODEX_HOME`.
   - **Any other request-bearing command** — create a temporary shadow `CODEX_HOME` and rewrite its `config.toml` to use `codex-multi-auth-runtime-proxy`.
5. Forward official Codex with the selected home.
6. Proxy request handling selects/refreshes managed accounts and rotates on rate limit, auth, network, or server failure before streaming starts.
7. On process exit, shadow-home transports sync refreshed official Codex state files back and remove the shadow home. The canonical-home transport wrote state in place, so there is nothing to sync.

Independently of the transport, the wrapper reconciles the top-level `cli_auth_credentials_store = "file"` assignment in the real `~/.codex/config.toml` at startup (idempotent; see `lib/codex-cli/writer.ts`). That is the only key this project persists into the official config.

* * *

## 7) Request Handling Flow (Plugin Host)

1. Transform request for Codex backend compatibility.
2. Resolve account candidate set (health, cooldown, quota, affinity).
3. Execute request with timeout/retry policy.
4. Apply failover/rotation/cooldown decisions.
5. Persist account/cache/session updates.

* * *

## 8) Unsupported Model / Entitlement Flow

1. Detect unsupported model or entitlement failures.
2. Record in entitlement cache.
3. Apply capability penalties for account/model pair.
4. Use fallback model policy if enabled.
5. Re-evaluate account scoring and retry path.

* * *

## 9) Live Runtime Sync Flow

1. File watcher detects account-file updates.
2. Debounce and reload in-memory account manager.
3. Session affinity and guardian processes continue with updated state.

* * *

## 10) Debugging Effective Config

Use:

```bash
codex-multi-auth config explain          # every pluginConfig field: value, default, source
codex-multi-auth config explain --json   # machine-readable report
codex-multi-auth config template         # starter config template (modern|legacy|minimal)
codex-multi-auth status
codex-multi-auth report --json
codex-multi-auth rotation status
```

`config explain` mirrors the real load precedence in §3 — env path first, then unified settings, then the legacy ladder — and reports each field's `source` (`env`, `unified`, `file`, `default`, plus `unreadable`/`none` when the active source cannot be read) together with the env names that could override it. Because it resolves the same way as `loadPluginConfig`, it is the authoritative answer to "which file and which env var produced this value?"

Check files:

- `~/.codex/multi-auth/settings.json`
- `~/.codex/multi-auth/openai-codex-accounts.json`
- `~/.codex/multi-auth/runtime-observability.json`

* * *

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [../configuration.md](../configuration.md)
