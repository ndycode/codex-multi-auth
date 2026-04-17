# PROJECT KNOWLEDGE BASE

Generated: 2026-04-17
Commit: 1f6da97
Branch: main
Package version: 1.2.7

## OVERVIEW
Codex plugin: intercepts OpenAI SDK calls, routes through ChatGPT Codex backend with multi-account OAuth rotation. Includes CLI management dashboard, per-project/worktree account storage, and deterministic repo hygiene tooling.

## STRUCTURE
```
./
├── index.ts              # plugin entry (7-step fetch pipeline, tool registration)
├── lib/                  # core logic (see lib/AGENTS.md)
│   ├── auth/             # OAuth flow, PKCE, callback server
│   ├── accounts/         # rate limit tracking per account
│   ├── codex-cli/        # CLI state, sync, observability
│   ├── codex-manager/    # settings-hub split into 5 focused sub-modules (all <500 LOC)
│   ├── prompts/          # model-family prompts, GitHub ETag cache
│   ├── recovery/         # conversation state persistence
│   ├── request/          # request transform, SSE, rate-limit backoff
│   ├── storage/          # project root detection, worktree resolution, migrations
│   ├── tools/            # hashline tool helpers
│   └── ui/               # TUI: ansi, auth-menu, theme, select, copy
├── test/                 # vitest suites (see test/AGENTS.md)
│   ├── chaos/            # fault injection tests
│   ├── fixtures/         # test data (v3-storage.json)
│   └── property/         # fast-check property-based tests
├── scripts/              # install, build, hygiene, benchmarks
├── config/               # Codex.json examples (legacy/modern)
├── docs/                 # user + maintainer documentation
│   ├── development/      # architecture, config fields/flow, testing, TUI parity
│   ├── reference/        # commands, settings, storage paths
│   ├── releases/         # v0.1.0, v0.1.1, beta, legacy history
│   └── benchmarks/       # edit format benchmark
├── vendor/               # vendored codex-ai-plugin + codex-ai-sdk dist shims
├── assets/               # static assets
├── .github/              # CI workflows, issue/PR templates, dependabot
└── dist/                 # build output (generated, do not edit)
```

## WHERE TO LOOK
| Task | Location | Notes |
| --- | --- | --- |
| Plugin orchestration | `index.ts` | 7-step request pipeline, tool registration |
| OAuth flow + PKCE | `lib/auth/auth.ts` | token refresh, JWT decode, `REDIRECT_URI` = `127.0.0.1:1455` |
| OAuth callback server | `lib/auth/server.ts` | binds port 1455 |
| Multi-account rotation | `lib/accounts.ts` | health scoring, cooldown, selection |
| Account storage | `lib/storage.ts` | V3 format, per-project/global paths, worktree migration, case-insensitive email dedup |
| Worktree resolution | `lib/storage/paths.ts` | `resolveProjectStorageIdentityRoot`, linked worktree detection, commondir/gitdir validation |
| Storage migrations | `lib/storage/migrations.ts` | V1/V2 → V3 upgrade |
| Request transformation | `lib/request/request-transformer.ts` | model normalization, prompt injection |
| Headers + rate limits | `lib/request/fetch-helpers.ts` | Codex headers, error mapping |
| SSE to JSON | `lib/request/response-handler.ts` | stream parsing |
| Stream failover | `lib/request/stream-failover.ts` | SSE stream recovery |
| Failure policy | `lib/request/failure-policy.ts` | retry/failover decisions |
| Rate limit backoff | `lib/request/rate-limit-backoff.ts` | exponential + jitter |
| Model map | `lib/request/helpers/model-map.ts` | model name normalization |
| Prompt templates | `lib/prompts/codex.ts` | model-family detection, GitHub ETag cache |
| Config parsing | `lib/config.ts` | CODEX_MODE, plugin options |
| CLI manager | `lib/codex-manager.ts` | command dispatcher, `codex auth ...` family |
| Settings hub | `lib/codex-manager/settings-hub/` | interactive settings split into shared/dashboard/backend/experimental/index (all <500 LOC), Q = cancel without save; `settings-hub.ts` is a back-compat re-export stub |
| CLI state/sync | `lib/codex-cli/` | state management, observability, sync, writer |
| Session recovery | `lib/recovery/` | conversation state persistence |
| Graceful shutdown | `lib/shutdown.ts` | cleanup on process exit |
| Health monitoring | `lib/health.ts` | account health status |
| Circuit breaker | `lib/circuit-breaker.ts` | failure isolation |
| Unified settings | `lib/unified-settings.ts` | settings persistence with EBUSY retry |
| Dashboard settings | `lib/dashboard-settings.ts` | dashboard configuration |
| UI layer | `lib/ui/` | ansi, auth-menu, confirm, copy, format, runtime, select, theme |
| Repo hygiene | `scripts/repo-hygiene.js` | `clean --mode aggressive`, `check`, Windows `removeWithRetry` |
| Codex bin wrapper | `scripts/codex.js` | lazy-load auth runtime, graceful missing-dist handling |
| Tests | `test/` | vitest globals, 80% coverage threshold, 225 files, 3418 tests |

