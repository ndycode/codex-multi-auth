# PR 11 Handoff: Local Client Tokens

Branch: `feat/local-governance-review-stack`
Base: open local governance review stack PR

## Scope

Add local bridge client token storage that persists only SHA-256 hashes plus
prefix metadata. Plain tokens are returned only on create or rotate. The local
bridge now requires bearer tokens by default for forwarded `/v1/models` and
`/v1/responses` requests.

## Files Changed

- `lib/local-client-tokens.ts`
- `lib/local-bridge.ts`
- `lib/codex-manager/commands/bridge.ts`
- `lib/codex-manager.ts`
- `lib/codex-manager/help.ts`
- `lib/index.ts`
- `test/local-client-tokens.test.ts`
- `test/local-bridge.test.ts`
- `test/codex-manager-bridge-command.test.ts`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-11-local-client-tokens.md`

## Validation

- `npm run typecheck`
- `npm test -- test/local-client-tokens.test.ts test/local-bridge.test.ts test/codex-manager-bridge-command.test.ts`
- `npm run lint`
- `npm run build`

## Follow-ups

- PR 12 should make generated integration snippets use `CODEX_MULTI_AUTH_LOCAL_KEY`.
