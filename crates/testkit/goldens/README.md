# Golden byte fixtures (TypeScript reference implementation)

Byte-exact fixtures for the Rust rewrite, produced by the **real** TypeScript
implementation (`dist/lib/`, package version 2.7.1). Every fixture is the file
the TS library actually wrote to disk in a sandboxed HOME; the Rust
implementation must reproduce these bytes exactly (or parse them exactly).

Regenerate with:

```
npm run build   # only if dist/ is stale
node crates/testkit/goldens/generate.mjs
```

The generator is deterministic: repeated runs produce byte-identical fixtures.
It runs fully sandboxed (`HOME`, `USERPROFILE`, `CODEX_HOME`,
`CODEX_MULTI_AUTH_DIR` all point into a fresh temp dir set in-process **before**
any `dist/` import, because several modules resolve their target path at module
load time). The real user profile is never touched; the sandbox is deleted
afterwards.

## Fixed inputs

| Constant | Value |
| --- | --- |
| `T0` (canonical timestamp) | `1750000000000` |
| `EXPIRES_AT` | `1750003600000` (T0 + 1h) |
| `FIXED_CLIENT_KEY` | `"0123456789abcdef"` x 4 (64 hex chars) |
| `FIXED_PLAIN_TOKEN` | `cma_local_` + base64url(bytes `0x00..0x1f`) |
| `BASE_URL` | `http://127.0.0.1:8123` |
| minimal `config.toml` | `model = "gpt-5.2"` / `model_provider = "openai"` / `disable_response_storage = true` + `[tools]` table (see `generate.mjs`) |

All timestamps/ids that the public API lets callers inject use these fixed
values. Where the library stamps clock/randomness internally, the produced file
is re-parsed, **only** that field is replaced, and the payload is re-serialized
with the exact same serializer call the library used (same indent and
trailing-newline convention). Every such replacement is listed per fixture
below; everything else is authentic library output.

## Fixture catalog

### accounts-v3.json
- **Producer:** `saveAccounts(storage)` (`dist/lib/storage.js`), on-disk name
  `openai-codex-accounts.json`. Serialization: `JSON.stringify(storage, null, 2)`,
  no trailing newline.
- **Input:** a v3 pool with 2 accounts (workspaces incl. a disabled one,
  per-family `rateLimitResetTimes`, cooldown on account 2), `activeIndex: 1`,
  `activeIndexByFamily` covering all 5 model families, `pinnedAccountIndex: 1`,
  `affinityGeneration: 4`. Note `saveAccounts` serializes the caller's object
  verbatim (no reordering on the write path), so the generator constructs the
  input in the same canonical field order the library itself uses when it
  builds storage objects (`normalizeAccountStorage` /
  `cloneAccountStorageForPersistence` top-level order; `AccountMetadataV3`
  declaration order per account).
- **Post-processing:** none.

### accounts-v3.wal
- **Producer:** the WAL journal entry `saveAccounts` writes (via its internal
  `writeJournal`) before the atomic rename, for the exact save above.
  Single-line `JSON.stringify` of
  `{version: 1, createdAt, path, checksum, content}` where `checksum` =
  sha256 hex of `content` and `content` is byte-identical to
  `accounts-v3.json`.
- **Capture harness:** `saveAccounts` deletes the WAL after a successful save,
  so the generator temporarily wraps `fs.promises.unlink` to read the `*.wal`
  bytes immediately before the (still executed) real deletion. The bytes are
  what the library wrote.
- **Post-processing:** `createdAt` (internally `Date.now()`) -> `T0`; `path`
  (sandbox-absolute accounts path) -> `/golden/multi-auth/openai-codex-accounts.json`.
  The checksum covers only `content`, so both replacements keep it valid.

### flagged-v1.json
- **Producer:** `saveFlaggedAccounts(storage)` (`dist/lib/storage.js`), on-disk
  name `openai-codex-flagged-accounts.json`. The library normalizes through
  `normalizeFlaggedStorage` before writing (that function defines the field
  order). `JSON.stringify(..., null, 2)`, no trailing newline.
- **Input:** one flagged account (`flaggedAt: T0`,
  `flaggedReason: "invalid_grant on refresh"`, `lastError`, cooldown fields,
  one workspace).
- **Post-processing:** none.

### settings.json
- **Producer:** `saveUnifiedPluginConfig(getDefaultPluginConfig())` followed by
  `saveUnifiedDashboardSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS)`
  (`dist/lib/unified-settings.js`, defaults from `dist/lib/config.js` and
  `dist/lib/dashboard-settings.js`). Record shape:
  `{pluginConfig, version: 1, dashboardDisplaySettings}`.
  `JSON.stringify(..., null, 2)` + trailing newline.
- **Input:** the library's own default plugin config and default dashboard
  display settings (canonical defaults of version 2.7.1).
