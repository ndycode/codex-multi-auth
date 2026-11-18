# PR 05 Handoff: Routing Profiles Core

> **Historical record — completed work.** This document is a planning artifact from the
> April 2026 local-governance effort. Every roadmap item below shipped in 2.1.0 and 2.2.0;
> the package is now on the 2.x line well past those releases. Branch names, "Ready for
> review" statuses, version stamps, and test counts are preserved as written at the time and
> are **not** current repository state. For how these features behave today see
> [../../../reference/commands.md](../../../reference/commands.md),
> [../../../reference/settings.md](../../../reference/settings.md), and [../../ARCHITECTURE.md](../../ARCHITECTURE.md).

Branch: `feat/routing-profiles-core`
Base: `origin/main` after PR 04 merge

## Scope

Add project-aware routing profile storage and resolution helpers. This PR does
not enforce routing profiles at runtime.

## Files Changed

- `lib/routing-profiles.ts`
- `lib/index.ts`
- `test/routing-profiles.test.ts`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-05-routing-profiles-core.md`

## Validation

- `npm run typecheck` passed.
- `npm test -- test/routing-profiles.test.ts` passed: 1 file, 2 tests.
- `npm run lint` passed.
- `npm run build` passed.

## Follow-ups

- PR 06 can attach budget limits to profile keys.
- PR 08 should enforce profiles before runtime account selection.
