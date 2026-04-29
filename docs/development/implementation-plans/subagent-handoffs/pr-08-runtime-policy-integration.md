# PR 08 Handoff: Runtime Policy Integration

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
  `codex auth monitor`.
