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

During upgrades, configuration precedence is:

1. Environment override values.
2. `CODEX_MULTI_AUTH_CONFIG_PATH` file values.
3. Unified settings compatibility values.
4. Runtime defaults.

For day-to-day operator use, prefer stable overrides documented in [configuration.md](configuration.md).
For maintainer/debug flows, see advanced/internal controls in [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md).

---

## Legacy Compatibility

Legacy files may still be discovered during migration-only compatibility checks.
They are not canonical for new setups.

See [reference/storage-paths.md](reference/storage-paths.md).

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