# PROJECT KNOWLEDGE BASE

Generated: 2026-04-25
Commit: a87e005
Validated: 2026-06-10 against commit 98d9819 (repo audit; claims re-checked against the tree, content not regenerated)
Branch: main
Package version: 2.3.0-beta.1

## OVERVIEW

`codex-multi-auth` is a Codex CLI-first OAuth account manager and optional forwarding wrapper for the official Codex CLI. The installed `codex-multi-auth` entrypoint handles account-management commands locally, `codex-multi-auth-codex` forwards official Codex commands through this package's wrapper when explicitly used, and runtime rotation can route live Responses traffic through a localhost account-rotation proxy by default. The plugin-host entrypoint remains exported for compatibility, but the primary product surface is the account manager, optional wrapper, storage, runtime proxy, and repair tooling.

## STRUCTURE

```
./
├── scripts/
│   ├── codex.js              # codex-multi-auth-codex wrapper, official CLI forwarder, shadow CODEX_HOME/runtime proxy setup
│   ├── codex-multi-auth.js   # standalone package CLI entrypoint
│   ├── codex-routing.js      # auth command and compatibility alias routing
│   ├── codex-bin-resolver.js # official Codex binary discovery
│   ├── codex-app-router.js   # persistent localhost router for packaged Codex app bind
│   └── codex-app-launcher.js # reversible user-level app launcher routing helper
├── index.ts                  # optional plugin-host runtime entry
├── lib/                      # core runtime logic (see lib/AGENTS.md)
│   ├── auth/                 # OAuth flow, PKCE, callback server
│   ├── runtime/              # Codex CLI/app integration helpers, app bind, live sync, runtime observability
│   ├── request/              # request transform, SSE, failover, backoff
│   ├── storage/              # path resolution, migrations, backups, restore, import/export
│   ├── codex-cli/            # Codex CLI state sync and writer helpers
│   ├── codex-manager/        # command modules and settings panels
│   ├── prompts/              # model-family prompts, GitHub ETag cache
│   ├── recovery/             # conversation recovery state
│   ├── tools/                # hashline helper tools
│   └── ui/                   # TUI rendering, menus, copy, theme, select
├── test/                     # vitest suites (see test/AGENTS.md)
├── docs/                     # user, reference, release, audit, and maintainer docs
├── config/                   # optional plugin-host config templates
├── vendor/                   # vendored codex-ai-plugin + codex-ai-sdk shims
├── assets/                   # static assets
├── .github/                  # CI, issue/PR templates, plugin scanner fixtures
└── dist/                     # build output (generated, do not edit)
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Wrapper command routing | `scripts/codex.js`, `scripts/codex-routing.js` | `codex-multi-auth-codex auth ...` local handling, compatibility aliases, official CLI forwarding |
| Official Codex binary discovery | `scripts/codex-bin-resolver.js` | npm, native, PATH, and override resolution |
| Runtime rotation proxy | `lib/runtime-rotation-proxy.ts` | loopback Responses/model proxy, account selection, token refresh, retries, streaming response forwarding |
| Runtime proxy provider constants | `lib/runtime-constants.ts` | `codex-multi-auth-runtime-proxy`, app-helper status file |
| Shadow CODEX_HOME handling | `scripts/codex.js` | temporary provider config, state sync-back, lock cleanup, official state preservation |
| Packaged Codex app bind | `lib/runtime/app-bind.ts`, `scripts/codex-app-router.js` | reversible `config.toml` bind to persistent localhost router |
| User app launcher routing | `scripts/codex-app-launcher.js` | Windows shortcut/taskbar routing and macOS wrapper app helper |
| OAuth flow + PKCE | `lib/auth/auth.ts` | token exchange/refresh, JWT decode, callback URL |
| OAuth callback server | `lib/auth/server.ts` | binds port 1455 |
| Account pool and selection | `lib/accounts.ts`, `lib/rotation.ts` | health scoring, cooldowns, hybrid selection |
| Account storage | `lib/storage.ts`, `lib/storage/` | V3 format, per-project/global paths, worktree migration, backup/restore |
| Worktree resolution | `lib/storage/paths.ts` | repo identity root, linked-worktree detection, commondir/gitdir validation |
| Config parsing | `lib/config.ts`, `lib/schemas.ts` | `pluginConfig`, environment overrides, config explain report |
| CLI manager | `lib/codex-manager.ts`, `lib/codex-manager/commands/` | `codex-multi-auth ...` command dispatcher and command modules |
| Settings hub | `lib/codex-manager/settings-hub/` | split shared/dashboard/backend/experimental/index panels; `settings-hub.ts` is a re-export stub |
| Runtime observability | `lib/runtime/runtime-observability.ts`, `lib/codex-manager/commands/status.ts`, `lib/codex-manager/commands/report.ts` | persisted runtime counters and diagnostics |
| Request transformation | `lib/request/request-transformer.ts` | model normalization, prompt injection, Responses compatibility |
| Headers + rate limits | `lib/request/fetch-helpers.ts` | Codex headers, deprecation/sunset warnings, error mapping |
| SSE to JSON | `lib/request/response-handler.ts` | stream parsing and compatibility fields |
| Stream failover | `lib/request/stream-failover.ts` | SSE recovery |
| Failure policy | `lib/request/failure-policy.ts` | retry/failover decisions |
| Prompt templates | `lib/prompts/codex.ts` | model-family detection, GitHub ETag cache |
| Repo hygiene | `scripts/repo-hygiene.js` | `clean --mode aggressive`, `check`, Windows retry helpers |
| Tests | `test/` | Vitest, property tests, chaos tests, docs integrity tests |

## CONVENTIONS

- Source lives in root `index.ts`, `lib/`, and `scripts/`; `dist/` is generated output.
- ESM only (`"type": "module"`), Node >= 18.17.
- Canonical package name is `codex-multi-auth`.
- Canonical command family is `codex-multi-auth ...`.
- The package does not publish a global `codex` bin; `codex-multi-auth-codex` is the explicit wrapper: auth commands run locally, non-auth commands forward to official Codex.
- Runtime rotation is default-on through `codexRuntimeRotationProxy`; users can opt out with `codex-multi-auth rotation disable` or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0`.
- The runtime proxy is loopback-only and uses a per-process client token. It forwards only Responses API and model discovery requests.
- The persistent desktop app bind is reversible and edits user config/startup metadata, not official app binaries.
- OAuth callback port remains 1455.
- Local project-owned state defaults to `~/.codex/multi-auth`; official Codex state remains under `~/.codex`.
- Settings Q hotkey = cancel without save; theme live-preview restores baseline on cancel.
- Email dedup is case-insensitive via `normalizeEmailKey()` (trim + lowercase).
- Windows filesystem safety: retry transient `EBUSY`/`EPERM`/`ENOTEMPTY` cleanup and write failures where tests cover Windows locks.

