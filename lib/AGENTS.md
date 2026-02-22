# LIB KNOWLEDGE BASE

Generated: 2026-02-03

## OVERVIEW
Core plugin logic: authentication, request pipeline, account management, prompt templates.

## STRUCTURE
```
lib/
├── accounts.ts           # multi-account pool, rotation, health scoring
├── accounts/
│   └── rate-limits.ts    # rate limit tracking per account
├── audit.ts              # rotating file audit log
├── auth/
│   ├── auth.ts           # OAuth flow (PKCE, JWT decode, token refresh)
│   ├── browser.ts        # platform-specific browser open
│   ├── server.ts         # OAuth callback server (port 1455)
│   └── token-utils.ts    # token validation, parsing
├── auth-rate-limit.ts    # token bucket for auth requests
├── auto-update-checker.ts # npm version check
├── circuit-breaker.ts    # failure isolation
├── cli.ts                # CLI helpers
├── config.ts             # plugin config parsing
├── constants.ts          # URLs, limits, labels
├── context-overflow.ts   # context length error handling
├── errors.ts             # custom error types (StorageError, etc.)
├── health.ts             # account health status
├── index.ts              # barrel exports
├── logger.ts             # debug/request logging
├── parallel-probe.ts     # parallel health checks
├── proactive-refresh.ts  # token refresh before expiry
├── prompts/
│   ├── codex.ts          # model-family prompts, GitHub ETag cache
│   ├── codex-opencode-bridge.ts  # tool remapping instructions
│   └── opencode-codex.ts # OpenCode-specific prompts
├── recovery.ts           # session recovery
├── recovery/
│   ├── constants.ts
│   ├── index.ts
│   ├── storage.ts
│   └── types.ts
├── refresh-queue.ts      # queued token refresh (race prevention)
├── request/
│   ├── fetch-helpers.ts  # Codex headers, error mapping
│   ├── helpers/
│   │   ├── input-utils.ts
│   │   ├── model-map.ts
│   │   └── tool-utils.ts
│   ├── rate-limit-backoff.ts
│   ├── request-transformer.ts  # model normalization, prompt injection
│   └── response-handler.ts     # SSE stream parsing
├── rotation.ts           # account selection algorithm
├── schemas.ts            # Zod schemas
├── shutdown.ts           # graceful shutdown
├── storage.ts            # V3 JSON storage, per-project/global
├── storage/
│   ├── migrations.ts     # V1/V2 → V3 migration
│   └── paths.ts          # project root detection
├── table-formatter.ts    # CLI table formatting
├── types.ts              # TypeScript interfaces
└── utils.ts              # shared utilities
```

## WHERE TO LOOK
| Task | Location | Notes |
| --- | --- | --- |
| Token exchange/refresh | `auth/auth.ts` | PKCE flow, JWT decode, skew window |
| Token validation | `auth/token-utils.ts` | expiry checks, parsing |
| Browser launch | `auth/browser.ts` | platform-specific open |
| Callback server | `auth/server.ts` | HTTP on port 1455 |
| URL/body transform | `request/request-transformer.ts` | model map, prompt injection |
| Headers + errors | `request/fetch-helpers.ts` | Codex headers, rate limit handling |
| SSE parsing | `request/response-handler.ts` | `response.done` extraction |
| Rate limit backoff | `request/rate-limit-backoff.ts` | exponential + jitter |
| Model family detection | `prompts/codex.ts` | GPT-5.x, Codex variants |
| Bridge prompts | `prompts/codex-opencode-bridge.ts` | tool remapping instructions |
| Account selection | `rotation.ts` | hybrid health + token bucket |
| Account rate limits | `accounts/rate-limits.ts` | per-account tracking |
| Storage format | `storage.ts` | V3 with migration from V1/V2 |
| Storage paths | `storage/paths.ts` | project root detection |
| Storage migrations | `storage/migrations.ts` | V1/V2 → V3 upgrade |
| Error types | `errors.ts` | StorageError, custom errors |
| Health monitoring | `health.ts` | account health status |
| Parallel probes | `parallel-probe.ts` | concurrent health checks |
| Graceful shutdown | `shutdown.ts` | cleanup on exit |
| Table formatting | `table-formatter.ts` | CLI output tables |
| Shared utilities | `utils.ts` | common helpers |

## CONVENTIONS
- All exports via `lib/index.ts` barrel.
- Model families defined in `prompts/codex.ts`: `MODEL_FAMILIES` constant.
- Account health: 0-100 score, decrements on failure, resets on success.
- Token bucket: per-account request tracking for rate limit avoidance.
- StorageError preserves original stack traces via `cause` parameter.

## ANTI-PATTERNS
- Never import from `dist/`; use source paths.
- Never suppress type errors.
- Never hardcode OAuth ports (use `REDIRECT_URI` constant).
