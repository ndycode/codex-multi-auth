# Architecture

Maintainer map for the Codex CLI wrapper, local OAuth account manager, default-on Responses rotation proxy, local governance, optional local bridge, and optional plugin-host runtime. The user-facing version of this system is [../architecture.md](../architecture.md).

* * *

## Design Goals

1. Keep account management simple for end users (`codex-multi-auth ...`).
2. Preserve official Codex CLI behavior for non-auth commands.
3. Route live account rotation by default while keeping explicit opt-out controls.
4. Keep runtime rotation local, reversible, and compatible with official Codex state files.
5. Preserve stateless backend request compatibility (`store: false`) unless explicit background-response compatibility is enabled.
6. Keep plugin-host integration available without making it the default user path.
7. Keep local governance (usage ledger, budgets, account policies, routing profiles) file-backed and opt-in at the operator command surface.

* * *

## Module Layering

`lib/` dependencies are acyclic (enforced by `import-x/no-cycle` in lint) and follow one direction:

```text
types/constants → storage → accounts → runtime → manager/CLI
```

- **types/constants** — leaf utilities with no project imports: `errors.ts`, `schemas.ts`, `runtime-constants.ts`, `runtime-paths.ts`, `temp-path.ts`, `fs-retry.ts` (every retry loop declares its policy here), `utils.ts` (`combineSignals` — the `AbortSignal.any` replacement for the Node >= 22.19 floor), `storage/json-store-lock.ts` (shared CAS machinery for the governance JSON stores).
- **storage** — `lib/storage.ts` facade + `lib/storage/` modules: V3 load/normalize/merge/save, WAL + `.bak` rotation + named backups, path and worktree-identity resolution (`storage/paths.ts`), flagged pool, pending-auth journal.
- **accounts** — pool semantics on top of storage: `accounts.ts`, `rotation.ts` (hybrid selector), `account-policy.ts`, `routing-profiles.ts`, `budget-guard.ts`, `usage/` ledger, `quota-*.ts`, `refresh-queue.ts`, `refresh-lease.ts`, `capability-policy.ts`, `model-capability-matrix.ts`.
- **runtime** — request-path machinery: `runtime-rotation-proxy.ts` + `lib/runtime/` (rotation-account-selection, app-bind, first-run, live-sync, refresh-guardian, runtime-observability, native-* app-server pieces), `request/` (transformer, fetch-helpers, response-handler, stream-failover, failure-policy, rate-limit-backoff), `policy/runtime-policy.ts` + `policy/runtime-policy-cache.ts` (governance composition + hot-path caches), `auth/` OAuth.
- **manager/CLI** — `codex-manager.ts` dispatcher, `codex-manager/commands/*` (one module per command), `codex-manager/settings-hub/`, `codex-manager/active-account-sync.ts` (storage → official `auth.json` selection mirror; lives here because it needs manager-layer credential helpers — see its file header), `codex-cli/` official-state writer.

Lower layers never import from higher ones; shared types belong in the lower layer (for example `storage/public-types.ts`) with higher layers re-exporting for surface compatibility. `index.ts` (plugin-host entry) sits above everything and may import anywhere.

Practical consequence: a fix in `storage/` can rely on `temp-path.ts`/`fs-retry.ts` but never on `rotation.ts`; a new command module may use the whole stack.

* * *

## System Diagram

```text
Terminal user
  |
  | codex-multi-auth ...
  v
scripts/codex-multi-auth.js
  |- normalizes bare manager subcommands to auth subcommands
  |- dispatches through lib/codex-manager.ts (CLI_COMMAND_HANDLERS)
  |- runs first-run setup once per runtime root (durable installs)
  |- reads/writes ~/.codex/multi-auth/*
  |- syncs active account to official Codex CLI files

Terminal user
  |
  | mcodex ...  (convenience launcher only)
  v
scripts/mcodex.js -> scripts/codex.js (or --monitor / --tmux helpers)

Terminal user
  |
  | codex-multi-auth-codex exec/review/resume/app/...
  v
scripts/codex.js
  |- auth ... -> local manager
  |- resolves official Codex binary (env -> package -> npm root -> PATH)
  |- reconciles top-level cli_auth_credentials_store = "file"
  |- resolves --account / FORCE_ACCOUNT to an ephemeral pin
  |- picks a rotation transport (five branches, two homes)
  v
Official Codex CLI
  |
  | provider: codex-multi-auth-runtime-proxy, loopback base_url
  v
lib/runtime-rotation-proxy.ts  (per-launch client key, loopback only)
  |- client auth -> path/method gate -> runtime policy -> budget guard
  |- catalog gate -> selection loop -> token refresh -> upstream fetch
  |- classify + rotate on failure; stream back on success
  |- ledger row + runtime observability + active-account mirror
  v
https://chatgpt.com/backend-api

Optional: lib/local-bridge.ts (loopback /health /v1/models /v1/responses,
hashed cma_local_* tokens, forwards into a runtime proxy base URL).

Optional: lib/runtime/app-bind.ts + scripts/codex-app-router.js
(persistent localhost router for the packaged desktop app; reversible).

Optional: index.ts plugin-host runtime (loader-configured custom fetch,
proactive refresh guardian, live account sync, same pool/policy).
```

* * *

## Proxy Request Flow (numbered)

Per accepted request, `lib/runtime-rotation-proxy.ts` runs this pipeline. Steps 4–5 are policy; step 9 is the selection loop; steps 10–12 are classification and exit.

