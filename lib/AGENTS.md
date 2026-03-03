# LIB KNOWLEDGE BASE

Generated: 2026-03-01
Commit: 9ac8a84

## OVERVIEW
Core plugin logic: authentication, request pipeline, account management, prompt templates, CLI dashboard, settings hub, worktree-aware storage, and UI layer.

## STRUCTURE
```
lib/
├── accounts.ts              # multi-account pool, rotation, health scoring
├── accounts/
│   └── rate-limits.ts       # rate limit tracking per account
├── audit.ts                 # rotating file audit log
├── auth/
│   ├── auth.ts              # OAuth flow (PKCE, JWT decode, token refresh)
│   ├── browser.ts           # platform-specific browser open
│   ├── server.ts            # OAuth callback server (port 1455)
│   └── token-utils.ts       # token validation, parsing
├── auth-rate-limit.ts       # token bucket for auth requests
├── auto-update-checker.ts   # npm version check
├── capability-policy.ts     # model capability enforcement
├── circuit-breaker.ts       # failure isolation
├── cli.ts                   # CLI helpers
├── codex-cli/
│   ├── observability.ts     # runtime telemetry
│   ├── state.ts             # CLI state management
│   ├── sync.ts              # account sync coordination
│   └── writer.ts            # output formatting
├── codex-manager.ts         # CLI command dispatcher (codex auth ...)
├── codex-manager/
│   └── settings-hub.ts      # extracted interactive settings (2100 lines)
├── config.ts                # plugin config parsing (CODEX_MODE, etc.)
├── constants.ts             # URLs, limits, labels
├── context-overflow.ts      # context length error handling
├── dashboard-settings.ts    # dashboard configuration schema
├── entitlement-cache.ts     # entitlement caching
├── errors.ts                # custom error types (StorageError, etc.)
├── forecast.ts              # account forecast logic
├── health.ts                # account health status
├── index.ts                 # barrel exports
├── live-account-sync.ts     # live account synchronization
├── logger.ts                # debug/request logging
├── oauth-success.html       # OAuth success page (copied to dist/ at build)
├── parallel-probe.ts        # parallel health checks
├── preemptive-quota-scheduler.ts  # quota deferral scheduling
├── proactive-refresh.ts     # token refresh before expiry
├── prompts/
│   ├── codex.ts             # model-family prompts, GitHub ETag cache
│   ├── codex-host-bridge.ts # tool remapping instructions
│   └── host-codex-prompt.ts # Codex-specific prompts
├── quota-cache.ts           # quota state persistence
├── quota-probe.ts           # quota availability checks
├── recovery.ts              # session recovery
├── recovery/
│   ├── constants.ts         # recovery constants
│   ├── index.ts             # recovery barrel
│   ├── storage.ts           # recovery state persistence
│   └── types.ts             # recovery type definitions
├── refresh-guardian.ts      # refresh token guardian
├── refresh-lease.ts         # refresh lease management
├── refresh-queue.ts         # queued token refresh (race prevention)
├── request/
│   ├── failure-policy.ts    # retry/failover decision logic
│   ├── fetch-helpers.ts     # Codex headers, error mapping
│   ├── helpers/
│   │   ├── input-utils.ts   # input filtering
│   │   ├── model-map.ts     # model name normalization
│   │   └── tool-utils.ts    # tool schema helpers
│   ├── rate-limit-backoff.ts    # exponential + jitter backoff
│   ├── request-transformer.ts   # model normalization, prompt injection
│   ├── response-handler.ts      # SSE stream parsing
│   └── stream-failover.ts       # SSE stream recovery
├── rotation.ts              # account selection algorithm
├── runtime-paths.ts         # runtime path resolution
├── schemas.ts               # Zod schemas
├── session-affinity.ts      # session-to-account affinity
├── shutdown.ts              # graceful shutdown
├── storage.ts               # V3 JSON storage, per-project/global, worktree migration
├── storage/
│   ├── migrations.ts        # V1/V2 → V3 migration
│   └── paths.ts             # project root detection, worktree identity resolution
├── table-formatter.ts       # CLI table formatting
├── tools/
│   └── hashline-tools.ts    # hashline tool helpers
├── types.ts                 # TypeScript interfaces
├── ui/
│   ├── ansi.ts              # ANSI escape helpers
│   ├── auth-menu.ts         # interactive auth menu
│   ├── confirm.ts           # confirmation prompts
│   ├── copy.ts              # UI text/copy strings
│   ├── format.ts            # display formatting
│   ├── runtime.ts           # runtime UI utilities
│   ├── select.ts            # selection prompts
│   └── theme.ts             # TUI theming
├── unified-settings.ts      # settings persistence with EBUSY retry queue
└── utils.ts                 # shared utilities
```

