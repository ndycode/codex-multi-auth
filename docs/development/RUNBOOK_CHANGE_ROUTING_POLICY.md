# Runbook: Change Routing Policy

Safe workflow for changing account selection, fallback, retry, or failover behavior in the wrapper runtime, runtime rotation proxy, or optional plugin-host runtime. For the deeper safety path (quota inputs, explain/report surfaces), see [RUNBOOK_CHANGE_ROUTING_POLICY_SAFELY.md](RUNBOOK_CHANGE_ROUTING_POLICY_SAFELY.md).

* * *

## Goal

Adjust routing policy without obscuring why requests changed behavior.

* * *

## Primary Files

- `index.ts` — plugin-host runtime orchestration
- `lib/runtime-rotation-proxy.ts` — rotation request flow
- `lib/runtime/rotation-account-selection.ts` — `chooseAccount` tier order
- `lib/policy/runtime-policy.ts` — policy composition (budgets/tags/profiles/boosts)
- `lib/request/failure-policy.ts` — pure retry/failover decision table
- `lib/request/rate-limit-backoff.ts` — cooldown/backoff behavior
- `lib/request/stream-failover.ts` — SSE failover (pre-first-byte only)
- `lib/request/request-transformer.ts` — request invariants
- `lib/accounts.ts`, `lib/rotation.ts` — selection inputs, health state
- `test/index.test.ts`, `test/index-retry.test.ts`, `test/runtime-rotation-proxy.test.ts`, `test/rotation-account-selection.test.ts`, `test/failure-policy.test.ts`, `test/request-transformer.test.ts`, `test/stream-failover.test.ts`, `test/rate-limit-backoff.test.ts`

* * *

## Implementation Steps

1. Write down the policy change in one sentence before coding.
2. Identify which decision point the change actually touches:
   - account choice (selection tiers)
   - policy gating (budgets, tags, model allow/deny, pause/drain)
   - fallback model choice
   - retry timing / cooldown timing
   - stream failover behavior
   - runtime rotation proxy behavior
3. Add or update the narrowest tests first.
4. Preserve request invariants unless the change explicitly targets them:
   - `stream: true`
   - `store: false`
   - include `reasoning.encrypted_content`
5. Keep the skip-reason precedence intact unless the release intentionally changes it: `disabled` → `workspace-disabled` → `token-invalid` → `rate-limited` → `cooling-down` → `circuit-open`.
6. Prefer adjusting one policy decision point instead of rewriting multiple layers at once.
7. If behavior becomes harder to explain, add diagnostics or comments before merging — `codex-multi-auth why-selected`, `report`, and `rotation status` output are the operator-visible explanation surfaces.

* * *

## Validation

```bash
npm run lint
npm run typecheck
npm test -- test/index.test.ts test/index-retry.test.ts test/runtime-rotation-proxy.test.ts test/rotation-account-selection.test.ts test/failure-policy.test.ts test/request-transformer.test.ts test/stream-failover.test.ts test/rate-limit-backoff.test.ts
npm run build
```

Exercise one real routing path (`codex-multi-auth-codex exec` with rotation enabled, or `codex-multi-auth rotation status` after) to confirm the changed reasoning shows up correctly.

* * *

## Review Checklist

- policy delta is clearly stated
- request invariants remain covered
- runtime rotation stays default-on, loopback-only, and authenticated unless the release plan explicitly changes that policy
- retry or fallback changes have targeted regression tests
- reviewers can tell whether behavior changed intentionally or accidentally
- exhaustion/exit contracts (`codex_runtime_rotation_pool_exhausted`, `codex_pinned_account_unavailable`) still carry `reason`, `retry_after_ms`, and `account_skip_reasons`
- no storage or CLI refactor was mixed into the same change
