# PROJECT KNOWLEDGE BASE

Generated: 2026-02-03
Commit: 461ea2b
Branch: main

## OVERVIEW
OpenCode plugin: intercepts OpenAI SDK calls, routes through ChatGPT Codex backend with multi-account OAuth rotation.

## STRUCTURE
```
./
├── index.ts              # plugin entry (7-step fetch pipeline, tool registration)
├── lib/                  # core logic (see lib/AGENTS.md)
├── test/                 # vitest suites (see test/AGENTS.md)
├── scripts/              # install + build helpers
├── config/               # opencode.json examples (legacy/modern)
├── docs/                 # architecture + user docs
├── assets/               # static assets
└── dist/                 # build output (generated, do not edit)
```

## WHERE TO LOOK
| Task | Location | Notes |
| --- | --- | --- |
| Plugin orchestration | `index.ts` | 7-step request pipeline, tool registration |
| OAuth flow + PKCE | `lib/auth/auth.ts` | token refresh, JWT decode |
| OAuth callback server | `lib/auth/server.ts` | binds port 1455 |
| Multi-account rotation | `lib/accounts.ts` | health scoring, cooldown, selection |
| Account storage | `lib/storage.ts` | V3 format, per-project/global paths |
| Request transformation | `lib/request/request-transformer.ts` | model normalization, prompt injection |
| Headers + rate limits | `lib/request/fetch-helpers.ts` | Codex headers, error mapping |
| SSE to JSON | `lib/request/response-handler.ts` | stream parsing |
| Prompt templates | `lib/prompts/codex.ts` | model-family detection, GitHub ETag cache |
| Config parsing | `lib/config.ts` | CODEX_MODE, plugin options |
| Session recovery | `lib/recovery/` | conversation state persistence |
| Graceful shutdown | `lib/shutdown.ts` | cleanup on process exit |
| Health monitoring | `lib/health.ts` | account health status |
| Circuit breaker | `lib/circuit-breaker.ts` | failure isolation |
| Tests | `test/` | vitest globals, 80% coverage threshold |

## CONVENTIONS
- Source: root `index.ts` + `lib/`; `dist/` is generated output.
- ESLint flat config: `no-explicit-any` enforced, unused args prefixed `_`.
- Tests relax lint rules (see `eslint.config.js`).
- Build copies `lib/oauth-success.html` to `dist/lib/` via `scripts/copy-oauth-success.js`.
- ESM only (`"type": "module"`), Node >= 18.

## ANTI-PATTERNS (THIS PROJECT)
- Do not edit `dist/` or `tmp*` directories.
- Do not use `as any`, `@ts-ignore`, `@ts-expect-error`.
- Do not open public security issues; see `SECURITY.md`.
- Do not hardcode ports other than 1455 for OAuth server.

## COMMANDS
```bash
npm run build       # tsc + copy oauth-success.html
npm run typecheck   # type checking only
npm test            # vitest once
npm run test:watch  # vitest watch mode
npm run lint        # eslint
```

## NOTES
- OAuth callback: `http://127.0.0.1:1455/auth/callback`.
- ChatGPT backend requires `store: false`, include `reasoning.encrypted_content`.
- Per-project accounts: `~/.opencode/projects/<project-key>/openai-codex-accounts.json` (walks up to find project root).
- Global accounts: `~/.opencode/openai-codex-accounts.json`.
- Prompt templates synced from Codex CLI GitHub releases with ETag caching.
- 5xx server errors trigger account rotation and health penalty (same as network errors).
- API deprecation/sunset headers (RFC 8594) are logged as warnings.
- StorageError preserves original stack traces via `cause` parameter.
- saveToDiskDebounced errors are logged but don't crash the plugin.

## SKILL MAPPING (for delegate_task)

Skills to load when delegating tasks in this codebase.

### Core Skills (load on most tasks)

| Skill | Justification |
|-------|---------------|
| `typescript-senior` | Strict mode, template literal types (`QuotaKey`), discriminated unions (`TokenResult`), Zod inference |
| `node-backend` | ESM-first, `node:crypto`, Buffer API, async patterns |
| `testing-js` | Vitest with 80% coverage threshold, `vi.mock`, `vi.useFakeTimers` |
| `mcp-builder` | Uses `@opencode-ai/plugin/tool` pattern for tool registration |

### Domain-Specific Skills (load when touching these areas)

| Skill | When to Load | Key Files |
|-------|--------------|-----------|
| `auth-patterns` | OAuth flow, PKCE, JWT, token refresh | `lib/auth/auth.ts`, `lib/refresh-queue.ts` |
| `secrets-management` | Token storage, credential handling | `lib/storage.ts`, account JSON files |
| `api-design` | Request transformation, headers, SSE | `lib/request/` directory |
| `error-observability` | Circuit breaker, health scoring, logging | `lib/circuit-breaker.ts`, `lib/logger.ts`, `lib/health.ts` |
| `git-master` | Any git operations | - |
| `github` | PRs, GitHub API (ETag caching) | `lib/prompts/codex.ts` |

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

// Git/GitHub operations
delegate_task(category="quick", load_skills=["git-master", "github"])
```
