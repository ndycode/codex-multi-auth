# TEST KNOWLEDGE BASE

Generated: 2026-10-06
Commit: 65b9e682 (2.19.1)

## OVERVIEW

Vitest suites for OAuth flow, request transforms, response handling, rotation logic, storage, CLI management, governance stores, repo hygiene, and more.
**~7,400 tests** (7,373 collected, 7,364 passed + 9 skipped on this tip) across **421 test files** with 80% coverage thresholds (statements/branches/functions/lines).
Execution is **single-worker by design**: `pool: 'forks'` + `fileParallelism: false` in `vitest.config.ts` and `--maxWorkers=1` in the npm `test` script, because OAuth callback suites bind the fixed port 1455 and other suites share filesystem fixtures. The forks pool is pinned explicitly (a past worker_threads-pool crash on Windows motivated tests-ci-16).

## STRUCTURE

```
test/
├── helpers/                    # global-sandbox (HOME/CODEX_HOME → temp; loads FIRST), remove-with-retry,
│                               #   owned-pids (process-tree cleanup), cli-test-fixtures
├── fixtures/                   # v3-storage.json
├── __snapshots__/              # copy-oauth-success.test.ts.snap
├── property/                   # 23 fast-check *.property.test.ts + setup.ts + setup.test.ts + helpers.ts
│                               #   (fc.configureGlobal: pinned PROPERTY_SEED, numRuns=100; seedFromTestName)
├── chaos/                      # fault-injection, fs-faults, net-faults
│
│   # ── auth & login (25) ──
├── auth, auth-logging, auth-rate-limit, auth-menu-builder / auth-menu-hotkeys / auth-menu-quota-bar,
│   account-access, browser, browser-oauth-flow, callback-guidance, cli-auth-menu, device-auth,
│   manual-oauth-flow, persist-selected-account, hydrate-emails, login-flow,
│   login-menu-accounts / login-menu-actions / login-menu-data,
│   login-oauth-callback-guidance / login-oauth-selection, login-workspace-choice,
│   oauth-server.integration (binds 1455), oauth-server-port-conflict, server.unit
│
│   # ── codex-manager CLI (35) ──
├── codex-manager-* (32): one suite per command module plus panel/helper suites (account,
│   account-pool-write, best, bridge, budget, check, cli, credentials, detail-tone, forecast,
│   formatters, help, history, integrations, login-menu-refresh, login-workspace-512,
│   manual-callback, models, monitor, org-override, quota-cache-helpers, report, resets, rotation,
│   selection-diagnostics, status, switch, uninstall-dispatch, usage, verify, why-selected, workspace)
│   + repair-commands, init-config-command, debug-bundle-redact
│
│   # ── wrapper & bins (8) ──
├── codex-multi-auth-wrapper, codex-multi-auth-bin-wrapper, codex-bin-wrapper, codex-app-router,
│   codex-routing, mcodex-launcher, mcodex-statusline-scope, router-address-probe
│
│   # ── codex-cli sync & prompts (12) ──
├── codex-cli-mirror, codex-cli-org-account-alignment, codex-cli-state, codex-cli-sync,
│   codex-cli-writer, codex-cli-writer-callers, codex-model-resolution,
│   codex, codex-prompts, codex-host-resolver, host-codex-prompt, prompt-fetch-utils
│
│   # ── accounts & selection (25) ──
├── accounts, accounts-edge, accounts-load-from-disk, accounts-routing-mutex, accounts-workspace-baseline,
│   account-check-helpers / -types, account-clear(-entry), account-manager-cache(-entry),
│   account-model-catalog, account-persistence, account-policy, account-pool, account-port,
│   account-rate-limits, account-reset-target, account-save(-entry), account-select-event,
│   account-selection, account-snapshot, account-status, account-storage-scope-entry
│
│   # ── storage & durability (35) ──
├── storage, storage-async, storage-file-lock, storage-file-paths, storage-flagged,
│   storage-health-inspection, storage-import-export, storage-last-backup, storage-named-backups,
│   storage-parser, storage-recovery-paths, storage-scope, storage-snapshot-merge,
│   flagged-entry / flagged-load-entry / flagged-save-entry / flagged-storage-io / flagged-storage,
│   pending-auth, fixture-guards, snapshot-inspectors, transactions, credential-sidecars,
│   metadata-section, record-utils, project-migration, import-export, gitignore, paths,
│   affinity-generation, crash-mid-write, multi-proc-save, resilience-storage.integration,
│   h3-token-clobber, json-store-lock
│
│   # ── backups & restore (9) ──
├── backup-metadata(-builder), backup-paths, backup-restore, named-backup-entry, named-backup-export,
│   named-backups-entry, restore-assessment, restore-backup-entry
│
│   # ── runtime proxy, rotation & regressions (73) ──
├── runtime-rotation-proxy, runtime-rotation-proxy-safe-equal, runtime-policy, runtime-policy-cache,
│   rotation-proxy-state, runtime-account-* (check, manager-cache, scope,
│   select-event, selection), runtime-auth-facade, runtime-capability-failures,
│   runtime-current-account, runtime-live-sync, runtime-manual-oauth-flow,
│   runtime-observability(-dir-mode), runtime-paths, runtime-quota-probe, runtime-refresh-guardian,
│   runtime-request-init, runtime-services, runtime-session-recovery, runtime-toast, runtime-verify-flagged
│   rotation, rotation-account-selection, rotation-integration, rotation-token-refresh,
│   routing-mutex(-config), scheduling-strategy-config, session-affinity(-entry),
│   live-account-sync(-edge), live-sync-entry, live-proxy-parallel, loader-setup, event-handler,
│   preemptive-quota-scheduler, proactive-refresh, refresh-guardian(-entry), refresh-lease,
│   refresh-queue, subscription-first-use / -quota-event / -quota-order, responses-websocket,
│   inference-activity, reset-credit-routing, reset-credits, native-account-storage/-sync,
│   native-client-auth, native-provider-config, native-rate-limits, native-wrapper-binding,
│   app-bind(-io-retry), app-helper-selection, first-run, automatic-account-checks,
│   automatic-subscription-checks, resume-picker
│   + regression suites: issue-474-pin-safety / pin-honored / pin-end-to-end / affinity-invalidation,
│   issue-689-model-capacity-retry, pr691-switch-revalidation / proxy-switch-invalidation
│
│   # ── request pipeline & models (43) ──
├── request-transformer, request-init, request-resilience, request-attempt-budget, fetch-helpers,
│   failure-policy, failover-config, rate-limit-backoff, rate-limit-decision, stream-failover(-runtime),
│   response-handler(-logging, -sse-buffer), response-compaction, response-metadata, response-outcome,
│   response-output-history, input-utils, tool-utils, wait-utils, concurrency, prototype-key-safety,
│   circuit-breaker, effort-suffix-stripping, model-map, model-route-policy, model-capability-matrix,
│   model-discovery-status, gpt56-models, gpt6-astra-models, gpt6-sol-luna-models, retired-models,
│   capability-policy, capability-boost, entitlement-cache, context-budget-guard(-proxy),
│   context-budget-response, context-budget-window-coverage, context-overflow,
│   imagegen-canonical-provider, image-runtime-lifecycle
│
│   # ── governance, quota & API routes (26) ──
├── usage-ledger, usage-extraction, usage-pricing-coverage, usage-redaction, usage-service-tier,
│   stream-usage-deferral, budget-guard, routing-profiles, quota-cache, quota-headers, quota-probe,
│   quota-readiness, quota-settings, forecast, forecast-report-shared, limits-command, health,
│   health-check, parallel-probe, local-bridge, local-client-tokens, api-login-menu,
│   api-model-capabilities, api-model-runtime, api-route-store, integration-generators
│
│   # ── oc-chatgpt interop (3) ──
├── oc-chatgpt-import-adapter, oc-chatgpt-orchestrator, oc-chatgpt-target-detection
│
│   # ── config, settings & UI (49) ──
├── config, config-explain, config-files, config-save, config-schema-generated, config-schema-templates,
│   config-toml-restore, env-parsing, plugin-config, unified-settings(-controller, -entry),
│   dashboard-display-panel, dashboard-formatters, dashboard-settings(-controller, -data, -entry),
│   settings-hub-entry / -menu / -prompt / -shared / -utils, settings-panels, settings-persist-utils,
│   settings-preview, settings-write-queue, experimental-settings-* (3), experimental-sync-target(-entry),
│   backend-category-* (3), backend-settings-* (4), select, ui-format, ui-runtime(-entry), ui-theme,
│   ansi, display-width, table-formatter, check-progress, update-notice
│
│   # ── repo, infra & misc (46) ──
├── errors, schemas, utils, fs-retry, temp-path, logger, shutdown, audit, audit-dev-allowlist,
│   audit-phase1-regression, recovery, recovery-constants, recovery-storage, cli, cli-output-contracts,
│   documentation (doc-contract), eslint-config, public-api-contract, module-boundaries, ci-workflows,
│   precommit-hook, package-bin, plugin-manifest, lockfile-version-floor, release-main-prs-regression,
│   repo-hygiene, copy-oauth-success, check-pack-budget, postinstall, preuninstall,
│   install-codex-auth(-retry), uninstall-command, uninstall-ebusy-retry, bench-format-render,
│   benchmark-render-dashboard-script, benchmark-runtime-path-script, test-model-matrix-script,
│   global-sandbox, owned-pids-helper, wsl, token-utils, hashline-tools, index, index-retry,
│   zz-stress-helper-lifecycle
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| OAuth flow | `auth.test.ts` | PKCE + JWT decoding |
| OAuth callback server | `oauth-server.integration.test.ts`, `oauth-server-port-conflict.test.ts`, `server.unit.test.ts` | binds fixed port 1455; dual-bind conflict coverage |
| Device auth | `device-auth.test.ts` | device-code polling/exchange |
| Login surfaces | `login-*.test.ts`, `login-oauth-*.test.ts`, `cli-auth-menu.test.ts`, `browser*.test.ts`, `manual-oauth-flow.test.ts` | dashboard rows, transports, callbacks |
| Token utils | `token-utils.test.ts` | validation, parsing |
| Storage core | `storage.test.ts`, `storage-async.test.ts`, `storage-snapshot-merge.test.ts`, `storage-recovery-paths.test.ts` | V3, worktree migration, merge conflicts, recovery ladder |
| Storage durability | `crash-mid-write.test.ts`, `multi-proc-save.test.ts`, `json-store-lock.test.ts`, `transactions.test.ts`, `storage-file-lock.test.ts`, `h3-token-clobber.test.ts` | torn writes, cross-process saves, CAS/lockfile |
| Backups/restore | `backup-*.test.ts`, `named-backup*.test.ts`, `restore-*.test.ts`, `storage-last-backup.test.ts` | rotation, named backups, restore planning |
| Flagged pool | `flagged-*.test.ts`, `storage-flagged.test.ts` | flagged store (no WAL, single .bak) |
| Runtime proxy | `runtime-rotation-proxy.test.ts`, `runtime-rotation-proxy-safe-equal.test.ts`, `live-proxy-parallel.test.ts` | proxy lifecycle, timing-safe auth, parallel live proxy |
| Selection tiers | `rotation-account-selection.test.ts`, `rotation.test.ts`, `rotation-integration.test.ts`, `accounts-routing-mutex.test.ts`, `routing-mutex*.test.ts`, `scheduling-strategy-config.test.ts`, `session-affinity*.test.ts` | chooseAccount order, pin discipline, mutex, affinity |
| Regressions | `issue-474-*.test.ts`, `issue-689-model-capacity-retry.test.ts`, `pr691-*.test.ts` | pin/affinity correctness, capacity retry, switch revalidation |
| Token refresh | `refresh-queue.test.ts`, `refresh-lease.test.ts`, `refresh-guardian*.test.ts`, `proactive-refresh.test.ts`, `rotation-token-refresh.test.ts` | dedup, cross-process lease, guardian |
| Quota/preemptive | `quota-*.test.ts`, `preemptive-quota-scheduler.test.ts`, `subscription-*.test.ts` | probe, cache, readiness, deferral |
| Native binding | `native-*.test.ts`, `app-bind*.test.ts`, `first-run.test.ts`, `codex-app-router.test.ts`, `router-address-probe.test.ts` | packaged-app bind path |
| Request transform | `request-transformer.test.ts`, `model-map.test.ts`, `gpt*models.test.ts`, `retired-models.test.ts`, `effort-suffix-stripping.test.ts` | normalization, model catalog, effort variants |
| Fetch/SSE | `fetch-helpers.test.ts`, `response-handler*.test.ts`, `stream-failover*.test.ts`, `response-outcome.test.ts` | headers, SSE→JSON, failover |
| Failure policy | `failure-policy.test.ts`, `rate-limit-*.test.ts`, `failover-config.test.ts`, `request-resilience.test.ts` | decision tables, backoff |
| Context budget | `context-budget-*.test.ts`, `context-overflow.test.ts` | guard thresholds, synthesized replies |
| Governance | `budget-guard.test.ts`, `routing-profiles.test.ts`, `account-policy.test.ts`, `runtime-policy*.test.ts`, `usage-*.test.ts`, `local-bridge.test.ts`, `local-client-tokens.test.ts` | stores + policy composition + ledger |
| API routes | `api-route-store.test.ts`, `api-model-*.test.ts`, `api-login-menu.test.ts` | persisted routes + non-OAuth runtime |
| CLI commands | `codex-manager-*-command.test.ts`, `codex-manager-cli.test.ts`, `repair-commands.test.ts`, `uninstall-command.test.ts`, `limits-command.test.ts` | one suite per command + settings Q cancel |
| Settings hub | `settings-hub-*.test.ts`, `settings-*.test.ts`, `unified-settings*.test.ts`, `dashboard-*.test.ts`, `backend-*.test.ts`, `experimental-*.test.ts` | panels, Q=cancel, preview, queued persist |
| Config | `config*.test.ts`, `plugin-config.test.ts`, `env-parsing.test.ts`, `config-explain.test.ts` | resolution ladder, env overrides, explain parity |
| Wrapper/bins | `codex-multi-auth-wrapper.test.ts`, `codex-multi-auth-bin-wrapper.test.ts`, `codex-bin-wrapper.test.ts`, `mcodex-*.test.ts`, `codex-routing.test.ts` | forwarding, launcher, alias routing |
| oc-chatgpt interop | `oc-chatgpt-*.test.ts` | target detect, import merge, orchestrated sync |
| Property tests | `property/` | 23 fast-check suites; pinned seed + numRuns=100 via `property/setup.ts` |
| Chaos/faults | `chaos/` | fault-injection, fs-faults, net-faults |
| Docs parity | `documentation.test.ts` | doc contract: pinned literals, command flags, naming policy |
| Public API | `public-api-contract.test.ts`, `package-bin.test.ts`, `plugin-manifest.test.ts` | exports/bins/manifest surface |
| Repo hygiene | `repo-hygiene.test.ts`, `copy-oauth-success.test.ts`, `check-pack-budget.test.ts`, `ci-workflows.test.ts`, `precommit-hook.test.ts` | scripts + CI wiring |
| Sandbox/helpers | `helpers/global-sandbox.ts`, `helpers/remove-with-retry.ts`, `helpers/owned-pids.ts` | HOME/CODEX_HOME redirect (loads first), Windows-safe rm, process cleanup |

## CONVENTIONS

- Vitest globals are enabled (`describe`, `it`, `expect`); environment is `node`.
- `test/helpers/global-sandbox.ts` is a setupFile and loads FIRST: it redirects `HOME`/`CODEX_HOME` to a throwaway temp dir so suites that forget to redirect storage paths never touch a developer's real `~/.codex`.
- `test/property/setup.ts` is the second setupFile: it wires `fc.configureGlobal` (pinned `PROPERTY_SEED`, `numRuns=100`) so property failures reproduce from CI logs.
- Single-worker execution is deliberate (`pool:'forks'`, `fileParallelism:false`, `--maxWorkers=1`): OAuth callback suites share fixed port 1455 and many suites share filesystem fixtures. Do not introduce parallelism without fixing port allocation.
- Coverage thresholds: 80% across statements/branches/functions/lines (v8 provider).
- Lint rules are relaxed for tests (see `eslint.config.js`).
- Property tests use fast-check; keep new property suites under `test/property/` so the shared setup applies.
- Windows filesystem cleanup uses `removeWithRetry` (`test/helpers/remove-with-retry.ts`) with EBUSY/EPERM/ENOTEMPTY backoff.
- Stream failover and other timer-sensitive tests use `vi.useFakeTimers()` for deterministic assertions (no real timeouts).
- OAuth server suites await port release in `afterEach` so the next single-worker file can rebind 1455.
- Module-level state in `lib/` is reset between suites via the `reset*ForTests` helpers (e.g. `resetRuntimePolicyCacheForTests`, `resetJsonStoreWriteQueuesForTests`, `resetActiveAccountSyncMetaForTests`); call them in `beforeEach`/`afterEach` when a suite touches process-global state.

## ANTI-PATTERNS

- Avoid hardcoding ports other than 1455 for OAuth server tests (it is the registered callback port).
- Do not rely on `dist/` in tests; use source files.
- Do not skip tests without justification.
- Do not use bare `fs.rm`/`fs.rmSync` in test cleanup; use `removeWithRetry` for Windows safety.
- Do not enable test parallelism or rely on test ordering; suites must be self-contained under single-worker execution.
- Do not bypass the global sandbox — never let a suite write to a real `$HOME`/`$CODEX_HOME`.
- Do not use real network/timeouts where fake timers or loopback stubs exist.
