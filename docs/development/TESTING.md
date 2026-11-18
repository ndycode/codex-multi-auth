# Testing Guide

How the test suite is organized, why it runs serially, and which commands gate a change.

* * *

## Test Stack

| Layer | Tooling |
| --- | --- |
| Unit/integration tests | Vitest 4 (`test/**/*.test.ts`, globals enabled) |
| Property tests | fast-check (`test/property/`) |
| Chaos / fault injection | `test/chaos/` (real fs + net fault injection) |
| Type checks | TypeScript (`tsc --noEmit`; `tsconfig.scripts.json` covers `scripts/`) |
| Linting | ESLint (`.ts` sources plus `scripts/**/*.{js,mjs}`) |
| Coverage | Vitest V8 |

Coverage thresholds in `vitest.config.ts`: statements / branches / functions / lines >= `80`.

Suite size: ~419 test files, ~7,230 tests (9 skipped by default). `test/documentation.test.ts` is itself part of the gate — it enforces the documentation contract (required files, pinned literals, link integrity, env-var existence).

* * *

## Why `npm test` Runs Serially

`npm test` = `vitest run --maxWorkers=1`, and `vitest.config.ts` pins `pool: 'forks'` + `fileParallelism: false`. This is deliberate, not a performance oversight:

- The OAuth suites bind the **fixed** callback port `1455` — the provider-registered redirect URI cannot be parameterized, so two parallel workers would collide on the port. `test/oauth-server.integration.test.ts` additionally awaits the port release in `afterEach`.
- Storage/CAS suites share `CODEX_MULTI_AUTH_DIR`-rooted fixtures; a global sandbox (`test/helpers/global-sandbox.ts`, loaded first via `setupFiles`) redirects every suite's `HOME`/`CODEX_HOME` into a throwaway temp dir so a forgetful suite can never touch a real `~/.codex`.
- The `forks` pool (each file in a child process) avoids a pre-existing Windows `worker_threads` crash that reproduced upstream; it is pinned so a Vitest default change cannot reintroduce it.

Do not remove `--maxWorkers=1` or raise `fileParallelism` without making port-1455 and shared-dir suites hermetic first.

## Property and Chaos Suites

- `test/property/*.property.test.ts` — fast-check randomized invariants: account identity/dedup, storage round-trips, transformer request bodies, SSE parsing, ledger redaction, budget guards, session affinity, hybrid-selector and rotation concurrency, write-queue ordering. `test/property/setup.ts` holds the global `fc` config (wired through `setupFiles` — it must stay there to take effect).
- `test/chaos/` — real fault injection against fs (`fs-faults`) and network (`net-faults`), plus live concurrency coverage (`fault-injection`); complements the deterministic unit suites with behavior under actual failures rather than mocked ones.
- `test/zz-stress-helper-lifecycle.test.ts` and multi-process/crash-mid-write suites cover helper lifecycle and cross-process storage races.

* * *

## Core Commands

```bash
npm run typecheck        # tsc --noEmit (index.ts + lib/**)
npm run typecheck:scripts # tsconfig.scripts.json (scripts/*.js, checkJs)
npm run lint             # eslint ts + scripts
npm test                 # vitest run --maxWorkers=1
npm run build            # tsc + copy oauth-success.html into dist
```

Optional:

```bash
npm run test:watch
npm run test:coverage
npm test -- test/documentation.test.ts
npm test -- test/runtime-rotation-proxy.test.ts test/codex-bin-wrapper.test.ts
npm run test:model-matrix:smoke
npm run bench:edit-formats:smoke
```

* * *

