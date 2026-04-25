# Documentation Architecture

Canonical governance for repository documentation quality and consistency.

---

## Documentation Layers

| Layer | Audience | Primary goal |
| --- | --- | --- |
| Product entry | New operators | Install quickly and complete first successful login/check |
| User operations | Daily users | Configure, run, recover, and report issues safely |
| Reference | Power users and maintainers | Exact command, setting, and path lookup |
| Development | Contributors and maintainers | Internal architecture, flow, tests, and ownership |

---

## Source of Truth Map

| Scope | File |
| --- | --- |
| Project entry | `README.md` |
| Docs portal | `docs/README.md` |
| Daily operator landing | `docs/index.md` |
| Onboarding | `docs/getting-started.md` |
| FAQ | `docs/faq.md` |
| Public architecture overview | `docs/architecture.md` |
| Feature map | `docs/features.md` |
| Configuration guide | `docs/configuration.md` |
| Troubleshooting guide | `docs/troubleshooting.md` |
| Privacy and data handling | `docs/privacy.md` |
| Upgrade and migration | `docs/upgrade.md` |
| Command reference | `docs/reference/commands.md` |
| Public API contract | `docs/reference/public-api.md` |
| Error contract reference | `docs/reference/error-contracts.md` |
| Settings reference | `docs/reference/settings.md` |
| Storage path reference | `docs/reference/storage-paths.md` |
| Docs style contract | `docs/STYLE_GUIDE.md` |
| Docs governance (this file) | `docs/DOCUMENTATION.md` |
| Architecture internals | `docs/development/ARCHITECTURE.md` |
| Runtime rotation implementation guide | `docs/development/ARCHITECTURE.md` |
| GitHub metadata guidance | `docs/development/GITHUB_DISCOVERABILITY.md` |
| IA/findability audit (2026-03-01) | `docs/development/IA_FINDABILITY_AUDIT_2026-03-01.md` |
| Config fields internals | `docs/development/CONFIG_FIELDS.md` |
| Config flow internals | `docs/development/CONFIG_FLOW.md` |
| Repository ownership map | `docs/development/REPOSITORY_SCOPE.md` |
| Testing and release gates | `docs/development/TESTING.md` |
| TUI parity checklist | `docs/development/TUI_PARITY_CHECKLIST.md` |
| Benchmark methodology | `docs/benchmarks/code-edit-format-benchmark.md` |
| Historical audit snapshots | `docs/audits/` |

---

## Canonical Policy

1. Canonical package name: `codex-multi-auth`.
2. Canonical account command family: `codex auth ...`.
3. Canonical storage root: `~/.codex/multi-auth` unless explicitly overridden.
4. Compatibility aliases (`codex multi auth`, `codex multi-auth`, `codex multiauth`) belong only in command reference, troubleshooting, or migration sections.
5. Legacy paths/flows and scoped package references belong only in migration and compatibility sections.
6. Current stable release line is `2.x`; foundational `0.x` and pre-`0.1.0` entries stay archived separately.
7. Runtime rotation is documented as default-on unless a future release intentionally changes that policy.
8. Audit evidence under `docs/audits/` is historical snapshot material. Do not rewrite captured evidence to look current; add snapshot notes or new audit artifacts instead.

---

## Update Rules

When runtime behavior changes:

1. Update `README.md` and `docs/getting-started.md` first.
2. Update `docs/faq.md` and `docs/architecture.md` when the first-time-user story or public system framing changes.
3. Update `docs/features.md` for capability coverage changes.
4. Update relevant command/settings/path references.
5. Update `docs/troubleshooting.md` with new failure signatures or recovery steps.
6. Update development docs when architecture, config flow, or GitHub-facing metadata guidance changes.
7. Update `docs/upgrade.md` for migration-impacting behavior.
8. Update `docs/reference/storage-paths.md` when runtime files, app bind files, or official Codex state interactions change.
9. Update `SECURITY.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md` when governance or safe usage guidance changes.
10. Keep issue/PR templates aligned with validation expectations.

---

## Documentation QA Checklist

Before merge:

1. Every documented command is executable as written.
2. CLI flags documented in references match runtime parser/usage output.
3. Paths match runtime modules (`lib/runtime-paths.ts`, `lib/storage.ts`, `lib/config.ts`).
4. Internal links are valid.
5. Cross-platform instructions exist for OS-sensitive operations.
6. No conflicting guidance between README, docs, and governance files.

---

## Related

- [Project README.md](../README.md)
- [Docs Portal](README.md)
- [STYLE_GUIDE.md](STYLE_GUIDE.md)
