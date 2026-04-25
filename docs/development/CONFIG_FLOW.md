# Configuration Flow

How configuration is resolved at runtime from files, env, and defaults.

* * *

## 1) Root Directory Resolution

Runtime root priority:

1. `CODEX_MULTI_AUTH_DIR`
2. `CODEX_HOME/multi-auth`
3. Detected fallback roots with existing storage signals
4. Legacy path fallback only when signals exist

Canonical target is `~/.codex/multi-auth` when no override is set.

* * *

## 2) Unified Settings Resolution

`settings.json` is read for:

- `dashboardDisplaySettings`
- `pluginConfig`

If legacy config exists, compatibility load and migration path still apply.

* * *

## 3) Runtime Value Precedence

For runtime values stored in `pluginConfig`:

1. Unified settings `pluginConfig` (if present and valid)
2. Fallback file from `CODEX_MULTI_AUTH_CONFIG_PATH` or legacy compatibility path (only when unified config is missing/invalid)
3. Hardcoded default in `DEFAULT_PLUGIN_CONFIG`

After source selection, environment variables apply per-setting overrides.

For dashboard display values:

1. Persisted `dashboardDisplaySettings`
2. Normalization + fallback defaults

* * *

## 4) Account Storage Path Flow

1. Resolve root directory.
2. Use global accounts file by default.
3. If project-scoped mode is active, use project namespaced path under root.
4. Attempt legacy project-file migration when applicable.

* * *

## 5) Command Routing Flow

1. Wrapper receives `codex` or `codex-multi-auth`.
2. Normalize alias args (`multi auth`, `multi-auth`, `multiauth`).
3. If command belongs to auth manager scope, run local manager.
4. Otherwise discover and forward to the official Codex CLI binary.
5. For forwarded request-bearing commands, check whether runtime rotation is enabled.
6. Direct `codex-multi-auth ...` invocations route through the same routing entrypoint.

* * *

## 6) Runtime Rotation Flow

1. Resolve `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY`; if unset, read `pluginConfig.codexRuntimeRotationProxy`, which defaults to enabled.
2. If disabled or the forwarded command is help/non-requesting, forward directly to official Codex.
3. If enabled, start a loopback Responses proxy with a per-process client token.
4. Create a temporary shadow `CODEX_HOME` and rewrite `config.toml` to use `codex-multi-auth-runtime-proxy`.
5. Forward official Codex with the shadow home.
6. Proxy request handling selects/refreshed managed accounts and rotates on rate limit, auth, network, or server failure before streaming starts.
7. On process exit, sync refreshed official Codex state files back and remove the shadow home.

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
codex auth status
codex auth report --json
codex auth rotation status
```

Check files:

- `~/.codex/multi-auth/settings.json`
- `~/.codex/multi-auth/openai-codex-accounts.json`

* * *

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [../configuration.md](../configuration.md)
