# PR 12 Handoff: Integration Generators

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

Add deterministic integration snippets for OpenCode, OpenClaw, Python, curl,
and environment variables. Snippets use `CODEX_MULTI_AUTH_LOCAL_KEY`; the
Python snippet demonstrates `client.responses.create`, not chat completions.

## Files Changed

- `lib/integration-generators.ts`
- `lib/codex-manager/commands/integrations.ts`
- `lib/codex-manager.ts`
- `lib/codex-manager/help.ts`
- `lib/index.ts`
- `test/integration-generators.test.ts`
- `test/codex-manager-integrations-command.test.ts`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-12-integration-generators.md`

## Validation

- `npm run typecheck`
- `npm test -- test/integration-generators.test.ts test/codex-manager-integrations-command.test.ts test/documentation.test.ts`
- `npm run lint`
- `npm run build`

## Follow-ups

- PR 13 should complete the final README, changelog, storage, privacy, and
  testing docs pass.
