# PR 07 Handoff: Model Capability Matrix

> **Historical record — completed work.** This document is a planning artifact from the
> April 2026 local-governance effort. Every roadmap item below shipped in 2.1.0 and 2.2.0;
> the package is now on the 2.x line well past those releases. Branch names, "Ready for
> review" statuses, version stamps, and test counts are preserved as written at the time and
> are **not** current repository state. For how these features behave today see
> [../../../reference/commands.md](../../../reference/commands.md),
> [../../../reference/settings.md](../../../reference/settings.md), and [../../ARCHITECTURE.md](../../ARCHITECTURE.md).

Branch: `feat/local-governance-review-stack`
Base: `origin/main` with local governance review stack PR open

## Scope

Add local model/account capability matrix views using existing model profiles,
entitlement cache snapshots, capability policy state, and quota cache data.

## Files Changed

- `lib/model-capability-matrix.ts`
- `lib/codex-manager/commands/models.ts`
- `lib/codex-manager.ts`
- `lib/codex-manager/help.ts`
- `lib/index.ts`
- `test/model-capability-matrix.test.ts`
- `test/codex-manager-models-command.test.ts`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-07-model-capability-matrix.md`

## Validation

- `npm run typecheck`
- `npm test -- test/model-capability-matrix.test.ts test/codex-manager-models-command.test.ts test/test-model-matrix-script.test.ts`
- `npm run build`
- `npm run test:model-matrix:smoke` (3 passed, 9 skipped, 0 failed)
- `npm run lint`

## Follow-ups

- PR 08 should use this matrix data during runtime policy evaluation.

