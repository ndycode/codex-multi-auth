# Upgrade Guide

Migrate legacy installs to the canonical `codex-multi-auth` workflow on the current `2.x` release line.

---

## Canonical Targets

- Package: `codex-multi-auth`
- Command family: `codex-multi-auth ...`
- Runtime root: `~/.codex/multi-auth`
- Optional wrapper: `codex-multi-auth-codex` / `mcodex`
- Official CLI binary name: `codex` (owned by `@openai/codex` or another official install path)

---

## v2.1.2 Bin Migration

`v2.1.2` intentionally stops publishing a global `codex` executable. That
name belongs to the official Codex install path and can be owned by npm,
Homebrew, or an official release binary.

Use these commands after upgrading:

```bash
codex --version
codex-multi-auth --version
codex-multi-auth-codex --version
codex-multi-auth status
```

If you previously ran this package through `codex`, switch account-management
commands to `codex-multi-auth ...`. If you intentionally need the forwarding
wrapper from this package, use `codex-multi-auth-codex ...` or `mcodex ...`.

---

## First-Run Setup Note (Shipped)

Installing the package no longer performs desktop-app detection, app bind, or
launcher-shortcut setup during `npm install`. Postinstall is notice-only.
That work now runs once on your first `codex-multi-auth` invocation from a
durable global install:

```bash
npm i -g codex-multi-auth
codex-multi-auth status
```

Expected outcome: the first command claims a one-time marker at
`~/.codex/multi-auth/first-run-setup.json` and performs the app bind and
launcher setup (best-effort — a failure never blocks the command). `npx` runs
and project-local installs deliberately skip this setup and do not consume the
marker.

Opt-outs:

| Variable | Effect |
| --- | --- |
| `CODEX_MULTI_AUTH_APP_BIND=0` | Skip packaged Codex app bind on first run |
| `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` | Same bind skip (install-oriented alias used by rotation enable / self-heal paths) |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` | Skip user-level launcher routing install |
| CI environments | Always skip first-run setup |

Either `CODEX_MULTI_AUTH_APP_BIND` or `CODEX_MULTI_AUTH_APP_BIND_INSTALL` can
gate the app-bind step; when both are unset, bind runs when runtime rotation is
enabled and a Codex desktop app is detected.

---

## Migration Checklist

1. Install official Codex CLI:

```bash
npm i -g @openai/codex
```

2. Remove legacy scoped package if present:

```bash
npm uninstall -g @ndycode/codex-multi-auth
```

3. Install canonical package:

```bash
npm i -g codex-multi-auth
```

4. Verify routing and wrapper status:

```bash
codex --version
codex-multi-auth --version
codex-multi-auth-codex --version
codex-multi-auth status
```

5. Rebuild account health baseline:

```bash
codex-multi-auth login
codex-multi-auth check
codex-multi-auth forecast --live --model gpt-5.6-sol
```

---

## Login Flow Upgrade Notes

- `codex-multi-auth login` remains the default browser-first path.
- `codex-multi-auth login --device-auth` is the preferred remote/headless path. It prints a verification URL like `https://auth.openai.com/codex/device` and a one-time code, then completes without a local browser or callback server.
- `codex-multi-auth login --manual` and `codex-multi-auth login --no-browser` force manual callback handling for browser-restricted shells.
- `CODEX_AUTH_NO_BROWSER=1` suppresses browser launch for automation/headless sessions. False-like values such as `0` and `false` no longer force manual mode.
- In non-TTY/manual shells, provide the full redirect URL on stdin, for example: `echo "http://127.0.0.1:1455/auth/callback?code=..." | codex-multi-auth login --manual`.
- No new npm scripts, storage migrations, or extra upgrade steps were introduced for this auth-flow change.

For the full command/behavior reference, see [reference/commands.md](reference/commands.md).

---

## Configuration Upgrade Notes

During upgrades, runtime config source precedence is:

1. Unified settings `pluginConfig` from `settings.json` (when valid).
2. Fallback file config from `CODEX_MULTI_AUTH_CONFIG_PATH` (or legacy compatibility path) when unified settings are absent/invalid.
3. Runtime defaults.

After source selection, environment variables still override individual setting values.

For day-to-day operator use, prefer stable overrides documented in [configuration.md](configuration.md).
For maintainer/debug flows, see advanced/internal controls in [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md).

---

## Runtime Rotation Upgrade Note

The 2.0.1 line makes runtime rotation the default for request-bearing wrapper-launched Codex sessions and keeps the packaged app bind reversible. That policy remains on the current `2.x` release line.

