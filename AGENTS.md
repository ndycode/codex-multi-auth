# PROJECT KNOWLEDGE BASE

Generated: 2026-10-06
Commit: 65b9e682
Branch: main
Package version: 2.19.1

## OVERVIEW

`codex-multi-auth` is a Codex CLI-first OAuth account manager and optional forwarding wrapper for the official Codex CLI. The architecture is manager-first: the `codex-multi-auth` bin (`scripts/codex-multi-auth.js`) owns the account-management CLI — 31 subcommands dispatched through `lib/codex-manager.ts` (`runCodexMultiAuthCli`), `codex-multi-auth login` ≡ `codex-multi-auth auth login`. The `codex-multi-auth-codex` bin (`scripts/codex.js`) owns explicit wrapper forwarding to the official Codex CLI plus shadow `CODEX_HOME` and runtime-rotation-proxy setup; `mcodex` is a launcher-only convenience wrapper over `scripts/codex.js`; `codex-multi-auth-app-launcher` is a reversible OS launcher routing helper. Runtime rotation is default-on: forwarded Responses/model traffic routes through a loopback-only account-rotation proxy (provider id `codex-multi-auth-runtime-proxy`). Local governance (usage ledger, budget guards, account policies, routing profiles, quota cache, local bridge tokens) stays file-backed under the multi-auth root. `index.ts` remains the exported plugin-host compatibility entry, but the primary product surface is the account manager, optional wrapper, storage, runtime proxy, governance commands, and repair tooling.

## STRUCTURE

