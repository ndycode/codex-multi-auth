# Test Suite

This directory contains the test suite for the OpenAI Codex OAuth plugin.

**Stats**: 2071 tests across 87 test files with 80%+ coverage threshold.

## Test Structure

```
test/
├── README.md                          # This file
├── accounts.test.ts                   # Multi-account storage/rotation tests
├── ansi.test.ts                       # ANSI escape helpers
├── audit.test.ts                      # Rotating file audit log tests
├── auth-menu-hotkeys.test.ts          # Auth menu hotkey behavior
├── auth-rate-limit.test.ts            # Token bucket rate limiting
├── auth.test.ts                       # OAuth authentication tests (PKCE + JWT)
├── auto-update-checker.test.ts        # npm version check tests
├── browser.test.ts                    # Platform-specific browser open behavior
├── capability-policy.test.ts          # Model capability enforcement
├── chaos/
│   └── fault-injection.test.ts        # Chaos/fault injection tests
├── circuit-breaker.test.ts            # Failure isolation tests
├── cli-auth-menu.test.ts              # CLI auth menu integration
├── cli.test.ts                        # CLI helper tests
├── codex-bin-wrapper.test.ts          # Bin wrapper lazy-load, missing dist handling
├── codex-cli-state.test.ts            # CLI state management
├── codex-cli-sync.test.ts             # CLI sync coordination
├── codex-host-resolver.test.ts        # Host resolver
├── codex-manager-cli.test.ts          # CLI settings Q cancel, all 5 panels
├── codex-prompts.test.ts              # Codex prompt generation tests
├── codex-routing.test.ts              # Codex routing decisions
├── codex.test.ts                      # Codex prompt/instructions behavior
├── config-files.test.ts               # Config file handling
├── config.test.ts                     # Configuration parsing/merging tests
├── context-overflow.test.ts           # Context length handling tests
├── copy-oauth-success.test.ts         # Build script tests
├── dashboard-settings.test.ts         # Dashboard settings
├── documentation.test.ts              # Docs parity, CLI command flags, config precedence, governance
├── entitlement-cache.test.ts          # Entitlement cache
├── errors.test.ts                     # Custom error type tests
├── eslint-config.test.ts              # ESLint config validation
├── failure-policy.test.ts             # Retry/failover policy
├── fetch-helpers.test.ts              # Fetch flow helper tests
├── fixtures/
│   └── v3-storage.json                # V3 storage fixture
├── forecast.test.ts                   # Account forecast
├── hashline-tools.test.ts             # Hashline tool helpers
├── health.test.ts                     # Account health status tests
├── host-codex-prompt.test.ts          # Host-specific prompt tests
├── index-retry.test.ts               # Plugin retry logic tests
├── index.test.ts                      # Main plugin integration, email dedup
├── input-utils.test.ts               # Input filtering tests
├── install-codex-auth.test.ts         # Installer tests
├── live-account-sync.test.ts          # Live account sync
├── logger.test.ts                     # Logging functionality tests
├── model-map.test.ts                  # Model name normalization tests
├── oauth-server.integration.test.ts   # OAuth server integration (port 1455)
├── package-bin.test.ts                # package.json bin field
├── parallel-probe.test.ts             # Concurrent health check tests
├── paths.test.ts                      # Project root detection, worktree identity, UNC paths
├── plugin-config.test.ts              # Plugin config defaults + overrides
├── preemptive-quota-scheduler.test.ts # Quota deferral
├── proactive-refresh.test.ts          # Token refresh before expiry
├── property/
│   ├── helpers.ts                     # Property test utilities
│   ├── rotation.property.test.ts      # Rotation property-based tests
│   ├── setup.test.ts                  # Property test setup
│   ├── setup.ts                       # Property test config
│   └── transformer.property.test.ts   # Transformer property tests
├── quota-cache.test.ts                # Quota cache
├── quota-probe.test.ts                # Quota probe
├── rate-limit-backoff.test.ts         # Exponential backoff tests
├── recovery-constants.test.ts         # Recovery constants tests
├── recovery-storage.test.ts           # Recovery storage tests
├── recovery.test.ts                   # Session recovery tests
├── refresh-guardian.test.ts           # Refresh guardian
├── refresh-lease.test.ts              # Refresh lease
├── refresh-queue.test.ts              # Queued token refresh tests
├── repo-hygiene.test.ts               # Repo cleanup/check, Windows removeWithRetry
├── request-transformer.test.ts        # Request transformation tests
├── response-handler-logging.test.ts   # SSE handler logging branches
├── response-handler.test.ts           # Response handling tests (SSE to JSON)
├── rotation-integration.test.ts       # Rotation integration, Windows cleanup
├── rotation.test.ts                   # Account selection tests
├── runtime-paths.test.ts              # Runtime path resolution
├── schemas.test.ts                    # Zod schema validation tests
├── select.test.ts                     # Select prompt tests
├── server.unit.test.ts                # OAuth server unit tests
├── session-affinity.test.ts           # Session affinity
├── shutdown.test.ts                   # Graceful shutdown tests
├── storage-async.test.ts              # Async storage operation tests
├── storage-recovery-paths.test.ts     # Storage recovery paths
├── storage.test.ts                    # V3 storage, worktree migration, concurrent load, forged pointers
├── stream-failover.test.ts            # Stream failover (fake-timer deterministic)
├── table-formatter.test.ts            # CLI table output tests
├── test-model-matrix-script.test.ts   # Model matrix script
├── token-utils.test.ts               # Token validation tests
├── tool-utils.test.ts                 # Tool schema helper tests
├── ui-format.test.ts                  # UI formatting
├── ui-runtime.test.ts                 # UI runtime
├── ui-theme.test.ts                   # UI theming
├── unified-settings.test.ts           # Settings persistence, EBUSY retry, write queue
└── utils.test.ts                      # Shared utility tests
```

