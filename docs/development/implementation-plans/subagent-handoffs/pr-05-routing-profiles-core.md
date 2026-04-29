# PR 05 Handoff: Routing Profiles Core

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
