# PR 09 Handoff: Monitor Command

Branch: `feat/local-governance-review-stack`
Base: open local governance review stack PR

## Scope

Add `codex auth monitor` to aggregate local runtime observability, usage,
account policies, routing profile context, budget guards, model capability
matrix summary, quota cache counts, and current project context.

## Files Changed

- `lib/codex-manager/commands/monitor.ts`
- `lib/codex-manager.ts`
- `lib/codex-manager/help.ts`
- `test/codex-manager-monitor-command.test.ts`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-09-monitor-command.md`

## Validation

- `npm run typecheck`
- `npm test -- test/codex-manager-monitor-command.test.ts test/runtime-policy.test.ts`
- `npm run build`
- `npm run lint`

## Follow-ups

- PR 10 can reuse monitor output when validating local bridge state.