```
./
├── scripts/
│   ├── codex-multi-auth.js    # `codex-multi-auth` bin: standalone account-manager CLI entrypoint
│   ├── codex.js               # `codex-multi-auth-codex` bin: official-CLI forwarder, shadow CODEX_HOME + runtime proxy setup
│   ├── mcodex.js              # `mcodex` bin: launcher only — forwards to codex.js; optional --monitor / --tmux
│   ├── codex-app-launcher.js  # `codex-multi-auth-app-launcher` bin: reversible Windows/macOS/Linux launcher routing
│   ├── codex-routing.js       # auth-subcommand routing + compatibility alias normalization
│   ├── codex-bin-resolver.js  # official Codex binary discovery (env override → npm → prefix roots → PATH)
│   ├── codex-app-router.js    # detached persistent localhost router behind `rotation bind-app` (shipped, not a bin)
│   ├── postinstall.js         # notice-only npm hook; real setup is lib/runtime/first-run.ts
│   ├── preuninstall.js        # shipped but not an npm hook; `uninstall` subcommand replicates it
│   ├── install-codex-auth-utils.js  # installer helpers (install-codex-auth.js is repo-only, not shipped)
│   ├── repo-hygiene.js        # `clean`/`check` repo hygiene + Windows retry helpers
│   ├── copy-oauth-success.js, generate-config-schema.mjs  # build tooling
│   ├── check-pack-budget.mjs + -lib.js                    # package size budget check
│   ├── test-model-matrix.js, benchmark-*.mjs, bench-format/, test-all-models.sh, validate-model-map.sh  # matrix/bench tooling
│   └── audit-dev-allowlist.js, update-vendor-provenance.mjs, verify-vendor-provenance.mjs  # audit/vendor tooling
├── index.ts                  # plugin-host compatibility entry (`.` export: OpenAIOAuthPlugin)
├── lib/                      # core runtime logic (see lib/AGENTS.md)
│   ├── auth/                 # OAuth flow, PKCE, dual-bind callback server, device auth, token utils
│   ├── storage.ts + storage/ # V3 account pool: load/save, three-way snapshot merge, dedup, backups/WAL, flagged pool, file/json-store locks
│   ├── accounts.ts + accounts/ # pool facade, health scoring, cooldowns, per-account rate limits
│   ├── runtime-rotation-proxy.ts + runtime/ # loopback Responses/model proxy; app bind, first-run, native binding, selection, quota, checks
│   ├── request/              # request transform, headers, SSE handling, failover/backoff policy
│   ├── policy/               # runtime policy composition + hot-path store caches
│   ├── usage/                # append-only local usage ledger, pricing, redaction
│   ├── codex-cli/            # official Codex CLI state sync + writer helpers
│   ├── codex-manager.ts + codex-manager/ # CLI dispatcher, command modules, settings hub, login menus
│   ├── prompts/              # model-family prompts, GitHub ETag cache
│   ├── context-budget*/ + context-overflow.ts  # proactive budget guard + reactive overflow → synthesized replies
│   ├── oc-chatgpt-*.ts       # oc-chatgpt multi-auth interop (target detect, import adapter, sync orchestrator)
│   ├── recovery/             # conversation recovery state
│   ├── tools/                # hashline helper tools
│   ├── ui/                   # TUI rendering, menus, copy, theme, select
│   └── (flat modules)        # governance stores, quota, refresh machinery, rotation, config, schemas, utils
├── test/                     # vitest suites (see test/AGENTS.md) — 415 files incl. property/ + chaos/
├── docs/                     # user docs + reference/, releases/ (~82), development/ runbooks, audits/, design/, benchmarks/
├── config/                   # pluginConfig templates (modern/legacy/minimal) + generated JSON schema
├── vendor/                   # vendored codex-ai-plugin + codex-ai-sdk type-only shims (+ provenance.json)
├── assets/                   # static assets (icons, hero image)
├── bench/                    # format benchmark harness
├── skills/                   # codex-auth-setup skill (referenced by plugin manifest; not in files[])
├── .github/                  # CI workflows, issue/PR templates, plugin scanner fixtures
└── dist/                     # build output (generated, do not edit)
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Standalone CLI entry | `scripts/codex-multi-auth.js` | `codex-multi-auth` bin; `--version`, arg normalization, dynamic import of `dist/lib/codex-manager.js` (needs `npm run build`) |
| CLI dispatcher | `lib/codex-manager.ts`, `lib/codex-manager/account-manager-commands.ts` | `runCodexMultiAuthCli`: first-run setup → auth-prefix normalization → 31-command handler map; mutating commands pin the GLOBAL pool via `setStoragePath(null)` |
| Command modules | `lib/codex-manager/commands/` (25), `lib/codex-manager/login-flow.ts`, `lib/codex-manager/repair-commands.ts` | `login`, `verify-flagged`/`fix`/`doctor`, `list`/`status`/`features` live outside `commands/` |
| Wrapper forwarding | `scripts/codex.js` (~6.6k lines) | `codex-multi-auth-codex ...`: auth args → local manager; everything else → resolved official Codex binary with runtime-proxy context, shadow CODEX_HOME, ≤5 spawn attempts |
| Compatibility aliases | `scripts/codex-routing.js` | `multi auth`/`multi-auth`/`multiauth` argv aliases normalize to `auth` before dispatch |
| Convenience launcher | `scripts/mcodex.js` | `mcodex` bin: forwards to `codex.js`; optional `--monitor` / `--tmux` helpers; no account logic |
| Official Codex binary discovery | `scripts/codex-bin-resolver.js` | `CODEX_MULTI_AUTH_REAL_CODEX_BIN` (absolute-only) → @openai/codex require.resolve → prefix roots → npm root -g → PATH |
| Runtime rotation proxy | `lib/runtime-rotation-proxy.ts` (~3.3k lines) | loopback `node:http` server; per-launch client token; account selection, token refresh, retries, streaming forward; pool exhaustion → `codex_runtime_rotation_pool_exhausted` |
| Runtime proxy constants | `lib/runtime-constants.ts` | provider id `codex-multi-auth-runtime-proxy`, app-helper status/owner filenames |
| Account selection | `lib/runtime/rotation-account-selection.ts`, `lib/rotation.ts`, `lib/accounts.ts` | soft pin → priority tiers → hard pin → sequential → session affinity → hybrid score → linear scan; bounded attempts (≤4 transient, 16 pin ceiling) |
| Shadow CODEX_HOME | `scripts/codex.js` | temporary provider config, state sync-back, lock cleanup, official state preservation |
| Packaged app bind | `lib/runtime/app-bind.ts`, `scripts/codex-app-router.js` | reversible `config.toml` bind to persistent localhost router |
| Native app-server binding | `lib/runtime/native-*.ts` | provider config, binding lock, client auth, account sync/storage, rate-limit RPC for the packaged Codex app |
| User app launcher routing | `scripts/codex-app-launcher.js` | Windows shortcut/taskbar retarget, macOS wrapper app, Linux .desktop |
| First-run setup | `lib/runtime/first-run.ts` | one-time durable-install app bind / launcher self-heal; `first-run-setup.json` marker; skipped under npx/CI/cwd-local |
| OAuth flow + PKCE | `lib/auth/auth.ts` | token exchange/refresh, JWT decode (claims only), fixed `http://localhost:1455/auth/callback` |
| OAuth callback server | `lib/auth/server.ts` | dual-binds `::1` + `127.0.0.1` on port 1455 for `localhost` redirect hosts; conflict on either family is fatal; only `GET /auth/callback` served |
| Device-code login | `lib/auth/device-auth.ts` | headless/remote login (`login --device-auth`); 15-min cap; verifier never persisted |
| Browser/manual login | `lib/auth/browser.ts`, `lib/runtime/browser-oauth-flow.ts`, `lib/runtime/manual-oauth-flow.ts` | platform browser open + manual-paste fallback paths |
| WSL / Windows host detection | `lib/wsl.ts`, `lib/auth/callback-guidance.ts` | callback port contention + browser host guidance for WSL installs |
| Account storage | `lib/storage.ts` (~2.9k lines), `lib/storage/` | V3 format; load recovery ladder (WAL → .bak chain → empty); baseline three-way merge on save; O(n log n) indexed dedup fixpoint (`DedupNewestIndex`, `deduplicateAccountsByIdentity` live here) |
| Snapshot merge | `lib/storage/snapshot-merge.ts` | three-way merge: identity-keyed inventory, per-row field merges, pointer re-resolution by identity; `ESTALE` conflicts |
| Cross-process store CAS | `lib/storage/json-store-lock.ts` | per-path write queue + `<path>.lock` wx lockfile (10s TTL takeover) + mtime CAS; shared by config/settings/governance stores |
| File transaction lock | `lib/storage/file-lock.ts`, `lib/storage/transactions.ts` | dir-lock CAS on account pool writes; `withAccountStorageTransaction` = mutex + file lock + merge + persist |
| Pending-auth journal | `lib/storage/pending-auth.ts` | rotated credentials that could not reach the pool; overlaid on next load |
| Fixture guards | `lib/storage/fixture-guards.ts` | synthetic-fixture detection; refuses to persist fixture payloads as real storage |
| Backup rotation | `lib/storage.ts` (`rotateAccountsBackupIfDue`) | `.bak`→`.bak.1`→`.bak.2` (depth 3); throttled to ≥30s/path by default (`CODEX_AUTH_STORAGE_BACKUP_MIN_INTERVAL_MS`, 0 = every save) |
| Worktree resolution | `lib/storage/paths.ts` | `resolveProjectStorageIdentityRoot`: gitdir back-ref + commondir containment; linked worktrees share one pool |
| Config parsing | `lib/config.ts`, `lib/schemas.ts`, `lib/unified-settings.ts` | `pluginConfig` resolution ladder, env overrides per setting, `config explain` report, settings.json persistence |
| Usage ledger | `lib/usage/` | append-only `usage-ledger.jsonl` + archives; pricing, sha256-redacted rows; streaming rows deferred until usage arrives |
| Budget guards | `lib/budget-guard.ts` | hour/day/week/month request/token/cost limits evaluated from ledger summaries; upsert-only store; advisory under races |
| Account policies | `lib/account-policy.ts` | tags, weights, priority, pause/drain, auto-prime, notes (sha256-keyed; upsert-only) |
| Routing profiles | `lib/routing-profiles.ts` | per-project preferred/avoid tags + model allow/deny lists; file-only (no write CLI) |
| Runtime policy | `lib/policy/runtime-policy.ts` | composes profile+budget+policy into per-request allow/deny + `blockedAccountIndexes` + score boosts |
| Runtime policy caches | `lib/policy/runtime-policy-cache.ts` | per-store fingerprint+TTL caches + project-resolution cache; `resetRuntimePolicyCacheForTests()` |
| Capability / model matrix | `lib/capability-policy.ts`, `lib/model-capability-matrix.ts`, `lib/entitlement-cache.ts` | unsupported-model suppression (in-memory, dormant at runtime) and per-account matrix reporting |
| Local bridge | `lib/local-bridge.ts`, `lib/local-client-tokens.ts` | loopback `/health` `/v1/models` `/v1/responses` forwarder + hashed `cma_local_*` bearer tokens |
| API route store | `lib/api-route-store.ts` | persisted api/zdr route definitions under the multi-auth root (zod-validated, lock+CAS writes) |
| API login + runtime | `lib/codex-manager/api-login-menu.ts`, `lib/runtime/api-model-runtime.ts`, `lib/runtime/api-model-capabilities.ts` | API-key login menu; non-OAuth model routes bypass the pool |
| Quota | `lib/quota-probe.ts`, `lib/quota-cache.ts`, `lib/quota-readiness.ts`, `lib/runtime/quota-headers.ts` | probe chain, persisted snapshots, account-ref normalization/readiness, `x-codex-*` header parsing |
| Token refresh | `lib/refresh-queue.ts`, `lib/refresh-lease.ts`, `lib/refresh-guardian.ts`, `lib/proactive-refresh.ts` | in-process dedup queue; cross-process leases (`<multi-auth>/refresh-leases/`); guardian+proactive are plugin-host only |
| Session affinity | `lib/session-affinity.ts` | session→account map (TTL 20m, 512 LRU) keyed from session/conversation headers → prompt_cache_key → previous_response_id → metadata |
| Routing mutex | `lib/routing-mutex.ts` | optional serialized select+commit (`CODEX_AUTH_ROUTING_MUTEX=enabled`; default `legacy`) |
| Preemptive quota | `lib/preemptive-quota-scheduler.ts`, `lib/runtime/preemptive-quota.ts` | defers near-exhausted accounts using `x-codex-*` quota snapshots (≥95% used; max deferral 2h) |
| Automatic checks | `lib/runtime/automatic-account-checks.ts`, `lib/runtime/automatic-subscription-checks.ts` | periodic quota/account refresh (15-min interval, 5s initial delay) |
| Reset credits | `lib/runtime/reset-credits.ts`, `lib/runtime/reset-credit-routing.ts`, `lib/runtime/account-reset-credits.ts` | earned reset-credit snapshots + unpinned recovery routing |
| Inference activity | `lib/runtime/inference-activity.ts` | per-account last-inference timestamps used by selection |
| Account model catalog | `lib/runtime/account-model-catalog.ts` | per-account model catalog for native binds (retry clamped to 15 min) |
| Resume picker | `lib/runtime/resume-picker.ts` | TTY `codex resume` thread catalog/picker inside the wrapper |
| Active-account sync | `lib/codex-manager/active-account-sync.ts`, `lib/live-account-sync.ts` | writes official CLI selection on managed switch; live file reload (plugin host); `resetActiveAccountSyncMetaForTests()` |
| Codex CLI state | `lib/codex-cli/` | `~/.codex` auth/accounts/config.toml read+write, file-auth-store enforcement, state sync |
| Context budget | `lib/context-budget-guard.ts`, `lib/context-budget-response.ts`, `lib/context-budget/`, `lib/context-overflow.ts`, `lib/synthetic-response.ts` | proactive pause at hard threshold + reactive overflow handling; locally-synthesized Responses replies |
| Request transformation | `lib/request/request-transformer.ts` | model normalization, `store:false`/`stream:true` forcing, prompt injection, tool/input pipeline, reasoning config |
| Headers + errors | `lib/request/fetch-helpers.ts`, `lib/request/headers.ts`, `lib/request/error-classification.ts` | Codex headers, deprecation/sunset warnings, error mapping (404 usage-limit → 429; entitlement → 403) |
| SSE to JSON | `lib/request/response-handler.ts` | stream parsing (10MB cap, per-chunk stall), synthesized `output_text`, usage extraction |
| Stream failover | `lib/request/stream-failover.ts`, `lib/request/stream-failover-runtime.ts` | ≤1 failover, only before first byte; runtime-proxy variant strips internal headers |
| Failure policy | `lib/request/failure-policy.ts` | pure decision table for auth-refresh/network/server/rate-limit/empty/unknown |
| Rate-limit backoff | `lib/request/rate-limit-backoff.ts` | per account\|quotaKey exponential backoff, 429 dedup, reason multipliers |
| Health/breaker/bucket | `lib/health.ts`, `lib/circuit-breaker.ts`, `lib/auth-rate-limit.ts` | score 0–100; closed→open @3 failures/60s; 50-token bucket |
| Prompt templates | `lib/prompts/codex.ts`, `lib/prompts/host-codex-prompt.ts`, `lib/request/helpers/model-map.ts` | model-family detection, GitHub-release prompts with ETag cache, host prompt detection |
| Runtime observability | `lib/runtime/runtime-observability.ts` | persisted counters consumed by `status`/`report`/`monitor`/`rotation status`/`why-selected` |
| Settings hub | `lib/codex-manager/settings-hub/` (shared/dashboard/backend/experimental/index) + `*-settings-*`/`settings-*` siblings | 6 menu actions; Q = cancel; preview-first theme; draft + keyed-merge persist |
| oc-chatgpt interop | `lib/oc-chatgpt-target-detection.ts`, `lib/oc-chatgpt-import-adapter.ts`, `lib/oc-chatgpt-orchestrator.ts` | detect/import/sync an oc-chatgpt multi-auth store (`OC_CODEX_MULTI_AUTH_DIR`; legacy `OC_CHATGPT_MULTI_AUTH_DIR` accepted) |
| Update notice | `lib/update-notice.ts` | npm version check with startup budget |
| Audit log | `lib/audit.ts` | rotating file audit log |
| Forecast/best | `lib/forecast.ts`, `lib/codex-manager/commands/forecast.ts`, `lib/codex-manager/commands/best.ts` | forecast-pick; `best` also switches |
| Shared helpers | `lib/utils.ts`, `lib/fs-retry.ts`, `lib/temp-path.ts`, `lib/concurrency.ts`, `lib/env-parsing.ts`, `lib/errors.ts`, `lib/logger.ts`, `lib/shutdown.ts`, `lib/table-formatter.ts` | `combineSignals` (AbortSignal.any replacement for Node ≥18.17), retry policies, crypto temp paths, mapWithConcurrency, env coercion, CodexError hierarchy |
| UI components | `lib/ui/` | ansi, auth-menu(+builder), check-progress, confirm, display-width, format, runtime, select, theme, ui-copy |
| Hashline tools | `lib/tools/hashline-tools.ts` | plugin-host edit/apply_patch/hashline_read tool impl |
| Repo hygiene | `scripts/repo-hygiene.js` | `clean --mode aggressive`, `check`, Windows retry helpers |
| Tests | `test/` | 415 vitest files, ~6,960 tests; see `test/AGENTS.md` |

