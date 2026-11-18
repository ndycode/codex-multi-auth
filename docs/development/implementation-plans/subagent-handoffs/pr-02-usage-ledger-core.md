# PR 02 Handoff: Usage Ledger Core

> **Historical record — completed work.** This document is a planning artifact from the
> April 2026 local-governance effort. Every roadmap item below shipped in 2.1.0 and 2.2.0;
> the package is now on the 2.x line well past those releases. Branch names, "Ready for
> review" statuses, version stamps, and test counts are preserved as written at the time and
> are **not** current repository state. For how these features behave today see
> [../../../reference/commands.md](../../../reference/commands.md),
> [../../../reference/settings.md](../../../reference/settings.md), and [../../ARCHITECTURE.md](../../ARCHITECTURE.md).

Branch: `feat/usage-ledger-core`
Base: `origin/main` after PR 01 merge

## Scope

Add the local usage ledger core without command dispatch or runtime integration.

## Files Changed

- `lib/usage/types.ts`
- `lib/usage/redaction.ts`
- `lib/usage/pricing.ts`
- `lib/usage/ledger.ts`
- `lib/usage/index.ts`
- `lib/index.ts`
- `test/usage-ledger.test.ts`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-02-usage-ledger-core.md`

## Validation

- `npm run typecheck` passed.
- `npm test -- test/usage-ledger.test.ts` passed: 1 file, 6 tests.
- `npm run lint` passed.
- `npm run build` passed.

## Follow-ups

- PR 03 should add `codex-multi-auth usage` command behavior on top of these helpers.
- Runtime append calls are intentionally deferred until PR 08.
