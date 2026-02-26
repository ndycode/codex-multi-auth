# Testing Guide

Testing strategy and release checks for `codex-multi-auth`.

## Test Stack

| Layer | Tooling |
| --- | --- |
| Unit/integration tests | Vitest (`test/**/*.test.ts`) |
| Type checks | TypeScript (`tsc --noEmit`) |
| Linting | ESLint flat config |
| Coverage | V8 coverage via Vitest |

Coverage thresholds configured in `vitest.config.ts`:

- statements: 80
- branches: 80
- functions: 80
- lines: 80

## Core Commands

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

## Recommended Local Gate Before PR

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run build`

## What To Test For Auth/Account Changes

| Area | Minimum checks |
| --- | --- |
| Login flow | `codex auth login` completes OAuth and stores real account |
| Listing/switching | `codex auth list` and `codex auth switch <index>` behave correctly |
| Health commands | `codex auth check`, `forecast`, `fix`, `doctor`, `report` output sane results |
| Storage durability | corrupted/partial write recovery still works (backup/WAL path) |
| Sync behavior | active account sync to Codex CLI state |
| No-restart updates | live account sync reacts to storage mutations |

## Manual Smoke Script

```bash
codex auth login
codex auth list
codex auth forecast --live
codex auth fix --dry-run
codex auth doctor --fix --dry-run
codex auth report --live --json
```

## OpenCode Plugin Smoke

```bash
opencode run "hello" --model=openai/gpt-5.1 --variant=medium
```

Validate:

- request succeeds
- no ID-related stateless errors
- fallback/rotation behavior looks correct when induced

## Failure-Mode Test Ideas

| Scenario | Expected behavior |
| --- | --- |
| OAuth callback port in use | clear error path, no crash |
| Invalid refresh token | account marked unhealthy; fix/doctor reports it |
| All accounts rate-limited | forecast/report reflect wait and recommendation |
| Storage write failure | `StorageError` includes path/code/hint |
| Unsupported model | strict/fallback policy applied per config |

## Benchmark Notes

Code edit format benchmark docs:

- [../benchmarks/code-edit-format-benchmark.md](../benchmarks/code-edit-format-benchmark.md)

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [CONFIG_FLOW.md](CONFIG_FLOW.md)

