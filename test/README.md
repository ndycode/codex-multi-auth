# Test Suite

Vitest suites covering OAuth flows, request transforms, rotation and the runtime
proxy, storage durability, the CLI manager, governance stores, repo hygiene, and
documentation parity.

**Stats**: ~7,400 tests across 421 test files with 80% coverage thresholds
(statements, branches, functions, lines). A small number of tests are skipped by
default.

For the full suite map, per-family file inventory, and contributor conventions,
see [`AGENTS.md`](./AGENTS.md) in this directory.

## Layout

```
test/
├── helpers/    # global-sandbox (redirects HOME/CODEX_HOME; loads first),
│               # remove-with-retry, owned-pids, cli-test-fixtures
├── fixtures/   # v3-storage.json
├── property/   # fast-check property suites (pinned seed, numRuns=100)
├── chaos/      # real fault injection: fs-faults, net-faults, fault-injection
└── *.test.ts   # ~390 root suites, one per module/behavior area
```

## Running tests

```bash
npm test                 # run all tests once (single worker, serial)
npm run test:watch       # watch mode
npm run test:ui          # visual test UI
npm run test:coverage    # coverage report (v8)
```

Execution is single-worker by design: OAuth callback suites bind the fixed port
1455 and many suites share filesystem fixtures, so `vitest.config.ts` pins
`pool: 'forks'` + `fileParallelism: false` and the `test` script passes
`--maxWorkers=1`. Do not parallelize without fixing port allocation.

## Conventions

- `test/helpers/global-sandbox.ts` loads first and redirects `HOME`/`CODEX_HOME`
  to a temp dir — suites can never touch a developer's real `~/.codex`.
- Property suites live in `test/property/` so the shared fast-check setup
  (pinned seed, reproducible failures) applies.
- Timer-sensitive tests use `vi.useFakeTimers()`; no real timeouts.
- Windows cleanup uses `removeWithRetry` (EBUSY/EPERM/ENOTEMPTY backoff).
- Module-level state is reset between suites via `reset*ForTests` helpers.
- `test/documentation.test.ts` enforces the doc contract: pinned literals,
  command flags, env-var existence, and naming policy — update it deliberately
  when docs or CLI surface change.

## Adding tests

1. Create or update the relevant `*.test.ts` (or `property/*.property.test.ts`).
2. Keep tests isolated; use the sandbox helpers for filesystem state.
3. Run `npm test` and `npm run typecheck` before committing.
