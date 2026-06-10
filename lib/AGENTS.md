# LIB KNOWLEDGE BASE

Generated: 2026-04-25
Commit: a87e005

## OVERVIEW

Core implementation for the conflict-free account manager, optional Codex CLI forwarding wrapper, OAuth/storage/runtime services, optional plugin-host request bridge, and default-on runtime Responses rotation proxy. The current architecture is manager-first: `scripts/codex-multi-auth.js` owns the primary account-management entrypoint, `scripts/codex.js` owns explicit wrapper forwarding and runtime proxy setup, while `lib/` owns account selection, storage, config, app bind, request compatibility, and diagnostics.

## STRUCTURE

```
lib/
├── accounts.ts                    # multi-account pool, health, cooldowns, persistence facade
├── accounts/
│   └── rate-limits.ts             # per-account rate limit tracking
├── auth/                          # OAuth flow, browser/manual login, callback server, token utils
├── codex-cli/                     # official Codex CLI state sync and output writer helpers
├── codex-manager.ts               # codex-multi-auth command dispatcher
├── codex-manager/
│   ├── commands/                  # focused command implementations
│   ├── settings-hub.ts            # back-compat re-export stub
│   └── settings-hub/              # shared/dashboard/backend/experimental/index panels
├── request/                       # request transform, headers, response handling, retry/failover
├── runtime/                       # Codex CLI/app integration helpers
│   ├── app-bind.ts                # persistent packaged-app bind to localhost router
│   ├── config-toml.ts             # provider config rewrite helpers
│   ├── runtime-observability.ts   # persisted runtime counters
│   ├── live-sync.ts               # runtime account sync
│   ├── quota-probe.ts             # live quota probes
│   └── ...                        # account status, app/server helpers, UI runtime support
├── runtime-rotation-proxy.ts      # loopback Responses/model proxy with account rotation
├── runtime-constants.ts           # shared runtime provider/status filenames
├── storage.ts                     # V3 account storage facade
├── storage/                       # migrations, paths, backup/restore, import/export, metadata
├── prompts/                       # model family detection and prompt/template helpers
├── recovery/                      # session recovery state
├── ui/                            # ANSI/TUI/select/copy/theme helpers
├── config.ts                      # runtime config resolution and env overrides
├── schemas.ts                     # Zod schemas for config/storage/request contracts
├── rotation.ts                    # hybrid account selection algorithm
├── quota-probe.ts                 # account quota probe orchestration
├── quota-cache.ts                 # persisted quota snapshots
├── live-account-sync.ts           # account-file live reload
├── session-affinity.ts            # session-to-account affinity store
├── refresh-queue.ts               # queued token refresh
├── refresh-lease.ts               # cross-process refresh leases
├── refresh-guardian.ts            # proactive refresh guard
├── preemptive-quota-scheduler.ts  # quota deferral scheduling
├── runtime-paths.ts               # multi-auth and Codex path resolution
├── errors.ts                      # custom errors
├── logger.ts                      # diagnostics and request logging
├── shutdown.ts                    # graceful shutdown helpers
├── table-formatter.ts             # CLI table formatting
└── index.ts                       # public barrel exports
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Runtime rotation proxy | `runtime-rotation-proxy.ts` | loopback-only Responses/model proxy, client API key auth, account rotation, streaming response forwarding |
| Runtime provider config | `runtime/config-toml.ts`, `runtime-constants.ts` | `codex-multi-auth-runtime-proxy` provider rewrite helpers |
| Packaged app bind | `runtime/app-bind.ts` | reversible user `config.toml` bind, startup entry, router status/log paths |
| Runtime observability | `runtime/runtime-observability.ts` | persisted request counters consumed by status/report |
| Token exchange/refresh | `auth/auth.ts` | PKCE flow, JWT decode, skew window, callback URL |
| OAuth callback server | `auth/server.ts` | HTTP callback on port 1455 |
| Browser/manual auth | `auth/browser.ts`, `runtime/manual-oauth-flow.ts`, `runtime/browser-oauth-flow.ts` | platform and non-TTY login paths |
| Request transform | `request/request-transformer.ts` | model map, stateless Responses defaults, prompt injection |
| Headers + errors | `request/fetch-helpers.ts` | Codex headers, deprecation/sunset warnings, rate limit handling |
| SSE parsing | `request/response-handler.ts` | stream parsing and compatibility fields |
| Stream failover | `request/stream-failover.ts` | SSE recovery |
| Failure policy | `request/failure-policy.ts` | retry/failover decisions |
| Account selection | `rotation.ts`, `accounts.ts` | hybrid health + token bucket selection |
| Account rate limits | `accounts/rate-limits.ts` | per-account tracking |
| Storage format | `storage.ts`, `storage/` | V3 storage, backup/WAL, migration, restore, import/export |
| Storage paths | `storage/paths.ts`, `runtime-paths.ts` | project root detection and runtime root resolution |
| CLI commands | `codex-manager.ts`, `codex-manager/commands/` | `codex-multi-auth login/list/check/fix/doctor/...` |
| Settings UI | `codex-manager/settings-hub/` | settings panels, Q = cancel, preview-first writes |
| Config resolution | `config.ts`, `schemas.ts` | defaults, unified settings, env overrides, config explain |
| Prompt/model families | `prompts/codex.ts` | GPT-5.x and Codex family handling |
| UI components | `ui/` | ansi, auth-menu, confirm, copy, format, runtime, select, theme |

## CONVENTIONS

- All public exports should flow through `lib/index.ts` or documented package subpaths.
- Module dependencies must stay acyclic (enforced by `import-x/no-cycle` in lint) and follow the layering
  `types/constants → storage → accounts → runtime → manager/CLI`: lower layers never import from higher ones.
  Shared types/helpers belong in the lower layer (e.g. `storage/public-types.ts`), with higher layers re-exporting
  for surface compatibility instead of lower layers importing back from facades like `lib/storage.ts`.
- Runtime rotation code must preserve pass-through semantics except for auth/provider headers that intentionally change.
- Node fetch returns decoded response bytes while preserving upstream `content-encoding`; do not forward stale decoded encoding metadata to local clients.
- Runtime proxy client-facing headers must not expose account emails or tokens.
- Runtime rotation should fail open to normal official Codex forwarding when startup helpers are unavailable.
- Account health is 0-100 and should be updated through the account manager APIs.
- Settings hub remains split under `codex-manager/settings-hub/`; keep the top-level stub as a compatibility re-export.
- Settings writes use queued retry for `EBUSY`/`EPERM`/`EAGAIN`.
- Email dedup uses `normalizeEmailKey()`: trim + lowercase.
- Worktree storage uses `resolveProjectStorageIdentityRoot`; never derive project pools from raw worktree paths.

## ANTI-PATTERNS

- Never import from `dist/` in source tests or library code.
- Never suppress type errors.
- Never hardcode OAuth ports; use the existing auth constants/helpers.
- Never add account emails/tokens to runtime proxy client responses.
- Never patch official Codex app binaries for desktop routing.
- Never use bare recursive cleanup in Windows-sensitive paths without retry handling.
- Never key project storage directly by worktree path.
