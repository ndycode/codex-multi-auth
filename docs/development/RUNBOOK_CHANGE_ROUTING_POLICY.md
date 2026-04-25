# Runbook: Change Routing Policy

Safe workflow for changing account selection, fallback, retry, or failover behavior in the wrapper runtime, runtime rotation proxy, or optional plugin-host runtime.

* * *

## Goal

Adjust routing policy without obscuring why requests changed behavior.

* * *

## Primary Files

- `index.ts`
- `lib/runtime-rotation-proxy.ts`
- `lib/request/failure-policy.ts`
- `lib/request/rate-limit-backoff.ts`
- `lib/request/stream-failover.ts`
- `lib/request/request-transformer.ts`
- `lib/accounts.ts`
- `lib/rotation.ts`
- `test/index.test.ts`
- `test/index-retry.test.ts`
- `test/runtime-rotation-proxy.test.ts`
- `test/failure-policy.test.ts`
- `test/request-transformer.test.ts`
- `test/stream-failover.test.ts`

* * *

## Implementation Steps

1. Write down the policy change in one sentence before coding.
2. Identify whether the change affects:
   - account choice
   - fallback model choice
   - retry timing
   - cooldown timing
   - stream failover behavior
   - runtime rotation proxy behavior
3. Add or update the narrowest tests first.
4. Preserve request invariants unless the change explicitly targets them:
   - `stream: true`
   - `store: false`
   - include `reasoning.encrypted_content`
5. Prefer adjusting one policy decision point instead of rewriting multiple layers at once.
6. If behavior becomes harder to explain, add diagnostics or comments before merging.

* * *

## Validation

```bash
npm run lint
npm run typecheck
npm test -- test/index.test.ts test/index-retry.test.ts test/runtime-rotation-proxy.test.ts test/failure-policy.test.ts test/request-transformer.test.ts test/stream-failover.test.ts
npm run build
```

* * *

## Review Checklist

- policy delta is clearly stated
- request invariants remain covered
- runtime rotation stays default-on, loopback-only, and authenticated unless the release plan explicitly changes that policy
- retry or fallback changes have targeted regression tests
- reviewers can tell whether behavior changed intentionally or accidentally
- no storage or CLI refactor was mixed into the same change
