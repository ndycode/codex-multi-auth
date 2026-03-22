# Upgrade Guide

Migrate legacy installs to the canonical `codex-multi-auth` workflow on the `0.x` release line.

---

## Canonical Targets

- Package: `codex-multi-auth`
- Command family: `codex auth ...`
- Runtime root: `~/.codex/multi-auth`

---

## Migration Checklist

1. Install official Codex CLI:

```bash
npm i -g @openai/codex
```

1. Remove legacy scoped package if present:

```bash
npm uninstall -g @ndycode/codex-multi-auth
```

1. Install canonical package:

```bash
npm i -g codex-multi-auth
```

1. Verify routing and wrapper status:

```bash
codex --version
codex-multi-auth --version
codex auth status
```

1. Rebuild account health baseline:

```bash
codex auth login
codex auth check
codex auth forecast --live --model gpt-5-codex
```

---

## Login Flow Upgrade Notes

- `codex auth login` remains the default browser-first path.
- `codex auth login --manual` and `codex auth login --no-browser` force manual callback handling for browser-restricted shells.
- `CODEX_AUTH_NO_BROWSER=1` suppresses browser launch for automation/headless sessions. False-like values such as `0` and `false` no longer force manual mode.
- In non-TTY/manual shells, provide the full redirect URL on stdin, for example: `echo "http://127.0.0.1:1455/auth/callback?code=..." | codex auth login --manual`.
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

## Onboarding Restore Note

`codex auth login` now opens directly into the sign-in menu when the active pool is empty, instead of opening the account dashboard first.

- `Recover saved accounts` appears only when at least one valid named backup exists.
- No new CLI flags or npm scripts were added for this flow.
- The backup root remains `~/.codex/multi-auth/backups` by default, or `%CODEX_MULTI_AUTH_DIR%\backups` when `CODEX_MULTI_AUTH_DIR` is set.

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
| `codex auth` not found | Run `where codex` (Windows) or `which codex` (macOS/Linux) |
| Old package still active | Uninstall scoped package and reinstall unscoped package |
| Account pool appears stale | Run `codex auth doctor --fix`, then re-login impacted accounts |
| Mixed path confusion | Check [reference/storage-paths.md](reference/storage-paths.md) |

---

## Related

- [getting-started.md](getting-started.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)
