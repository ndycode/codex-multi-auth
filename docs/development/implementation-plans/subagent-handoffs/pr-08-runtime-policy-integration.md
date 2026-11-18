# PR 08 Handoff: Runtime Policy Integration

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

Add local runtime policy evaluation and wire it into runtime account selection.
The policy path uses local account policies, project routing profiles, budget
guards, and in-memory capability policy state where available. Runtime requests
append at most one local usage ledger row after success, failure, or policy
block.

## Files Changed

- `lib/policy/runtime-policy.ts`
- `lib/runtime-rotation-proxy.ts`
- `index.ts`
- `lib/index.ts`
- `test/runtime-policy.test.ts`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-08-runtime-policy-integration.md`

## Validation

- `npm run typecheck`
- `npm test -- test/runtime-policy.test.ts test/runtime-rotation-proxy.test.ts test/index.test.ts test/failure-policy.test.ts test/request-transformer.test.ts test/stream-failover.test.ts`
- `npm run lint`
- `npm run build`

## Follow-ups

- PR 09 should surface runtime policy, usage, profile, and budget state in
  `codex-multi-auth monitor`.