## CONVENTIONS
- Source: root `index.ts` + `lib/`; `dist/` is generated output.
- ESLint flat config: `no-explicit-any` enforced, unused args prefixed `_`.
- Tests relax lint rules (see `eslint.config.js`).
- Build copies `lib/oauth-success.html` to `dist/lib/` via `scripts/copy-oauth-success.js`.
- ESM only (`"type": "module"`), Node >= 18.
- Windows filesystem safety: all `fs.rm` calls in scripts/tests use `removeWithRetry` with EBUSY/EPERM/ENOTEMPTY backoff.
- Settings Q hotkey = cancel without save; theme live-preview restores baseline on cancel.
- Email dedup is case-insensitive via `normalizeEmailKey()` (trim + lowercase).

## ANTI-PATTERNS (THIS PROJECT)
- Do not edit `dist/` or `tmp*` directories.
- Do not use `as any`, `@ts-ignore`, `@ts-expect-error`.
- Do not open public security issues; see `SECURITY.md`.
- Do not hardcode ports other than 1455 for OAuth server.
- Do not use bare `fs.rm` without retry logic in scripts or test cleanup (Windows antivirus locks).
- Do not key project storage by worktree path; use `resolveProjectStorageIdentityRoot` for shared repo identity.

## COMMANDS
```bash
npm run build            # tsc + copy oauth-success.html
npm run typecheck        # type checking only
npm test                 # vitest once (225 files, 3418 tests)
npm run test:watch       # vitest watch mode
npm run test:coverage    # vitest with coverage report
npm run lint             # eslint (ts + scripts)
npm run clean:repo       # deterministic repo hygiene cleanup
npm run clean:repo:check # validate hygiene (CI-gated)
```

## NOTES
- OAuth callback: `http://127.0.0.1:1455/auth/callback`.
- ChatGPT backend requires `store: false`, include `reasoning.encrypted_content`.
- Per-project accounts: `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json` (walks up to find project root).
- Global accounts: `~/.codex/multi-auth/openai-codex-accounts.json`.
- Linked worktrees share accounts via repo identity root (commondir-based resolution).
- Legacy worktree-keyed accounts are auto-migrated on first load; legacy files retained on persist failure.
- Prompt templates synced from Codex CLI GitHub releases with ETag caching.
- 5xx server errors trigger account rotation and health penalty (same as network errors).
- API deprecation/sunset headers (RFC 8594) are logged as warnings.
- StorageError preserves original stack traces via `cause` parameter.
- saveToDiskDebounced errors are logged but don't crash the plugin.
- Settings writes use queued retry with EBUSY/EPERM/EAGAIN backoff (max 4 retries, exponential).

## SKILL MAPPING (for delegate_task)

Skills to load when delegating tasks in this codebase.

### Core Skills (load on most tasks)

| Skill | Justification |
|-------|---------------|
| `typescript-senior` | Strict mode, template literal types (`QuotaKey`), discriminated unions (`TokenResult`), Zod inference |
| `node-backend` | ESM-first, `node:crypto`, Buffer API, async patterns |
| `testing-js` | Vitest with 80% coverage threshold, `vi.mock`, `vi.useFakeTimers` |
| `mcp-builder` | Uses `@codex-ai/plugin/tool` pattern for tool registration |

### Domain-Specific Skills (load when touching these areas)

| Skill | When to Load | Key Files |
|-------|--------------|-----------|
| `auth-patterns` | OAuth flow, PKCE, JWT, token refresh | `lib/auth/auth.ts`, `lib/refresh-queue.ts` |
| `secrets-management` | Token storage, credential handling | `lib/storage.ts`, account JSON files |
| `api-design` | Request transformation, headers, SSE | `lib/request/` directory |
| `error-observability` | Circuit breaker, health scoring, logging | `lib/circuit-breaker.ts`, `lib/logger.ts`, `lib/health.ts` |
| `git-master` | Any git operations | - |
| `github` | PRs, GitHub API (ETag caching) | `lib/prompts/codex.ts` |
| `clean-architecture` | Settings hub, module extraction, refactoring | `lib/codex-manager/settings-hub.ts` |

### Situational Skills

| Skill | When to Load |
|-------|--------------|
| `clean-architecture` | Refactoring, new module design |
| `property-based-testing` | Testing rotation logic, rate-limit edge cases |

### Quick Reference

```typescript
// Auth work
delegate_task(category="...", load_skills=["typescript-senior", "node-backend", "auth-patterns", "secrets-management"])

// Request pipeline work
delegate_task(category="...", load_skills=["typescript-senior", "node-backend", "api-design", "error-observability"])

// Testing
delegate_task(category="...", load_skills=["typescript-senior", "node-backend", "testing-js"])

// Plugin architecture
delegate_task(category="...", load_skills=["typescript-senior", "node-backend", "mcp-builder"])

// CLI / Settings hub
delegate_task(category="...", load_skills=["typescript-senior", "node-backend", "clean-architecture"])

// Storage / Worktree
delegate_task(category="...", load_skills=["typescript-senior", "node-backend", "secrets-management"])

// Git/GitHub operations
delegate_task(category="quick", load_skills=["git-master", "github"])
```
