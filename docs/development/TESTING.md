# Testing Guide

Testing strategy and release gate for runtime, CLI, and docs consistency.

* * *

## Test Stack

| Layer | Tooling |
| --- | --- |
| Unit/integration tests | Vitest (`test/**/*.test.ts`) |
| Type checks | TypeScript (`tsc --noEmit`) |
| Linting | ESLint |
| Coverage | Vitest V8 coverage |

Coverage thresholds in `vitest.config.ts`: statements/branches/functions/lines >= `80`.

* * *

## Core Commands

```bash
npm run setup:dev
npm run verify
npm run verify:ci
```

Component commands:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Optional:

```bash
npm run test:watch
npm run test:coverage
npm run test:model-matrix:smoke
npm run bench:edit-formats:smoke
```

* * *

## Recommended Local Gate Before PR

1. `npm run verify`
2. `npm run test -- test/documentation.test.ts`
3. for first clone setup: `npm run setup:dev`
4. run docs command checks for newly documented command paths

## Release Gate

Run before version bump, tag, or publish workflow:

1. `npm run release:check`
2. verify changelog and release notes alignment
3. confirm PR checks are green on the release branch

* * *

## Auth/Account Change Test Matrix

| Area | Minimum checks |
| --- | --- |
| Login flow | `codex auth login` completes and stores real account data |
| Switching flow | `codex auth switch <index>` updates active account behavior |
| Health operations | `check`, `forecast`, `fix`, `doctor`, `report` produce sane output |
| Storage durability | backup/WAL recovery remains valid |
| CLI state sync | active account sync with Codex CLI files |
| Live updates | account changes picked up without restart |
| Concurrency race safety | refresh/write races covered by deterministic tests |
| Windows transient FS handling | retry behavior for `EBUSY`/`EPERM` paths |

* * *

## Manual Smoke Pack

```bash
codex auth login
codex auth list
codex auth check
codex auth forecast --live
codex auth fix --dry-run
codex auth doctor --fix --dry-run
codex auth report --live --json
```

Optional plugin-host smoke:

```bash
<run-your-host-runtime-smoke-command>
```

* * *

## Failure-Mode Scenarios

| Scenario | Expected behavior |
| --- | --- |
| OAuth callback port conflict | clean error and retry path |
| Invalid/expired refresh token | account flagged/disabled by policy tools |
| All accounts rate-limited | forecast/report show wait and recommendation |
| Storage write error | `StorageError` has actionable hint |
| Unsupported model | policy fallback or strict failure as configured |
| Stream stalls | stream failover logic engages by policy |

* * *

## Docs QA (when docs change)

1. Verify every command snippet is runnable.
2. Cross-check path references against runtime modules.
3. Confirm cross-links are valid.
4. Keep feature matrix in sync with implemented features.

* * *

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [../DOCUMENTATION.md](../DOCUMENTATION.md)
- [../benchmarks/code-edit-format-benchmark.md](../benchmarks/code-edit-format-benchmark.md)