1. **Trace.** Mint a traceId and correlation headers for log/report joins.
2. **Client auth.** `Authorization: Bearer` or `x-api-key` checked with `timingSafeEqual` *before* path discrimination — unauthenticated always returns `401 runtime_rotation_proxy_unauthorized`. The wrapper injects a random 32-byte hex key per launch (`OPENAI_API_KEY`). Native (app-bind) mode additionally accepts a live managed token or the desktop `auth.json` token; the account store is re-read per request so mid-session `switch` takes effect without a restart.
3. **Method/path gate.** Only `POST /responses` (+ `/codex/`, `/v1/` aliases), `GET /models` (+ `/v1`), `POST /images/generations|edits` (+ `/v1`), `GET|POST /thread/goal/*`. Else `404 runtime_rotation_proxy_not_found`. Body ≤ 64 MiB (`413`), gzip/deflate/br/zstd decoded (`415` on anything else). JSON + `model` required. `api/` and `zdr/` service-tier prefixes are parsed off the path here.
4. **Runtime policy.** `loadRuntimePolicyState` (cached, see below) + `evaluateRuntimePolicy`: routing-profile model deny/allow lists, budget guards (shared-ledger read across `global` + `project:<key>` + `profile.budgetKey`), per-account pause/drain/priority/tag/weight boosts. Not-allowed → `429 budget_blocked` or `403 policy_blocked`; policy-load failure → `503 runtime_policy_unavailable`.
5. **Context budget guard (experimental, off by default).** Hard threshold → locally synthesized `context_budget_guard_paused` response; soft threshold → advisory headers only.
6. **`api/`/`zdr/` bypass.** Those routes short-circuit the OAuth pool into `ApiModelRuntime` (direct API-key traffic, no managed accounts).
7. **Native catalog gate.** In native mode, per-workspace model catalog enforcement → `403 model_not_available_in_account_catalog`.
8. **Reset-credit recovery** (native, unpinned): reset-credit accounts can be recovered before selection.
9. **Selection loop** (up to `accountCount` attempts; transient attempts capped at `min(accountCount, 4)`; pinned requests cap at `min(maxAttempts, 4)` with a hard ceiling of 16 iterations):
   `chooseAccount` (under `withRoutingMutex` when `CODEX_AUTH_ROUTING_MUTEX=enabled`) → preemptive-quota deferral check → `consumeTokenWithReason` (token bucket debit + circuit-breaker admission; breaker-open refunds the token) → `ensureFreshAccessToken` (live if `expires > now + 60s skew`, else the dedup refresh queue) → workspace/quota revalidation → build upstream headers (strip hop-by-hop/host/`x-api-key`/cookie/`proxy-authorization`; set `Authorization: Bearer`, `ChatGPT-Account-Id`, `OpenAI-Beta`, `originator`) → `fetch(..., { redirect: "error" })` — **redirects are never followed**, so a Bearer token cannot leak to a redirected host.
10. **Classify upstream response.** Capability 400/403/404 → learn + rotate; `429` → capacity wait or rate-limit mark (per family, `family:model` optional, clamped to 7d); `402`/`403` workspace-disabled → disable that workspace; `401` → hard `token_invalidated` exit vs 30s auth cooldown; `>=500` → capacity or 4s server cooldown; network error → refund + 6s cooldown. Transient marks continue the loop; non-retryable returns.
11. **Success path.** Snapshot `x-codex-*` quota headers into the `PreemptiveQuotaScheduler`; commit session affinity; persist runtime active-account mirror (skipped for pins, and skipped in sequential/mutex modes that do not re-commit); `forwardStreamingResponse` — pull-driven backpressure, per-chunk stall timeout (45s default), upstream usage scanner, terminal `ResponseOutcome` synthesis when the stream ends without a terminal event.
12. **Exit.** Pinned request with no eligible account → `503 codex_pinned_account_unavailable` with reason + remedy. Otherwise → `codex_runtime_rotation_pool_exhausted` (503/429 JSON) carrying `reason`, `retry_after_ms`, and `account_skip_reasons`, and pointing at `codex-multi-auth rotation status`. Bounded always: fetch timeout 60s, stream stall 45s, capacity deadline, 16-iteration pin ceiling — never a silent hang.

### `chooseAccount` tier order

`lib/runtime/rotation-account-selection.ts`:

1. **Soft pin** — the persisted `pinnedAccountIndex` written by `codex-multi-auth switch` (native stored switch), used once.
2. **Policy priority tiers** — accounts with a `priority` (0–9) from `codex-multi-auth account priority`, lowest tier first.
3. **Hard pin** — `--account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` (ephemeral): `missing` → immediate exit, `policy-blocked`/`disabled` → exit, cooldown honored only with `allowPinnedCooldown`; never advances the rotation cursor.
4. **Sequential** (`schedulingStrategy=sequential`, drain-first): stick to the current account while usable; advance only on true exhaustion.
5. **Session affinity** — `SessionAffinityStore` Map, 20-minute TTL, 512-entry LRU; session key from `session_id`/`conversation_id` headers → `prompt_cache_key` → `previous_response_id` → `metadata.{session_id,conversation_id,thread_id}`; a taken slot calls `markSwitched`.
6. **Hybrid** — `selectHybridAccount`: `health*2 + tokens*5 + hoursSinceUsed*2 + capabilityBoost + scoreBoostByAccount`, plus PID-offset jitter, plus a `+1000` sticky boost inside `minRotationIntervalMs`. Eligible = enabled + workspace-enabled + not rate-limited/invalidated/cooling/circuit-open.
7. **Linear scan** — first eligible account not already attempted.

