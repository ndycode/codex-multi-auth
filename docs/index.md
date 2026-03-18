# codex-multi-auth Docs

Daily-use guide for the `codex auth ...` workflow, including restore, sync, and diagnostics.

---

## 60-Second Path

```bash
codex auth login
codex auth list
codex auth check
```

If login detects recoverable named backups before OAuth, confirm the prompt to open `Restore From Backup` first.

If you are choosing an account for the next session:

```bash
codex auth forecast --live
```

---

## Use This Section For

- first setup and verification: [getting-started.md](getting-started.md)
- quick answers before install: [faq.md](faq.md)
- understanding the wrapper and optional plugin runtime: [architecture.md](architecture.md)
- recovering from login, routing, or state problems: [troubleshooting.md](troubleshooting.md)

---

## Common Daily Commands

```bash
codex auth status
codex auth list
codex auth switch 2
codex auth report --live --json
codex auth doctor --fix
```

Interactive workflows that ship in the dashboard:

- backup restore: `codex auth login` -> `Restore From Backup`
- sync preview and apply: `codex auth login` -> `Settings` -> `Codex CLI Sync`
- settings split: `codex auth login` -> `Settings` -> `Everyday Settings` or `Advanced & Operator`

---

## Canonical Policy

- Canonical package: `codex-multi-auth`
- Canonical command family: `codex auth ...`
- Canonical storage root: `~/.codex/multi-auth`

Legacy migration details live in [upgrade.md](upgrade.md).

---

## Next References

- Command flags and hotkeys: [reference/commands.md](reference/commands.md)
- Runtime settings: [reference/settings.md](reference/settings.md)
- Storage paths: [reference/storage-paths.md](reference/storage-paths.md)
- Full docs portal: [README.md](README.md)
