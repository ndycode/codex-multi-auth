# Release and Rollback Runbook

Release governance for `codex-multi-auth` with provenance and rollback controls.

---

## Preconditions

1. Branch is up to date with `main`.
2. Required checks pass:
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - `npm run audit:ci`
   - `npm run perf:budget-check`
3. `secret-scan` workflow is green.

---

## Release Procedure

1. Create release tag from validated commit.
2. Publish GitHub release.
3. Trigger workflow:
   - `.github/workflows/release-provenance.yml`
4. Validate published package integrity:
   - `npm view codex-multi-auth version`
   - verify provenance is attached to the publish event.

Required release record:

- release tag
- commit SHA
- workflow run URL
- test evidence timestamp

---

## Rollback Procedure

Use rollback when `SEV-1` or unmitigated `SEV-2` occurs after release.

1. Stop further publishing.
2. Re-point consumers to previous known-good tag.
3. Open hotfix branch from previous stable SHA.
4. Re-run mandatory checks and republish fixed patch.

Rollback verification:

```bash
npm run ops:health-check
npm run audit:ci
npm run test -- test/storage.test.ts test/codex-manager-cli.test.ts
```

Rollback is complete only when:

- verification commands pass
- issue reproduction no longer occurs
- release notes include rollback details

---

## Retention and Cleanup

Run scheduled cleanup at least weekly:

```bash
npm run ops:retention-cleanup
```

Default retention is 90 days. Override for emergency cleanup:

```bash
npm run ops:retention-cleanup -- --days=30
```
