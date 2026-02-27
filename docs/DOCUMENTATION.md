# Documentation Architecture

This file defines the canonical documentation system for `codex-multi-auth`.

* * *

## Documentation Layers

| Layer | Audience | Goal |
| --- | --- | --- |
| Product entry | New users | Install quickly and run first successful login/check |
| User operations | Users/operators | Configure, operate, troubleshoot safely |
| Reference | Power users/maintainers | Exact command/setting/path lookup |
| Development | Maintainers/contributors | Internal architecture, flow, tests, ownership |

* * *

## Master Chart

| Scope | File |
| --- | --- |
| Project entry | `README.md` |
| Docs portal | `docs/README.md` |
| Docs landing | `docs/index.md` |
| Beginner setup | `docs/getting-started.md` |
| Feature matrix | `docs/features.md` |
| Configuration guide | `docs/configuration.md` |
| Troubleshooting guide | `docs/troubleshooting.md` |
| Privacy/data handling | `docs/privacy.md` |
| Upgrade/migration | `docs/upgrade.md` |
| Command reference | `docs/reference/commands.md` |
| Settings reference | `docs/reference/settings.md` |
| Storage path reference | `docs/reference/storage-paths.md` |
| Documentation style rules | `docs/STYLE_GUIDE.md` |
| Docs governance (this file) | `docs/DOCUMENTATION.md` |
| Architecture internals | `docs/development/ARCHITECTURE.md` |
| Config fields internals | `docs/development/CONFIG_FIELDS.md` |
| Config flow internals | `docs/development/CONFIG_FLOW.md` |
| Repository ownership map | `docs/development/REPOSITORY_SCOPE.md` |
| Testing guide | `docs/development/TESTING.md` |
| TUI parity checklist | `docs/development/TUI_PARITY_CHECKLIST.md` |
| Benchmarks | `docs/benchmarks/code-edit-format-benchmark.md` |

* * *

## Tone and Formatting Contract

All user-facing docs must follow `docs/STYLE_GUIDE.md`:

1. Beginner-first language.
2. Short lead sentence.
3. Quick path before deep details.
4. Command-first examples.
5. Clear next steps/related links.

Codex CLI-first style is the baseline:

- concise sections
- operational clarity
- progressive disclosure

* * *

## Canonical Command and Path Policy

1. Canonical account workflow command family: `codex auth ...`.
2. Canonical runtime storage root: `~/.codex/multi-auth`.
3. Legacy paths/flows are documented only in migration/compat sections.
4. Do not present legacy flows as the default workflow.

* * *

## Update Rules

When runtime behavior changes:

1. Update `README.md` and `docs/getting-started.md` first.
2. Update `docs/features.md` for feature coverage changes.
3. Update command/settings/path references if any CLI/config/storage behavior changed.
4. Update `docs/troubleshooting.md` with new failure signatures.
5. Update development docs when architecture/config flow changed.
6. Update `docs/upgrade.md` when migration steps, command routing, or paths changed.
7. Keep `SECURITY.md` aligned with current storage paths and credential handling.
8. Update npm script references whenever build/install workflow changes.

* * *

## Documentation QA Checklist

Before merge:

1. Every documented command executes as written.
2. Paths match runtime code (`lib/runtime-paths.ts`, `lib/storage.ts`, `lib/config.ts`).
3. Feature matrix covers all implemented features.
4. Internal links are valid.
5. Cross-platform examples are present for OS-sensitive flows.
6. No conflicting duplicate guidance across pages.

* * *

## Related

- [Project README.md](../README.md)
- [Docs README.md](README.md)
- [STYLE_GUIDE.md](STYLE_GUIDE.md)
