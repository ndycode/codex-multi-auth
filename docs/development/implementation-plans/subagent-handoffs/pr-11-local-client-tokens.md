# PR 11 Handoff: Local Client Tokens

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
