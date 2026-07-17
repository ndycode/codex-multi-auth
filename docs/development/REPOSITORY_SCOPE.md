# Repository Scope Map

Ownership map for source paths and documentation paths.

* * *

## Top-Level Map

| Path | Purpose |
| --- | --- |
| `scripts/` | Installed wrapper, `mcodex` launcher, official Codex forwarder, runtime app/router helpers, repo hygiene |
| `index.ts` | Optional plugin-host runtime entry |
| `lib/` | Core auth, storage, account manager, runtime proxy, app bind, governance, UI, policies |
| `docs/` | User docs + references + maintainer docs |
| `test/` | Unit/integration/property tests |
| `config/` | Plugin-host config examples |
| `vendor/` | Vendored codex-ai-plugin + codex-ai-sdk dist shims |
| `assets/` | Static project assets |
| `dist/` | Generated build output (do not edit directly) |

* * *

## Core Runtime Ownership

| Area | Primary files |
| --- | --- |
| CLI wrapper and forwarding | `scripts/codex.js`, `scripts/codex-routing.js`, `scripts/codex-bin-resolver.js` |
| Convenience launcher | `scripts/mcodex.js` |
| CLI auth manager | `lib/codex-manager.ts` |
| Manager command modules | `lib/codex-manager/commands/*` |
| Settings hub | `lib/codex-manager/settings-hub.ts`, `lib/codex-manager/settings-hub/` |
| OAuth flow/server | `lib/auth/*` |
| Runtime rotation proxy | `lib/runtime-rotation-proxy.ts`, `lib/runtime/config-toml.ts`, `lib/runtime-constants.ts`, `lib/runtime/rotation-account-selection.ts` |
| Runtime app bind/router | `lib/runtime/app-bind.ts`, `scripts/codex-app-router.js`, `scripts/codex-app-launcher.js` |
| First-run setup | `lib/runtime/first-run.ts` |
| Runtime observability | `lib/runtime/runtime-observability.ts`, `lib/codex-manager/commands/status.ts`, `lib/codex-manager/commands/report.ts`, `lib/codex-manager/commands/rotation.ts` |
| Local bridge | `lib/local-bridge.ts`, `lib/local-client-tokens.ts`, `lib/codex-manager/commands/bridge.ts` |
| Usage ledger | `lib/usage/`, `lib/codex-manager/commands/usage.ts` |
| Budget guard | `lib/budget-guard.ts`, `lib/codex-manager/commands/budget.ts` |
| Account policy | `lib/account-policy.ts`, `lib/codex-manager/commands/account.ts` |
| Routing profiles | `lib/routing-profiles.ts` |
| Capability policy / model matrix | `lib/capability-policy.ts`, `lib/model-capability-matrix.ts`, `lib/entitlement-cache.ts`, `lib/codex-manager/commands/models.ts` |
| Runtime policy composition | `lib/policy/runtime-policy.ts` |
| Storage and paths | `lib/storage.ts`, `lib/storage/paths.ts`, `lib/runtime-paths.ts` |
| Worktree resolution | `lib/storage/paths.ts` (`resolveProjectStorageIdentityRoot`) |
| Unified settings | `lib/unified-settings.ts`, `lib/dashboard-settings.ts`, `lib/config.ts` |
| Account runtime | `lib/accounts.ts`, `lib/rotation.ts`, `lib/forecast.ts` |
| Quota runtime | `lib/quota-probe.ts`, `lib/quota-cache.ts`, `lib/preemptive-quota-scheduler.ts` |
| Resilience | `lib/live-account-sync.ts`, `lib/session-affinity.ts`, `lib/refresh-guardian.ts`, `lib/refresh-lease.ts` |
| Request pipeline | `lib/request/*`, `index.ts` |
| Optional plugin-host entry | `index.ts` |
| UI system | `lib/ui/*` |
| Repo hygiene | `scripts/repo-hygiene.js` |

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
6. Update runtime-rotation docs when forwarded Codex, shadow-home, proxy, app bind, or launcher behavior changes.
7. Update `docs/upgrade.md` and any npm-script references when command flow/build steps changed.