## Running Tests

```bash
# Run all tests once
npm test

# Watch mode (re-run on file changes)
npm run test:watch

# Visual test UI
npm run test:ui

# Generate coverage report
npm run test:coverage
```

## Test Coverage

### auth.test.ts
Tests OAuth authentication functionality:
- State generation and uniqueness
- Authorization input parsing (URL, code#state, query string formats)
- JWT decoding and payload extraction
- Authorization flow creation with PKCE
- URL parameter validation

### accounts.test.ts
Tests multi-account behavior:
- Account seeding from fallback auth
- Account rotation when rate-limited
- Cooldown handling for transient failures
- Health scoring and recovery

### config.test.ts + plugin-config.test.ts
Tests configuration parsing and merging:
- Global configuration application
- Per-model configuration overrides
- Default values and fallbacks
- Reasoning effort normalization (e.g. minimal → low for Codex families)
- Model-family detection and prompt selection

### request-transformer.test.ts
Tests request body transformations:
- Model name normalization
- Input filtering (stateless operation)
- Bridge/tool-remap message injection
- Reasoning configuration application
- Unsupported parameter removal

### response-handler.test.ts + response-handler-logging.test.ts
Tests SSE to JSON conversion:
- Content-type header management
- SSE stream parsing (response.done, response.completed)
- Malformed JSON handling
- Empty stream handling
- Status preservation
- Logging branch coverage for SSE handler

### fetch-helpers.test.ts
Tests focused helpers used in the 7-step fetch flow:
- URL rewriting
- Header construction
- Body normalization
- Request/response edge cases

### rotation.test.ts + rotation-integration.test.ts
Tests account selection algorithm:
- Health-based scoring
- Token bucket consumption
- Rate limit handling
- Account cooldown
- Windows temp dir cleanup safety

### property/
Property-based tests using fast-check:
- Rotation invariants
- Transformer edge cases
- Randomized input validation

### storage.test.ts + storage-async.test.ts
Tests V3 storage format:
- Per-project and global paths
- Migration from V1/V2
- Async operations
- Error handling
- Worktree migration and concurrent load
- Forged pointer rejection

### paths.test.ts
Tests project root detection and worktree identity:
- `resolveProjectStorageIdentityRoot` resolution
- Linked worktree commondir/gitdir validation
- UNC path support on Windows
- Forged commondir rejection

### circuit-breaker.test.ts
Tests failure isolation:
- Open/closed states
- Failure thresholds
- Recovery behavior

### health.test.ts + parallel-probe.test.ts
Tests account health monitoring:
- Health score calculations
- Concurrent health checks
- Status aggregation

### shutdown.test.ts
Tests graceful shutdown:
- Cleanup callbacks
- Signal handling
- Resource cleanup

### chaos/fault-injection.test.ts
Tests system resilience:
- Network failure simulation
- Token expiry scenarios
- Rate limit exhaustion

### codex-bin-wrapper.test.ts
Tests bin wrapper behavior:
- Lazy-load of auth runtime
- Graceful handling when dist runtime is missing
- Concurrent wrapper invocations

### codex-manager-cli.test.ts
Tests CLI settings management:
- Q hotkey cancels without saving across all 5 settings panels
- Theme live-preview restores baseline on cancel
- EBUSY/concurrent race handling

### repo-hygiene.test.ts
Tests deterministic repo hygiene tooling:
- `clean --mode aggressive` behavior
- `check` mode validation
- Windows `removeWithRetry` with EBUSY/EPERM/ENOTEMPTY backoff

### unified-settings.test.ts
Tests settings persistence:
- EBUSY/EPERM/EAGAIN retry with exponential backoff
- Temp file cleanup
- Write queue ordering

### stream-failover.test.ts
Tests SSE stream recovery:
- Fake-timer deterministic assertions (no real timeouts)
- Failover trigger conditions
- Stream reconnection

### documentation.test.ts
Tests documentation parity enforcement:
- CLI command flags match implementation
- Config precedence docs match runtime
- Changelog governance policy
- Cross-reference consistency

### index.test.ts
Tests main plugin integration:
- Plugin lifecycle
- Case-insensitive email dedup via `normalizeEmailKey()`
- Request routing

### capability-policy.test.ts + entitlement-cache.test.ts
Tests model capability enforcement:
- Unsupported model suppression
- Entitlement caching
- Policy scoring

### failure-policy.test.ts
Tests retry and failover decisions:
- Controlled retry policy
- Failover conditions
- Error classification

### UI tests (ansi, auth-menu-hotkeys, cli-auth-menu, select, ui-format, ui-runtime, ui-theme)
Tests TUI rendering and interaction:
- ANSI escape sequence helpers
- Auth menu hotkey behavior
- Select prompt navigation
- UI formatting utilities
- Runtime detection
- Theme switching and live preview

## Test Philosophy

1. **Comprehensive Coverage**: Tests cover normal cases, edge cases, and error conditions
2. **Fast Execution**: Unit tests should remain fast and deterministic
3. **No External Dependencies**: Tests avoid real network calls
4. **Type Safety**: All tests are TypeScript with strict type checking
5. **Property-Based Testing**: Critical paths tested with randomized inputs
6. **Windows Safety**: All temp dir cleanup uses `removeWithRetry` with EBUSY/EPERM/ENOTEMPTY backoff

## CI/CD Integration

Tests automatically run in GitHub Actions on:
- Every push to main
- Every pull request

The CI workflow currently tests against Node.js versions (20.x, 22.x).

## Adding New Tests

When adding new functionality:

1. Create or update the relevant test file
2. Follow the existing pattern using vitest's `describe` and `it` blocks
3. Keep tests isolated and independent of external state
4. Run `npm test` to verify all tests pass
5. Run `npm run typecheck` to ensure TypeScript types are correct

## Example Configurations

See the `config/` directory for working configuration examples:
- `codex-legacy.json`: Legacy complete example with all model variants
- `codex-modern.json`: Variant-based example for host runtime v1.0.210+
