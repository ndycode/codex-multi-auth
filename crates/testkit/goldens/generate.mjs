#!/usr/bin/env node
/**
 * Golden byte-fixture generator for the Rust rewrite of codex-multi-auth.
 *
 * Exercises the REAL TypeScript implementation (build output in dist/lib) inside a
 * throwaway sandbox HOME, then copies each persisted artifact into this directory
 * under a stable name. See README.md (same directory) for the fixture catalog,
 * the exact producing function per fixture, and every post-processing step.
 *
 * Determinism rules:
 *  - All caller-injectable timestamps/ids use fixed values (T0 = 1750000000000).
 *  - Where the library stamps Date.now() / randomness INTERNALLY (documented in
 *    README.md), the produced file is re-parsed, ONLY the random/clock field is
 *    replaced with a fixed value, and the payload is re-serialized with the exact
 *    same serializer call the library used (same indent, same trailing-newline
 *    convention), so every other byte is authentic library output.
 *
 * Run:  node crates/testkit/goldens/generate.mjs
 */

import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const goldensDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(goldensDir, "..", "..", "..");
const distLib = join(repoRoot, "dist", "lib");

// ---------------------------------------------------------------------------
// Fixed deterministic inputs
// ---------------------------------------------------------------------------
const T0 = 1750000000000; // 2025-06-15T15:06:40.000Z
const EXPIRES_AT = 1750003600000; // T0 + 1h
const FIXED_CLIENT_KEY = "0123456789abcdef".repeat(4); // 64 hex chars, stands in for randomBytes(32).hex
const FIXED_TOKEN_UUID = "00000000-0000-4000-8000-000000000001";
const FIXED_PLAIN_TOKEN = `cma_local_${Buffer.from([...Array(32).keys()]).toString("base64url")}`;
const BASE_URL = "http://127.0.0.1:8123";
const MINIMAL_CONFIG_TOML = [
  'model = "gpt-5.2"',
  'model_provider = "openai"',
  "disable_response_storage = true",
  "",
  "[tools]",
  "web_search = true",
  "",
].join("\n");

const sha256hex = (value) => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------
// Sandbox: must be fully configured BEFORE any dist/ import. Several modules
// (quota-cache, unified-settings, update-notice, config) resolve their target
// path at module-load time via getCodexMultiAuthDir()/getCodexHomeDir().
// ---------------------------------------------------------------------------
const sandbox = await fsp.mkdtemp(join(os.tmpdir(), "cma-goldens-"));
const codexHome = join(sandbox, "codex-home");
const multiAuthDir = join(sandbox, "multi-auth");
const appBindCodexHome = join(sandbox, "app-bind-codex-home");

process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.CODEX_HOME = codexHome;
process.env.CODEX_MULTI_AUTH_DIR = multiAuthDir;
for (const key of [
  "VITEST", // runtime-observability disables persistence when VITEST === "true"
  "CODEX_MULTI_AUTH_SYNC_CODEX_CLI",
  "CODEX_AUTH_SYNC_CODEX_CLI",
  "CODEX_CLI_ACCOUNTS_PATH",
  "CODEX_CLI_AUTH_PATH",
  "CODEX_CLI_CONFIG_PATH",
  "CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE",
  "CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME",
  "CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY",
]) {
  delete process.env[key];
}

const mod = (p) => import(pathToFileURL(join(distLib, p)).href);

