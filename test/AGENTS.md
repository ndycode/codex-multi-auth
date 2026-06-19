# TEST KNOWLEDGE BASE

Generated: 2026-05-02
Commit: b0ef65d

## OVERVIEW
Vitest suites for OAuth flow, request transforms, response handling, rotation logic, storage, CLI management, repo hygiene, and more.
**4909 tests** across **317 test files** with 80%+ coverage threshold.

## STRUCTURE
```
test/
├── accounts.test.ts                # multi-account storage/rotation
├── ansi.test.ts                    # ANSI escape helpers
├── audit.test.ts                   # rotating file audit log
├── auth-menu-builder.test.ts       # auth dashboard view-model formatters
├── auth-menu-hotkeys.test.ts       # auth menu hotkey behavior
├── auth-rate-limit.test.ts         # token bucket for auth
├── auth.test.ts                    # OAuth PKCE + JWT decoding
├── update-notice.test.ts           # npm version notice
├── browser.test.ts                 # platform-specific browser open
├── capability-policy.test.ts       # model capability enforcement
├── chaos/
│   └── fault-injection.test.ts     # chaos/fault injection tests
├── circuit-breaker.test.ts         # failure isolation
├── cli-auth-menu.test.ts           # CLI auth menu integration
├── cli.test.ts                     # CLI helpers
├── codex-bin-wrapper.test.ts       # bin wrapper lazy-load, missing dist handling
├── codex-cli-state.test.ts         # CLI state management
├── codex-cli-sync.test.ts          # CLI sync coordination
├── codex-host-resolver.test.ts     # host resolver
├── codex-manager-cli.test.ts       # CLI settings Q cancel, all 5 panels
├── codex-prompts.test.ts           # Codex prompt generation
├── codex-routing.test.ts           # Codex routing decisions
├── codex.test.ts                   # Codex instructions/caching
├── config-files.test.ts            # config file handling
├── config.test.ts                  # configuration parsing/merging
├── context-overflow.test.ts        # context length handling
├── copy-oauth-success.test.ts      # build script tests
├── dashboard-settings.test.ts      # dashboard settings
├── documentation.test.ts           # docs parity, CLI command flags, config precedence, governance
├── entitlement-cache.test.ts       # entitlement cache
├── errors.test.ts                  # custom error types
├── eslint-config.test.ts           # ESLint config validation
├── failure-policy.test.ts          # retry/failover policy
├── fetch-helpers.test.ts           # fetch flow helpers
├── fixtures/
│   └── v3-storage.json             # V3 storage fixture
├── forecast.test.ts                # account forecast
├── hashline-tools.test.ts          # hashline tool helpers
├── health.test.ts                  # account health status
├── host-codex-prompt.test.ts       # host-specific prompts
├── index-retry.test.ts             # plugin retry logic
├── index.test.ts                   # main plugin integration, email dedup
├── input-utils.test.ts             # input filtering
├── install-codex-auth.test.ts      # installer tests
├── live-account-sync.test.ts       # live account sync
├── health-check.test.ts            # runHealthCheck quick + live probe paths
├── logger.test.ts                  # logging functionality
├── login-flow.test.ts              # runAuthLogin transports and cap handling
├── login-menu-accounts.test.ts     # account-row assembly for the login menu
├── login-menu-actions.test.ts      # manage actions, identity re-resolution
├── login-menu-data.test.ts         # dashboard row view model, drift sync
├── login-oauth-selection.test.ts   # login-oauth account selection
├── model-map.test.ts               # model name normalization
├── oauth-server.integration.test.ts # OAuth server (port 1455)
├── package-bin.test.ts             # package.json bin field
├── parallel-probe.test.ts          # concurrent health checks
├── paths.test.ts                   # project root detection, worktree identity, UNC paths
├── plugin-config.test.ts           # plugin config defaults
├── preemptive-quota-scheduler.test.ts # quota deferral
├── proactive-refresh.test.ts       # token refresh before expiry
├── property/
│   ├── account-identity.property.test.ts # identity matching/dedup invariants
│   ├── helpers.ts                  # property test utilities
│   ├── model-fallback.property.test.ts # unsupported-model fallback invariants
│   ├── rotation.property.test.ts   # rotation property tests
│   ├── setup.test.ts               # property test setup
│   ├── setup.ts                    # property test config
│   ├── settings-write-queue.property.test.ts # write-queue ordering/clamp invariants
│   └── transformer.property.test.ts # transformer property tests
├── quota-cache.test.ts             # quota cache
├── quota-probe.test.ts             # quota probe
├── rate-limit-backoff.test.ts      # exponential backoff
├── rate-limit-decision.test.ts     # rate-limit/invalidation decision tree
├── recovery-constants.test.ts      # recovery constants
├── recovery-storage.test.ts        # recovery storage
├── recovery.test.ts                # session recovery
├── refresh-guardian.test.ts        # refresh guardian
├── refresh-lease.test.ts           # refresh lease
├── refresh-queue.test.ts           # queued token refresh
├── repo-hygiene.test.ts            # repo cleanup/check, Windows removeWithRetry
├── request-transformer.test.ts     # request body transforms
├── response-handler-logging.test.ts # SSE handler logging branches
├── response-handler.test.ts        # SSE to JSON conversion
├── rotation-account-selection.test.ts # chooseAccount tiers, pin discipline
├── rotation-integration.test.ts    # rotation integration, Windows cleanup
├── rotation-proxy-state.test.ts    # proxy state init, stale-state recovery
├── rotation-token-refresh.test.ts  # ensureFreshAccessToken refresh/cooldown
├── rotation.test.ts                # account selection
├── runtime-paths.test.ts           # runtime path resolution
├── schemas.test.ts                 # Zod schema validation
├── select.test.ts                  # select prompt tests
├── server.unit.test.ts             # OAuth server unit tests
├── session-affinity.test.ts        # session affinity
├── settings-hub-shared.test.ts     # settings merge/persist transaction
├── settings-write-queue.test.ts    # queued settings write retry policy
├── shutdown.test.ts                # graceful shutdown
├── storage-async.test.ts           # async storage operations
├── storage-recovery-paths.test.ts  # storage recovery paths
├── storage.test.ts                 # V3 storage, worktree migration, concurrent load, forged pointers
├── stream-failover.test.ts         # stream failover (fake-timer deterministic)
├── table-formatter.test.ts         # CLI table output
├── test-model-matrix-script.test.ts # model matrix script
├── token-utils.test.ts             # token validation
├── tool-utils.test.ts              # tool schema helpers
├── ui-format.test.ts               # UI formatting
├── ui-runtime.test.ts              # UI runtime
├── ui-theme.test.ts                # UI theming
├── unified-settings.test.ts        # settings persistence, EBUSY retry, write queue
└── utils.test.ts                   # shared utilities
```

