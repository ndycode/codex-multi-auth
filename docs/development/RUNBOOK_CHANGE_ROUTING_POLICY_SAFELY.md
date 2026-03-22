# Runbook: Change Routing or Account-Selection Policy Safely

Use this when changing account selection, quota behavior, retry/failover logic, or forecast/report reasoning.

## Goal

Change policy without breaking request flow, account safety, or diagnostics.

## Where to Change

- `index.ts` — runtime orchestration
- `lib/accounts.ts` — account selection inputs, health state, and cooldown readiness data
- `lib/rotation.ts` — account selection
- `lib/forecast.ts` — readiness/risk forecasting
- `lib/request/failure-policy.ts` — retry/failover decisions
- `lib/request/rate-limit-backoff.ts` — cooldown/backoff behavior
- `lib/quota-probe.ts` / `lib/quota-cache.ts` — quota-derived decision inputs
- `test/accounts.test.ts`, `test/rotation.test.ts`, `test/forecast.test.ts`, `test/failure-policy.test.ts`, `test/rate-limit-backoff.test.ts`, `test/codex-manager-cli.test.ts` — policy coverage

## Safe Workflow

1. Isolate the policy change from pure code motion.
2. Update the reasoning-producing surfaces (`forecast`, `report`, diagnostics) if their output semantics change.
3. Add or update focused tests before widening scope.
4. Prefer one policy change per PR.

## Compatibility Checks

- Do not break existing JSON contract shapes unless the contract is explicitly being revised.
- If recommendation or routing reasoning changes, update the explain/report output tests too.
- Keep live-probe behavior and storage mutations covered by tests.

## QA

- `npm run typecheck`
- `npm run lint -- index.ts lib/rotation.ts lib/forecast.ts lib/request/failure-policy.ts lib/request/rate-limit-backoff.ts test/rotation.test.ts test/forecast.test.ts test/failure-policy.test.ts test/rate-limit-backoff.test.ts test/codex-manager-cli.test.ts`
- Run the targeted policy tests you touched
- Execute at least one real CLI/manual QA path that demonstrates the changed reasoning or routing behavior
