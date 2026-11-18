# PR 03 Handoff: Usage Command

> **Historical record — completed work.** This document is a planning artifact from the
> April 2026 local-governance effort. Every roadmap item below shipped in 2.1.0 and 2.2.0;
> the package is now on the 2.x line well past those releases. Branch names, "Ready for
> review" statuses, version stamps, and test counts are preserved as written at the time and
> are **not** current repository state. For how these features behave today see
> [../../../reference/commands.md](../../../reference/commands.md),
> [../../../reference/settings.md](../../../reference/settings.md), and [../../ARCHITECTURE.md](../../ARCHITECTURE.md).

Branch: `feat/usage-command`
Base: `origin/main` after PR 02 merge

## Scope

Add `codex-multi-auth usage` command behavior on top of the local usage ledger core.

## Files Changed

- `lib/codex-manager/commands/usage.ts`
- `lib/codex-manager.ts`
- `lib/codex-manager/help.ts`
- `docs/reference/commands.md`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-03-usage-command.md`

## Validation

- `npm run typecheck` passed.
- `npm test -- test/codex-manager-usage-command.test.ts test/usage-ledger.test.ts test/documentation.test.ts` passed: 3 files, 36 tests.
- `npm run lint` passed.
- `npm run build` passed.

## Follow-ups

- PR 08 should add runtime usage row appends.
- PR 09 should include usage summaries in `codex-multi-auth monitor`.
