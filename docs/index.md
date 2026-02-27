# codex-multi-auth Docs

Codex CLI-first multi-account OAuth docs in one place.

* * *

## Quick Start

```bash
codex auth login
codex auth list
codex auth check
```

Then continue with:

- [Getting Started](getting-started.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)

* * *

## Quick Commands

```bash
codex auth forecast --live
codex auth fix --dry-run
codex auth doctor --fix
codex auth report --live --json
```

* * *

## Documentation Sections

- User guides: [README.md](README.md)
- Full features list: [features.md](features.md)
- Command reference: [reference/commands.md](reference/commands.md)
- Settings reference: [reference/settings.md](reference/settings.md)
- Storage paths: [reference/storage-paths.md](reference/storage-paths.md)
- Development internals: [development/](development/)

* * *

## Notes

- `codex auth ...` is the canonical account-management flow.
- Legacy path/command notes live in [upgrade.md](upgrade.md).
- Non-auth `codex` commands are forwarded to the official `@openai/codex` CLI by the wrapper.
