# codex-multi-auth Docs

Codex CLI-first multi-account OAuth documentation.

## Start Here

1. [getting-started.md](getting-started.md)
2. Run `codex auth login`
3. Verify with `codex auth list`
4. Continue with [configuration.md](configuration.md)

## Quick Commands

```bash
codex auth login
codex auth list
codex auth switch 2
codex auth forecast --live
codex auth fix --dry-run
codex auth doctor --fix
```

## Docs Chart

| Topic | Link |
| --- | --- |
| Full docs portal | [README.md](README.md) |
| Upgrade notes | [upgrade.md](upgrade.md) |
| Configuration | [configuration.md](configuration.md) |
| Troubleshooting | [troubleshooting.md](troubleshooting.md) |
| Privacy | [privacy.md](privacy.md) |
| Development internals | [development/](development/) |

## Notes

- Browser pop-up during `codex auth login` is expected.
- `codex` forwards non-`auth` commands to the official `@openai/codex` CLI.
