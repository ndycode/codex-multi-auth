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

For plugin runtime values:

1. Environment override
2. Unified/compat config value
3. Hardcoded default in `DEFAULT_PLUGIN_CONFIG`

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

1. Wrapper receives `codex` invocation.
2. Normalize alias args (`multi auth`, `multi-auth`, `multiauth`).
3. If command belongs to auth manager scope, run local manager.
4. Otherwise forward invocation to official Codex CLI binary.

* * *

## 6) Request Handling Flow (Plugin)

1. Transform request for Codex backend compatibility.
2. Resolve account candidate set (health, cooldown, quota, affinity).
3. Execute request with timeout/retry policy.
4. Apply failover/rotation/cooldown decisions.
5. Persist account/cache/session updates.

* * *

## 7) Unsupported Model / Entitlement Flow

1. Detect unsupported model or entitlement failures.
2. Record in entitlement cache.
3. Apply capability penalties for account/model pair.
4. Use fallback model policy if enabled.
5. Re-evaluate account scoring and retry path.

* * *

## 8) Live Runtime Sync Flow

1. File watcher detects account-file updates.
2. Debounce and reload in-memory account manager.
3. Session affinity and guardian processes continue with updated state.

* * *

## 9) Debugging Effective Config

Use:

```bash
codex auth status
codex auth report --json
```

Check files:

- `~/.codex/multi-auth/settings.json`
- `~/.codex/multi-auth/openai-codex-accounts.json`

* * *

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [../configuration.md](../configuration.md)
