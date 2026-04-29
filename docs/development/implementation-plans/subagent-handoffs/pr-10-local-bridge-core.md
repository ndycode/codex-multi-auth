# PR 10 Handoff: Local Bridge Core

Branch: `feat/local-governance-review-stack`
Base: open local governance review stack PR

## Scope

Add an optional loopback-only local bridge core with `/health`, `/v1/models`,
and `/v1/responses`. The bridge forwards only the narrow local integration
surface to an existing runtime proxy base URL and records local usage rows.

## Files Changed

- `lib/local-bridge.ts`
- `lib/index.ts`
- `test/local-bridge.test.ts`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-10-local-bridge-core.md`

## Validation

- `npm run typecheck`
- `npm test -- test/local-bridge.test.ts`
- `npm run lint`
- `npm run build`

## Follow-ups

- PR 11 should add hashed local client tokens and require bearer auth by
  default for bridge requests.
