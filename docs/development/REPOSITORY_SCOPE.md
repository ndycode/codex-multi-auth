# Repository Scope Map

Ownership map for source paths and documentation paths.

* * *

## Top-Level Map

| Path | Purpose |
| --- | --- |
| `index.ts` | Plugin-host runtime entry |
| `lib/` | Core runtime, auth, storage, UI, policies |
| `scripts/` | CLI wrappers and helper scripts |
| `docs/` | User docs + references + maintainer docs |
| `test/` | Unit/integration/property tests |
| `config/` | Plugin-host config examples |
| `assets/` | Static project assets |
| `dist/` | Generated build output (do not edit directly) |

* * *

## Core Runtime Ownership

| Area | Primary files |
| --- | --- |
| CLI auth manager | `lib/codex-manager.ts` |
| OAuth flow/server | `lib/auth/*` |
| Storage and paths | `lib/storage.ts`, `lib/storage/paths.ts`, `lib/runtime-paths.ts` |
| Unified settings | `lib/unified-settings.ts`, `lib/dashboard-settings.ts`, `lib/config.ts` |
| Account runtime | `lib/accounts.ts`, `lib/rotation.ts`, `lib/forecast.ts` |
| Quota runtime | `lib/quota-probe.ts`, `lib/quota-cache.ts`, `lib/preemptive-quota-scheduler.ts` |
| Resilience | `lib/live-account-sync.ts`, `lib/session-affinity.ts`, `lib/refresh-guardian.ts`, `lib/refresh-lease.ts` |
| Request pipeline | `lib/request/*`, `index.ts` |
| UI system | `lib/ui/*` |

* * *

## Documentation Ownership

| Area | Files |
| --- | --- |
| User docs | `docs/getting-started.md`, `docs/configuration.md`, `docs/troubleshooting.md`, `docs/features.md`, `docs/upgrade.md`, `docs/privacy.md` |
| Reference docs | `docs/reference/*` |
| Maintainer docs | `docs/development/*`, `docs/DOCUMENTATION.md` |
| Style and consistency | `docs/STYLE_GUIDE.md` |

* * *

## AGENTS Scope Hierarchy

Within this repo:

1. `AGENTS.md` (root scope)
2. `lib/AGENTS.md` for `lib/**`
3. `test/AGENTS.md` for `test/**`

Deeper AGENTS files override higher-level guidance for their subtree.

* * *

## Generated or Local Artifacts (Not Source)

- `dist/`
- `.tmp*` directories
- local caches/logs under runtime roots

Do not treat these as primary implementation sources.

* * *

## Feature Placement Checklist

When adding a new feature:

1. Implement runtime/module code in `lib/`.
2. Add/extend tests in `test/`.
3. Update user docs (`docs/features.md` + relevant guides).
4. Update references if command/setting/path changed.
5. Update architecture/config flow docs for cross-cutting behavior.
