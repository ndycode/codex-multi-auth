# PR 03 Handoff: Usage Command

Branch: `feat/usage-command`
Base: `origin/main` after PR 02 merge

## Scope

Add `codex auth usage` command behavior on top of the local usage ledger core.

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
- PR 09 should include usage summaries in `codex auth monitor`.
