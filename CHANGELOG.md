# Changelog

All notable changes to this project are documented in this file.
Dates use ISO format (`YYYY-MM-DD`).

This repository's current stable release line is `2.x`.
Current stable release notes live in `docs/releases/`.
This top-level changelog preserves the foundational `0.x` milestones and points older iteration history to `docs/releases/legacy-pre-0.1-history.md`.

## [2.3.3] - 2026-06-19

Security and durability hardening from a deep stress audit of the rotation, persistence, and SSE-handling paths. No feature changes; routing, account-selection, and the normal auth flow are unchanged.
See [docs/releases/v2.3.3.md](docs/releases/v2.3.3.md) for full details.

### Fixed

- Unbounded rate-limit window: a hostile or buggy upstream `retry-after`/quota-reset value could wedge an account unavailable for years. Retry/quota windows are now clamped to `MAX_RATE_LIMIT_DELAY_MS` (7 days), centrally in the account rate-limit setter and at source in `getQuotaNearExhaustionWaitMs` (H1)
- Refresh-lease ownership: a slow owner whose lease expired and was stolen would unlink the new owner's lock on release, collapsing cross-process mutual exclusion. The lock now carries a per-owner nonce and `release()` only unlinks when it still matches (H2)
- Cross-process token clobber: a routine `saveToDisk` rewrote the whole in-memory pool and could revert a single-use refresh token another process had just rotated. The save now reconciles token material from disk, adopting a strictly-newer on-disk token (H3)
- Transient 429 over-deferral: a 30–60s 429 benched an account for the full 2h cap by folding the benign weekly window into the wait. Only genuinely-exhausted windows now count toward a 429 deferral (H4)
- Forecast wait/recommendation: `getLiveQuotaWaitMs` took a blind max of both quota windows, overstating the wait and inverting the recommended account. It now filters to exhausted windows under usage pressure (a 429 still honors all windows) (H5)
- SSE failures misreported as success: a mid-stream `error`, or a `response.failed` event, returned the raw SSE body at HTTP 200 — recorded as an account success and skipping rotation/retry. These now route to a synthesized non-2xx (H6/H7)
- SSE `data:` parsing required a trailing space after the colon; spec-valid `data:value` lines were dropped (M1)
- V1→V3 storage migration discarded the migrated account bodies, losing the scalar `rateLimitResetTime` → map `rateLimitResetTimes` conversion, so a rate-limited account looked immediately available on upgrade (M3)
- Local-client-token store: temp-file write + rename without an `fsync` could truncate the store on crash/power-loss. The temp file is now fsynced before rename (L3)
- OAuth `expires_in`/`expires` accepted any number; a zero/negative value minted an already-expired token and triggered a tight refresh loop. Both now require a positive integer (I1)
- Log scrubber now masks the project's own `cma_local_…` bearer tokens in free text, alongside the existing JWT/hex/`sk-`/`Bearer` patterns (I2)

### Correctness note

- `response.incomplete` (e.g. hitting `max_output_tokens` or a content filter) is treated as a normal early stop: its partial response is delivered at HTTP 200 and counts as a healthy account, distinct from the `response.failed` failure path.

## [2.3.2] - 2026-06-16

Self-healing recovery for an orphaned runtime-proxy app-bind. No runtime-rotation, storage, or auth behavior changed.
See [docs/releases/v2.3.2.md](docs/releases/v2.3.2.md) for full details.

### Fixed

