# Release Runbook

Maintainer checklist for preparing a reliable release from `main`.

---

## Preconditions

1. Release PR merged to `main`
2. CI checks green on latest `main`
3. Working tree clean

---

## Validation Gate

Run from repository root:

```bash
npm run release:check
```

This command runs:

1. `npm run verify`
2. `npm run test -- test/documentation.test.ts`
3. `npm pack --dry-run`

---

## Documentation Gate

Before publishing/tagging:

1. update `CHANGELOG.md`
2. add or update matching release note in `docs/releases/`
3. verify docs links in `README.md` and `docs/README.md` point to the latest stable release note

---

## Publish/Tag Flow

1. bump version in `package.json` and lockfile as needed
2. commit release metadata
3. create signed/annotated git tag
4. push commit and tag
5. verify package metadata and release notes in GitHub

---

## Rollback

If release validation fails after version bump:

1. revert release commit on branch
2. re-run `npm run release:check`
3. open a corrective PR with failure evidence
