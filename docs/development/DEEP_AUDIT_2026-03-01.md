# Deep Audit Report (2026-03-01)

## Scope

- Full repository hardening audit from `origin/main` at commit `36cf5d4e5c4d30f5a98b44f5711379425c7c8b1a`.
- Runtime, test, docs/governance, and dependency surfaces.
- Executed in isolated worktree branch: `audit/deep-hardening-2026-03-01`.

## Findings

### AUD-001 (Blocker) - Documentation policy regression

- Surface: docs integrity contract (`test/documentation.test.ts`).
- Evidence: `uses scoped package only in explicit legacy migration notes` failed.
- Root cause: `docs/releases/v0.1.1.md` contained a scoped package literal outside the allowlist.
- Resolution: replaced scoped literal with generic migration-only wording and explicit link to upgrade guide.
- Files:
  - `docs/releases/v0.1.1.md`

### AUD-002 (High) - Runtime dependency vulnerability (`hono`)

- Surface: production dependency audit (`npm audit --omit=dev --audit-level=high`).
- Evidence: `hono` high severity advisory (vulnerable range included locked version).
- Resolution:
  - Raised direct dependency floor to `^4.12.2`.
  - Raised override floor to `^4.12.2`.
  - Refreshed lockfile to patched resolved version.
- Files:
  - `package.json`
  - `package-lock.json`

### AUD-003 (High, dev tooling) - Unexpected `rollup` vulnerability in audit CI

- Surface: `npm run audit:dev:allowlist`.
- Evidence: high-severity `rollup` advisory was not allowlisted and failed `audit:ci`.
- Resolution:
  - Added override `rollup: ^4.59.0`.
  - Refreshed lockfile to patched resolved version.
- Files:
  - `package.json`
  - `package-lock.json`

## Validation Evidence

- `npm run lint` -> pass
- `npm run typecheck` -> pass
- `npm run build` -> pass
- `npm test` -> pass (`87` files, `2071` tests)
- `npm test -- test/documentation.test.ts` -> pass
- `npm run audit:ci` -> pass
  - `audit:prod` reports `0` vulnerabilities
  - `audit:dev:allowlist` reports only allowlisted `minimatch` highs

## Architect Verification

- Verdict: `APPROVE` (no blockers).
- Summary:
  - Dependency strategy is minimal and compatible with current toolchain ranges.
  - Docs change aligns with existing documentation integrity policy.

## Residual Risk

- Dev-only allowlisted `minimatch` findings remain visible in `audit:dev:allowlist`; currently non-blocking under repository policy.

