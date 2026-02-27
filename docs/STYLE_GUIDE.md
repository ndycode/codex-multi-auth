# Documentation Style Guide

Use this style guide for every docs page in this repository.

* * *

## Goals

1. Beginner-first clarity.
2. Fast path first, deep details second.
3. Consistent wording and section structure.
4. Codex CLI-first tone: concise, practical, command-driven.

* * *

## Page Template

User-facing pages should follow this order:

1. Title.
2. One-line lead.
3. Quick path section.
4. Common tasks section.
5. Deeper details/reference section.
6. Troubleshooting/gotchas section (if relevant).
7. Related links.

Use `* * *` separators between major blocks for scanability.

* * *

## Writing Rules

1. Prefer short sentences and direct verbs.
2. Prefer action phrasing:
   - "Run ..."
   - "Check ..."
   - "If this fails, do ..."
3. Avoid long abstract paragraphs before commands.
4. Explain expected result after critical commands.
5. Define acronyms/jargon once in plain language.

* * *

## Command Example Rules

1. Use runnable commands.
2. Include platform-specific blocks for OS-sensitive operations.
3. Use canonical command family: `codex auth ...`.
4. Keep command blocks small and task-specific.

* * *

## Path and Terminology Rules

1. Canonical runtime root is `~/.codex/multi-auth`.
2. Legacy paths belong in migration/compat sections only.
3. Keep command/path naming consistent across all docs.
4. Do not mix old/new command families in beginner quick paths.

* * *

## Tables and Lists

1. Use compact tables for key-value or comparison data.
2. Keep table columns minimal and meaningful.
3. Use flat bullet lists (no nested bullets in docs where possible).
4. Keep long references in dedicated `docs/reference/*` pages.

* * *

## Maintainer Rules

1. Any runtime change that affects users must update:
   - `README.md`
   - `docs/getting-started.md`
   - `docs/features.md`
   - relevant reference pages
2. Any new setting/flag/path must be reflected in reference docs.
3. Keep `docs/upgrade.md` updated for command/path migration changes.
4. Keep `SECURITY.md` path guidance aligned with runtime paths.
5. Validate commands before merging documentation changes.

* * *

## Anti-Patterns

Avoid:

- command examples that are not executable
- conflicting path guidance across pages
- legacy-first wording in primary guides
- giant walls of text before actionable steps