- **Post-processing:** none.

### quota-cache.json
- **Producer:** `saveQuotaCache(data)` (`dist/lib/quota-cache.js`). Payload
  `{version: 1, byAccountId, byEmail}`, `JSON.stringify(..., null, 2)` +
  trailing newline.
- **Input:** two entries (one healthy 200/`gpt-5.2`/`plus`, one exhausted
  429/`gpt-5-codex`/`team`) keyed by both accountId and email, fixed
  `updatedAt: T0` and fixed window numbers. Entry field order matches the
  library's `normalizeEntry` order.
- **Post-processing:** none.

### budget-guards.json
- **Producer:** `loadBudgetGuardStore()` + `upsertBudgetLimit(store, limit, T0)`
  (x2) + `saveBudgetGuardStore(store)` (`dist/lib/budget-guard.js`; save runs
  the store through `normalizeStore`). Trailing newline.
- **Input:** `team-alpha` day limit (requests/tokens/cost) and `personal` month
  limit (cost only; absent caps are omitted from the JSON).
- **Post-processing:** none (`updatedAt` is injectable via the `now` parameter).

### account-policies.json
- **Producer:** `getAccountPolicyKey({accountId})` +
  `upsertAccountPolicy(store, key, mutate, T0)` (x2) +
  `saveAccountPolicyStore(store)` (`dist/lib/account-policy.js`). Keys are the
  library's own `sha256:<hex of accountId>` derivation for `acct-user-one` /
  `acct-user-two`. Trailing newline.
- **Input:** policy 1: tags `personal, primary`, weight 2, note; policy 2:
  tags `team`, weight 1, `paused: true`, note.
- **Post-processing:** none.

### routing-profiles.json
- **Producer:** `createDefaultRoutingProfile({... now: T0})` +
  `upsertRoutingProfile(store, profile, mutate, T0)` +
  `saveRoutingProfileStore(store)` (`dist/lib/routing-profiles.js`). Trailing
  newline.
- **Input:** `projectKey: "my-app-0123456789ab"` (fixed string in the library's
  `<name>-<12-hex>` format, chosen instead of `getProjectStorageKey` so the
  bytes don't depend on the generating machine's filesystem),
  `identityRoot: "/workspace/my-app"`, preferred/avoid tags, model allowlist,
  `accountWeightByKey` keyed by the same `sha256:` account-policy keys,
  `budgetKey: "team-alpha"`.
- **Post-processing:** none.

### local-client-tokens.json
- **Producer:** `addLocalClientToken({label: "workstation", now: T0})`
  (`dist/lib/local-client-tokens.js`). Trailing newline.
- **Post-processing:** the library generates `id` via `randomUUID()` and the
  token via `randomBytes(32)`. Replaced with values derived from
  `FIXED_PLAIN_TOKEN` using the library's own scheme so the record stays
  internally consistent: `id` -> `00000000-0000-4000-8000-000000000001`,
  `prefix` -> first 18 chars of `FIXED_PLAIN_TOKEN` (`cma_local_AAECAwQF`),
  `tokenHash` -> `sha256:` + sha256 hex of `FIXED_PLAIN_TOKEN`.

### runtime-observability.json
- **Producer:** `mutateRuntimeObservabilitySnapshot(mutator)`
  (`dist/lib/runtime/runtime-observability.js`), which persists the snapshot
  asynchronously. `JSON.stringify(..., null, 2)`, no trailing newline. The
  full default snapshot shape (all fields of `createDefaultSnapshot`) is
  present; the mutator sets pool-exhaustion state, skip reasons, policy blocks,
  reload markers, and runtime metrics to fixed values.
- **Post-processing:** `updatedAt` (stamped `Date.now()` by the library after
  the mutator runs) -> `T0`.
- **Note:** persistence is disabled when `VITEST=true`; the generator clears
  that variable before import.

### app-bind-state.json
- **Producer:** `bindCodexAppRuntimeRotation(options)`
  (`dist/lib/runtime/app-bind.js`), on-disk name
  `runtime-rotation-app-bind.json`. `JSON.stringify(..., null, 2)` + trailing
  newline.
- **Input:** options `{platform: "linux", now: () => T0, nodePath:
  "/usr/bin/node", routerScriptPath: "/opt/codex-multi-auth/scripts/codex-app-router.js",
  spawnDetached: false}` plus a dedicated bind codex-home
  (`CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME`) seeded with the minimal
  `config.toml`. A **seeded input** router status file
  (`runtime-rotation-app-bind-status.json` with `state: "running"`,
  `pid: <generator pid>`, `baseUrl: BASE_URL`) lets bind resolve port 8123
  without spawning a real router process.
