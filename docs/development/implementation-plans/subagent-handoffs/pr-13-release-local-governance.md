# PR 13 Handoff: Release Local Governance Docs

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

Final docs pass for local usage governance and the local bridge. Updates README,
command reference, storage reference, privacy cleanup paths, testing guide,
changelog, docs portal release-candidate link, and `v2.1.0` release notes.

## Files Changed

- `README.md`
- `CHANGELOG.md`
- `docs/README.md`
- `docs/privacy.md`
- `docs/reference/commands.md`
- `docs/reference/storage-paths.md`
- `docs/development/TESTING.md`
- `docs/releases/v2.1.0.md`
- `test/documentation.test.ts`
- `docs/development/implementation-plans/status.md`
- `docs/development/implementation-plans/subagent-handoffs/pr-13-release-local-governance.md`

## Validation

- `npm run lint`
- `npm run typecheck`
- `npm test -- test/documentation.test.ts`
- `npm test`
- `npm run build`
- `npm run clean:repo:check`

## Notes

- Documentation test allowlist was narrowed to permit OpenCode references in
  `docs/reference/commands.md` for the new integration generator command.