- Orphaned app-bind: when `config.toml` was left bound to `codex-multi-auth-runtime-proxy` but the app-bind state/backup files were gone, `rotation status` reported "not configured" and `unbind-app` was a no-op, leaving Codex routed to a dead proxy port. `unbind-app` now self-heals (restoring the provider, falling back to `openai` with no backup), `getAppBindStatus` exposes `unmanagedBind`, and status surfaces "bound but unmanaged" (#614, #615)
- Duplicate `model_provider` key in the no-backup recovery path for half-orphaned configs (proxy block present, top-level provider already native) — produced invalid TOML; the restore now never inserts a second top-level `model_provider` (#615)

## [2.3.1] - 2026-06-16

Adds the read-only `codex-multi-auth history` command. No runtime, storage, or auth behavior changed.
See [docs/releases/v2.3.1.md](docs/releases/v2.3.1.md) for full details.

### Added

- `codex-multi-auth history` (`list` / `show <id>`, both with `--json`) lists local Codex sessions across all providers by reading `<codex-home>/sessions` rollout files directly, bypassing the `model_provider` filtering that hides threads in `codex resume` while runtime rotation or app bind is active. Fixes the "history not shared across accounts" report — the split is by provider name, not account (#612, #613)

## [2.3.0] - 2026-06-15

First stable cut of the `2.3.0` line. Promotes the `2.3.0-beta` series to stable and adds three runtime-rotation durability fixes landed after `beta.3`.
See [docs/releases/v2.3.0.md](docs/releases/v2.3.0.md) for full details.

### Fixed

- Stale-runtime recovery deadlock: the rotation proxy returned a permanent `503 "All managed Codex accounts are temporarily unavailable"` even with healthy accounts, because persisted per-account transient state (cooldowns, rate-limit windows) was restored on reload and the recovery guard refused to run against it (#606, #607)
- Cooldown not persisted when an account has no resolvable `accountId` — a restart inside the window dropped the cooldown and re-selected the broken account (#608)
- Rate-limit window not persisted in the short-retry 429 path — same durability gap as the missing-accountId branch, in the runtime fetch loop (#609)

### Notes

- Published under the `latest` dist-tag (`npm i -g codex-multi-auth`).
- Includes everything from the `2.3.0-beta.1` → `2.3.0-beta.3` prereleases.

---

## [2.3.0-beta.3] - 2026-06-11

Stream backpressure fix, deduplication fixpoint, retry-loop consolidation, typed errors, 20 new test suites, dead code pruned.
See [docs/releases/v2.3.0-beta.3.md](docs/releases/v2.3.0-beta.3.md) for full details.

### Fixed

- Stream forwarding stalling for slow clients (backpressure not respected)
- Multi-tier account deduplication requiring more than one pass
- Storage spy cascades in test suite from leaked `fs` mocks

### Improved

- `CodexValidationError` on rotation-proxy startup guards (#586)
- `StorageError` on unreadable config save aborts (#588)
- Last two hand-rolled retry loops migrated to shared `withRetry`
- 20 new direct test suites; property-based dedup coverage

---

## [2.3.0-beta.2] - 2026-06-11

Repository audit (34 PRs), 4 correctness bug fixes, security hardening, and major
`codex-manager.ts` / `runtime-rotation-proxy.ts` decomposition.
See [docs/releases/v2.3.0-beta.2.md](docs/releases/v2.3.0-beta.2.md) for full details.

### Fixed

- Sequential scheduling pointer corruption: `persistRuntimeActiveAccount` advanced
  the drain-first primary in legacy routing mode even when `schedulingStrategy:
  "sequential"` was set, breaking the #509 invariant
- Flagged accounts lost `workspaces`/`currentWorkspaceIndex` on flag→restore
  round-trip due to `normalizeFlaggedStorage` omitting those fields
- Quota cache wipe on transient disk failure: dead `catch` in
  `refreshQuotaCacheForMenu` caused empty-load to save only current-run entries
- Expired token forwarded after failed refresh commit when
  `commitRefreshedAuthOnce` returned `null`

### Security

- Temp-file staging paths now use `crypto.randomBytes` instead of `Math.random()`
- CI action steps pinned to exact commit SHAs
- Private account response headers blocked by prefix match (not allowlist)
- Stream stall `withTimeout` ordering fixed: reject before `onTimeout`

---

## [2.2.2] - 2026-06-03

Patch release for a stale runtime-overlay false positive in `forecast --live`.
See [docs/releases/v2.2.2.md](docs/releases/v2.2.2.md) for full details.

### Fixed

- `forecast --live` no longer marks working accounts as unavailable when a
  time-bounded runtime overlay reason (`rate-limited`, `cooling-down:...`)
  persists on disk after its window has expired; the overlay is now
  cross-referenced against the time-aware disk state before being applied, and
  `doctor`'s `forecast-runtime-alignment` warning clears with it (#507)
- a successful request now clears that account's persisted runtime skip reason
  via `recordRuntimeAccountRecovery`, so non-time-bounded reasons such as
  `token-exhausted` (which the forecast cannot validate against disk) no longer
  linger after the account recovers (#507)

## [2.1.3] - 2026-05-01

Patch release for Codex Desktop app-bind history visibility and merged-main
runtime session repair. See [docs/releases/v2.1.3.md](docs/releases/v2.1.3.md)
for full details.

### Fixed

- repaired successful wrapper-launched session index writes when official Codex
  emits rollout-store noise for missing thread entries
- serialized concurrent local session-index repair using the existing
  shadow-home lock and atomic index replacement
- kept failed forwarded runs from writing synthetic session-index entries
- resolved app-bind status paths from the active status state before printing
  Desktop history and speed-control guidance

### Documentation

- documented the Codex Desktop history workaround:
  `codex-multi-auth rotation unbind-app` or `codex-multi-auth rotation disable`
- documented Codex-owned model speed control through
  `model_reasoning_effort`

## [2.1.2] - 2026-04-30

Patch release for conflict-free installs alongside the official Codex CLI.
See [docs/releases/v2.1.2.md](docs/releases/v2.1.2.md) for full details.

### Changed

- removed the published global `codex` executable from `codex-multi-auth`
  so npm no longer collides with official or Homebrew-owned Codex installs
- added `codex-multi-auth-codex` as the explicit forwarding wrapper
  executable for users who still want this package's Codex wrapper
- kept account-management commands available through `codex-multi-auth ...`

## [2.1.1] - 2026-04-29

Patch release for the local governance command router and bridge token JSON
output. See [docs/releases/v2.1.1.md](docs/releases/v2.1.1.md) for full
details.

### Fixed

- route all `codex auth` local governance and bridge subcommands through the
  multi-auth wrapper instead of falling through to the official Codex CLI
- return valid JSON for `codex auth bridge token list --json` when no local
  bridge tokens are configured

## [2.1.0] - 2026-04-29

Stable release for local usage governance and the local bridge. See [docs/releases/v2.1.0.md](docs/releases/v2.1.0.md) for full details.

### Added

- local JSONL usage ledger, `codex auth usage`, budgets, account policies, routing profiles, model capability views, and `codex auth monitor`
- runtime policy enforcement before account selection in runtime proxy and plugin-host paths, with exactly-once local usage rows for request outcomes
- optional loopback-only local bridge for `/health`, `/v1/models`, and `/v1/responses`
- hashed local bridge client tokens and deterministic integration snippets using `CODEX_MULTI_AUTH_LOCAL_KEY`

## [2.0.1] - 2026-04-25

### Changed

- runtime rotation now defaults on for request-bearing wrapper-launched Codex sessions
- package install/update now self-heals supported packaged app binds and app launcher routing by default, with environment opt-outs
- installed packages now show best-effort daily manual update notices when npm has a newer release; update with `npm install -g codex-multi-auth@latest`
- aligned active documentation with the 2.x wrapper-first architecture, default-on runtime Responses proxy, reversible Codex app bind, and historical audit snapshot boundaries
- updated live quota probes, model normalization, and shipped templates to prefer current documented OpenAI models (`gpt-5.5` general, `gpt-5.3-codex` Codex) while keeping legacy `gpt-5-codex` requests as compatibility aliases
- removed deprecated `gpt-5.1-codex*` selectors from shipped config templates; those inputs now route to the current documented Codex model when encountered for compatibility

## [2.0.0] - 2026-04-25

Major release for the official Codex runtime rotation proxy and hardened app/shadow-home runtime path. See [docs/releases/v2.0.0.md](docs/releases/v2.0.0.md) for full details.

### Added

- loopback-only Responses API runtime rotation proxy for official Codex sessions
- `codexRuntimeRotationProxy`, `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=1`, and `codex auth rotation enable|disable|status`
- runtime rotation support for wrapper-launched `codex app` and `codex app-server`

### Fixed

- stripped stale decoded upstream `content-encoding` metadata before proxy responses reach local Codex clients
- retried and cleaned up shadow-home sync locks when owner metadata writes fail transiently or permanently
- resumed `process.stdin` during app-server protocol cleanup so retry attempts cannot inherit paused stdin

## [1.3.2] - 2026-04-24

Patch release for TTY-safe forwarded Codex runs after the `v1.3.1` GPT-5.5 rollout. See [docs/releases/v1.3.2.md](docs/releases/v1.3.2.md) for full details.

### Fixed

- terminal-attached forwarded `codex` runs inherit stdio instead of piping stdout and stderr
- non-TTY forwarded runs keep captured output for unsupported-model fallback handling
- synchronous Windows `spawn()` failures use the existing clean wrapper failure path

## [1.3.1] - 2026-04-24

Patch release for the GPT-5.5 rollout and runtime compatibility cleanup.

- keep `gpt-5.5` and `gpt-5.5-pro` as first-attempt models
- fall back to `gpt-5.4` only after real unsupported-model responses on ChatGPT Codex surfaces
- harden the wrapper retry path for both unsupported-model and no-access error shapes
- validate native `gpt-5.5` on official Codex `0.124.0` while preserving deterministic fallback on older or non-entitled runtimes

## [1.3.0] - 2026-04-17

Phase 1 post-audit hardening: 20 focused PRs + 7 audit-fix commits + 1 follow-up PR (#413). 3527 tests (+182 from v1.2.7). Zero breaking changes, one opt-in flag (`routingMutex`). See [docs/releases/v1.3.0.md](docs/releases/v1.3.0.md) for full details.

### Added

- `routingMutex` plugin config flag (PR-N / R4) with values `"enabled" | "legacy"` (default `"legacy"`). When `"enabled"`, cursor-mutation sites in the account pool (`markSwitchedLocked`, `markAccountCoolingDownLocked`, `setActiveIndexLocked`) are serialized through a promise-chain async mutex in `lib/routing-mutex.ts`, closing the TOCTOU race described in design items D-02/D-09. The flag defaults to `"legacy"` for one full release cycle so existing deployments see zero behavior change; users can opt in via settings or the `CODEX_AUTH_ROUTING_MUTEX=enabled` environment variable. A new `SelectionRecord` type is threaded out of the rotation decision path so the fetch loop can hand structured selection metadata to observability, why-selected, and failure-policy consumers.
- `codex auth why-selected [--now|--last] [--json]` diagnostic command surfacing per-candidate hybrid scoring breakdown (PR-P).
- `codex auth verify [--paths|--flagged|--all] [--json]` self-test command walking the storage path resolution chain and exercising the `resolvePath()` sandbox (PR-P). `verify-flagged` retained as back-compat alias.
- Zod `safeParseJson<T>(raw, schema, context)` helper; 12 storage-read sites migrated to schema-validated JSON parsing with `AnyAccountStorageSchema` as authoritative normalizer (PR-L / AUDIT-M20).
- New types exported: `SelectionRecord`, `HybridSelectionCandidateTrace`, `HybridSelectionTraceResult`, `FlaggedAccountStorageV1Schema`, `AccountsJournalEntrySchema`.
- `docs/audits/MASTER_AUDIT.md` + `docs/audits/evidence/findings-index.json` published (PR #393).
- Phase 1 regression suite locking in audit invariants (PKCE S256, state entropy, SSE failover) (PR-S / AUDIT-L01).

### Changed

- `resolvePath()` now rejects lookalike-prefix paths (e.g. `HomeX` vs `Home/`) via `path.relative()` comparison, closing a sandbox-escape class (PR-A / AUDIT-C1 / AUDIT-H1).
- OAuth URLs redacted in user-facing login output to prevent token leakage through clipboard or terminal scrollback (PR-B / AUDIT-H4).
- OAuth callback host unified through `AUTH_REDIRECT` SSOT (`127.0.0.1:1455`) across bind, copy, and HTML; 4 duplicate hardcoded sites removed (PR-C / AUDIT-H5 / M14 / M30).
- Hybrid selector now returns `null` when no accounts are available instead of a stale fallback (PR-D / AUDIT-H2).
- Short-429 retry marks the account unavailable BEFORE the retry sleep, closing a TOCTOU race between two requests targeting the same rate-limited account (PR-E / AUDIT-H3).
- Active-account pointer normalized on disable/remove; residual `removeAccount` last-in-family dangle resolved in follow-up #413 (PR-F / #413 / AUDIT-H10).
- Recovery storage migrated to atomic write + retry-safe delete pattern; atomic write migration completed for `injectTextPart` / `prependThinkingPart`; `renameSync` retries on `EBUSY`/`EPERM` (PR-H / audit-fix `f877c85` / AUDIT-M01).
- Account-clear ordering writes the reset marker BEFORE deletion and retries `EPERM` on read (PR-I / AUDIT-M04 / M05).
- Per-project vs CLI-sync config conflict surfaced to the user instead of silently bypassing project-scoped isolation (PR-J / AUDIT-M09).
- Malformed SSE JSON chunks surface as structured warnings instead of silent buffer drops; 10MB buffer cap documented; deprecation/sunset headers logged uniformly across success and failure paths (PR-K / AUDIT-H9 / M16 / M18 / M34).
- `lib/codex-manager/settings-hub.ts` (808 LOC) split into 5 focused sub-modules under `lib/codex-manager/settings-hub/` (`dashboard`, `backend`, `experimental`, `shared`, `index`), each <500 LOC; original file retained as a 9-line re-export stub for test compatibility (PR-M / AUDIT-M24 / G-01 / JN-03).
- `getAccountHealth()` now reads the tracker directly; field-name drift vs `ManagedAccount` documented (PR-O / AUDIT-M08 / D-04).
- `npm run pack:check` builds first; tests migrated to `os.tmpdir()`; 6 stray `tmp*` directories removed from repo root (PR-G / AUDIT-H7 / M31).
- Dual-linter scope documented: ESLint in lint-staged, Biome manual, CI enforcement via `ci.yml` + `pr-ci.yml`; husky `prepare` hook side effect documented (PR-T / audit-fix `d9f7253` / AUDIT-M21 / M22 / M23 partial).
- `lib/AGENTS.md` staleness fixed; `docs/reference/storage-paths.md` `deriveProjectKey` typo corrected (PR-Q / AUDIT-H8 / M32 / L04).

### Rollout plan

- v1.3.0: `routingMutex` shipped with default `"legacy"`. Advanced users opt in via config or env.
- v1.4.0: evaluate enablement based on telemetry and flip default to `"enabled"`.

## [0.1.8] - 2026-03-11

### Fixed

- Hardened flagged-account reset recovery so intentional clears remain authoritative even when the primary flagged file survives an initial delete failure.
- Removed the fresh-worktree `npm test` dependency on prebuilt `dist/` output by validating config precedence directly from source imports.
- Tightened model-matrix smoke classification so unsupported account/runtime capabilities are reported as non-blocking skips instead of false release failures.
- Restored backup metadata, restore assessment, and transaction-safe named backup export behavior after merging the experimental settings and backend primitive stacks.

### Changed

- Codex CLI sync remains mirror-only, preserving canonical multi-auth storage as the single source of truth while still allowing mirror-file selection updates.
- Experimental settings flows, backend primitive extraction, and wrapper non-TTY docs now ship in the stable branch.
- Release validation now includes broader merged-feature regression coverage spanning unified settings, flagged reset suppression, mirror-only Codex CLI sync, experimental sync, named backup export, and wrapper/docs behavior.

### Added

- Cross-feature regression coverage for merged release behavior in `test/release-main-prs-regression.test.ts`.
- Preview-first `oc-chatgpt-multi-auth` sync orchestration, named backup export flows, and target-detection coverage promoted from the stacked settings/sync branches.

## [0.1.7] - 2026-03-03

### Fixed

- Hardened Windows global command routing so multi-auth survives stock Codex npm shim takeovers across `codex.bat`, `codex.cmd`, and `codex.ps1`.
- Strengthened account recovery by promoting discovered real backups when the primary storage file is synthetic fixture data.
- Hardened Codex auth sync writes by including complete token shape (`access_token`, `refresh_token`, `id_token`) in active account payloads.

### Changed

- Added invocation-path-first shim resolution and stock-shim signature replacement to reduce stale launcher routing on Windows.
- Added PowerShell profile guard installation so new PowerShell sessions keep resolving `codex` to the multi-auth wrapper.

### Added

- Visible package version in the dashboard header (`Accounts Dashboard (vX.Y.Z)`).

## [0.1.6] - 2026-03-03

### Fixed

- Improved runtime path selection when account storage is available only through recovery artifacts.
- Added backup discovery recovery so non-standard backup files can restore `openai-codex-accounts.json` automatically.
- Aligned Codex CLI sync default paths with `CODEX_HOME` to prevent auth writes from going to a different profile directory.
- Hardened switch-sync reporting so account switches fail fast when required Codex auth persistence does not complete.

### Changed

- Multi-auth now treats backup and WAL signals as valid storage indicators during runtime directory selection.

## [0.1.5] - 2026-03-03

### Fixed

- Removed forced `process.exit(...)` from wrapper entrypoints to prevent Windows libuv shutdown assertions after `codex auth` commands.
- Updated model-matrix execution for current Codex CLI behavior (`exec`, non-interactive JSON mode, no deprecated `run` or `--port` flow).
- Tightened model-matrix result classification to avoid false negatives from permissive output text matching.

### Changed

- Windows `.cmd` matrix execution now resolves to the Node script entry where possible, preventing shell argument flattening issues.

### Added

- Regression coverage for `.cmd` wrapper resolution and matrix script helper behavior under Windows path formats.

## [0.1.4] - 2026-03-03

### Fixed

- Stabilized `codex auth switch <index>` and host sync reporting so local multi-auth selection remains deterministic under sync failures.
- Hardened refresh token normalization and refresh queue stale or timeout recovery paths.

### Added

- Expanded regression coverage across auth, refresh queue reliability, docs integrity, retry or backoff handling, and CLI routing.

## [0.1.3] - 2026-03-03

### Fixed

- `codex auth switch <index>` now succeeds locally even when Codex host-state sync is unavailable.
- Removed false-negative switch failures in environments where Codex no longer exposes JSON sync files (`accounts.json` and `auth.json`).
- Clarified switch output to explicitly state local multi-auth routing remains active when host sync cannot be completed.

### Added

- CLI regression coverage for local-switch success when Codex auth sync returns unavailable or failure.

## [0.1.2] - 2026-03-03

### Fixed

- Added staged rotating backup recovery and startup cleanup for stale `*.bak(.N).rotate.*.tmp` artifacts.
- Added retry and backoff around staged backup rename commits to tolerate transient Windows locks.
- Removed invalid filesystem retry codes and constrained backup-copy retries to real Node filesystem errors.
- Hardened Windows home resolution order and `HOMEPATH` normalization to avoid drive-relative paths.
- Fixed account storage identity handling across worktree branch changes and covered realpath fallback branches.

### Changed

- Backup rotation now stages candidate snapshots before commit, preserving historical chain integrity if latest-copy fails.
- Recovery path now prioritizes WAL then backup candidates with deterministic `.bak` -> `.bak.1` -> `.bak.2` cascade.
- Storage recovery paths and rotation tests expanded for parallel ordering and failure-mode determinism.

### Added

- Regression coverage for `.bak.2` fallback when newer backups are unreadable.
- Regression coverage for transient `EPERM` and `EBUSY` retry branches in backup copy and staged rename flows.
- Startup cleanup path for orphaned rotating backup staging artifacts.

## [0.1.1] - 2026-03-01

### Fixed

- OAuth callback host canonicalized to `127.0.0.1:1455` across auth constants and user-facing guidance.
- Account email dedup is now case-insensitive via `normalizeEmailKey()` (trim + lowercase).
- `codex` bin wrapper lazy-loads auth runtime so clean global installs avoid early module-load failures.
- Per-project account storage is shared across linked Git worktrees via `resolveProjectStorageIdentityRoot`.
- Legacy worktree-keyed accounts auto-migrate to canonical repo-shared storage, while legacy files are retained on persist failure.
- Windows filesystem safety: `removeWithRetry` with `EBUSY`, `EPERM`, and `ENOTEMPTY` backoff added to `scripts/repo-hygiene.js` and test cleanup.
- Stream failover tests use fake timers for deterministic assertions.
- Coverage gate stabilized by excluding integration-heavy files and adding targeted branch tests.

### Changed

- CLI settings hub extracted from `lib/codex-manager.ts` into `lib/codex-manager/settings-hub.ts`.
- Settings panel `Q` hotkey changed from save-and-back to cancel without save; theme live-preview restores baseline on cancel.
- Documentation architecture updated to dual-track navigation for operators and maintainers.
- Command, settings, storage, privacy, and troubleshooting references aligned for stronger runtime parity.
- Governance templates upgraded for production-grade issue and PR hygiene.
- `auth fix` help text now shows `--live` and `--model` flags.

### Added

- `scripts/repo-hygiene.js` for deterministic repo cleanup and hygiene checks.
- `lib/storage/paths.ts` for worktree identity resolution, commondir and gitdir validation, forged pointer rejection, and Windows UNC support.
- Archived pre-`0.1.0` historical changelog in `docs/releases/legacy-pre-0.1-history.md`.
- `docs/development/CLI_UI_DEEPSEARCH_AUDIT.md` as the settings extraction audit trail.
- PR template and modernized issue templates.
- 87 test files and 2071 tests.

## [0.1.0] - 2026-02-27

### Added

- Stable Codex-first multi-account OAuth workflow.
- Unified `codex auth ...` command family for login, switching, diagnostics, and reporting.
- Dashboard settings hub and backend reliability controls.
- Rotation and resilience modules for refresh, quota deferral, and failover.

### Validation

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

## Legacy History

Historical entries from pre-`0.1.0` internal iteration cycles are preserved in:

- `docs/releases/legacy-pre-0.1-history.md`

---

[0.1.0]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.0
[0.1.1]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.1
[0.1.2]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.2
[0.1.3]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.3
[0.1.4]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.4
[0.1.5]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.5
[0.1.6]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.6
[0.1.7]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.7
[1.3.0]: https://github.com/ndycode/codex-multi-auth/releases/tag/v1.3.0
[1.3.1]: https://github.com/ndycode/codex-multi-auth/releases/tag/v1.3.1
[1.3.2]: https://github.com/ndycode/codex-multi-auth/releases/tag/v1.3.2
[2.0.1]: https://github.com/ndycode/codex-multi-auth/releases/tag/v2.0.1
[2.0.0]: https://github.com/ndycode/codex-multi-auth/releases/tag/v2.0.0