## ANTI-PATTERNS

- Do not edit `dist/` or local temp/cache directories.
- Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Do not hardcode OAuth ports; use existing constants/helpers.
- Do not bypass the official Codex CLI by reimplementing general Codex commands in the wrapper.
- Keep runtime rotation default-on behavior aligned with explicit release and migration documentation.
- Do not patch official Codex app binaries; use app bind or launcher helpers.
- Do not expose account emails or tokens in runtime proxy client response headers or logs.
- Do not use bare recursive delete logic in Windows-sensitive scripts/tests without retry handling.
- Do not key project storage by worktree path; use `resolveProjectStorageIdentityRoot`.

## COMMANDS

```bash
npm run build            # tsc + copy oauth-success.html
npm run typecheck        # type checking only
npm test                 # vitest once
npm run test:coverage    # vitest with coverage report
npm run lint             # eslint (ts + scripts)
npm run clean:repo       # deterministic repo hygiene cleanup
npm run clean:repo:check # validate hygiene (CI-gated)
npm run pack:check       # build + package budget check
npm run vendor:verify    # vendored dependency provenance check
```

## NOTES

- OAuth callback: `http://127.0.0.1:1455/auth/callback`.
- ChatGPT-backed Codex request compatibility requires stateless defaults (`store: false`) unless explicit background-mode compatibility is enabled.
- Runtime rotation provider id: `codex-multi-auth-runtime-proxy`.
- Runtime rotation status: `codex-multi-auth rotation status`.
- Runtime proxy pool exhaustion returns `codex_runtime_rotation_pool_exhausted` and points to `codex-multi-auth rotation status`.
- Per-project accounts: `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`.
- Global accounts: `~/.codex/multi-auth/openai-codex-accounts.json`.
- Official Codex state: `~/.codex/auth.json`, `~/.codex/accounts.json`, `~/.codex/config.toml`.
- Runtime observability: `~/.codex/multi-auth/runtime-observability.json`.
- App helper status: `~/.codex/multi-auth/runtime-rotation-app-helper.json`.
- App bind state/logs: `~/.codex/multi-auth/app-bind/`.
- Prompt templates sync from Codex CLI GitHub releases with ETag caching.
- Historical audit evidence under `docs/audits/evidence/` is snapshot evidence, not current architecture guidance.
