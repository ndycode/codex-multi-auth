# codex-multi-auth Docs

Daily-use guide for the `codex auth ...` workflow.

---

## 60-Second Path

```bash
codex auth login
codex auth list
codex auth check
```

If you are choosing an account for the next session:

```bash
codex auth forecast --live
```

---

## Use This Section For

- first setup and verification: [getting-started.md](getting-started.md)
- quick answers before install: [faq.md](faq.md)
- understanding the wrapper, runtime rotation proxy, app bind, and optional plugin-host path: [architecture.md](architecture.md)
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

---

## Canonical Policy

- Canonical package: `codex-multi-auth`
- Canonical command family: `codex auth ...`
- Canonical storage root: `~/.codex/multi-auth`
- Runtime rotation: default-on, inspect or repair with `codex auth rotation status`

Legacy migration details live in [upgrade.md](upgrade.md).

---

## Next References

- Command flags and hotkeys: [reference/commands.md](reference/commands.md)
- Runtime settings: [reference/settings.md](reference/settings.md)
- Storage paths: [reference/storage-paths.md](reference/storage-paths.md)
- Full docs portal: [README.md](README.md)
