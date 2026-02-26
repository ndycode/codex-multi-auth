# Documentation Architecture

This file defines how documentation is organized and maintained.

## Master Documentation Chart

| Scope | File | Primary audience |
| --- | --- | --- |
| Project entry | `README.md` | New users |
| Docs portal | `docs/README.md` | All users |
| Docs landing | `docs/index.md` | All users |
| Setup | `docs/getting-started.md` | Beginners |
| Upgrade and migration | `docs/upgrade.md` | Beginners to operators |
| Runtime configuration | `docs/configuration.md` | Users and operators |
| Troubleshooting | `docs/troubleshooting.md` | Users and operators |
| Privacy/data | `docs/privacy.md` | All users |
| Architecture internals | `docs/development/ARCHITECTURE.md` | Maintainers |
| Config keys reference | `docs/development/CONFIG_FIELDS.md` | Maintainers |
| Config resolution flow | `docs/development/CONFIG_FLOW.md` | Maintainers |
| Repository ownership map | `docs/development/REPOSITORY_SCOPE.md` | Maintainers |
| Testing and release checks | `docs/development/TESTING.md` | Maintainers |
| TUI parity checklist | `docs/development/TUI_PARITY_CHECKLIST.md` | Maintainers |
| Upstream proposal | `docs/OPENCODE_PR_PROPOSAL.md` | Maintainers |
| Benchmark guide | `docs/benchmarks/code-edit-format-benchmark.md` | Maintainers |

## Documentation Layers

| Layer | Goal | Style |
| --- | --- | --- |
| Beginner | First successful login/use | command-first and short |
| Intermediate | Safe operations and tuning | tables, defaults, examples |
| Advanced | Maintenance and architecture | subsystem maps and invariants |

## Update Rules

When behavior changes:

1. Update `README.md` and `docs/getting-started.md` first.
2. Update `docs/configuration.md` and `docs/troubleshooting.md` for operator impact.
3. Update development docs for internal changes.
4. Keep commands and file paths synchronized with code.

## Consistency Rules

- Prefer `codex auth ...` command examples for account workflows.
- Use real runtime paths (`~/.codex/multi-auth/...`) for plugin internals.
- Mark legacy paths as compatibility-only.
- Keep JSON snippets minimal and runnable.

## Documentation QA Checklist

- Commands copied from docs execute without edits.
- Paths match `lib/config.ts` and `lib/storage.ts`.
- New config keys appear in both user and development references.
- New CLI flags appear in troubleshooting/examples where relevant.

## Related

- [README.md](../README.md)
- [README.md](README.md)
