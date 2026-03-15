# Upgrade Guide

Migrate legacy installs to the canonical `codex-multi-auth` workflow on the `0.x` release line.

---

## Canonical Targets

- Package: `codex-multi-auth`
- Command family: `codex auth ...`
- Runtime root: `~/.codex/multi-auth`

---

## Migration Checklist

1. Remove legacy scoped package if present:

```bash
npm uninstall -g @ndycode/codex-multi-auth
```

1. Install canonical package:

```bash
npm i -g codex-multi-auth
```

1. Verify routing and status:

```bash
codex auth status
```

1. If you also need the official Codex host/runtime for forwarded non-auth commands or plugin-host setup, install it now and continue with [advanced-plugin-install.md](advanced-plugin-install.md):

```bash
npm i -g @openai/codex
codex --version
```

1. Rebuild account health baseline:

Agents should confirm with the user before running `codex auth login` because it opens a browser OAuth flow and mutates local auth state.

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