## WHERE TO LOOK
| Task | Location | Notes |
| --- | --- | --- |
| Token exchange/refresh | `auth/auth.ts` | PKCE flow, JWT decode, skew window, `REDIRECT_URI` = `localhost:1455` |
| Token validation | `auth/token-utils.ts` | expiry checks, parsing |
| Browser launch | `auth/browser.ts` | platform-specific open |
| Callback server | `auth/server.ts` | HTTP on port 1455 |
| URL/body transform | `request/request-transformer.ts` | model map, prompt injection |
| Headers + errors | `request/fetch-helpers.ts` | Codex headers, rate limit handling |
| SSE parsing | `request/response-handler.ts` | `response.done` extraction |
| Stream failover | `request/stream-failover.ts` | SSE stream recovery |
| Failure policy | `request/failure-policy.ts` | retry/failover decisions |
| Rate limit backoff | `request/rate-limit-backoff.ts` | exponential + jitter |
| Model family detection | `prompts/codex.ts` | GPT-5.x, Codex variants |
| Bridge prompts | `prompts/codex-host-bridge.ts` | tool remapping instructions |
| Account selection | `rotation.ts` | hybrid health + token bucket |
| Account rate limits | `accounts/rate-limits.ts` | per-account tracking |
| Storage format | `storage.ts` | V3 with migration from V1/V2, worktree migration, email dedup |
| Storage paths | `storage/paths.ts` | project root detection, `resolveProjectStorageIdentityRoot` |
| Storage migrations | `storage/migrations.ts` | V1/V2 → V3 upgrade |
| CLI commands | `codex-manager.ts` | `codex auth login/list/check/fix/doctor/...` dispatcher |
| Settings UI | `codex-manager/settings-hub.ts` | interactive settings, Q = cancel, theme restore, EBUSY retry queue |
| CLI state | `codex-cli/state.ts` | state management |
| CLI sync | `codex-cli/sync.ts` | account sync coordination |
| Error types | `errors.ts` | StorageError, custom errors |
| Health monitoring | `health.ts` | account health status |
| Parallel probes | `parallel-probe.ts` | concurrent health checks |
| Graceful shutdown | `shutdown.ts` | cleanup on exit |
| Settings persistence | `unified-settings.ts` | queued writes, EBUSY/EPERM/EAGAIN retry |
| Table formatting | `table-formatter.ts` | CLI output tables |
| UI components | `ui/` | ansi, auth-menu, confirm, copy, format, runtime, select, theme |
| Shared utilities | `utils.ts` | common helpers |

## CONVENTIONS
- All exports via `lib/index.ts` barrel.
- Model families defined in `prompts/codex.ts`: `MODEL_FAMILIES` constant.
- Account health: 0-100 score, decrements on failure, resets on success.
- Token bucket: per-account request tracking for rate limit avoidance.
- StorageError preserves original stack traces via `cause` parameter.
- Settings hub uses Q = cancel without save; theme live-preview restores baseline on cancel.
- Settings writes queued per path with EBUSY/EPERM/EAGAIN retry (max 4 retries, exponential backoff).
- Email dedup via `normalizeEmailKey()`: trim + lowercase.
- Worktree storage: `resolveProjectStorageIdentityRoot` detects linked worktrees via `.git` file + commondir, validates gitdir backref, handles Windows UNC paths.

## ANTI-PATTERNS
- Never import from `dist/`; use source paths.
- Never suppress type errors.
- Never hardcode OAuth ports (use `REDIRECT_URI` constant).
- Never use bare `fs.rm` without retry logic (Windows antivirus locks).
- Never key project storage by worktree path directly.
