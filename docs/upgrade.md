# Upgrade Guide

Migrate from older package/path layouts to the current Codex-first workflow.

---

## Canonical Targets

- Canonical package: `codex-multi-auth`
- Canonical commands: `codex auth ...`
- Canonical root: `~/.codex/multi-auth`

---

## Migration Checklist

1. Ensure official Codex CLI is installed:

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

4. Verify command routing:

```bash
codex --version
codex auth status
```

5. Rebuild account health snapshot:

```bash
codex auth login
codex auth check
codex auth forecast --live
```

---

## Legacy Compatibility

Legacy files may still be read during migration compatibility checks.
They are not canonical and should not be used for new setup.

See [reference/storage-paths.md](reference/storage-paths.md).

---

## Common Upgrade Problems

| Problem | Action |
| --- | --- |
| `codex auth` not found | `where codex` (Windows) or `which codex` (macOS/Linux) |
| Old package still active | Uninstall scoped package and reinstall unscoped package |
| Accounts look stale | `codex auth doctor --fix` then re-login impacted accounts |
| Mixed path confusion | Check [reference/storage-paths.md](reference/storage-paths.md) |

---

## Related

- [getting-started.md](getting-started.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/storage-paths.md](reference/storage-paths.md)