const emitted = [];
async function emit(name, data) {
  await fsp.writeFile(join(goldensDir, name), data);
  emitted.push(name);
}
async function copyFixture(sourcePath, name) {
  await emit(name, await fsp.readFile(sourcePath));
}
async function waitForFile(path, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fsp.readFile(path, "utf8");
      if (predicate(raw)) return raw;
    } catch {
      // not there yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

try {
  // =========================================================================
  // 1+2. accounts-v3.json + accounts-v3.wal  (storage.saveAccounts)
  // =========================================================================
  const storage = await mod("storage.js");

  const account1 = {
    accountId: "acct-user-one",
    accountIdSource: "id_token",
    accountLabel: "Personal Plus",
    email: "user.one@example.com",
    refreshToken: "rt-fixture-account-one-0000000001",
    accessToken: "at-fixture-account-one-0000000001",
    expiresAt: EXPIRES_AT,
    enabled: true,
    addedAt: 1749900000000,
    lastUsed: 1749999000000,
    lastSwitchReason: "rotation",
    rateLimitResetTimes: { "gpt-5-codex": 1750000600000, codex: 1750000300000 },
    workspaces: [
      { id: "ws-personal-1", name: "Personal", enabled: true, isDefault: true },
      { id: "ws-team-alpha", name: "Team Alpha", enabled: false, disabledAt: 1749950000000 },
    ],
    currentWorkspaceIndex: 0,
  };
  const account2 = {
    accountId: "acct-user-two",
    accountIdSource: "token",
    accountLabel: "Team Business",
    email: "user.two@example.com",
    refreshToken: "rt-fixture-account-two-0000000002",
    accessToken: "at-fixture-account-two-0000000002",
    expiresAt: EXPIRES_AT,
    enabled: true,
    addedAt: 1749910000000,
    lastUsed: T0,
    lastSwitchReason: "manual",
    rateLimitResetTimes: { "gpt-5.2": 1750001200000 },
    coolingDownUntil: 1750000060000,
    cooldownReason: "rate-limit",
    workspaces: [{ id: "ws-biz-2", name: "Business", enabled: true, isDefault: true }],
    currentWorkspaceIndex: 0,
  };
  const accountsStorage = {
    version: 3,
    accounts: [account1, account2],
    activeIndex: 1,
    activeIndexByFamily: { "gpt-5-codex": 0, "codex-max": 1, codex: 0, "gpt-5.2": 1, "gpt-5.1": 0 },
    pinnedAccountIndex: 1,
    affinityGeneration: 4,
  };

  // WAL capture harness: saveAccounts writes the WAL journal, then deletes it
  // after the atomic rename succeeds (cleanupWal). To capture the exact bytes
  // the library wrote, temporarily wrap fs.promises.unlink so the *.wal file is
  // read (not blocked -- the real unlink still runs) right before deletion.
  const realUnlink = fsp.unlink;
  let walBytes = null;
  fsp.unlink = async function patchedUnlink(target, ...rest) {
    if (typeof target === "string" && target.endsWith(".wal") && walBytes === null) {
      try {
        walBytes = await fsp.readFile(target);
      } catch {
        // ignore; fall through to the real unlink
      }
    }
    return realUnlink.call(this, target, ...rest);
  };
  try {
    await storage.saveAccounts(accountsStorage);
  } finally {
    fsp.unlink = realUnlink;
  }
  if (!walBytes) throw new Error("WAL journal was not captured during saveAccounts");

  await copyFixture(join(multiAuthDir, "openai-codex-accounts.json"), "accounts-v3.json");

  // Post-process (documented): createdAt is Date.now(), path embeds the sandbox
  // dir. checksum covers only `content`, so neither replacement invalidates it.
  const walEntry = JSON.parse(walBytes.toString("utf8"));
  walEntry.createdAt = T0;
  walEntry.path = "/golden/multi-auth/openai-codex-accounts.json";
  await emit("accounts-v3.wal", JSON.stringify(walEntry));

  // =========================================================================
  // 3. flagged-v1.json  (storage.saveFlaggedAccounts)
  // =========================================================================
  await storage.saveFlaggedAccounts({
    version: 1,
    accounts: [
      {
        refreshToken: "rt-fixture-flagged-0000000003",
        addedAt: 1749800000000,
        lastUsed: 1749990000000,
        accountId: "acct-user-three",
        accountIdSource: "id_token",
        accountLabel: "Flagged Account",
        email: "user.three@example.com",
        accessToken: "at-fixture-flagged-0000000003",
        expiresAt: EXPIRES_AT,
        enabled: false,
        lastSwitchReason: "rate-limit",
        rateLimitResetTimes: { codex: 1750000900000 },
        coolingDownUntil: EXPIRES_AT,
        cooldownReason: "auth-failure",
        workspaces: [{ id: "ws-three-1", name: "Personal", enabled: true, isDefault: true }],
        currentWorkspaceIndex: 0,
        flaggedAt: T0,
        flaggedReason: "invalid_grant on refresh",
        lastError: "401 Unauthorized: invalid_grant",
      },
    ],
  });
  await copyFixture(join(multiAuthDir, "openai-codex-flagged-accounts.json"), "flagged-v1.json");

  // =========================================================================
  // 4. settings.json  (unified-settings saveUnifiedPluginConfig +
  //    saveUnifiedDashboardSettings, with library default payloads)
  // =========================================================================
  const config = await mod("config.js");
  const dashboard = await mod("dashboard-settings.js");
  const unifiedSettings = await mod("unified-settings.js");
  await unifiedSettings.saveUnifiedPluginConfig(config.getDefaultPluginConfig());
  await unifiedSettings.saveUnifiedDashboardSettings(dashboard.DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
  await copyFixture(join(multiAuthDir, "settings.json"), "settings.json");

  // =========================================================================
  // 5. quota-cache.json  (quota-cache saveQuotaCache)
  // =========================================================================
  const quotaCache = await mod("quota-cache.js");
  const quotaEntryOne = {
    updatedAt: T0,
    status: 200,
    model: "gpt-5.2",
    planType: "plus",
    primary: { usedPercent: 42, windowMinutes: 300, resetAtMs: 1750010000000 },
    secondary: { usedPercent: 12.5, windowMinutes: 10080, resetAtMs: 1750600000000 },
  };
  const quotaEntryTwo = {
    updatedAt: T0,
    status: 429,
    model: "gpt-5-codex",
    planType: "team",
    primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: 1750000600000 },
    secondary: { usedPercent: 63, windowMinutes: 10080, resetAtMs: 1750550000000 },
  };
  await quotaCache.saveQuotaCache({
    byAccountId: { "acct-user-one": quotaEntryOne, "acct-user-two": quotaEntryTwo },
    byEmail: { "user.one@example.com": quotaEntryOne, "user.two@example.com": quotaEntryTwo },
  });
  await copyFixture(join(multiAuthDir, "quota-cache.json"), "quota-cache.json");

  // =========================================================================
  // 6. budget-guards.json  (budget-guard upsertBudgetLimit + saveBudgetGuardStore)
  // =========================================================================
  const budgetGuard = await mod("budget-guard.js");
  const budgetStore = await budgetGuard.loadBudgetGuardStore();
  budgetGuard.upsertBudgetLimit(
    budgetStore,
    { key: "team-alpha", window: "day", maxRequests: 500, maxTokens: 2000000, maxCostUsd: 25 },
    T0,
  );
  budgetGuard.upsertBudgetLimit(budgetStore, { key: "personal", window: "month", maxCostUsd: 100 }, T0);
  await budgetGuard.saveBudgetGuardStore(budgetStore);
  await copyFixture(join(multiAuthDir, "budget-guards.json"), "budget-guards.json");

  // =========================================================================
  // 7. account-policies.json  (account-policy getAccountPolicyKey +
  //    upsertAccountPolicy + saveAccountPolicyStore)
  // =========================================================================
  const accountPolicy = await mod("account-policy.js");
  const policyKeyOne = accountPolicy.getAccountPolicyKey({ accountId: "acct-user-one" }, 0);
  const policyKeyTwo = accountPolicy.getAccountPolicyKey({ accountId: "acct-user-two" }, 1);
  const policyStore = await accountPolicy.loadAccountPolicyStore();
  accountPolicy.upsertAccountPolicy(
    policyStore,
    policyKeyOne,
    (policy) => {
      policy.tags = ["personal", "primary"];
      policy.weight = 2;
      policy.note = "Primary fixture account";
    },
    T0,
  );
  accountPolicy.upsertAccountPolicy(
    policyStore,
    policyKeyTwo,
    (policy) => {
      policy.tags = ["team"];
      policy.weight = 1;
      policy.paused = true;
      policy.note = "Paused fixture account";
    },
    T0,
  );
  await accountPolicy.saveAccountPolicyStore(policyStore);
  await copyFixture(join(multiAuthDir, "account-policies.json"), "account-policies.json");

  // =========================================================================
  // 8. routing-profiles.json  (routing-profiles createDefaultRoutingProfile +
  //    upsertRoutingProfile + saveRoutingProfileStore)
  // =========================================================================
  const routingProfiles = await mod("routing-profiles.js");
  const routingStore = await routingProfiles.loadRoutingProfileStore();
  const routingProfile = routingProfiles.createDefaultRoutingProfile({
    projectKey: "my-app-0123456789ab",
    projectName: "my-app",
    identityRoot: "/workspace/my-app",
    now: T0,
  });
  routingProfiles.upsertRoutingProfile(
    routingStore,
    routingProfile,
    (profile) => {
      profile.preferredTags = ["primary"];
      profile.avoidTags = ["burner"];
      profile.modelAllowlist = ["gpt-5.2", "gpt-5-codex"];
      profile.accountWeightByKey = { [policyKeyOne]: 2, [policyKeyTwo]: 0.5 };
      profile.budgetKey = "team-alpha";
    },
    T0,
  );
  await routingProfiles.saveRoutingProfileStore(routingStore);
  await copyFixture(join(multiAuthDir, "routing-profiles.json"), "routing-profiles.json");

  // =========================================================================
  // 9. local-client-tokens.json  (local-client-tokens addLocalClientToken)
  // =========================================================================
  const localClientTokens = await mod("local-client-tokens.js");
  await localClientTokens.addLocalClientToken({ label: "workstation", now: T0 });
  // Post-process (documented): id is randomUUID(), prefix/tokenHash derive from
  // randomBytes(32). Replaced with values derived from FIXED_PLAIN_TOKEN so the
  // record stays internally consistent (prefix = first 18 chars of the plain
  // token, tokenHash = sha256 of the plain token, library's own scheme).
  const tokenStore = JSON.parse(await fsp.readFile(join(multiAuthDir, "local-client-tokens.json"), "utf8"));
  tokenStore.tokens[0].id = FIXED_TOKEN_UUID;
  tokenStore.tokens[0].prefix = FIXED_PLAIN_TOKEN.slice(0, 18);
  tokenStore.tokens[0].tokenHash = `sha256:${sha256hex(FIXED_PLAIN_TOKEN)}`;
  await emit("local-client-tokens.json", `${JSON.stringify(tokenStore, null, 2)}\n`);

  // =========================================================================
  // 10. runtime-observability.json  (runtime-observability
  //     mutateRuntimeObservabilitySnapshot -> debounced persisted snapshot)
  // =========================================================================
  const observability = await mod("runtime/runtime-observability.js");
  observability.mutateRuntimeObservabilitySnapshot((snapshot) => {
    snapshot.responsesRequests = 3;
    snapshot.authRefreshRequests = 1;
    snapshot.lastAccountIndex = 1;
    snapshot.lastAccountLabel = "Team Business";
    snapshot.lastAccountEmail = "user.two@example.com";
    snapshot.lastAccountId = "acct-user-two";
    snapshot.lastAccountUpdatedAt = T0;
    snapshot.lastPoolExhaustionReason = "all-accounts-rate-limited";
    snapshot.lastPoolExhaustionRetryAfterMs = 30000;
    snapshot.lastPoolExhaustionSkipReasons = { 0: "rate-limited", 1: "cooldown" };
    snapshot.accountSkipReasons = { 0: "rate-limited" };
    snapshot.policyBlockedIndexes = [2];
    snapshot.policyBlockedReasons = { 2: "paused" };
    snapshot.lastRuntimeReloadAt = T0;
    snapshot.lastRuntimeReloadReason = "accounts-file-changed";
    Object.assign(snapshot.runtimeMetrics, {
      startedAt: 1749990000000,
      totalRequests: 3,
      successfulRequests: 2,
      failedRequests: 1,
      responsesRequests: 3,
      authRefreshRequests: 1,
      rateLimitedResponses: 1,
      accountRotations: 1,
      cumulativeLatencyMs: 5150,
      lastRequestAt: T0,
      lastError: "429 rate_limit_exceeded",
    });
  });
  const snapshotPath = join(multiAuthDir, "runtime-observability.json");
  const snapshotRaw = await waitForFile(snapshotPath, (raw) => {
    try {
      return JSON.parse(raw).updatedAt > 0;
    } catch {
      return false;
    }
  });
  // Post-process (documented): updatedAt is stamped Date.now() by the library.
  const snapshot = JSON.parse(snapshotRaw);
  snapshot.updatedAt = T0;
  await emit("runtime-observability.json", JSON.stringify(snapshot, null, 2));

  // =========================================================================
  // 11. app-bind-state.json  (runtime/app-bind bindCodexAppRuntimeRotation;
  //     on-disk name runtime-rotation-app-bind.json)
  // =========================================================================
  const appBind = await mod("runtime/app-bind.js");
  const configToml = await mod("runtime/config-toml.js");
  const bindDir = join(multiAuthDir, "app-bind");
  await fsp.mkdir(appBindCodexHome, { recursive: true });
  await fsp.writeFile(join(appBindCodexHome, "config.toml"), MINIMAL_CONFIG_TOML, "utf8");
  await fsp.mkdir(bindDir, { recursive: true });
  // Seeded INPUT (documented): a router status file reporting a live router on a
  // fixed port, so bind resolves port 8123 without spawning a real router
  // process. pid = this generator process (alive for the isProcessAlive check).
  await fsp.writeFile(
    join(bindDir, "runtime-rotation-app-bind-status.json"),
    `${JSON.stringify({ state: "running", pid: process.pid, baseUrl: BASE_URL, totalRequests: 0, updatedAt: T0 })}\n`,
    "utf8",
  );
  const bindEnv = {
    CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: appBindCodexHome,
    CODEX_MULTI_AUTH_DIR: multiAuthDir,
  };
  await appBind.bindCodexAppRuntimeRotation({
    env: bindEnv,
    platform: "linux", // no Startup/LaunchAgent side files; stable platform field
    home: sandbox,
    now: () => T0,
    nodePath: "/usr/bin/node",
    routerScriptPath: "/opt/codex-multi-auth/scripts/codex-app-router.js",
    spawnDetached: false,
  });
  // Post-process (documented): clientApiKey is randomBytes(32).hex -> replaced
  // with FIXED_CLIENT_KEY; boundConfigHash recomputed with the library's own
  // rewriteConfigTomlForAppBind over the same inputs so it stays consistent
  // (it equals sha256 of config-toml-provider-block.toml); sandbox-absolute
  // paths replaced with stable /golden placeholders.
  const bindState = JSON.parse(await fsp.readFile(join(bindDir, "runtime-rotation-app-bind.json"), "utf8"));
  bindState.clientApiKey = FIXED_CLIENT_KEY;
  bindState.boundConfigHash = sha256hex(
    appBind.rewriteConfigTomlForAppBind(MINIMAL_CONFIG_TOML, BASE_URL, FIXED_CLIENT_KEY),
  );
  bindState.configPath = "/golden/codex-home/config.toml";
  bindState.statePath = "/golden/multi-auth/app-bind/runtime-rotation-app-bind.json";
  bindState.backupPath = "/golden/multi-auth/app-bind/codex-config-backup.json";
  bindState.statusPath = "/golden/multi-auth/app-bind/runtime-rotation-app-bind-status.json";
  bindState.logPath = "/golden/multi-auth/app-bind/runtime-rotation-app-router.log";
  await emit("app-bind-state.json", `${JSON.stringify(bindState, null, 2)}\n`);

  // =========================================================================
  // 12. first-run-setup.json  (runtime/first-run ensureFirstRunSetup)
  // =========================================================================
  const firstRun = await mod("runtime/first-run.js");
  const firstRunResult = await firstRun.ensureFirstRunSetup({
    env: {},
    installedContext: true,
    markerPath: join(multiAuthDir, "first-run-setup.json"),
    now: () => T0,
    resolveRotation: () => true,
    bindCodexApp: async () => "completed",
    installLauncher: async () => "skipped",
    notify: () => {},
  });
  if (!firstRunResult.ran) throw new Error(`first-run setup did not run: ${firstRunResult.reason}`);
  await copyFixture(join(multiAuthDir, "first-run-setup.json"), "first-run-setup.json");

  // =========================================================================
  // 13. usage-ledger-row.jsonl  (usage/ledger appendUsageLedgerRow)
  // =========================================================================
  const ledger = await mod("usage/ledger.js");
  await ledger.appendUsageLedgerRow({
    id: "usage-fixture-0000000000000001",
    createdAt: T0,
    source: "runtime-proxy",
    operation: "responses",
    outcome: "success",
    model: "gpt-5.2",
    projectKey: "my-app-0123456789ab",
    accountId: "acct-user-one",
    email: "User.One@Example.com", // library lowercases before hashing
    accountIndex: 0,
    requestId: "req-fixture-0001",
    statusCode: 200,
    durationMs: 1234,
    inputTokens: 1200,
    outputTokens: 350,
    cachedInputTokens: 800,
    reasoningTokens: 64,
    costUsd: 0.0123,
  });
  await copyFixture(join(multiAuthDir, "usage", "usage-ledger.jsonl"), "usage-ledger-row.jsonl");

  // =========================================================================
  // 14. update-check-cache.json  (update-notice checkForUpdates with the npm
  //     registry fetch stubbed to a fixed payload)
  // =========================================================================
  const updateNotice = await mod("update-notice.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ name: "codex-multi-auth", version: "9.9.9" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    await updateNotice.checkForUpdates(true);
  } finally {
    globalThis.fetch = realFetch;
  }
  // Post-process (documented): lastCheck is stamped Date.now() by the library.
  const updateCache = JSON.parse(
    await fsp.readFile(join(multiAuthDir, "cache", "update-check-cache.json"), "utf8"),
  );
  updateCache.lastCheck = T0;
  await emit("update-check-cache.json", JSON.stringify(updateCache, null, 2));

  // =========================================================================
  // 15+16. codex-cli-accounts.json + codex-cli-auth.json
  //        (codex-cli/writer setCodexCliActiveSelection mirror writer)
  // =========================================================================
  const cliWriter = await mod("codex-cli/writer.js");
  await fsp.mkdir(codexHome, { recursive: true });
  // Seeded INPUT (documented): a pre-existing Codex CLI accounts.json that the
  // mirror writer rewrites in place (it only touches accounts.json when the
  // file already exists).
  const seededCliAccounts = {
    accounts: [
      {
        accountId: "acct-user-one",
        email: "user.one@example.com",
        access_token: "at-old-cli-one",
        refresh_token: "rt-old-cli-one",
        id_token: "idt-old-cli-one",
        active: false,
      },
      {
        accountId: "acct-user-two",
        email: "user.two@example.com",
        access_token: "at-old-cli-two",
        refresh_token: "rt-old-cli-two",
        id_token: "idt-old-cli-two",
        active: true,
      },
    ],
    activeAccountId: "acct-user-two",
    active_account_id: "acct-user-two",
  };
  await fsp.writeFile(join(codexHome, "accounts.json"), JSON.stringify(seededCliAccounts, null, 2), "utf8");
  const wroteSelection = await cliWriter.setCodexCliActiveSelection({
    accountId: "acct-user-one",
    email: "user.one@example.com",
    accessToken: "at-fixture-account-one-0000000001",
    refreshToken: "rt-fixture-account-one-0000000001",
    expiresAt: EXPIRES_AT,
    idToken: "idt-fixture-account-one-0000000001",
  });
  if (!wroteSelection) throw new Error("setCodexCliActiveSelection reported failure");
  // Post-process (documented): codexMultiAuthSyncVersion is stamped Date.now()
  // by the library in both mirror files.
  const cliAccounts = JSON.parse(await fsp.readFile(join(codexHome, "accounts.json"), "utf8"));
  cliAccounts.codexMultiAuthSyncVersion = T0;
  await emit("codex-cli-accounts.json", JSON.stringify(cliAccounts, null, 2));
  const cliAuth = JSON.parse(await fsp.readFile(join(codexHome, "auth.json"), "utf8"));
  cliAuth.codexMultiAuthSyncVersion = T0;
  await emit("codex-cli-auth.json", JSON.stringify(cliAuth, null, 2));

  // =========================================================================
  // 17. config-toml-provider-block.toml  (runtime/config-toml
  //     rewriteConfigTomlForRuntimeRotationProvider, pure function)
  // =========================================================================
  const rewrittenConfig = configToml.rewriteConfigTomlForRuntimeRotationProvider(
    MINIMAL_CONFIG_TOML,
    BASE_URL,
    FIXED_CLIENT_KEY,
  );
  await emit("config-toml-provider-block.toml", rewrittenConfig);

  // =========================================================================
  // Verify all fixtures landed, then clean up the sandbox.
  // =========================================================================
  const expected = [
    "accounts-v3.json",
    "accounts-v3.wal",
    "flagged-v1.json",
    "settings.json",
    "quota-cache.json",
    "budget-guards.json",
    "account-policies.json",
    "routing-profiles.json",
    "local-client-tokens.json",
    "runtime-observability.json",
    "app-bind-state.json",
    "first-run-setup.json",
    "usage-ledger-row.jsonl",
    "update-check-cache.json",
    "codex-cli-accounts.json",
    "codex-cli-auth.json",
    "config-toml-provider-block.toml",
  ];
  const missing = [];
  for (const name of expected) {
    const stat = await fsp.stat(join(goldensDir, name)).catch(() => null);
    if (!stat || stat.size === 0) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`Missing or empty fixtures: ${missing.join(", ")}`);
  }
  console.log(`OK: ${expected.length} fixtures written to ${goldensDir}`);
  for (const name of expected) {
    const bytes = await fsp.readFile(join(goldensDir, name));
    console.log(`  ${name}  ${bytes.length} bytes  sha256:${sha256hex(bytes).slice(0, 16)}`);
  }
} finally {
  await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

// Some imported dist modules keep timers/queues alive; exit explicitly.
process.exit(0);