## CONVENTIONS

- Source lives in root `index.ts`, `lib/`, and `scripts/`; `dist/` is generated output.
- ESM only (`"type": "module"`), Node >= 18.17.
- Canonical package name is `codex-multi-auth`; canonical command family is `codex-multi-auth ...`.
- The package does not publish a global `codex` bin; `codex-multi-auth-codex` is the explicit wrapper: auth commands run locally, non-auth commands forward to official Codex.
- The `auth` prefix is optional on both bins for all 31 manager commands (`codex-multi-auth login` ≡ `codex-multi-auth auth login`).
- `mcodex` is a convenience launcher only (`scripts/mcodex.js`); it forwards to `codex.js` and must not reimplement account-manager logic.
- Runtime rotation is default-on through `codexRuntimeRotationProxy`; users can opt out with `codex-multi-auth rotation disable` or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0`.
- The runtime proxy is loopback-only and uses a per-process client token. It forwards only Responses API, model discovery, image, and thread-goal requests.
- Proxy upstream policy: `https` always allowed; `http` only on a numeric loopback host (`127.0.0.0/8` or `[::1]`, never names) with an explicit port; redirects are never followed.
- OAuth callback listener dual-binds `::1` + `127.0.0.1` on port 1455 for `localhost` redirect URIs; a conflict on either family fails the bind rather than degrading.
- Account saves merge against an identity-keyed load baseline (`loadedAccountSnapshots` WeakMap → three-way merge); copy account pools only via `cloneTrackedAccountStorage`.
- Backup rotation is throttled: `.bak` chain rotates at most once per 30s per path by default (`CODEX_AUTH_STORAGE_BACKUP_MIN_INTERVAL_MS`, `0` = every save), always on missing/unreadable newest backup or account-count change.
- Governance JSON stores (settings, account policies, budget guards, routing profiles, local client tokens, quota cache) merge **upsert-only** under write-queue + wx lockfile + mtime CAS (`lib/storage/json-store-lock.ts`); per-key `updatedAt >=` wins.
- Local governance stays file-backed under `~/.codex/multi-auth` and composes in `lib/policy/runtime-policy.ts`.
- The persistent desktop app bind is reversible and edits user config/startup metadata, not official app binaries.
- Local project-owned state defaults to `~/.codex/multi-auth`; official Codex state remains under `~/.codex`.
- Settings Q hotkey = cancel without save; theme live-preview restores baseline on cancel.
- Email dedup is case-insensitive via `normalizeEmailKey()` (trim + lowercase).
- Windows filesystem safety: retry transient `EBUSY`/`EPERM`/`ENOTEMPTY`/`EAGAIN` cleanup and write failures where tests cover Windows locks.
- Vitest runs single-worker (`pool: 'forks'` + `fileParallelism: false` + `--maxWorkers=1`) because OAuth callback suites share fixed port 1455.

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
- Do not `structuredClone`/spread loaded account storage — that silently drops the merge baseline; use `cloneTrackedAccountStorage`.
- Do not write the governance JSON stores with raw `fs` writes; go through the `json-store-lock` queue + lockfile + CAS helpers.
- Do not use `AbortSignal.any` (Node floor is 18.17); use `combineSignals` from `lib/utils.ts`.
- Do not add module-level mutable state without a `reset*ForTests`-style helper.

## COMMANDS

```bash
npm run build            # tsc + copy oauth-success.html
npm run typecheck        # type checking only
npm run typecheck:scripts # tsc -p tsconfig.scripts.json (JS check)
npm test                 # vitest once (--maxWorkers=1)
npm run test:coverage    # vitest with coverage report
npm run lint             # eslint (ts + scripts)
npm run clean:repo       # deterministic repo hygiene cleanup
npm run clean:repo:check # validate hygiene (CI-gated)
npm run pack:check       # build + package budget check
npm run vendor:verify    # vendored dependency provenance check
```

## NOTES

- OAuth callback: `http://localhost:1455/auth/callback`; the listener binds BOTH `::1` and `127.0.0.1` on port 1455.
- ChatGPT-backed Codex request compatibility requires stateless defaults (`store: false`) unless explicit background-mode compatibility is enabled; `stream: true` is always forced on the wire.
- Runtime rotation provider id: `codex-multi-auth-runtime-proxy`.
- Runtime rotation status: `codex-multi-auth rotation status`.
- Runtime proxy pool exhaustion returns `codex_runtime_rotation_pool_exhausted` and points to `codex-multi-auth rotation status`; a hard-pinned account returns `codex_pinned_account_unavailable` instead.
- Per-project accounts: `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`.
- Global accounts: `~/.codex/multi-auth/openai-codex-accounts.json` (+ sibling `openai-codex-flagged-accounts.json`).
- Storage sidecars: `.bak`/`.bak.1`/`.bak.2` (depth 3), `.wal`, `.reset-intent`, `.pending-auth.json`, `<path>.write-lock/`, `<path>.lock`.
- Official Codex state: `~/.codex/auth.json`, `~/.codex/accounts.json`, `~/.codex/config.toml` (`cli_auth_credentials_store="file"` is enforced top-level; opt out `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0`).
- Governance stores under `~/.codex/multi-auth/`: `usage/usage-ledger.jsonl` (+ archives), `budget-guards.json`, `account-policies.json`, `routing-profiles.json`, `quota-cache.json`, `local-client-tokens.json`, `settings.json`, API route store, `refresh-leases/`.
- Runtime observability: `~/.codex/multi-auth/runtime-observability.json` (0600).
- App helper status: `~/.codex/multi-auth/runtime-rotation-app-helper.<pid>.json`; owner identity `...-owner.<pid>.json` (legacy un-suffixed files still read).
- App bind state/logs: `~/.codex/multi-auth/app-bind/`.
- `CODEX_MULTI_AUTH_DIR` relocates the multi-auth root; `CODEX_HOME` relocates `~/.codex` (then multi-auth root is `$CODEX_HOME/multi-auth`).
- Package exports subpaths: `.`, `./auth`, `./storage`, `./config`, `./request`, `./cli` (+ `./package.json`); the `dist/lib/index.js` barrel builds but is NOT reachable via a package specifier.
- Prompt templates sync from Codex CLI GitHub releases with ETag caching.
- Historical audit evidence under `docs/audits/evidence/` is snapshot evidence, not current architecture guidance.
