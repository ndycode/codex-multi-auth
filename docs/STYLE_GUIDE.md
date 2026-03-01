# Documentation Style Guide

Style contract for all docs in this repository.

---

## Goals

1. Fast onboarding for first-time operators.
2. Precise references for maintainers and automation users.
3. Stable wording for commands, flags, paths, and version policy.
4. Consistent structure across user and maintainer docs.

---

## Page Template

User-facing docs should generally follow:

1. Title and one-line lead.
2. Quick path commands.
3. Core operational workflow.
4. Troubleshooting or failure handling.
5. Related links.

Use short sections and scan-friendly tables where they improve clarity.

---

## Writing Rules

1. Prefer direct, actionable language.
2. Use runnable command examples.
3. Explain expected outcomes after critical commands.
4. Keep terminology consistent with runtime names.
5. Avoid speculative language when behavior is deterministic.

---

## Command and Path Rules

1. Canonical command family is `codex auth ...`.
2. Canonical runtime root is `~/.codex/multi-auth`.
3. Legacy command/path references belong only in migration contexts.
4. Compatibility aliases (`codex multi auth`, `codex multi-auth`, `codex multiauth`) belong only in command reference, troubleshooting, or migration contexts.
5. Keep command flags aligned with runtime usage text.

---

## Maintainer Rules

1. Behavior changes must update docs and tests together.
2. New flags/settings/paths must be reflected in `docs/reference/*`.
3. Migration-impacting changes must update `docs/upgrade.md`.
4. Governance-impacting changes must review `SECURITY.md` and `CONTRIBUTING.md`.
5. Keep PR/issue templates aligned with validation gates.

---

## Anti-Patterns

Avoid:

- non-runnable command snippets
- conflicting path guidance across docs
- legacy-first onboarding language
- undocumented behavior drift between runtime and docs
