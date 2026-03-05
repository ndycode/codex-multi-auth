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

2. Remove legacy scoped package if present:

   ```bash
   npm uninstall -g @ndycode/codex-multi-auth
   ```

3. Install canonical package:

   ```bash
   npm i -g codex-multi-auth
   ```

4. Verify routing and status:

   ```bash
   codex --version
   codex auth status
   ```

5. Rebuild account health baseline:

   ```bash
   codex auth login
   codex auth check
   codex auth forecast --live --model gpt-5-codex
   ```

---

## Configuration Upgrade Notes

During upgrades, runtime config source precedence is:

1. Unified settings `pluginConfig` from `settings.json` (when valid).
2. Fallback file config from `CODEX_MULTI_AUTH_CONFIG_PATH` (or legacy compatibility path) when unified settings are absent/invalid.
3. Runtime defaults.

After source selection, environment variables still override individual setting values.

For day-to-day operator use, prefer stable overrides documented in [configuration.md](configuration.md).
For maintainer/debug flows, see advanced/internal controls in [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md).

### Secret Storage Mode Migration (plaintext -> keychain)

Use this flow when migrating existing deployments that were running with plaintext token storage.

1. Back up runtime state before changing secret storage mode:

   ```bash
   cp -r ~/.codex/multi-auth ~/.codex/multi-auth.backup
   ```

2. Validate keychain backend availability:

   ```bash
   npm run ops:keychain-assert
   ```

   Run this from the project repository root where `package.json` defines enterprise ops scripts, or run your CI/job wrapper that exposes these scripts.

3. Set `CODEX_SECRET_STORAGE_MODE=keychain` in your runtime environment (or use `auto` only after the keychain validation above passes).

4. Trigger a controlled account rewrite so token refs are persisted in v4 format:

   ```bash
   codex auth check
   codex auth report --live
   ```

5. Verify health and storage state:

   ```bash
   npm run ops:health-check -- --require-files
   ```

   Run this from the same repository checkout (or your standard CI/job wrapper).

Windows migration note:

- Close editors/shells that may hold handles on `%CODEX_HOME%\\multi-auth` before migration writes.
- If you hit transient `EBUSY`/`EPERM` during migration, retry after closing locking processes; storage/settings writes use exponential backoff, but persistent locks still require operator action.

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