Skip-reason precedence when reporting why an account was bypassed: `disabled` → `workspace-disabled` → `token-invalid` → `rate-limited` → `cooling-down[:reason]` → `circuit-open`.

Supporting machinery, all per-account: `HealthScoreTracker` (0–100; +1 success, −10 rate-limit, −20 failure, +2/hr passive), `TokenBucketTracker` (50 max, 6/min refill, ≤90s refund, −10 drain on rate-limit), `CircuitBreaker` (open at 3 failures/60s; half-open probe after 30s; non-throwing `tryCanExecute()`), persisted cooldowns (`coolingDownUntil` + `cooldownReason`; auth-failure cooldowns only lengthen monotonically).

* * *

## Storage Lifecycle

`lib/storage.ts` + `lib/storage/` — V3 account storage (`{version:3, accounts:[...], activeIndex, activeIndexByFamily?, pinnedAccountIndex?, affinityGeneration?}`).

### Load — `loadAccounts`

1. Sweep stale `*.rotate.*.tmp` staging files; merge legacy worktree/project layouts (`mergeStorageForMigration`).
2. `stat` the primary file's mtime **before** reading (the read-then-check order is what makes the later CAS meaningful).
3. `loadAccountsFromPath`: up to 6 retries on `EBUSY`/`EPERM`/`EAGAIN`/`ENOTEMPTY`/`EACCES` (25ms×2ⁿ + ≤20ms jitter), zod `safeParse`, `SyntaxError` propagates as the recovery contract.
4. Persist a migrated copy when the stored version differs; honor `.reset-intent` marker; synthesize the empty-storage fixture when appropriate; promote the first non-synthetic backup.
5. On failure: WAL recovery (checksummed journal) → backup recovery over `.bak`[`.1`/`.2`] + discovered candidates → `ENOENT` = empty "missing-storage" → `null`.
6. Apply `.pending-auth.json` overlay (rotated credentials captured by an earlier failed commit), then register the snapshot in `loadedAccountSnapshots` — an **identity-keyed `WeakMap` baseline** that later saves merge against.

### Normalize — `normalizeAccountStorage`

Reject non-records, unknown versions (only 1 and 3), non-array `accounts`. Clamp `activeIndex`; capture the active record's identity *before* dedup so selection survives reordering. Migrate V1→V3 (`migrations.ts`: null-entry filter, scalar `rateLimitResetTime` → per-family `rateLimitResetTimes`, `activeIndexByFamily` across all model families). Drop records without a usable `refreshToken`; strip invalid `authInvalidated*` fields; run `deduplicateAccounts` to fixpoint (O(n log n): four incremental index families + a lazy max-heap ordered by `lastUsed`, `addedAt`, index); re-resolve all indices **by identity** with positional fallback; validate `pinnedAccountIndex`/`affinityGeneration` (dropped with a warning if unsafe).

Identity tiers (`getAccountIdentityKey`): `account:id::email:key` → `account:id` → `email:key` → `refresh:sha256`. Matching (`findMatchingAccountIndex`): composite id+email → safe email (refused when >1 distinct accountId owner) → compatible refresh token (vetoed on id/email conflict) → unique accountId fallback.

### Save — `saveAccounts` (in-proc mutex + cross-process dir lock)

1. `baseline = loadedAccountSnapshots.get(proposed)`.
2. **Baseline hit** → fresh primary read (`loadPrimaryAccountsForMerge`; unreadable → `EACCOUNTSUNREADABLE`, never backup-substituted) → `mergeAccountSnapshot(baseline, current, proposed)` three-way merge (below); the merged result is written and re-registered as the new baseline.
3. **Baseline miss** → `warnOnBaselinelessSave` (once/path/process; skipped when no/empty primary or mtime unchanged) — the write still proceeds last-writer-wins.
4. `saveAccountsToDisk`: `mkdir 0700`; ensure `.gitignore`; refuse synthetic payloads; throttled `.bak` rotation (below); JSON → WAL `{version:1, createdAt, path, checksum, content}` `0600` → temp file `0600` (crypto-nonce `.tmp`) → `stat > 0` → atomic `rename` (5 retries on `EPERM`/`EBUSY`) → clear reset marker → record primary mtime → delete WAL.
5. `cloneTrackedAccountStorage` = `structuredClone` + baseline re-registration — the **only** supported way to copy loaded storage. A raw clone silently drops the WeakMap baseline and loses merge protection on the next save.

Backup rotation is throttled (`rotateAccountsBackupIfDue`): always rotate when the newest `.bak` is missing/unreadable; inside `CODEX_AUTH_STORAGE_BACKUP_MIN_INTERVAL_MS` (default 30s, `0` = rotate every save) rotate only on account-count change. Staging order `.bak.1→.bak.2`, `.bak→.bak.1`, primary→`.bak` via `*.rotate.<nonce>.tmp`.

### Three-way merge — `snapshot-merge.ts`

`base`/`current`/`proposed` rows keyed by record identity (duplicate identity key → `ESTALE`). Inventory: a base-known row removed locally deletes it; a new-on-disk row that local also added differently is a conflict (`ESTALE`); local-only adds are appended. Per row: `lastUsed` = max; `rateLimitResetTimes` union by max (explicit clear detectable); cooldown keeps the later `coolingDownUntil` and drops an auth-failure bound to a replaced token; workspaces merge by id (add survives, remove wins, re-enable beats disable, two-sided edits conflict); `lastSwitchReason` prefers local. Pointers (`activeIndex`, `activeIndexByFamily`, `pinnedAccountIndex`) are re-picked **by identity**, never by position. `mergeAccountRuntimeObservations` is the observation-only variant used by the proxy (disk owns inventory).