## Recommended Local Gate Before PR

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run build`
5. `npm test -- test/documentation.test.ts` when docs, command text, env vars, or config fields changed

* * *

## Auth/Account Change Test Matrix

| Area | Minimum checks |
| --- | --- |
| Login flow | `codex-multi-auth login` completes and stores real account data |
| Switching flow | `codex-multi-auth switch <index>` updates active account behavior |
| Health operations | `check`, `forecast`, `fix`, `doctor`, `report` produce sane output |
| Storage durability | WAL/backup recovery, baseline-merge, pending-auth overlay stay valid |
| CLI state sync | active account mirrored into official `~/.codex` files |
| Runtime rotation | loopback proxy startup, request forwarding, rotation, shadow-home sync-back, app-helper status |
| Local governance | usage ledger, account policies, routing profiles, budget guards, runtime policy, monitor aggregation |
| Local bridge | loopback-only health/models/responses forwarding, bearer token checks |
| Packaged app bind | config backup/restore, router state, startup entry cleanup |
| Live updates | account changes picked up without restart |
| Concurrency | refresh/write races, cross-process CAS, lease handoff under deterministic tests |
| Windows transient FS | retry behavior for `EBUSY`/`EPERM`/`ENOTEMPTY` paths |

* * *

## Manual Smoke Pack

```bash
codex-multi-auth login
codex-multi-auth list
codex-multi-auth check
codex-multi-auth forecast --live
codex-multi-auth fix --dry-run
codex-multi-auth doctor --fix --dry-run
codex-multi-auth report --live --json
codex-multi-auth usage --since 24h --by outcome
codex-multi-auth monitor --json
codex-multi-auth bridge token create --label smoke
codex-multi-auth integrations --kind python
```

Runtime rotation smoke:

```bash
codex-multi-auth rotation status
codex-multi-auth-codex exec "say hello" --model gpt-6.1-sol
```

For live smoke evidence, confirm the official Codex startup/status output shows provider `codex-multi-auth-runtime-proxy` on a localhost Responses URL. Account/quota failures after that point can still prove routing if the provider and localhost path are visible.

* * *

## Failure-Mode Scenarios

| Scenario | Expected behavior |
| --- | --- |
| OAuth callback port conflict | clean error identifying the `1455` conflict + `--device-auth`/manual fallback path |
| Invalid/expired refresh token | account flagged/disabled by policy tools |
| All accounts rate-limited | forecast/report show wait and recommendation |
| Runtime rotation pool exhausted | proxy returns `codex_runtime_rotation_pool_exhausted` with `retry_after_ms`, per-account skip reasons, and a `codex-multi-auth rotation status` hint |
| Runtime proxy upstream compression | decoded client bytes are not paired with stale `content-encoding` |
| Shadow-home sync owner write failure | orphaned lock removed or retried so later sync-back is not silently skipped |
| Storage write error | `StorageError` carries an actionable hint |
| Unsupported model | policy fallback or strict failure as configured |
| Stream stalls | stream failover engages per policy (before first byte only) |
| Baseline-less save | write proceeds LWW; `CODEX_MULTI_AUTH_BASELINELESS_SAVE` warning emitted once/path/process |

* * *

## Refactor Guardrail Checklist

Before approving a large runtime, manager, or storage refactor, run the narrow suites that protect the highest-risk invariants:

```bash
npm test -- test/index.test.ts test/index-retry.test.ts
npm test -- test/runtime-rotation-proxy.test.ts test/runtime-rotation-proxy-safe-equal.test.ts test/codex-bin-wrapper.test.ts
npm test -- test/codex-manager-cli.test.ts
npm test -- test/storage.test.ts test/storage-async.test.ts test/storage-recovery-paths.test.ts test/paths.test.ts
```

Key guardrails to watch:

- request invariants stay locked: `stream: true`, `store: false`, and `reasoning.encrypted_content`
- runtime rotation stays default-on, loopback-only, and authenticated with local client keys
- shadow-home cleanup and sync-back remain safe under Windows-style `EBUSY`/`EPERM` failures
- storage failures still produce actionable `StorageError` hints
- linked-worktree and forged-path protections remain covered by `test/paths.test.ts`
- the `loadedAccountSnapshots` merge baseline is preserved — copies of loaded storage go through `cloneTrackedAccountStorage`, never raw `structuredClone`/spread

Runbooks for common maintenance tasks:

- [RUNBOOK_ADD_AUTH_COMMAND.md](RUNBOOK_ADD_AUTH_COMMAND.md)
- [RUNBOOK_ADD_CONFIG_FIELD.md](RUNBOOK_ADD_CONFIG_FIELD.md)
- [RUNBOOK_CHANGE_ROUTING_POLICY.md](RUNBOOK_CHANGE_ROUTING_POLICY.md)
- [RUNBOOK_ADD_AUTH_MANAGER_COMMAND.md](RUNBOOK_ADD_AUTH_MANAGER_COMMAND.md)
- [RUNBOOK_ADD_CONFIG_FIELD_SAFELY.md](RUNBOOK_ADD_CONFIG_FIELD_SAFELY.md)
- [RUNBOOK_CHANGE_ROUTING_POLICY_SAFELY.md](RUNBOOK_CHANGE_ROUTING_POLICY_SAFELY.md)

* * *

## Docs QA (when docs change)

1. Verify every command snippet is runnable as written.
2. Cross-check path references against runtime modules (`lib/runtime-paths.ts`, `lib/storage.ts`, `lib/config.ts`).
3. Confirm cross-links resolve (`test/documentation.test.ts` enforces this).
4. Keep the feature matrix in sync with implemented features.
5. Never paste real tokens, account emails, or session headers into tests or docs.

* * *

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [REPOSITORY_SCOPE.md](REPOSITORY_SCOPE.md)
- [../DOCUMENTATION.md](../DOCUMENTATION.md)
- [../benchmarks/code-edit-format-benchmark.md](../benchmarks/code-edit-format-benchmark.md)
