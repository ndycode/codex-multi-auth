# Repository Scope Map

Canonical path ownership and where to add new work.

## Top-Level Map

| Path | Purpose | Edit policy |
| --- | --- | --- |
| `index.ts` | Plugin entrypoint and orchestration | Source of truth |
| `lib/` | Runtime modules (auth, storage, rotation, request pipeline, UI) | Source of truth |
| `scripts/` | CLI wrappers, installers, benchmark scripts | Source of truth |
| `test/` | Vitest unit/integration tests | Source of truth |
| `config/` | Example OpenCode config templates | Source of truth |
| `docs/` | User + maintainer docs | Source of truth |
| `assets/` | Static assets | Source of truth |
| `dist/` | Compiled output | Generated, do not edit |

## Core Runtime Ownership

| Concern | Files |
| --- | --- |
| CLI command handling | `scripts/codex.js`, `lib/codex-manager.ts` |
| OAuth | `lib/auth/auth.ts`, `lib/auth/server.ts`, `lib/auth/browser.ts` |
| Storage and migration | `lib/storage.ts`, `lib/storage/paths.ts`, `lib/storage/migrations.ts` |
| Rotation/forecast/health | `lib/accounts.ts`, `lib/rotation.ts`, `lib/forecast.ts`, `lib/health.ts` |
| Request transform/fetch | `lib/request/request-transformer.ts`, `lib/request/fetch-helpers.ts` |
| Rate-limit retry logic | `lib/request/rate-limit-backoff.ts`, `lib/accounts/rate-limits.ts` |
| Live sync/affinity/guardian | `lib/live-account-sync.ts`, `lib/session-affinity.ts`, `lib/refresh-guardian.ts` |
| UI/TUI | `lib/ui/*`, `lib/cli.ts` |
| Prompt and model families | `lib/prompts/*`, `lib/request/helpers/model-map.ts` |

## AGENTS Scope Hierarchy

| File | Scope |
| --- | --- |
| `AGENTS.md` | Entire repository |
| `lib/AGENTS.md` | `lib/**` |
| `test/AGENTS.md` | `test/**` |

## Generated/Local Artifacts (Not Source)

| Pattern | Notes |
| --- | --- |
| `dist/**` | Build output |
| `node_modules/**` | Dependency installation |
| `coverage/**` | Coverage artifacts |
| `.tmp*`, `tmp*` | Scratch and temporary files |
| `.omx/**`, `.sisyphus/**` | Local agent/runtime state |

## Feature Placement Checklist

For new runtime behavior:

1. Add logic in `lib/` modules.
2. Wire entrypoints in `index.ts` or `lib/codex-manager.ts`.
3. Add/update config fields in `lib/schemas.ts` + `lib/config.ts`.
4. Add tests in `test/`.
5. Update docs in `README.md` and relevant `docs/*` pages.

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [TESTING.md](TESTING.md)
