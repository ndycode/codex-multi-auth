# Test Suite

This directory contains the test suite for the OpenAI Codex OAuth plugin.

**Stats**: 1498 tests across 49 test files with 89% coverage.

## Test Structure

```
test/
├── README.md                      # This file
├── accounts.test.ts               # Multi-account storage/rotation tests
├── audit.test.ts                  # Rotating file audit log tests
├── auth-rate-limit.test.ts        # Token bucket rate limiting
├── auth.test.ts                   # OAuth authentication tests
├── auto-update-checker.test.ts    # npm version check tests
├── browser.test.ts                # Platform-specific browser open behavior
├── chaos/
│   └── fault-injection.test.ts    # Chaos/fault injection tests
├── circuit-breaker.test.ts        # Failure isolation tests
├── cli.test.ts                    # CLI helper tests
├── codex-prompts.test.ts          # Codex prompt generation tests
├── codex.test.ts                  # Codex prompt/instructions behavior
├── config.test.ts                 # Configuration parsing/merging tests
├── context-overflow.test.ts       # Context length handling tests
├── copy-oauth-success.test.ts     # Build script tests
├── errors.test.ts                 # Custom error type tests
├── fetch-helpers.test.ts          # Fetch flow helper tests
├── health.test.ts                 # Account health status tests
├── index-retry.test.ts            # Plugin retry logic tests
├── index.test.ts                  # Main plugin integration tests
├── input-utils.test.ts            # Input filtering tests
├── logger.test.ts                 # Logging functionality tests
├── model-map.test.ts              # Model name normalization tests
├── oauth-server.integration.test.ts # OAuth server integration (port 1455)
├── opencode-codex.test.ts         # OpenCode-specific prompt tests
├── parallel-probe.test.ts         # Concurrent health check tests
├── paths.test.ts                  # Project root detection tests
├── plugin-config.test.ts          # Plugin config defaults + overrides
├── proactive-refresh.test.ts      # Token refresh before expiry
├── property/
│   ├── helpers.ts                 # Property test utilities
│   ├── rotation.property.test.ts  # Rotation property-based tests
│   ├── setup.test.ts              # Property test setup
│   ├── setup.ts
│   └── transformer.property.test.ts # Transformer property tests
├── rate-limit-backoff.test.ts     # Exponential backoff tests
├── recovery-constants.test.ts     # Recovery constants tests
├── recovery-storage.test.ts       # Recovery storage tests
├── recovery.test.ts               # Session recovery tests
├── refresh-queue.test.ts          # Queued token refresh tests
├── request-transformer.test.ts    # Request transformation tests
├── response-handler.test.ts       # Response handling tests
├── rotation-integration.test.ts   # Rotation integration tests
├── rotation.test.ts               # Account selection tests
├── schemas.test.ts                # Zod schema validation tests
├── server.unit.test.ts            # OAuth server unit tests
├── shutdown.test.ts               # Graceful shutdown tests
├── storage-async.test.ts          # Async storage operation tests
├── storage.test.ts                # V3 storage format tests
├── table-formatter.test.ts        # CLI table output tests
├── token-utils.test.ts            # Token validation tests
├── tool-utils.test.ts             # Tool schema helper tests
└── utils.test.ts                  # Shared utility tests
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

### response-handler.test.ts
Tests SSE to JSON conversion:
- Content-type header management
- SSE stream parsing (response.done, response.completed)
- Malformed JSON handling
- Empty stream handling
- Status preservation

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

## Test Philosophy

1. **Comprehensive Coverage**: Tests cover normal cases, edge cases, and error conditions
2. **Fast Execution**: Unit tests should remain fast and deterministic
3. **No External Dependencies**: Tests avoid real network calls
4. **Type Safety**: All tests are TypeScript with strict type checking
5. **Property-Based Testing**: Critical paths tested with randomized inputs

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
- `opencode-legacy.json`: Legacy complete example with all model variants
- `opencode-modern.json`: Variant-based example for OpenCode v1.0.210+