* * *

## Concurrency Model

Four cooperating mechanisms, each covering a different gap:

| Mechanism | Where | Covers |
| --- | --- | --- |
| In-process promise queues | `withStorageLock` (account pool), `withJsonStoreWriteQueue` (JSON stores), usage-ledger `appendQueue`, `RefreshQueue`, settings write queue | Writers inside this process |
| Cross-process lockfiles | `withFileTransactionLock` (account `.write-lock/` dir), `withJsonStoreFileLock` (`<path>.lock` wx), `<usage-ledger>.lock` | Writers in *other* processes |
| mtime CAS | `assertJsonStoreFileMtimeUnchanged` + `withJsonStoreCasRetry` (3 attempts) | Writers that take no lock; closes the read→merge→rename TOCTOU |
| Leases + baselines | `RefreshLeaseCoordinator` (`refresh-leases/` dir), `loadedAccountSnapshots` WeakMap, ALS reentrancy | Cross-process refresh dedup; merge protection; same-path reentrancy |

Details:

- **Account write lock** (`withFileTransactionLock`, `lib/storage/file-lock.ts`): creates `candidate-<rand>/` containing an owner file `<hostSha16>.<pid>.<uuid>`, then atomically renames it to `<path>.write-lock` — mkdir/rename atomicity is the mutex. Contention → `recoverDeadOwner` unlinks only a dead/abandoned owner → `ELOCKED` retried with jittered backoff `min(15×1.2ⁿ, 40)ms + [0,10)ms` over ~10s. Release unlinks the owner file and `rmdir`s; failures feed an abandoned-owner sweeper (250ms × 30). An `AsyncLocalStorage` lease makes the same path reentrant within one async context; `withAccountStorageTransaction` = mutex + dir lock + baseline merge + persist under ALS; `withAccountAndFlaggedStorageTransaction` adds flagged merge + rollback.
- **JSON stores** (`lib/storage/json-store-lock.ts`): shared machinery for config, unified settings, budget guards, routing profiles, account policies, local client tokens, quota cache. Three guards — per-path in-process queue, `<path>.lock` `wx` lockfile carrying `{pid, owner, acquiredAt, expiresAt}` (10s TTL, stale takeover, owner-checked release), and mtime CAS (`stat` → write via `tempPathFor` → assert unchanged else `ESTALE` → `rename` ×5; `withJsonStoreCasRetry` retries 3× with re-read + re-merge). Accepted trade-off: a holder paused >10s can have its lock stolen; the CAS is the backstop.
- **Merge semantics per store**: config/unified settings = shallow patch over a fresh read; account policies, budget guards, routing profiles = **per-key union by `updatedAt >=`, upsert-only** (entries are never deleted by a merge — that is why `budget limit` can upsert but nothing deletes); local client tokens = union-by-id with monotone `lastUsedAt`/`revokedAt`; quota cache = dir-lock + CAS + baseline-diff (updatedAt>= upserts, deletes only when unchanged).
- **Refresh dedup**: `RefreshQueue` is a per-process singleton — one in-flight refresh per token, rotation map so a rotated old token resolves to its replacement, abort at 30s. `RefreshLeaseCoordinator` (`<multi-auth>/refresh-leases/`) extends that across processes: a `wx` lease file `0600`, winner writes `result.json`, followers poll every 150ms up to ~35s, lease TTL 20s (disabled under test). `commitRefreshedAuth` writes inside `withAccountStorageTransaction`; failure keeps the new creds in memory and journals `recordPendingAuth` for the next load.
- **Routing mutex**: `CODEX_AUTH_ROUTING_MUTEX` default `legacy` (off); `enabled` serializes choose+commit inside `withRoutingMutex` so two requests in one process cannot pick the same account concurrently.
- **Runtime observability and policy caches**: `lib/policy/runtime-policy-cache.ts` keeps three store caches (`account-policies`, `budget-guards`, `routing-profiles`) keyed by absolute path with `{mtimeMs:size}` fingerprints — a hit requires fingerprint match **and** age < 30s TTL **and** the file's mtime settled >2s (FAT/Windows coarse timestamps), LRU 32 each — plus a project-resolution cache (<5s, `.git` fingerprint, max 64). `loadRuntimePolicyState` hands out `structuredClone`s so callers can never mutate cache-held objects. `resetRuntimePolicyCacheForTests()` exists for isolation; the rotation storage-meta cache follows the same fingerprint pattern in `lib/runtime/rotation-storage-meta.ts`.

* * *

## Runtime Rotation Transport Selection

The wrapper gate: `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY` env wins over `pluginConfig.codexRuntimeRotationProxy` (default **on**); skipped entirely when the app is natively bound, `CODEX_MULTI_AUTH_BYPASS=1`, or the forwarded args need no routing (`exec|review|resume|fork|app` + the root TUI route are routed; `help|completion|login|logout|mcp|sandbox|debug|apply|cloud|features|auth` and `--help` are not). `CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL` must be an explicit-port http URL on numeric loopback; set-but-not-routing fails closed.

Two homes over five branches (the first branch is split into its two predicates):