- Current installs route request-bearing commands launched through `codex-multi-auth-codex ...` or `mcodex ...` through the localhost rotation proxy unless `codexRuntimeRotationProxy=false` or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` is set.
- `codex-multi-auth rotation enable` persists the setting and repairs supported packaged Codex app binds through a reversible localhost router.
- `codex-multi-auth rotation disable` turns the setting off and removes the persistent app bind.
- Set `CODEX_MULTI_AUTH_APP_BIND=0` or `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` before first run or update if you only want wrapper-launched CLI/app sessions routed and do not want the packaged app bind installed.
- Set `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` before first run or update if you do not want supported user-level app launchers routed through the wrapper.
- Installed wrappers may perform a best-effort daily npm version check during normal forwarded startup. If a newer package is detected, update manually with `npm install -g codex-multi-auth@latest`.
- Official Codex app binaries are not patched.
- Pause/drain account policies and budget/profile checks are enforced on the rotation path via `evaluateRuntimePolicy`.

Validate after enabling:

```bash
codex-multi-auth rotation status
codex-multi-auth forecast --live
```

---

## Model Defaults Upgrade Note

On the current `2.x` line:

- `DEFAULT_MODEL` (general routing default and `gpt-5` alias target) is `gpt-5.5`.
- Diagnostic live/quota probes (`check`, `report`, `forecast`, `best`, `fix`) lead with `DEFAULT_PROBE_MODEL` = `gpt-5.6-sol`, then fall through the probe chain for accounts without entitlement.

When validating live repair or forecast after an upgrade, prefer:

```bash
codex-multi-auth forecast --live --model gpt-5.6-sol
codex-multi-auth fix --live --model gpt-5.5
```

---

## Responses Background Mode Upgrade Note

`backgroundResponses` and `CODEX_AUTH_BACKGROUND_RESPONSES=1` are opt-in compatibility controls for callers that intentionally send Responses API `background: true`.

- Leave them disabled for existing stateless pipelines. The default routing remains `store=false`.
- Enabling them switches background requests onto the stateful path, forces `store=true`, preserves caller-supplied input item IDs, and skips stateless-only defaults such as fast-session trimming and `reasoning.encrypted_content` injection.
- No new npm scripts or storage migrations are required, but you should validate one known `background: true` request end to end before enabling the flag across shared automation.

---

## Onboarding Restore Note

`codex-multi-auth login` now opens directly into the sign-in menu when the active pool is empty, instead of opening the account dashboard first.

- `Recover saved accounts` appears only when at least one valid named backup exists.
- No new CLI flags or npm scripts were added for this flow.
- The backup root remains `~/.codex/multi-auth/backups` by default, or `%CODEX_MULTI_AUTH_DIR%\backups` when `CODEX_MULTI_AUTH_DIR` is set.
- `codex-multi-auth login --device-auth` starts a new device-code login directly and does not open the restore menu. Use plain `codex-multi-auth login` first when you want to recover a saved backup.

---

## Local Governance Upgrade Note

Local governance commands shipped on the `2.x` line and remain available after upgrade:

- `codex-multi-auth usage` — local usage ledger summaries
- `codex-multi-auth budget` — local budget limits and checks
- `codex-multi-auth account pause|drain|…` — account policy controls enforced at runtime
- `codex-multi-auth models` / `codex-multi-auth monitor` — capability and operator views
- `codex-multi-auth bridge token …` — hashed `cma_local_*` client tokens for the optional loopback bridge
- `codex-multi-auth history` — provider-agnostic local session list
- `mcodex` — convenience wrapper launcher

No remote dashboard or hosted multi-user service is introduced. Data stays under `~/.codex/multi-auth`.

---

## Legacy Compatibility

Legacy files may still be discovered during migration-only compatibility checks.
They are not canonical for new setups.

See [reference/storage-paths.md](reference/storage-paths.md).

### Worktree Storage Migration

If you used `perProjectAccounts=true` before worktree identity sharing was added, older worktree-keyed account files are migrated automatically on first load:

- Legacy worktree storage is merged into the canonical repo-shared project file.
- Legacy files are removed only after a successful canonical write.
- If canonical persistence fails, legacy files are retained to avoid data loss.

---

## Common Upgrade Problems

| Problem | Action |
| --- | --- |
| `codex-multi-auth` not found | Run `where codex-multi-auth` (Windows) or `which codex-multi-auth` (macOS/Linux) |
| Old package still active | Uninstall scoped package `@ndycode/codex-multi-auth` and reinstall unscoped `codex-multi-auth` |
| Account pool appears stale | Run `codex-multi-auth doctor --fix`, then re-login impacted accounts |
| Mixed path confusion | Check [reference/storage-paths.md](reference/storage-paths.md) |
| Wrapper still expected as `codex` | Use `codex-multi-auth-codex` or `mcodex`; keep official `codex` for stock CLI |
| Newest models missing after upgrade | Re-run config install paths for model pickers; see [troubleshooting.md](troubleshooting.md) |

---

## Related

- [getting-started.md](getting-started.md)
- [troubleshooting.md](troubleshooting.md)
- [architecture.md](architecture.md)
- [features.md](features.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)