- **Post-processing:** `clientApiKey` (internally `randomBytes(32).hex`) ->
  `FIXED_CLIENT_KEY`; `boundConfigHash` recomputed with the library's own
  `rewriteConfigTomlForAppBind(minimalConfig, BASE_URL, FIXED_CLIENT_KEY)` so it
  stays consistent -- it equals the sha256 of
  `config-toml-provider-block.toml`; the five sandbox-absolute path fields
  (`configPath`, `statePath`, `backupPath`, `statusPath`, `logPath`) ->
  stable `/golden/...` placeholders. `platform`, `nodePath`,
  `routerScriptPath`, `updatedAt` were already fixed via options.

### first-run-setup.json
- **Producer:** `ensureFirstRunSetup(deps)` (`dist/lib/runtime/first-run.js`)
  with injected deps: `env: {}`, `installedContext: true`, `now: () => T0`,
  `resolveRotation: () => true`, `bindCodexApp: async () => "completed"`,
  `installLauncher: async () => "skipped"`. Tab-indented JSON
  (`JSON.stringify(..., null, "\t")`) + trailing newline -- the finalized
  marker, not the initial claim stub.
- **Post-processing:** none.

### usage-ledger-row.jsonl
- **Producer:** `appendUsageLedgerRow(input)` (`dist/lib/usage/ledger.js`);
  single JSONL line (`JSON.stringify(row)` + `\n`) from
  `usage/usage-ledger.jsonl`.
- **Input:** fixed `id`/`createdAt`, `runtime-proxy`/`responses`/`success`,
  model `gpt-5.2`, fixed token counts, explicit `costUsd: 0.0123` (explicit so
  the fixture doesn't track the pricing table). `accountHash`/`emailHash` are
  the library's `sha256:` hashes of `acct-user-one` and
  `user.one@example.com` (input email deliberately mixed-case
  `User.One@Example.com` to exercise the library's lowercasing).
- **Post-processing:** none.

### update-check-cache.json
- **Producer:** `checkForUpdates(true)` (`dist/lib/update-notice.js`), on-disk
  `cache/update-check-cache.json`. `JSON.stringify(..., null, 2)`, no trailing
  newline.
- **Input:** `globalThis.fetch` is stubbed during the call to return
  `{name: "codex-multi-auth", version: "9.9.9"}` (the npm-registry network
  boundary is the only thing replaced; the cache bytes are written by the
  library). `currentVersion` is read by the library from the repo's real
  `package.json` -- it is `2.7.1` and **will change when the package version
  bumps**; regenerate after releases.
- **Post-processing:** `lastCheck` (stamped `Date.now()`) -> `T0`.

### codex-cli-accounts.json and codex-cli-auth.json
- **Producer:** `setCodexCliActiveSelection(selection)`
  (`dist/lib/codex-cli/writer.js`) -- the mirror writer output for
  `$CODEX_HOME/accounts.json` and `$CODEX_HOME/auth.json`.
  `JSON.stringify(..., null, 2)`, no trailing newline.
- **Input:** a **seeded input** CLI `accounts.json` (2 records with stale
  `at-old-cli-*` tokens, account two active) -- the writer only rewrites
  `accounts.json` when it already exists; `auth.json` did not exist (created
  from `{}`). Selection: account one with the fixture tokens and
  `expiresAt: EXPIRES_AT` (hence `last_refresh: "2025-06-15T16:06:40.000Z"`).
- **Post-processing:** `codexMultiAuthSyncVersion` in **both** files (stamped
  `Date.now()`) -> `T0`.

### config-toml-provider-block.toml
- **Producer:** `rewriteConfigTomlForRuntimeRotationProvider(minimalConfig,
  BASE_URL, FIXED_CLIENT_KEY)` (`dist/lib/runtime/config-toml.js`) -- the
  byte-exact result of applying the runtime-rotation provider-block insert to
  the minimal `config.toml` (provider swap to
  `codex-multi-auth-runtime-proxy`, `disable_response_storage` flipped to
  `false`, provider table with `experimental_bearer_token` appended).
- **Post-processing:** none. Invariant: `sha256(this file)` ==
  `boundConfigHash` in `app-bind-state.json` (same config, base URL, and key).

## Non-obvious environment gotchas encoded in the generator

- Path constants are frozen at module load in several modules
  (`quota-cache.js`, `unified-settings.js`, `update-notice.js`, `config.js`):
  sandbox env vars must be exported before the first `dist/` import.
- `runtime-observability.js` skips persistence entirely when `VITEST === "true"`.
- `saveAccounts` refuses payloads matching the synthetic-fixture heuristic
  (`accountN@example.com` + `fake_refresh_token_*`) when real storage exists;
  the fixture identities intentionally do not match that pattern.
- The WAL is deleted on successful save; it only survives on disk after a crash
  between journal write and rename (which is what the fixture simulates).