## WHERE TO LOOK
| Task | Location | Notes |
| --- | --- | --- |
| OAuth flow | `auth.test.ts` | PKCE + JWT decoding |
| Token utils | `token-utils.test.ts` | validation, parsing |
| Fetch helpers | `fetch-helpers.test.ts` | headers + errors |
| Request transforms | `request-transformer.test.ts` | model normalization |
| SSE handling | `response-handler.test.ts`, `response-handler-logging.test.ts` | SSE parsing, logging branches |
| OAuth server | `oauth-server.integration.test.ts` | binds port 1455 |
| Rotation logic | `rotation.test.ts`, `rotation-integration.test.ts` | account selection, Windows cleanup |
| Property tests | `property/` | fast-check property-based tests |
| Storage | `storage.test.ts`, `storage-async.test.ts` | V3, worktree migration, concurrent load |
| Worktree paths | `paths.test.ts` | identity resolution, UNC paths, forged pointers |
| Error handling | `errors.test.ts` | custom error types |
| Circuit breaker | `circuit-breaker.test.ts` | failure isolation |
| Health checks | `health.test.ts`, `parallel-probe.test.ts` | account health |
| Chaos testing | `chaos/fault-injection.test.ts` | fault injection |
| CLI management | `codex-manager-cli.test.ts` | Q cancel across 5 panels, EBUSY/concurrent races |
| Bin wrapper | `codex-bin-wrapper.test.ts` | lazy-load, missing dist, concurrent invocations |
| Repo hygiene | `repo-hygiene.test.ts` | cleanup/check modes, Windows removeWithRetry |
| Documentation parity | `documentation.test.ts` | command flags, config precedence, changelog policy, governance |
| Settings persistence | `unified-settings.test.ts` | EBUSY/EPERM retry, temp cleanup, write queue |
| Stream failover | `stream-failover.test.ts` | fake-timer deterministic assertions |
| Email dedup | `index.test.ts` | case-insensitive dedup |
| Live sync | `live-account-sync.test.ts` | account sync |

## CONVENTIONS
- Vitest globals are enabled (`describe`, `it`, `expect`).
- Coverage thresholds: 80% across statements/branches/functions/lines.
- Lint rules are relaxed for tests (see `eslint.config.js`).
- Property tests use fast-check for randomized testing.
- Windows filesystem cleanup uses `removeWithRetry` with EBUSY/EPERM/ENOTEMPTY backoff.
- Stream failover tests use `vi.useFakeTimers()` for deterministic assertions (no real timeouts).

## ANTI-PATTERNS
- Avoid hardcoding ports other than 1455 for OAuth server tests.
- Do not rely on `dist/` in tests; use source files.
- Do not skip tests without justification.
- Do not use bare `fs.rm` in test cleanup; use `removeWithRetry` for Windows safety.
