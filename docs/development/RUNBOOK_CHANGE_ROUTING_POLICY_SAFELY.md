# Runbook: Change Routing or Account-Selection Policy Safely

Use this when changing account selection, quota behavior, retry/failover logic, runtime rotation proxy behavior, or forecast/report reasoning. Companion short version: [RUNBOOK_CHANGE_ROUTING_POLICY.md](RUNBOOK_CHANGE_ROUTING_POLICY.md).

* * *

## Goal

Change policy without breaking request flow, account safety, or diagnostics.

* * *

## Where to Change

- `index.ts` — optional plugin-host runtime orchestration
- `lib/runtime-rotation-proxy.ts` — wrapper/app runtime Responses routing and account rotation
- `lib/runtime/rotation-account-selection.ts` — `chooseAccount` tiers: soft pin → priority → hard pin → sequential → affinity → hybrid → scan
- `lib/policy/runtime-policy.ts`, `lib/policy/runtime-policy-cache.ts` — composed per-request decision + its caches (invalidate via fingerprint, not by mutating cached objects)
- `lib/accounts.ts` — account selection inputs, health state, cooldown readiness data
- `lib/rotation.ts` — hybrid account selection (`health*2 + tokens*5 + hoursSinceUsed*2 + capabilityBoost`)
- `lib/forecast.ts` — readiness/risk forecasting
- `lib/request/failure-policy.ts` — retry/failover decision table
- `lib/request/rate-limit-backoff.ts` — cooldown/backoff behavior
- `lib/quota-probe.ts` / `lib/quota-cache.ts` / `lib/preemptive-quota-scheduler.ts` — quota-derived decision inputs and deferral
- `test/accounts.test.ts`, `test/rotation.test.ts`, `test/rotation-account-selection.test.ts`, `test/runtime-rotation-proxy.test.ts`, `test/forecast.test.ts`, `test/failure-policy.test.ts`, `test/rate-limit-backoff.test.ts`, `test/codex-manager-cli.test.ts` — policy coverage

* * *

## Safe Workflow

1. Isolate the policy change from pure code motion.
2. Locate the decision point before editing: selection tier, `evaluateRuntimePolicy` gate, failure-policy table row, backoff/cooldown constant, or quota-deferral rule. Prefer changing one.
3. Update the reasoning-producing surfaces (`forecast`, `report --explain`, `why-selected`, `rotation status`) if their output semantics change — operators read those to explain selection.
4. Add or update focused tests before widening scope.
5. Prefer one policy change per PR.

* * *

## Compatibility Checks

- Do not break existing JSON contract shapes unless the contract is explicitly being revised.
- Do not expose account emails/tokens or stale decoded upstream encoding headers from the runtime proxy.
- Keep runtime rotation default-on and loopback-only unless the release plan explicitly changes those invariants.
- Keep request invariants (`stream: true`, `store: false`, `reasoning.encrypted_content`) unless the change explicitly targets them.
- If recommendation or routing reasoning changes, update the explain/report output tests too.
- Keep live-probe behavior and storage mutations covered by tests.
- Changes to per-request policy state must respect the `runtime-policy-cache.ts` contract: callers get `structuredClone`d values; never mutate cache-held objects.

* * *

## Validation

```bash
npm run typecheck
npm run lint -- index.ts lib/rotation.ts lib/forecast.ts lib/policy/runtime-policy.ts lib/request/failure-policy.ts lib/request/rate-limit-backoff.ts lib/runtime-rotation-proxy.ts
npm test -- test/rotation.test.ts test/rotation-account-selection.test.ts test/forecast.test.ts test/failure-policy.test.ts test/rate-limit-backoff.test.ts test/runtime-rotation-proxy.test.ts test/codex-manager-cli.test.ts
npm run build
```

Execute at least one real CLI/manual QA path that demonstrates the changed reasoning or routing behavior (for example `codex-multi-auth why-selected --last --json` or a `report --explain` run).

* * *

## Review Checklist

- policy delta stated in one sentence; only one decision point changed
- `why-selected`/`report`/`rotation status` output still explains selections truthfully
- request invariants and proxy safety boundaries unchanged (or explicitly targeted)
- exhaustion exits still carry reason + `retry_after_ms` + `account_skip_reasons`
- targeted regression tests added; no storage/CLI refactor mixed in
- cached-policy objects never mutated by callers
