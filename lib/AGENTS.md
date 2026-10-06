# LIB KNOWLEDGE BASE

Generated: 2026-09-28
Commit: cafa1258

## OVERVIEW

Core implementation for the OAuth account manager, optional Codex CLI forwarding wrapper, storage/runtime services, local governance (usage/budget/policy/quota), optional local bridge, plugin-host compatibility entry, and the default-on runtime Responses rotation proxy. The architecture is manager-first: `scripts/codex-multi-auth.js` owns the primary account-management entrypoint, `scripts/codex.js` owns explicit wrapper forwarding and runtime proxy setup, `scripts/mcodex.js` is a convenience launcher only, while `lib/` owns account selection, storage, config, app bind, governance, request compatibility, and diagnostics.

## STRUCTURE

```
lib/
├── constants.ts                   # PLUGIN_NAME, CODEX_BASE_URL, provider/defaults shared constants
├── types.ts                       # shared public types
├── index.ts                       # internal barrel re-exporting every module (not a package subpath)
├── errors.ts                      # CodexError hierarchy (typed error contracts)
├── env-parsing.ts                 # boolean/integer env coercion
├── utils.ts                       # combineSignals (AbortSignal.any replacement for Node ≥22.19), misc
├── concurrency.ts                 # mapWithConcurrency
├── fs-retry.ts                    # shared withRetry/withRetrySync policies
├── temp-path.ts                   # crypto-random temp/staging path helper
├── logger.ts                      # diagnostics and request logging
├── audit.ts                       # rotating file audit log
├── shutdown.ts                    # graceful shutdown helpers
├── cli.ts                         # interactive-vs-non-interactive detection, login mode prompts
├── table-formatter.ts             # CLI table formatting
├── update-notice.ts               # npm version notice
├── wsl.ts                         # WSL/Windows host detection
├── config.ts                      # runtime config resolution ladder + env overrides + config explain
├── config-schema.ts               # generated JSON schema for pluginConfig
├── schemas.ts                     # Zod schemas for config/storage/request contracts
├── unified-settings.ts            # settings.json persistence (sections: pluginConfig, dashboardDisplaySettings)
├── dashboard-settings.ts          # dashboard display settings types/defaults
├── runtime-paths.ts               # multi-auth root + Codex path resolution (CODEX_MULTI_AUTH_DIR/CODEX_HOME)
├── accounts.ts                    # multi-account pool, health, cooldowns, persistence facade
├── accounts/
│   └── rate-limits.ts             # per-account rate limit tracking
├── account-policy.ts              # tags, weights, pause/drain, notes (hashed account keys; upsert-only)
├── auth-rate-limit.ts             # token bucket for auth paths
├── health.ts                      # account health status model
├── circuit-breaker.ts             # closed→open @3 failures/60s, half-open probe
├── rotation.ts                    # hybrid account selection algorithm
├── routing-mutex.ts               # optional process-local selection mutex
├── session-affinity.ts            # session→account affinity store (TTL, LRU)
├── live-account-sync.ts           # account-file live reload (plugin host)
├── refresh-queue.ts               # queued token refresh (dedup, rotation map)
├── refresh-lease.ts               # cross-process refresh leases (<multi-auth>/refresh-leases/)
├── refresh-guardian.ts            # proactive refresh guard (plugin host)
├── proactive-refresh.ts           # refresh-before-expiry scheduling
├── preemptive-quota-scheduler.ts  # quota deferral scheduling from x-codex-* snapshots
├── forecast.ts                    # account forecast model used by `forecast`/`best`
├── auth/                          # OAuth + login
│   ├── auth.ts                    # PKCE flow, token exchange/refresh, JWT decode, constants
│   ├── server.ts                  # callback server: dual-binds ::1 + 127.0.0.1 on 1455 for localhost
│   ├── device-auth.ts             # device-code login (not RFC 8628)
│   ├── browser.ts                 # platform browser open + clipboard fallbacks
│   ├── account-access.ts          # wham/accounts/check authorized-workspace constraint
│   ├── org-override.ts            # --org / CODEX_AUTH_ACCOUNT_ID precedence
│   ├── callback-guidance.ts       # bind-failure/timeout UX + WSL contention guidance
│   ├── token-utils.ts             # token validation/parsing
│   └── index.ts                   # `./auth` subpath barrel
├── storage.ts                     # V3 account storage facade: load/save, baseline merge, O(n log n) dedup fixpoint, backup rotation
├── storage/
│   ├── paths.ts                   # project root + resolveProjectStorageIdentityRoot (worktree commondir)
│   ├── path-state.ts              # storage path override state
│   ├── file-paths.ts              # accounts/flagged/sidecar path builders
│   ├── public-types.ts            # lower-layer shared types (upward re-exported by storage.ts)
│   ├── account-port.ts            # export/importAccountsSnapshot port helpers
│   ├── account-persistence.ts     # clone-for-persist / save plumbing
│   ├── account-save.ts + account-save-entry.ts      # save path
│   ├── account-clear.ts + account-clear-entry.ts    # clear path
│   ├── account-snapshot.ts        # snapshot helpers
│   ├── account-match-utils.ts     # findMatchingAccountIndex tiers
│   ├── identity.ts + record-identity.ts + hash.ts   # identity refs/keys, sha256 helpers
│   ├── record-utils.ts            # record field helpers
│   ├── migrations.ts              # V1→V3 migration
│   ├── storage-parser.ts          # zod parse of stored payloads
│   ├── snapshot-merge.ts          # three-way baseline merge (ESTALE conflicts)
│   ├── snapshot-inspectors.ts     # snapshot shape checks
│   ├── transactions.ts            # withStorageLock mutex + with*StorageTransaction
│   ├── file-lock.ts               # local-disk dir-lock CAS for account writes
│   ├── json-store-lock.ts         # queue + wx lockfile + mtime CAS for governance JSON stores
│   ├── pending-auth.ts            # journal of rotated creds that missed the pool write
│   ├── fixture-guards.ts          # synthetic-fixture detection/refusal
│   ├── project-migration.ts       # legacy worktree/project storage merge
│   ├── import-export.ts           # pool import/export (merge+dedup inside transaction)
│   ├── backup-paths.ts + backup-restore.ts + backup-metadata*.ts  # .bak chain + named backups
│   ├── named-backup*.ts + named-backup-export (root module)       # named backup mgmt/export
│   ├── restore-assessment.ts + restore-backup-entry.ts + restore-metadata.ts  # restore planning
│   ├── flagged-*.ts               # flagged-account pool + entry wrappers (no WAL, single .bak)
│   ├── credential-sidecars.ts     # .wal/.reset-intent/.pending-auth sidecars
│   ├── metadata-section.ts        # storage metadata sections
│   ├── health.ts                  # inspectStorageHealth
│   ├── error-hints.ts             # StorageError hints
│   ├── cache-artifacts.ts         # cache-like backup artifact detection
│   ├── gitignore.ts               # auto .gitignore for storage dir
│   └── save-retry.ts              # save retry policy
├── codex-cli/                     # official Codex CLI state sync + writer helpers
│   ├── state.ts                   # ~/.codex auth.json/accounts.json read+sync
│   ├── sync.ts                    # selection sync-back + file-auth-store enforcement
│   ├── writer.ts                  # codexCliMirror writers
│   ├── observability.ts           # CLI metrics/observability
│   └── index.ts                   # `./cli` subpath barrel
├── codex-manager.ts               # `codex-multi-auth` dispatcher (runCodexMultiAuthCli, 31 handlers)
├── codex-manager/
│   ├── account-manager-commands.ts # ACCOUNT_MANAGER_COMMANDS: the 31-command name set
│   ├── login-flow.ts              # `login` command orchestration
│   ├── repair-commands.ts         # `verify-flagged`, `fix`, `doctor`
│   ├── help.ts                    # help/usage text (doc-contract pinned strings)
│   ├── account-credentials.ts + persist-selected-account.ts + account-pool-write.ts  # credential + pool writes
│   ├── active-account-sync.ts     # writes official CLI selection after managed switch (resetActiveAccountSyncMetaForTests)
│   ├── api-login-menu.ts          # API-key login menu
│   ├── login-menu-*.ts + login-action-panel.ts + login-oauth.ts + login-workspace-choice.ts + manual-callback.ts  # dashboard flows
│   ├── health-check.ts            # runHealthCheck (quick + live probe)
│   ├── forecast-report-shared.ts  # shared forecast/report helpers
│   ├── quota-cache-helpers.ts + rate-limit-markers.ts + dashboard-formatters.ts + dashboard-settings-*.ts
│   ├── settings-hub*.ts + settings-panels.ts + settings-persist-utils.ts + settings-preview.ts + settings-write-queue.ts
│   ├── unified-settings-*.ts + dashboard-display-panel.ts + theme-settings-panel.ts + statusline-settings-panel.ts
│   ├── backend-*.ts + experimental-*.ts + behavior-settings-panel.ts   # settings categories/panels
│   ├── settings-hub/              # shared/dashboard/backend/experimental/index panels
│   ├── formatters/                # account/model/quota/text-style formatters
│   └── commands/                  # 25 command modules: account, best, bridge, budget, check, config-explain,
│                                  #   debug-bundle, forecast, history, init-config, integrations, limits, models,
│                                  #   monitor, report, resets, rotation, status, switch, uninstall, unpin, usage,
│                                  #   verify, why-selected, workspace
├── policy/
│   ├── runtime-policy.ts          # composes budgets, policies, profiles, boosts → per-request decision
│   └── runtime-policy-cache.ts    # hot-path store caches + project-resolution cache (resetRuntimePolicyCacheForTests)
├── usage/                         # local usage ledger
│   ├── ledger.ts                  # append-only jsonl ledger + archives + summaries
│   ├── pricing.ts                 # token cost estimates (fail-closed on unpriced models)
│   ├── redaction.ts               # hashed identity; never prompts/auth headers/raw ids
│   ├── stream-usage-deferral.ts   # holds streaming rows until usage arrives
│   ├── usage-extraction.ts        # extractResponsesUsage
│   ├── types.ts + index.ts        # row/summary types + barrel
├── request/                       # request transform, headers, response handling, retry/failover
│   ├── request-transformer.ts     # model normalization, forced store/stream, tool+input pipeline
│   ├── fetch-helpers.ts           # facade: headers, transform, error/success handling
│   ├── headers.ts + url-rewriting.ts + request-init.ts + client-cancellation.ts
│   ├── token-refresh.ts           # request-path token refresh
│   ├── response-handler.ts + response-metadata.ts + response-compaction.ts + response-outcome.ts
│   ├── error-classification.ts + rate-limit-decision.ts + failure-policy.ts + failover-config.ts
│   ├── rate-limit-backoff.ts      # exponential backoff per account|quotaKey
│   ├── request-attempt-budget.ts + request-resilience.ts + wait-utils.ts
│   ├── stream-failover.ts + stream-failover-runtime.ts   # SSE failover (plugin host / runtime proxy)
│   ├── helpers/                   # model-map, input-utils, tool-utils
│   └── index.ts                   # `./request` subpath barrel
├── runtime-rotation-proxy.ts      # loopback Responses/model/images/thread-goal proxy (~3.3k lines)
├── runtime-constants.ts           # provider id `codex-multi-auth-runtime-proxy`, app-helper filenames
├── runtime/                       # Codex CLI/app integration helpers
│   ├── rotation-account-selection.ts # chooseAccount tiers: soft pin→priority→hard pin→sequential→affinity→hybrid→scan
│   ├── rotation-proxy-state.ts + rotation-storage-meta.ts + rotation-server-types.ts + rotation-token-refresh.ts
│   ├── app-bind.ts                # persistent packaged-app bind to localhost router
│   ├── app-helper-selection.ts    # app-helper account selection glue
│   ├── first-run.ts               # one-time durable-install app bind / launcher self-heal
│   ├── config-toml.ts             # provider config rewrite helpers
│   ├── native-provider-config.ts + native-binding-lock.ts + native-client-auth.ts
│   ├── native-account-storage.ts + native-account-sync.ts + native-rate-limits.ts  # packaged-app bind path
│   ├── account-*.ts               # check*/pool/scope/select-event/selection/state/status/storage-scope-entry
│   ├── account-manager-cache*.ts  # runtime AccountManager cache entries
│   ├── account-model-catalog.ts   # per-account model catalog (native; retry ≤15m)
│   ├── account-reset-credits.ts + reset-credits.ts + reset-credit-routing.ts  # reset-credit recovery
│   ├── api-model-runtime.ts + api-model-capabilities.ts  # api/zdr model routes (bypass OAuth pool)
│   ├── automatic-account-checks.ts + automatic-subscription-checks.ts  # periodic refresh loops
│   ├── capability-boost.ts + catalog-capabilities.ts + runtime-capability-failures.ts
│   ├── context-budget-settings.ts # wire context-budget guard config into runtime
│   ├── event-handler.ts + loader-setup.ts + runtime-services.ts + runtime-observability.ts + status-marker.ts
│   ├── inference-activity.ts      # per-account last-inference timestamps
│   ├── live-sync*.ts + refresh-guardian*.ts + session-affinity-entry.ts  # plugin-host service entries
│   ├── manual-oauth-flow.ts + browser-oauth-flow.ts + auth-facade.ts  # login flows (plugin-host DI)
│   ├── model-discovery-status.ts + quota-headers.ts + quota-probe.ts + quota-settings.ts
│   ├── preemptive-quota.ts + subscription-first-use.ts + subscription-quota-event.ts + subscription-quota-order.ts
│   ├── request-init.ts + response-output-history.ts + responses-websocket.ts  # request plumbing + native WS gateway
│   ├── resume-picker.ts           # TTY `codex resume` thread picker
│   ├── session-recovery.ts + storage-scope.ts + toast.ts + ui-runtime*.ts + verify-flagged.ts + workspace-model-scopes.ts
│   └── flagged-verify-types.ts + hydrate-emails.ts + login-menu-accounts.ts + runtime-current-account.ts
├── context-budget-guard.ts        # proactive context-window pause (soft/hard thresholds)
├── context-budget-response.ts     # synthesized hard-threshold pause reply
├── context-budget/model-context-windows.ts  # per-model window sizes
├── context-overflow.ts            # reactive context-overflow detector/handler
├── synthetic-response.ts          # shared builder for locally-answered Responses replies
├── api-route-store.ts             # persisted api/zdr route definitions (zod + lock/CAS writes)
├── oc-chatgpt-target-detection.ts # locate an oc-chatgpt multi-auth store (OC_CODEX_MULTI_AUTH_DIR, legacy OC_CHATGPT_MULTI_AUTH_DIR)
├── oc-chatgpt-import-adapter.ts   # build/preview import payloads from that store
├── oc-chatgpt-orchestrator.ts     # plan/apply oc-chatgpt sync + named-backup export
├── capability-policy.ts           # unsupported-model suppression scoring (in-memory; dormant at runtime)
├── entitlement-cache.ts           # entitlement block cache (in-memory; no production markBlocked)
├── model-capability-matrix.ts     # per-account model capability matrix (`models` command)
├── model-route-policy.ts          # oauth|api|zdr route kind + route catalog helpers
├── routing-profiles.ts            # project-aware routing preferences (file-only store)
├── budget-guard.ts                # request/token/cost budget limits + evaluation (upsert-only)
├── quota-probe.ts + quota-cache.ts + quota-readiness.ts   # probe chain, persisted snapshots, account-ref normalization
├── local-bridge.ts                # loopback OpenAI-compatible forwarder over the runtime proxy
├── local-client-tokens.ts         # hashed `cma_local_*` bearer tokens
├── integration-generators.ts      # `integrations` command snippet generators
├── named-backup-export.ts         # named backup export helpers
├── recovery.ts + recovery/        # conversation recovery state (constants/storage/types)
├── prompts/                       # codex.ts (families), host-codex-prompt.ts, codex-host-bridge.ts,
│                                  # fetch-utils.ts (GitHub ETag cache)
├── tools/hashline-tools.ts        # hashline helper tools (plugin-host edit/apply_patch/read)
├── ui/                            # ansi, auth-menu(+builder), check-progress, confirm, display-width,
│                                  # format, runtime, select, theme, ui-copy
├── redaction.ts                   # maskEmail/redactEmails string helpers
├── parallel-probe.ts              # concurrent account probing
├── oauth-success.html             # callback success page (copied to dist)
└── index.ts                       # internal barrel exports
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Runtime rotation proxy | `runtime-rotation-proxy.ts` | loopback-only; client API key auth before path discrimination; selection loop with bounded attempts; upstream `http` only on numeric loopback w/ explicit port; redirects never followed |
| Runtime provider config | `runtime/config-toml.ts`, `runtime-constants.ts` | `codex-multi-auth-runtime-proxy` provider rewrite helpers |
| Packaged app bind | `runtime/app-bind.ts`, `runtime/native-*.ts` | reversible user `config.toml` bind; native binding lock, client auth, account sync, rate-limit RPC, WS gateway |
| Runtime observability | `runtime/runtime-observability.ts` | persisted request counters consumed by status/report |
| Token exchange/refresh | `auth/auth.ts`, `request/token-refresh.ts`, `runtime/rotation-token-refresh.ts`, `refresh-queue.ts`, `refresh-lease.ts` | PKCE flow, JWT decode (claims only), 60s skew, queued/cross-process refresh |
| Device-code login | `auth/device-auth.ts` | headless/remote `login --device-auth`; verifier never persisted |
| OAuth callback server | `auth/server.ts` | dual-bind `::1`+`127.0.0.1` on 1455; either-family conflict = bind failure |
| Browser/manual auth | `auth/browser.ts`, `runtime/manual-oauth-flow.ts`, `runtime/browser-oauth-flow.ts` | platform and non-TTY login paths |
| WSL detection | `wsl.ts`, `auth/callback-guidance.ts` | Windows-host / WSL callback and browser guidance |
| Request transform | `request/request-transformer.ts` | model map, forced `store:false`/`stream:true`, prompt injection, tool/input pipeline, `reasoning.encrypted_content` include |
| Headers + errors | `request/fetch-helpers.ts`, `request/headers.ts`, `request/error-classification.ts` | Codex headers, deprecation/sunset warnings, rate-limit parsing, error normalization |
| SSE parsing | `request/response-handler.ts` | chunk-stall timeouts, 10MB cap, synthesized fields, usage extraction |
| Stream failover | `request/stream-failover.ts`, `request/stream-failover-runtime.ts` | ≤1 failover pre-first-byte; runtime variant strips internal headers |
| Failure policy | `request/failure-policy.ts`, `request/rate-limit-backoff.ts`, `request/rate-limit-decision.ts` | pure decision tables + backoff |
| Account selection | `rotation.ts`, `accounts.ts`, `runtime/rotation-account-selection.ts` | soft pin → priority tiers → hard pin → sequential → affinity → hybrid → scan |
| Account rate limits | `accounts/rate-limits.ts`, `auth-rate-limit.ts` | per-account tracking + auth-path token bucket |
| Storage load/save | `storage.ts`, `storage/account-persistence.ts`, `storage/account-save*.ts` | recovery ladder WAL→bak chain→empty; baseline three-way merge on save; identity-keyed O(n log n) dedup |
| Snapshot merge | `storage/snapshot-merge.ts` | base/current/proposed merge; `ESTALE` on inventory conflict |
| Store concurrency | `storage/transactions.ts`, `storage/file-lock.ts`, `storage/json-store-lock.ts` | ALS mutex + dir-lock CAS for pools; queue+lockfile+mtime CAS for governance stores |
| Sidecars | `storage/pending-auth.ts`, `storage/credential-sidecars.ts`, `storage/fixture-guards.ts` | pending-auth journal, `.wal`/`.reset-intent`, synthetic-fixture refusal |
| Backups/restore | `storage/backup-*.ts`, `storage/named-backups*.ts`, `storage/restore-*.ts`, `named-backup-export.ts` | `.bak`×3 rotation (≥30s throttle default), named backups, restore assessment |
| Worktree paths | `storage/paths.ts`, `runtime-paths.ts` | identity-root resolution; multi-auth root override chain |
| Usage ledger | `usage/` | append-only redacted JSONL; archives only via includeArchives |
| Budget guards | `budget-guard.ts` | windows evaluated from ledger summaries; unpriced cost = fail-closed deny |
| Account policies | `account-policy.ts` | tags/weights/priority/pause/drain; upsert-only |
| Routing profiles | `routing-profiles.ts` | model allow/deny + tag preferences per project |
| Runtime policy | `policy/runtime-policy.ts`, `policy/runtime-policy-cache.ts` | per-request decision + cached store reads (fingerprint+TTL+settle) |
| Capability / matrix | `capability-policy.ts`, `model-capability-matrix.ts`, `entitlement-cache.ts` | in-memory suppression (dormant), matrix reporting, entitlement blocks |
| Model routes | `model-route-policy.ts`, `api-route-store.ts`, `runtime/api-model-runtime.ts`, `runtime/api-model-capabilities.ts`, `codex-manager/api-login-menu.ts` | oauth/api/zdr route kinds, persisted routes, non-OAuth runtime, API-key login |
| Local bridge | `local-bridge.ts`, `local-client-tokens.ts` | loopback `/health` `/v1/models` `/v1/responses` + hashed tokens |
| Context budget | `context-budget-guard.ts`, `context-budget-response.ts`, `context-budget/`, `context-overflow.ts`, `synthetic-response.ts` | proactive soft/hard guard + reactive overflow → synthesized replies |
| Quota | `quota-probe.ts`, `quota-cache.ts`, `quota-readiness.ts`, `runtime/quota-headers.ts`, `preemptive-quota-scheduler.ts` | probe chain, snapshot cache, account matching, header parse, deferral |
| Refresh machinery | `refresh-queue.ts`, `refresh-lease.ts`, `refresh-guardian.ts`, `proactive-refresh.ts`, `live-account-sync.ts`, `codex-manager/active-account-sync.ts` | in-process dedup, cross-process lease, guardian/proactive (plugin host), live sync, CLI selection write |
| Rotation runtime | `runtime/rotation-*.ts`, `routing-mutex.ts`, `session-affinity.ts` | proxy state, storage-meta re-read, token refresh, optional mutex, affinity |
| Automatic checks | `runtime/automatic-account-checks.ts`, `runtime/automatic-subscription-checks.ts` | 15-min interval loops |
| Reset credits | `runtime/reset-credits.ts`, `runtime/reset-credit-routing.ts`, `runtime/account-reset-credits.ts` | snapshot parse, recovery routing |
| Inference activity | `runtime/inference-activity.ts` | last-inference timestamps |
| Model catalog | `runtime/account-model-catalog.ts` | per-account catalog for native binds |
| Resume picker | `runtime/resume-picker.ts` | TTY resume catalog |
| First-run setup | `runtime/first-run.ts` | durable-install app bind / launcher self-heal |
| CLI commands | `codex-manager.ts`, `codex-manager/commands/`, `codex-manager/{login-flow,repair-commands}.ts` | 31 commands; `login` + repair trio + `list`/`status`/`features` outside `commands/` |
| Settings UI | `codex-manager/settings-hub/`, `codex-manager/settings-*.ts`, `codex-manager/*-settings-*.ts` | panels, Q = cancel, preview-first writes, queued persist |
| Config resolution | `config.ts`, `schemas.ts`, `unified-settings.ts`, `config-schema.ts` | defaults, unified settings, env overrides, config explain, JSON schema emit |
| Codex CLI state | `codex-cli/` | official state read/write + file-auth-store enforcement |
| oc-chatgpt interop | `oc-chatgpt-*.ts` | target detection → import adapter → sync orchestrator |
| Prompt/model families | `prompts/codex.ts`, `prompts/host-codex-prompt.ts`, `request/helpers/model-map.ts` | GPT-5.x/6.x + codex families, host prompt cache |
| Recovery | `recovery.ts`, `recovery/` | session recovery state |
| UI components | `ui/` | ansi, auth-menu (+builder), check-progress, confirm, display-width, format, runtime, select, theme, ui-copy |
| Retry policies | `fs-retry.ts` | shared `withRetry`/`withRetrySync`; every retry loop declares its policy here |
| Temp/staging paths | `temp-path.ts` | crypto-random suffixes; never derive temp names from `Math.random()` |
| Shared utils | `utils.ts`, `concurrency.ts`, `env-parsing.ts` | `combineSignals`, `mapWithConcurrency`, env coercion |

## CONVENTIONS

- All public exports should flow through `lib/index.ts` or the documented package subpaths (`./auth`, `./storage`, `./config`, `./request`, `./cli`). The barrel builds to `dist/lib/index.js` but is not reachable as a package specifier.
- Module dependencies must stay acyclic (enforced by `import-x/no-cycle` in lint) and follow the layering
  `types/constants → storage → accounts → runtime → manager/CLI`: lower layers never import from higher ones.
  Shared types/helpers belong in the lower layer (e.g. `storage/public-types.ts`), with higher layers re-exporting
  for surface compatibility instead of lower layers importing back from facades like `lib/storage.ts`.
- Runtime rotation code must preserve pass-through semantics except for auth/provider headers that intentionally change.
- Node fetch returns decoded response bytes while preserving upstream `content-encoding`; do not forward stale decoded encoding metadata to local clients.
- Runtime proxy client-facing headers must not expose account emails or tokens.
- Runtime rotation should fail open to normal official Codex forwarding when startup helpers are unavailable.
- Proxy upstream policy is fail-closed: `https` always; `http` only on numeric loopback (`127.0.0.0/8`/`[::1]`) with explicit port; no credentials/query/fragment; redirects are hard errors.
- Account health is 0-100 and should be updated through the account manager APIs.
- Account saves are baseline merges: `saveAccounts` reads the fresh primary, merges `baseline→current→proposed` via `snapshot-merge`, and mutates `proposed` in place. `cloneTrackedAccountStorage` (structuredClone + baseline re-register) is the ONLY supported pool copy.
- Backup rotation is throttled (≥30s/path default, `CODEX_AUTH_STORAGE_BACKUP_MIN_INTERVAL_MS`, `0` = every save); the `.bak` chain is depth 3, staged via `*.rotate.<nonce>.tmp`.
- Governance JSON stores (config/settings, account policies, budget guards, routing profiles, client tokens, quota cache) write through `json-store-lock` (per-path queue → wx lockfile → mtime CAS → temp+rename) and merge **upsert-only** on `updatedAt >=`; deletes are not supported.
- Settings hub remains split under `codex-manager/settings-hub/`; keep the top-level stub as a compatibility re-export.
- Settings writes use queued retry for `EBUSY`/`EPERM`/`EAGAIN`.
- Email dedup uses `normalizeEmailKey()`: trim + lowercase.
- Worktree storage uses `resolveProjectStorageIdentityRoot`; never derive project pools from raw worktree paths.
- `combineSignals` (`utils.ts`) replaces `AbortSignal.any` so the Node ≥22.19 floor is safe.
- State lives in a class when multiple independent instances or dependency injection are needed
  (`AccountManager` per pool, `CircuitBreaker` per account, `SessionAffinityStore` per proxy, `AccountModelCatalog`,
  `ResetCreditService`, `ResponseOutputHistory`) and for the `CodexError` hierarchy. Module-level state + plain
  functions are reserved for genuinely process-global concerns (auth rate-limit trackers, the routing mutex,
  UI runtime options, the storage-meta cache, the JSON-store write queues, the runtime policy caches) and must ship
  a test reset helper (`reset*ForTests` / `resetVolatileRuntimeState`-style, e.g. `resetRuntimePolicyCacheForTests`,
  `resetActiveAccountSyncMetaForTests`, `resetJsonStoreWriteQueuesForTests`) so suites can isolate it. Do not add
  module-level state for anything a caller might want two of.

## ANTI-PATTERNS

- Never import from `dist/` in source tests or library code.
- Never suppress type errors (`as any`, `@ts-ignore`, `@ts-expect-error`).
- Never hardcode OAuth ports; use the existing auth constants/helpers.
- Never add account emails/tokens to runtime proxy client responses.
- Never patch official Codex app binaries for desktop routing.
- Never use bare recursive cleanup in Windows-sensitive paths without retry handling.
- Never key project storage directly by worktree path.
- Never `structuredClone`/spread a loaded account pool — the identity-keyed baseline WeakMap is lost and merges silently degrade to last-writer-wins.
- Never write governance/account JSON stores with raw `fs.writeFile`; use `json-store-lock`/`transactions` machinery.
- Never let the proxy follow upstream redirects or forward to named `http` hosts.
- Never add module-level mutable state without a `reset*ForTests` helper.
