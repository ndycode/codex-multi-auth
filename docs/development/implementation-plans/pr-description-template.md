# Local Governance PR Description Template

> **Historical record — completed work.** This document is a planning artifact from the
> April 2026 local-governance effort. Every roadmap item below shipped in 2.1.0 and 2.2.0;
> the package is now on the 2.x line well past those releases. Branch names, "Ready for
> review" statuses, version stamps, and test counts are preserved as written at the time and
> are **not** current repository state. For how these features behave today see
> [../../reference/commands.md](../../reference/commands.md),
> [../../reference/settings.md](../../reference/settings.md), and [../ARCHITECTURE.md](../ARCHITECTURE.md).

Use this template for each local governance PR.

```markdown
## Summary

-

## What Changed

-

## Validation

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm test -- test/documentation.test.ts`
- [ ] `npm run build`

## Docs and Governance Checklist

- [ ] README updated (if user-visible behavior changed)
- [ ] `docs/getting-started.md` updated (if onboarding flow changed)
- [ ] `docs/features.md` updated (if capability surface changed)
- [ ] relevant `docs/reference/*` pages updated (if commands/settings/paths changed)
- [ ] `docs/upgrade.md` updated (if migration behavior changed)
- [ ] `SECURITY.md` and `CONTRIBUTING.md` reviewed for alignment

## Risk and Rollback

- Risk level:
- Rollback plan:

## Additional Notes

-
```

