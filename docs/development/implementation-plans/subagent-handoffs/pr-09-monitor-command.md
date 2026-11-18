# PR 09 Handoff: Monitor Command

> **Historical record — completed work.** This document is a planning artifact from the
> April 2026 local-governance effort. Every roadmap item below shipped in 2.1.0 and 2.2.0;
> the package is now on the 2.x line well past those releases. Branch names, "Ready for
> review" statuses, version stamps, and test counts are preserved as written at the time and
> are **not** current repository state. For how these features behave today see
> [../../../reference/commands.md](../../../reference/commands.md),
> [../../../reference/settings.md](../../../reference/settings.md), and [../../ARCHITECTURE.md](../../ARCHITECTURE.md).

Branch: `feat/local-governance-review-stack`
Base: open local governance review stack PR

## Scope

Add `codex-multi-auth monitor` to aggregate local runtime observability, usage,
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
