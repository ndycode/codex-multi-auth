# TEST KNOWLEDGE BASE

Generated: 2026-02-03

## OVERVIEW
Vitest suites for OAuth flow, request transforms, response handling, rotation logic, and more.
**1498 tests** across **49 test files** with 89% coverage.

## STRUCTURE
```
test/
├── accounts.test.ts               # multi-account storage/rotation
├── audit.test.ts                  # rotating file audit log
├── auth-rate-limit.test.ts        # token bucket for auth
├── auth.test.ts                   # OAuth PKCE + JWT decoding
├── auto-update-checker.test.ts    # npm version check
├── browser.test.ts                # platform-specific browser open
├── chaos/
│   └── fault-injection.test.ts    # chaos/fault injection tests
├── circuit-breaker.test.ts        # failure isolation
├── cli.test.ts                    # CLI helpers
├── codex-prompts.test.ts          # Codex prompt generation
├── codex.test.ts                  # Codex instructions/caching
├── config.test.ts                 # configuration parsing/merging
├── context-overflow.test.ts       # context length handling
├── copy-oauth-success.test.ts     # build script tests
├── errors.test.ts                 # custom error types
├── fetch-helpers.test.ts          # fetch flow helpers
├── health.test.ts                 # account health status
├── index-retry.test.ts            # plugin retry logic
├── index.test.ts                  # main plugin integration
├── input-utils.test.ts            # input filtering
├── logger.test.ts                 # logging functionality
├── model-map.test.ts              # model name normalization
├── oauth-server.integration.test.ts # OAuth server (port 1455)
├── opencode-codex.test.ts         # OpenCode-specific prompts
├── parallel-probe.test.ts         # concurrent health checks
├── paths.test.ts                  # project root detection
├── plugin-config.test.ts          # plugin config defaults
├── proactive-refresh.test.ts      # token refresh before expiry
├── property/
│   ├── helpers.ts                 # property test utilities
│   ├── rotation.property.test.ts  # rotation property tests
│   ├── setup.test.ts
│   ├── setup.ts
│   └── transformer.property.test.ts # transformer property tests
├── rate-limit-backoff.test.ts     # exponential backoff
├── recovery-constants.test.ts     # recovery constants
├── recovery-storage.test.ts       # recovery storage
├── recovery.test.ts               # session recovery
├── refresh-queue.test.ts          # queued token refresh
├── request-transformer.test.ts    # request body transforms
├── response-handler.test.ts       # SSE to JSON conversion
├── rotation-integration.test.ts   # rotation integration
├── rotation.test.ts               # account selection
├── schemas.test.ts                # Zod schema validation
├── server.unit.test.ts            # OAuth server unit tests
├── shutdown.test.ts               # graceful shutdown
├── storage-async.test.ts          # async storage operations
├── storage.test.ts                # V3 storage format
├── table-formatter.test.ts        # CLI table output
├── token-utils.test.ts            # token validation
├── tool-utils.test.ts             # tool schema helpers
└── utils.test.ts                  # shared utilities
```

## WHERE TO LOOK
| Task | Location | Notes |
| --- | --- | --- |
| OAuth flow | `auth.test.ts` | PKCE + JWT decoding |
| Token utils | `token-utils.test.ts` | validation, parsing |
| Fetch helpers | `fetch-helpers.test.ts` | headers + errors |
| Request transforms | `request-transformer.test.ts` | model normalization |
| SSE handling | `response-handler.test.ts` | SSE parsing |
| OAuth server | `oauth-server.integration.test.ts` | binds port 1455 |
| Rotation logic | `rotation.test.ts`, `rotation-integration.test.ts` | account selection |
| Property tests | `property/` | fast-check property-based tests |
| Storage | `storage.test.ts`, `storage-async.test.ts` | V3 format, async ops |
| Error handling | `errors.test.ts` | custom error types |
| Circuit breaker | `circuit-breaker.test.ts` | failure isolation |
| Health checks | `health.test.ts`, `parallel-probe.test.ts` | account health |
| Chaos testing | `chaos/fault-injection.test.ts` | fault injection |

## CONVENTIONS
- Vitest globals are enabled (`describe`, `it`, `expect`).
- Coverage thresholds: 80% across statements/branches/functions/lines.
- Lint rules are relaxed for tests (see `eslint.config.js`).
- Property tests use fast-check for randomized testing.

## ANTI-PATTERNS
- Avoid hardcoding ports other than 1455 for OAuth server tests.
- Do not rely on `dist/` in tests; use source files.
- Do not skip tests without justification.