| Branch | Predicate | Transport |
| --- | --- | --- |
| Interactive TUI | `isCodexInteractiveTuiCommand` — bare `codex [OPTIONS]` or `codex [OPTIONS] [PROMPT]` (a first positional that is not a real subcommand is the prompt, #673) | App runtime helper, `useCanonicalHome: true`, `detachOnExit: true`. Canonical `CODEX_HOME`; provider injected as ephemeral `-c model_providers.*` overrides. Nothing provider/transport-related is written to `config.toml` — the only top-level key reconciled there remains `cli_auth_credentials_store`. |
| Interactive `resume` / `fork` | `isCodexInteractiveResumeCommand` | Same transport/options as TUI; must see the canonical thread index. |
| `app-server` | `isCodexAppServerCommand` | App helper with `useCanonicalHome: true`, `detachOnExit: false`, `installAppServerShim: false`, `proxyAppServerAccountRead: true`. A resident server owns its proxy for its whole lifetime. |
| `codex app` | `isCodexAppCommand` | App runtime helper + shadow `CODEX_HOME` + app-server CLI shim. |
| Everything else | request-bearing forwarded command | Shadow `CODEX_HOME` built inline by the wrapper process. |

Why canonical for interactive: copying `CODEX_HOME` into a shadow forced official Codex to reindex thread history and SQLite state on every TUI launch. `resume`/`fork` additionally break outright on a shadow — the mirror deliberately omits runtime SQLite state, so the shadow thread index lacks the thread being resumed and the TUI sits blank (#647). `app-server` is worse: the mirror *links* directories, Codex `lstat`-checks `<CODEX_HOME>/app-server-control`, and a frozen index is handed to every attached client for the server's whole life (#659).

The app-server CLI shim is deliberately **not** installed on the `app-server` branch. Its only purpose is routing a Codex-spawned `codex app-server` (the desktop app via `CODEX_CLI_PATH`) back through the wrapper; installing it stamps `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` onto an environment that a resident server passes to shell tools and MCP servers — every nested `codex-multi-auth-codex` call would read rotation as disabled and bill the wrong account. With no shim there is no `CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL`, so the branch requests account-response rewriting explicitly via `proxyAppServerAccountRead` (load-bearing; dropping it fails `test/codex-bin-wrapper.test.ts` account-response tests).

A helper that cannot start is a hard failure on all canonical-home branches — unlike the shadow path there is no rotation-off shape to degrade into, and quietly serving a resident server unrotated is worse than not serving it. `createRuntimeRotationProxyContextIfEnabled` catches the launch failure, releases the compatibility home already built, and returns a `startupError` that `forwardToRealCodex` converts to exit 1 *before* the official CLI spawns. On the shadow path, proxy failure degrades to plain forwarding unless an explicit upstream demands rotation.

Helper self-reaping is identity-checked and bounded — a detached helper decides "is my launcher alive" by PID **plus kernel start time** (`CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS`), and reaps itself on the first of these deadlines:

| Rule | Behavior |
| --- | --- |
| Owner identity | PID + kernel start time. Bare `kill(pid, 0)` cannot distinguish a launcher from a PID recycler; a single false "alive" was never corrected (helpers observed 33h past idle timeout, hundreds deep). |
| Recheck cadence | At most once a minute. A *failed* re-read keeps the previous verdict rather than declaring a live owner dead — under process-table pressure `fork` itself can fail. |
| Degraded check | No start time → bare liveness. Normal on Windows (`ps` absent): probes short-circuit rather than spawning a doomed process; the lifetime ceiling bounds leaks there. |
| Idle timeout | `CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS`, default 12h, refreshed by traffic and by a live owner. |
| Detached window | `CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS`, default 15m, `0` disables. Applies once the owner is *confirmed* dead, and only to a helper that has **never served a request** (`totalRequests: 0`) with zero open connections — a live `codex app` session idle between turns holds no socket (proxy `keepAliveTimeout` stays at Node's 5s), so socket-only gating would reap a working proxy. Unreadable counters fail open into reaping: "unknown" must not count as "attached". |
| Lifetime ceiling | `CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS`, default 24h, `0` disables. Unconditional — the backstop that turns any future accounting bug into a bounded leak. |

Helper lifecycle metadata: each helper publishes `runtime-rotation-app-helper.<pid>.json` (un-suffixed legacy path still read) on change plus heartbeat, owns a `runtime-rotation-app-helper-owner.<pid>.json` identity file removed on exit, and each launcher sweeps dead-PID metadata *after* spawning its own helper (the sweep is synchronous and unbounded and must never sit in front of `codex app`/TUI startup). `rotation unbind-app` reclaims the same metadata independently — the only repair path on a machine that stopped launching helpers. Terminal states are `idle-timeout`, `owner-gone`, `max-lifetime`, `stopped`, `error`; only `running` means running. `idleExpiresAt` reports whichever deadline is actually enforced.

`stopRuntimeRotationAppHelper` sends `SIGTERM`, waits the graceful window, escalates to `SIGKILL`, then unconditionally destroys piped stdio and unrefs the child — the helper is spawned with piped stdio, so a process that outlives the window (or anything that inherited the pipes) would otherwise keep the wrapper's event loop referenced forever. On Windows, signals are emulated termination, so stream teardown is the only part that reliably frees the wrapper.

Two interactive sessions can run concurrently against the same canonical home — same as running official Codex twice — and **no lock is taken over session state** (neither session copies or syncs it). Scope that guarantee to session state only: `ensureCodexCliFileAuthStore` still read-modify-writes canonical `config.toml` when the store is not `"file"`, safe in practice because it is idempotent and lands via atomic rename — anything non-idempotent added there would need a real lock.

Internal env used by these branches (not operator-facing): `CODEX_MULTI_AUTH_APP_ROTATION_USE_CANONICAL_HOME`, `CODEX_MULTI_AUTH_APP_ROTATION_INSTALL_APP_SERVER_SHIM`, `CODEX_MULTI_AUTH_APP_SERVER_CONFIG_ARGS_JSON`, `CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID`, `CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS`, `CODEX_MULTI_AUTH_REAL_CODEX_HOME`.

* * *

## Request Pipeline (plugin-host path)

The optional `index.ts` runtime is a separate, mostly-verbatim forwarder; the runtime proxy above does not share this code path:

1. `extractRequestUrl` → `rewriteUrlForCodex`: `*/responses` → `*/codex/responses`, force host/protocol to `CODEX_BASE_URL`, strip userinfo.
2. `normalizeRequestInit` + `parseRequestBodyFromInit`; `isStreaming = body.stream === true`.
3. `transformRequestForCodex` → `transformRequestBody` (`lib/request/request-transformer.ts`): model normalization (`resolveNormalizedModel`: alias → `-max`/`-ultra` strip → family chain → `DEFAULT_MODEL gpt-6.1-sol`), per-model config + variant merge, background-mode assertions, then **forced invariants** — `body.stream = true` always, `body.store = false` unless background mode is enabled, `body.include` deduped + force-appended `reasoning.encrypted_content` — plus tool sanitization, `body.instructions = codexInstructions` (GitHub-release prompt files, ETag-cached 15min), orphaned/missing tool-output repair, reasoning + verbosity + `prompt_cache_retention` precedence, `max_output_tokens`/`max_completion_tokens` dropped.
4. `createCodexHeaders`: delete `x-api-key`; set `Authorization: Bearer`, `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`, `originator: codex_cli_rs`, `accept: text/event-stream`, conversation/session ids from `promptCacheKey`.
5. `fetch` → `handleErrorResponse` / `withStreamingFailover` (failover only while `emittedBytes === 0`; injects SSE comment `: codex-multi-auth failover N`) → `handleSuccessResponse` (`convertSseToJson`: per-chunk stall timeout, 10MB cap, synthesized `output_text` merge, terminal-failure synthetic `upstream_stream_error`).

`evaluateFailurePolicy` is a pure decision table: `auth-refresh` rotates with a 30s cooldown after ≥3 consecutive failures; `network`/`server`/`empty-response` refund the bucket token and rotate once retries are spent (balanced vs consecutive same-account delays); `rate-limit` marks and rotates; `unknown` refunds + records + rotates. Default `failoverMode` is aggressive (always rotate).

* * *

## Local Bridge Flow

1. Operator creates a client token via `codex-multi-auth bridge token create` (plaintext `cma_local_<32B b64url>` shown once; store keeps SHA-256 hash + 18-char prefix + label in `local-client-tokens.json`).
2. Bridge binds loopback only, forwards to a loopback-only runtime base URL, and requires the bearer token (timing-safe compare) by default.
3. Allowed routes: `GET /health` (unauthenticated; does not echo the upstream), `GET /v1/models`, `POST /v1/responses`; 404 catch-all.
4. Outbound requests strip inbound `authorization`/`x-api-key`/`cookie`/`proxy-authorization` and inject the runtime client key; every forward appends a `source:"local-bridge"` ledger row.
5. Token verification takes the cross-process store lock per request and writes only when `lastUsedAt` moved ≥60s.

* * *

## First-Run Setup

Install scripts stay side-effect-free. On the first durable CLI invocation after install, `lib/runtime/first-run.ts`:

- Claims `~/.codex/multi-auth/first-run-setup.json` once (exclusive create; concurrent claims race safely).
- Runs three best-effort steps, each recording `completed`/`skipped`/`failed` without secrets:
  1. **App bind** — packaged Codex app bind, when rotation is enabled and the environment is not CI/`npx`/project-local.
  2. **Launcher** — user-level launcher routing, under the same gate.
  3. **Auth store** — `ensureCodexCliFileAuthStore()` pins `cli_auth_credentials_store = "file"` in `~/.codex/config.toml`.
- Failures are debug-logged and never block the requested command.

The marker is versioned (`FIRST_RUN_MARKER_VERSION = 2`). A v1 or unreadable marker is migrated in place on the next run — only the auth-store step replays; app bind and launcher are deliberately not rerun so removed shortcuts stay removed. A **failed** auth-store step records the pre-v2 version so the next run retries it (one transient Windows `EPERM`/`EBUSY` must not strand the install on keychain mode); `skipped` advances the version. Explicit repair: `codex-multi-auth rotation enable` / `bind-app` / launcher helpers, plus `codex-multi-auth doctor --fix` for the auth-store pin.

* * *

## Core Subsystems

| Subsystem | Key files | Responsibility |
| --- | --- | --- |
| Standalone package CLI | `scripts/codex-multi-auth.js`, `scripts/codex-routing.js` | Primary account-manager entrypoint, bare-subcommand normalization, version surface |
| Convenience launcher | `scripts/mcodex.js` | `mcodex` bin: forwards to the wrapper; optional `--monitor` and `--tmux` helpers |
| Forwarding wrapper | `scripts/codex.js`, `scripts/codex-routing.js`, `scripts/codex-bin-resolver.js` | Local auth routing, official Codex discovery, transport selection, ephemeral `--account` pin, shadow-home lifecycle |
| Official Codex CLI state | `lib/codex-cli/` (`state.ts`, `writer.ts`, `sync.ts`, `observability.ts`) | `~/.codex` auth/accounts/`config.toml` surface, active-selection sync, `cli_auth_credentials_store` reconcile |
| Active-account mirror | `lib/codex-manager/active-account-sync.ts` | Fingerprint-gated storage→`auth.json` selection mirror; own module to keep the wrapper cold-start off the manager module graph (~126 modules incl. zod) |
| Auth flow | `lib/auth/` (`auth.ts`, `server.ts`, `browser.ts`, `device-auth.ts`, `token-utils.ts`) | PKCE OAuth, dual-stack `:1455` callback server, manual/device-auth paths, token exchange/refresh, authorized-workspace resolution |
| Account manager | `lib/codex-manager.ts`, `lib/codex-manager/commands/`, `lib/accounts.ts` | `CLI_COMMAND_HANDLERS` dispatch (31 commands), dashboard, health, repair |
| Runtime rotation proxy | `lib/runtime-rotation-proxy.ts`, `lib/runtime-constants.ts`, `lib/runtime/rotation-*.ts`, `lib/runtime/native-*.ts` | Loopback Responses/model/images/thread-goal proxy, client auth, rotation/failover, streaming forward |
| Account selection | `lib/runtime/rotation-account-selection.ts`, `lib/rotation.ts`, `lib/accounts.ts` | Pin → priority → sequential|affinity → hybrid → scan |
| App bind + router | `lib/runtime/app-bind.ts`, `lib/runtime/native-*.ts`, `scripts/codex-app-router.js`, `scripts/codex-app-launcher.js` | Persistent localhost router, config backup/restore, startup entry, launcher routing |
| First-run setup | `lib/runtime/first-run.ts` | One-time durable-install self-heal; `first-run-setup.json` marker |
| Local bridge | `lib/local-bridge.ts`, `lib/local-client-tokens.ts` | Loopback OpenAI-compatible forwarder; hashed token store |
| Usage ledger | `lib/usage/` (`ledger.ts`, `pricing.ts`, `redaction.ts`) | Append-only JSONL + archives, per-model pricing (fail-closed on unpriced), hashed identity |
| Budget guard | `lib/budget-guard.ts` | hour/day/week/month request/token/cost limits over ledger summaries (advisory) |
| Account policy | `lib/account-policy.ts` | Tags, weight, priority, auto-prime, pause/drain, notes (hashed account keys) |
| Routing profiles | `lib/routing-profiles.ts` | Per-project preferred/avoid tags, model allow/deny, per-account weights, budget key — file-only writes |
| Runtime policy | `lib/policy/runtime-policy.ts`, `lib/policy/runtime-policy-cache.ts` | Compose policies + budgets + profiles + capability boosts per request; fingerprint caches keep the hot path to a few `statSync`s |
| Capability / matrix | `lib/capability-policy.ts`, `lib/model-capability-matrix.ts`, `lib/entitlement-cache.ts` | In-memory unsupported-model suppression (record path currently dormant), per-account model matrix |
| JSON-store CAS machinery | `lib/storage/json-store-lock.ts` | Shared queue + `wx` lockfile + mtime CAS for every file-backed governance store |
| Storage/paths | `lib/storage.ts`, `lib/storage/`, `lib/runtime-paths.ts` | V3 lifecycle, WAL/backups, `resolveProjectStorageIdentityRoot` worktree identity |
| Unified settings/config | `lib/unified-settings.ts`, `lib/dashboard-settings.ts`, `lib/config.ts`, `lib/schemas.ts` | `settings.json` persistence, `pluginConfig` defaults, env overrides, `config explain` |
| Quota + forecast | `lib/forecast.ts`, `lib/quota-probe.ts`, `lib/quota-cache.ts`, `lib/preemptive-quota-scheduler.ts` | Readiness scoring, live probes, cached quota, preemptive deferral |
| Resilience | `lib/refresh-queue.ts`, `lib/refresh-lease.ts`, `lib/refresh-guardian.ts`, `lib/live-account-sync.ts`, `lib/session-affinity.ts`, `lib/circuit-breaker.ts` | Dedup refresh, cross-process leases, proactive guardian (plugin host), live sync, sticky sessions, breaker |
| Request pipeline | `lib/request/*` (`request-transformer.ts`, `fetch-helpers.ts`, `response-handler.ts`, `stream-failover.ts`, `failure-policy.ts`, `rate-limit-backoff.ts`) | Plugin-host transform, headers, SSE→JSON, failover, retry policy |
| Runtime observability | `lib/runtime/runtime-observability.ts` | Persisted counters for status/report/monitor/rotation-status/why-selected |
| Settings hub | `lib/codex-manager/settings-hub/` (`settings-hub.ts` stub re-exports) | Six panels; Q = cancel without save; theme live-preview restores baseline |
| Signal utilities | `lib/utils.ts` | `combineSignals` (`AbortSignal.any` replacement for Node ≥ 22.19) |
| Repo hygiene | `scripts/repo-hygiene.js` | Deterministic cleanup + CI-gated check |

* * *

## Storage Model

Canonical multi-auth root: `~/.codex/multi-auth` (`CODEX_MULTI_AUTH_DIR` overrides; strict `$CODEX_HOME/multi-auth` when `CODEX_HOME` is customized).

| File | Purpose |
| --- | --- |
| `settings.json` (+`.bak`) | Unified dashboard + runtime config (`pluginConfig` section) |
| `openai-codex-accounts.json` | Main account pool (V3) |
| `openai-codex-accounts.json{.bak,.bak.1,.bak.2,.wal}` | Rotated backups + write-ahead journal |
| `openai-codex-accounts.json.pending-auth.json` | Rotated-credential journal applied on next load |
| `openai-codex-flagged-accounts.json` (+single `.bak`) | Flagged pool — no WAL, no rotation |
| `quota-cache.json` | Cached quota snapshots by accountId/email/workspace |
| `runtime-observability.json` `0600` | Runtime request counters + last-account metadata |
| `first-run-setup.json` | One-time durable-install claim marker |
| `account-policies.json` | Tags, weights, priority, pause/drain, notes |
| `routing-profiles.json` | Per-project routing preferences |
| `budget-guards.json` | Local request/token/cost limits |
| `local-client-tokens.json` | Bridge token hashes (no plaintext) |
| `usage/usage-ledger.jsonl` + `usage-ledger.<stamp>.jsonl` | Append-only usage metadata + archives |
| `refresh-leases/` | Cross-process refresh lease + result files |
| `runtime-rotation-app-helper.<pid>.json` | Per-helper status (un-suffixed legacy path still read) |
| `runtime-rotation-app-helper-owner.<pid>.json` | Per-helper owner identity; removed on exit, swept once PID is dead |
| `app-bind/` | Packaged app bind state, backup metadata, router status/log |
| `projects/<key>/` | Per-project account pools keyed by repo identity root |
| `backups/` | Named operator-exported backups |
| `logs/`, `cache/` | Diagnostics (when enabled), prompt/cache artifacts |

Official Codex-owned files stay under `~/.codex`: `auth.json`, `accounts.json`, `config.toml` (overridable via `CODEX_CLI_AUTH_PATH`/`CODEX_CLI_ACCOUNTS_PATH`/`CODEX_CLI_CONFIG_PATH`).

* * *

## Security Boundaries

1. **Loopback only** — rotation proxy, app router, and local bridge bind `127.0.0.1`/`localhost`/`::1` only; non-loopback bases are rejected. `upstreamBaseUrl` allows http only on numeric loopback with an explicit port — never names, credentials, query, or fragment.
2. **Local client authentication** — proxy uses a per-launch client key (timing-safe compare, checked before path routing); bridge uses hashed bearer tokens.
3. **No account PII in client-facing responses** — never account emails, auth tokens, or stale decoded `content-encoding` metadata.
4. **Redirects never followed** — `redirect: "error"` on every upstream fetch.
5. **Reversible app bind** — user `config.toml` + startup metadata only; official binaries never patched; unbind restores the backup.
6. **OAuth stays local** — callback binds `1455` on both `::1` and `127.0.0.1` (either-family conflict is fatal); PKCE S256; tokens land under the multi-auth root `0600`.
7. **Usage ledger redaction** — hashed identity fields and request metadata only.
8. **Ephemeral pins never persist** — `--account`/`FORCE_ACCOUNT` never mutate the stored `switch` pin and fail hard when the target is unavailable.
9. **Budgets are soft under concurrency** — pre-request ledger snapshot; intentional best-effort, not distributed quota.
10. **The keychain is never touched** — the auth-store reconcile only rewrites a top-level TOML assignment. Opt out per-invocation with `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0`, or globally with `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0`.
11. **Canonical-home overrides carry no secret on disk** — provider config goes through `-c` args and the client key through `OPENAI_API_KEY` in the child environment.

* * *

## Invariants

1. OAuth callback port remains `1455`.
2. `dist/` is generated output only.
3. Non-auth `codex-multi-auth-codex` commands forward to official Codex.
4. Canonical commands remain `codex-multi-auth ...`.
5. Runtime rotation is default-on and loopback-only.
6. Proxy client auth uses a per-process token.
7. Proxy responses never expose account emails, tokens, or stale decoded encoding headers.
8. App bind is reversible; official binaries are never patched.
9. Settings Q hotkey = cancel without save; theme live-preview restores baseline on cancel.
10. Email dedup is case-insensitive via `normalizeEmailKey()` (trim + lowercase).
11. Windows filesystem operations retry transient `EBUSY`/`EPERM`/`ENOTEMPTY` where lock-prone paths are touched.
12. Selection order stays pin → priority → sequential|affinity → hybrid → scan unless a release intentionally changes that contract.
13. `mcodex` is a convenience launcher only; it must not reimplement account-manager logic.
14. Interactive TUI/`resume`/`fork`/`app-server` sessions run against the canonical `CODEX_HOME` — never back onto a shadow copy.
15. The rotation provider is never written into real `~/.codex/config.toml` on the interactive path; the only top-level key reconciled there is `cli_auth_credentials_store`.
16. The keychain is never read or written.
17. Module imports stay acyclic and obey `types/constants → storage → accounts → runtime → manager/CLI`.
18. `cloneTrackedAccountStorage` is the only supported way to copy loaded account storage — raw clones drop the WeakMap merge baseline.
19. Governance store merges are union-by-`updatedAt` upserts; deletes never travel through a merge.

* * *

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md)
- [CONFIG_FLOW.md](CONFIG_FLOW.md)
- [TESTING.md](TESTING.md)
- [REPOSITORY_SCOPE.md](REPOSITORY_SCOPE.md)
- [../architecture.md](../architecture.md)
- [../features.md](../features.md)
