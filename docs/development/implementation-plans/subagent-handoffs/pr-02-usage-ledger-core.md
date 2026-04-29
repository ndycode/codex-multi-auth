# PR 02 Handoff: Usage Ledger Core

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

- PR 03 should add `codex auth usage` command behavior on top of these helpers.
- Runtime append calls are intentionally deferred until PR 08.
