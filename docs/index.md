# codex-multi-auth Docs

Daily-use landing page for operators using `codex auth ...` workflows.

---

## 5-Minute Start

```bash
codex auth login
codex auth list
codex auth check
```

Then pick your next path:

- Setup and first-run details: [getting-started.md](getting-started.md)
- Runtime behavior and controls: [configuration.md](configuration.md)
- Recovery workflows: [troubleshooting.md](troubleshooting.md)

---

## Daily Operations

```bash
codex auth forecast --live
codex auth fix --dry-run
codex auth doctor --fix
codex auth report --live --json
```

---

## Canonical Policy

- Canonical package: `codex-multi-auth`
- Canonical command family: `codex auth ...`
- Canonical data root: `~/.codex/multi-auth`

Legacy package/path guidance is documented in [upgrade.md](upgrade.md) and [reference/storage-paths.md](reference/storage-paths.md).

---

## Next References

- Command flags and hotkeys: [reference/commands.md](reference/commands.md)
- Settings and overrides: [reference/settings.md](reference/settings.md)
- Storage path matrix: [reference/storage-paths.md](reference/storage-paths.md)
- Operations runbooks: [runbooks/README.md](runbooks/README.md)
- Full docs portal: [README.md](README.md)
