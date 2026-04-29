# Local Governance Status

Base: `origin/main` at `4308b56a14c132c5df9584a7b611a02b64891b2c`

## Baseline

| Gate | Status | Notes |
| --- | --- | --- |
| `npm install` | Passed | 0 vulnerabilities reported. |
| `npm run typecheck` | Passed | Baseline before branch work. |
| `npm run lint` | Passed | Baseline before branch work. |
| `npm test` | Passed | 241 files, 3802 tests. |
| `npm run build` | Passed | Baseline before branch work. |

## PR Tracking

| PR | Branch | Status | Validation |
| --- | --- | --- | --- |
| 01 | `chore/roadmap-local-governance` | Ready for review | `npm test -- test/documentation.test.ts`; `npm run build`. |
| 02 | `feat/usage-ledger-core` | Ready for review | `npm run typecheck`; `npm test -- test/usage-ledger.test.ts`; `npm run lint`; `npm run build`. |
| 03 | `feat/usage-command` | Ready for review | `npm run typecheck`; usage command/core/docs tests; `npm run lint`; `npm run build`. |
| 04 | `feat/account-policy-controls` | Ready for review | `npm run typecheck`; account policy command/store/docs tests; `npm run lint`; `npm run build`. |
| 05 | `feat/routing-profiles-core` | Pending | Routing profile storage/project tests plus build. |
| 06 | `feat/budget-guard` | Pending | Budget guard command/evaluator tests plus build. |
| 07 | `feat/model-capability-matrix` | Pending | Model matrix tests plus `npm run test:model-matrix:smoke`. |
| 08 | `feat/runtime-policy-integration` | Pending | Runtime proxy, plugin-host retry, failure policy, request transformer, stream failover tests plus build. |
| 09 | `feat/monitor-command` | Pending | Monitor command aggregation tests plus build. |
| 10 | `feat/local-bridge-core` | Pending | Local bridge server tests plus build. |
| 11 | `feat/local-client-tokens` | Pending | Token hash lifecycle/auth tests plus build. |
| 12 | `feat/integration-generators` | Pending | Generator snapshot/docs tests plus build. |
| 13 | `docs/release-local-governance` | Pending | Full final documentation gate. |

## Current Notes

- `dist/` is generated output and must not be edited or committed.
- The initial baseline produced one snapshot working-tree marker with no content
  diff; it was restored before creating PR 01.
- If any future baseline or PR gate fails, record exact failure text in
  `open-issues.md`.
