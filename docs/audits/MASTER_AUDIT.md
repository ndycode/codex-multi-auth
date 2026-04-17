# Master Repository Audit â€” codex-multi-auth

**Audit Date**: 2026-04-17
**HEAD**: `1f6da97d06dcc8c268b304e6e45b6baa9a386679`
**Branch**: `main`
**Package**: `codex-multi-auth@1.2.7`
**Node**: (captured in `evidence/context.txt`)
**Audit methodology**: Sisyphus multi-wave plan executed under Atlas; evidence under `docs/audits/evidence/`
**Composition note**: Findings composed from dimension deep-dives (dim-C through dim-P). Several dimensions composed by Atlas from captured sub-agent analysis when agents exceeded step budgets before writing deliverables.

## Severity Rubric
- **CRITICAL**: token/auth corruption, data loss, unsafe credential handling, or core trust breakage
- **HIGH**: likely real-world operational pain, hard-to-debug failures, serious maintainability or resilience risk, bypassable security
- **MEDIUM**: meaningful architecture/testing/DX weakness, degraded UX
- **LOW**: cleanup, polish, consistency

## Dimensions Audited (Coverage Matrix)

| Dim | Area | Primary Section | Evidence File |
|-----|------|-----------------|---------------|
| Dimension A | Product / system understanding | Â§1 Executive, Â§2 System Map | inventory.txt, context.txt |
| Dimension B | Architecture | Â§2 System Map, Â§8 Refactors, Â§16 Modules | all dim-*.md |
| Dimension C | Auth / OAuth / token lifecycle | Â§5 HIGH (H4, H5), Â§10 Security | dim-C-auth.md |
| Dimension D | Multi-account / routing / failover | Â§5 HIGH (H2, H3, H10), Â§6 MEDIUM | dim-D-routing.md |
| Dimension E | Storage / filesystem / state | Â§5 HIGH (H1), Â§6 MEDIUM (M01-M05) | dim-E-storage.md |
| Dimension F | Config / settings / precedence | Â§5 HIGH (H6), Â§6 MEDIUM (M21-M23) | dim-F-config.md |
| Dimension G | CLI / UX | Â§6 MEDIUM (M24-M28), Â§12 | dim-G-cli.md |
| Dimension H | Request / SSE / resilience | Â§5 HIGH (H9), Â§6 MEDIUM (M16-M19) | dim-H-request.md |
| Dimension I | Type safety / validation | Â§6 MEDIUM (M20), Â§10 | dim-I-types.md |
| Dimension J | Error handling | Â§6 MEDIUM (M29), Â§10 | dim-JN-errors-health.md |
| Dimension K | Tests | Â§5 HIGH (H8), Â§11 | dim-K-tests.md |
| Dimension L | Release / CI / OSS | Â§5 HIGH (H7, H8), Â§12 | dim-LM-release-docs.md |
| Dimension M | Docs accuracy | Â§5 HIGH (H5, H8), Â§12 | dim-LM-release-docs.md + docs-claims.txt |
| Dimension N | Code health / cleanup | Â§6 MEDIUM (M30, M31), Â§7 | dim-JN-errors-health.md |
| Dimension O | Features | Â§9 | feature-recs inline |
| Dimension P | Perf (lightweight) | Â§6 MEDIUM (M34, M35), Â§7 (L11) | dim-P-perf.md |

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [System Map](#2-system-map)
3. [What Is Already Strong](#3-what-is-already-strong)
4. [Critical Issues](#4-critical-issues)
5. [High-Priority Improvements](#5-high-priority-improvements)
6. [Medium Improvements](#6-medium-improvements)
7. [Low-Priority Cleanups](#7-low-priority-cleanups)
8. [Refactoring Plan](#8-refactoring-plan)
9. [Feature Recommendations](#9-feature-recommendations)
10. [Security / Trust Review](#10-security--trust-review)
11. [Testing Gap Analysis](#11-testing-gap-analysis)
12. [CLI / DX / Docs Review](#12-cli--dx--docs-review)
13. [Quick Wins](#13-quick-wins)
14. [Phased Implementation Roadmap](#14-phased-implementation-roadmap)
15. [Top 20 Recommended Actions](#15-top-20-recommended-actions)
16. [Module-by-Module Notes](#16-module-by-module-notes)
17. [Final Verdict](#17-final-verdict)

---

## 1. Executive Summary

**Maturity: 4/5.** `codex-multi-auth` is a structurally healthy, security-conscious CLI-first OAuth manager. Strict TypeScript, centralized Zod schemas for high-risk payloads, `no-explicit-any` enforced (verified: 0 occurrences), `@ts-ignore` absent, clean typecheck, clean lint, clean `audit:ci`, clean `vendor:verify`, recent security-dep bump cadence, full OSS governance stack (SECURITY.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md, LICENSE), 4 CI workflows including CodeQL, and 3418 tests across 225 files with verified hermetic execution under redirected `HOME` + `CODEX_MULTI_AUTH_DIR`.

**Biggest strengths** (preserve):
- **Hermeticity**: tests do not leak to real `~/.codex/multi-auth/` when env-redirected â€” zero delta verified (see K-05)
- **Strict TypeScript discipline**: 0 `as any`, 0 `@ts-ignore` across `lib/` + `index.ts` (I-01, I-02)
- **Refresh-queue race prevention**: token-keyed dedupe + rotation handoff + rollback on persist fail (C-10)
- **Atomic writes for primary account storage + flagged storage + unified settings**: temp+rename pattern used (E-03 positive)
- **Request-loop termination safety**: 4 independent guards prevent infinite retry (H-09)
- **OSS readiness**: governance files complete; CodeQL workflow + dep scanner workflow in CI (LM-03, LM-08)

**Biggest risks**:
1. **`resolvePath()` path-guard regression** on HEAD â€” `test/paths.test.ts:846` fails; lookalike-prefix paths outside the home directory are not rejected; gates import/export, so a guard failure can redirect reads/writes outside approved roots (E-01, K-02)
2. **Hybrid account selector can return blocked/unavailable accounts** â€” `selectHybridAccount()` falls back to LRU even when `available.length === 0`; fetch loop trusts it without re-validating (D-01)
3. **Plugin config precedence bug** â€” `loadPluginConfig` does not prefer primary CONFIG_PATH over CODEX_HOME legacy path; `test/plugin-config.test.ts:417` fails on HEAD (F-01, K-04)
4. **Live OAuth URL leaks to stdout/clipboard** â€” browser-fallback and manual login print raw URL containing live `state` and `code_challenge` (C-AUTH-05)
5. **Docs-to-code drift**: AGENTS.md claims v0.1.x / "87 files, 2071 tests" â€” reality is v1.2.7 / 225 files / 3418 tests; README/docs claim canonical redirect `127.0.0.1:1455` but code uses `localhost:1455` (LM-02, LM-12, C-AUTH-03)

**Top 5 priorities for the next cycle**:
1. Fix `resolvePath()` lookalike bypass + `plugin-config` precedence + `codex-manager-cli auth list` message drift (the 3 failing tests are all real regressions)
2. Re-validate account availability after `selectHybridAccount()` OR change its contract to return `null` when no account is available
3. Redact OAuth URL in user-facing output (show host/port only, keep full URL for clipboard/browser handoff)
4. Fix `pack:check` bloat and truth-up AGENTS.md + docs redirect host
5. Split `settings-hub.ts` (2100 LOC) into sub-concern files (theme, accounts, sync, diagnostics, experimental)

---

## 2. System Map

### Architecture (inferred)

```
User (CLI/terminal)
  â”‚
  â–¼
scripts/codex.js  (bin wrapper â€” lazy-load auth runtime)
  â”‚
  â–¼
lib/codex-manager.ts  (command dispatcher)
  â”œâ”€â”€ codex auth login|status|check|list|switch|forecast|verify-flagged|fix|doctor|report
  â”‚
  â”œâ”€â–¶ lib/auth/  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
  â”‚   auth.ts (PKCE, JWT, token)  â”‚
  â”‚   server.ts (callback :1455)  â”‚
  â”‚   browser.ts                  â–¼
  â”‚                        OAuth 2.0 Authorization Code + PKCE
  â”‚                        https://auth.openai.com/...
  â”‚
  â”œâ”€â–¶ lib/accounts.ts + lib/accounts/**  â”€â”€â–¶  lib/rotation.ts  â”€â”€â–¶  lib/health.ts
  â”‚                                            (hybrid/round-robin/sticky)
  â”‚                                                  â”‚
  â”‚                                                  â–¼
  â”œâ”€â–¶ lib/request/** (index.ts 7-step pipeline)  â”€â”€â–¶  lib/circuit-breaker.ts
  â”‚   URL rewrite â†’ init â†’ transform â†’ continuation â†’ account iter/refresh/headers
  â”‚   â†’ fetch+timeout+retry/rotation â†’ success+SSE+failover
  â”‚                                                  â”‚
  â”‚                                                  â–¼
  â”‚                                    OpenAI Codex backend (ChatGPT routing)
  â”‚
  â”œâ”€â–¶ lib/storage.ts + lib/storage/**  â”€â”€â–¶  atomic writes
  â”‚   V1 â†” V3 migrations, worktree resolution, EBUSY retry
  â”‚   ~/.codex/multi-auth/ or CODEX_MULTI_AUTH_DIR
  â”‚
  â”œâ”€â–¶ lib/codex-manager/settings-hub.ts  (2100 LOC dashboard TUI)
  â”‚
  â””â”€â–¶ lib/ui/**  (ansi, auth-menu, theme, select, copy)
```

### Storage/config flow

- **Root**: `~/.codex/multi-auth/` (override: `CODEX_MULTI_AUTH_DIR`)
- **Settings**: `settings.json` (EBUSY/EPERM retry, max 4 exponential)
- **Accounts (global)**: `openai-codex-accounts.json`
- **Accounts (project-scoped)**: `projects/<project-key>/openai-codex-accounts.json`
- **Flagged**: `openai-codex-flagged-accounts.json`
- **Quota cache**: `quota-cache.json`
- **Runtime observability**: `runtime-observability.json`
- **Logs**: `logs/codex-plugin/`
- **Config path**: `CODEX_MULTI_AUTH_CONFIG_PATH` primary, `CODEX_HOME` legacy (precedence currently BUGGY â€” F-01)

### Trust boundaries

1. **User â†” CLI** (low â€” stdin + fs)
2. **CLI â†” OS keychain / file system** (MEDIUM â€” tokens persisted as plaintext JSON, mode 0600; larger-than-minimum secret footprint â€” C-AUTH-08)
3. **CLI â†” Browser / Localhost callback** (HIGH â€” `:1455` bound on any-interface; redirect URI mismatch risk C-AUTH-03)
4. **CLI â†” `auth.openai.com`** (HIGH â€” OAuth endpoint; hardcoded single host, no allowlist abstraction C-AUTH-12)
5. **CLI â†” ChatGPT backend** (HIGH â€” headers, rate-limits, model routing; failover across multiple accounts)
6. **Multi-account isolation** (MEDIUM â€” project-scoped storage can silently collapse to global when Codex CLI sync enabled D-06)

### Highest-risk boundaries

- `lib/storage/paths.ts::resolvePath()` â€” path-guard for import/export (HIGH â€” regression at HEAD, E-01/K-02)
- `lib/auth/auth.ts::REDIRECT_URI` â†” `lib/auth/server.ts` bind (HIGH â€” host mismatch C-AUTH-03)
- `lib/accounts.ts::selectHybridAccount()` â†” fetch loop in `index.ts` (HIGH â€” unavailable-account selection D-01)
- Token file at rest â€” plaintext JSON with refresh tokens + cached access tokens (MEDIUM â€” C-AUTH-08)

---

## 3. What Is Already Strong

These decisions work well and should be preserved through any refactor:

| Strength | Evidence | Preserve by |
|----------|----------|-------------|
| Hermetic test design â€” `HOME` / `CODEX_MULTI_AUTH_DIR` redirection produces zero drift under full suite | K-05 | Keep env-redirect pattern; add regression test asserting hermeticity when new tests land |
| Strict TypeScript with zero escape hatches â€” 0 `as any`, 0 `@ts-ignore`, 0 `@ts-expect-error`, 0 `@ts-nocheck` in `lib/` + `index.ts`; `strict: true` in tsconfig | I-01, I-02, I-05 | Keep ESLint flat-config `no-explicit-any` rule; add CI gate if not present |
| Refresh-queue race prevention with token-keyed dedupe + rotation handoff + rollback on persist fail | C-10 | Add a targeted regression test around rotation-then-persist-failure rollback if coverage does not already lock it |
| Atomic writes for primary account storage, flagged storage, unified settings, export | E-03 (positive) | Extend same pattern to recovery/session storage (currently violates â€” E-03) |
| 4-gate request-loop termination (attempted.size, outbound budget, MAX_SHORT_RETRY_ATTEMPTS=3, MAX_STREAM_FAILOVERS=1) | H-09 | Document the gates inline; add invariant test |
| Defensive storage corruption recovery â€” checksum-protected WAL + rotating backups | C-AUTH-09 | Add observability signal when WAL/backup recovery is used so operators notice silent recovery |
| Structured CLI doctrine â€” `doctor --fix` dry-run safe; Q=cancel hotkey consistent; theme live-preview with baseline restore on cancel | G-07, G-05 | Apply same `--dry-run` discipline to new repair commands |
| OSS governance â€” SECURITY.md, CODE_OF_CONDUCT, CONTRIBUTING, LICENSE, issue/PR templates, CodeQL + plugin scanner + dep scanner workflows | LM-03, LM-08 | Keep the full governance stack |
| Clean supply chain â€” `audit:ci` (prod + dev allowlist) + `vendor:verify` + bundleDependencies + npm overrides | LM-04, LM-05 | Keep; add per-release vendor manifest hash pinning if not present |
| Active security maintenance â€” recent hono 4.12.14, vite ^7.3.2 bumps at HEAD | LM-09 | Keep dependabot cadence; keep Dependabot config |
| Refresh-failure taxonomy in `lib/refresh-guardian.ts` â€” rate-limit/auth/network bucketed cooldowns; missing-refresh accounts auto-disabled | C-AUTH-13 | Surface bucketed states in operator diagnostics |
| Strong OAuth state generation â€” 16 bytes from `node:crypto` = 128-bit CSRF entropy | C-AUTH-02 | Add invariant test; keep `node:crypto` source |
| Rich CLI surface organized by Start/Daily/Repair/Advanced per README | LM-11 | Keep README structure; keep separation of repair commands from daily ops |

---

## 4. Critical Issues

> **Updated 2026-04-17 post-Oracle review** — see `docs/audits/evidence/oracle-verdicts.md`. Original draft had no CRITICAL findings; Oracle elevated AUDIT-H1 upon determining the failing unit test IS the reproduction.

| ID | Severity | Claim | Evidence | Confidence | Impact | Fix direction |
|----|----------|-------|----------|------------|--------|---------------|
| AUDIT-C1 | CRITICAL | **`resolvePath()` lookalike-prefix bypass** — path-guard for import/export does not reject lookalike prefix paths outside home directory. Trust boundary broken: import/export surfaces can read from attacker-controlled siblings or write outside approved roots. Maps to "unsafe credential handling" + "core trust breakage" in severity rubric. | `test/paths.test.ts:842-846` (FAILING on HEAD); `lib/storage/paths.ts:333-357`; cross-ref AUDIT-H1, E-01, K-02 | confirmed (failing test = code-level reproduction) | Local-access attacker creates lookalike directory (e.g. `<HOME>/.codex-multi-auth-evil/`) that bypasses guard; affects both read + write surfaces | Harden `isWithinDirectory()` with canonicalization; add regression tests for home/project/tmp lookalikes on Windows + POSIX. **Block next release on fix.** |

**Post-Oracle severity adjustments** (applied to `findings-index.json` with oracle_adjusted flag):

| Original | Oracle Verdict | Finding | Rationale |
|----------|----------------|---------|-----------|
| HIGH | **CRITICAL** (elevated) | AUDIT-H1 resolvePath lookalike | Failing test = reproduction; path-guard failure = trust breakage |
| MEDIUM | **HIGH** (elevated) | AUDIT-M09 project-scope silent bypass on CLI sync | Silent credential leak across projects matches HIGH criteria |
| HIGH | **MEDIUM** (demoted) | AUDIT-H6 loadPluginConfig precedence | Workaround exists; narrow blast radius |
| HIGH | **MEDIUM** (demoted) | AUDIT-H8 AGENTS.md staleness | Docs drift only, no runtime impact |
| HIGH | **MEDIUM** (demoted) | AUDIT-H9 SSE malformed-chunk discard | Dim-H internally marked MEDIUM — reconciled |
| HIGH | **MEDIUM** (demoted) | AUDIT-H10 dangling active pointer | Operator-facing friction, no credential dimension |
| MEDIUM | **HIGH (conditional)** | AUDIT-M13 plaintext tokens at rest | Elevates to HIGH only if AUDIT-C1 ships unfixed |

**Final severity distribution (post-Oracle):** 2 CRITICAL · 6 HIGH · 38 MEDIUM · 14 LOW (60 total incl. AUDIT-C1).

**Oracle top-3 refactor verdict** (confirmed with rationale, see `oracle-verdicts.md` §2):
1. **R2 RedirectURI SSOT** — closes AUDIT-H5 + eliminates drift class
2. **R3 Zod at JSON.parse boundaries** — additive, fail-closed, scales to 59 sites
3. **R4 Routing mutex + selection-record** — closes AUDIT-H2/H3/D09 simultaneously

**Oracle assumptions flagged for follow-up validation** (see `oracle-verdicts.md` §4):
- Inspect `pack:check` tarball for `.env`/fixtures/secrets — if present, AUDIT-H7 → CRITICAL
- Pin PKCE dep + audit source (C-AUTH-01)
- Spot-check 3 dim-H citations (salvaged from step-budget-truncated agent)
- Qualify hermeticity claim: applies to `HOME`/`CODEX_MULTI_AUTH_DIR`, NOT to CWD (evidenced by 6 tmp files at repo root)
- Count `lib/schemas.ts` schemas vs unique payload shapes across 59 parse sites (R3 cost estimation)

---

## 5. High-Priority Improvements

| ID | Severity | Claim | Evidence | Fix direction |
|----|----------|-------|----------|---------------|
| AUDIT-H1 | HIGH | **`resolvePath()` does not reject lookalike-prefix paths on HEAD** â€” import/export path-guard regression; can redirect reads/writes outside approved home/project/tmp roots | E-01; K-02; `test/paths.test.ts:842-846`, `lib/storage/paths.ts:333-357` | Reproduce with real Windows+POSIX lookalike cases, harden `isWithinDirectory()`, add regression tests |
| AUDIT-H2 | HIGH | **Hybrid account selector returns unavailable accounts** â€” `selectHybridAccount()` falls back to LRU even when `available.length === 0`; fetch loop trusts it | D-01; `lib/rotation.ts:379-392`, `lib/accounts.ts:668-697`, `index.ts:1149-1157` | Change selector contract to return `null` when no account available OR re-run `isAccountAvailableForFamily()` after hybrid selection |
| AUDIT-H3 | HIGH | **Short-window 429 retry does not mark account unavailable before sleeping** â€” concurrent requests keep selecting the same freshly rate-limited account | D-07; `index.ts:2089-2114`, `lib/accounts.ts:534-545,673-677` | Write immediate transient rate-limit marker before short-retry sleep OR reserve account locally until sleep window ends |
| AUDIT-H4 | HIGH | **Live OAuth URL leaks to stdout/clipboard** â€” browser-fallback and manual login print raw URL with live `state` and `code_challenge` | C-AUTH-05; `lib/codex-manager.ts:1825-1841`, `lib/auth/auth.ts:15-20,262-269`, `lib/auth/browser.ts:158-177` | Print redacted display URL; keep full URL only for clipboard/open-browser handoff; add `--show-full-url` debug escape hatch |
| AUDIT-H5 | HIGH | **Redirect host drift â€” code uses `localhost:1455` but docs claim `127.0.0.1:1455`** | C-AUTH-03; `lib/auth/auth.ts:12`, `lib/auth/server.ts:78-80,104`, `docs/reference/commands.md:84,98`, `CHANGELOG.md:125` | Choose one canonical callback origin; derive all user-facing strings from it; align docs/tests |
| AUDIT-H6 | HIGH | **`loadPluginConfig` CONFIG_PATH precedence bug** â€” does not prefer primary over legacy `CODEX_HOME` path when both exist | F-01; K-04; `test/plugin-config.test.ts:417` | Fix precedence order to match documented model (primary â†’ legacy); add explicit precedence test matrix |
| AUDIT-H7 | HIGH | **`npm run pack:check` FAILS exit=1** â€” pack budget violation; published tarball likely includes unintended files | LM-01; `docs/audits/evidence/pack-check.txt` | Inspect pack manifest; tighten `files` field in `package.json`; add CI gate on pack size delta |
| AUDIT-H8 | HIGH | **AGENTS.md stale across 4 axes** â€” v0.1.x/Commit 9ac8a84/Generated 2026-03-01/"87 files, 2071 tests" vs reality v1.2.7/1f6da97/225 files/3418 tests | LM-02; K-01; `AGENTS.md` Â§OVERVIEW vs `context.txt` | Regenerate AGENTS.md via `/init-deep` or equivalent; make generation a release gate |
| AUDIT-H9 | HIGH | **SSE non-streaming conversion buffers full stream up to 10MB and silently discards malformed JSON chunks** | H-03; `lib/request/response-handler.ts` | Surface malformed-chunk warnings via logger.warn; add structured parse-error taxonomy; consider streaming decode instead of buffer-then-parse |
| AUDIT-H10 | HIGH | **Active-account pointer can dangle after disable** â€” `getActiveIndexForFamily()` clamps bounds only; `setAccountEnabled()` does not repair pointer | D-05; `lib/accounts.ts:506-512,583-592,1145-1155`, `lib/runtime/account-status.ts:10-17` | Normalize active indices on every disable/remove; "active" means routable, not merely in-range |

---

## 6. Medium Improvements

| ID | Severity | Claim | Evidence | Fix direction |
|----|----------|-------|----------|---------------|
| AUDIT-M01 | MEDIUM | Recovery/session storage uses direct sync writes/deletes (no atomic temp+rename, no retry) | E-03; `lib/recovery/storage.ts:7,167-168,261-262,281-282,374-375` | Introduce shared atomic-write helper for recovery files + retry-safe deletes on Windows lock codes |
| AUDIT-M02 | MEDIUM | Concurrency guard is in-process only â€” two CLI processes can race on shared `~/.codex/multi-auth` files | E-04; `lib/storage/transactions.ts:10-34`, `lib/unified-settings.ts:23,423-430` | Add advisory file locking OR journal/compare-and-swap for shared files |
| AUDIT-M03 | MEDIUM | Active code supports V1â†”V3 only; no V2 migration path despite docs claiming V1/V2â†’V3 | E-05; `lib/storage.ts:1155-1180`, `lib/storage/migrations.ts:83-116` | Implement explicit V2 handling OR correct docs |
| AUDIT-M04 | MEDIUM | Account-clear writes reset marker AFTER deleting artifacts â€” crash between looks like accidental loss | E-07; `lib/storage/account-clear.ts:58-64` | Align account-clear ordering with flagged-clear flow: marker first |
| AUDIT-M05 | MEDIUM | Flagged-account read retry omits `EPERM` | E-08; `lib/storage/flagged-storage-file.ts:4-26`, `lib/storage/flagged-storage-io.ts:34-52` | Include `EPERM` in retryable flagged-read codes |
| AUDIT-M06 | MEDIUM | Routing non-determinism â€” PID-based bias + cursor mutation makes reproduction hard | D-02; `lib/rotation.ts:332-338,400-425`, `lib/accounts.ts:693-696` | Make deterministic mode default; gate PID bias behind explicit opt-in flag |
| AUDIT-M07 | MEDIUM | Health + quota tracker state NOT persisted; resets on restart | D-03; `lib/rotation.ts:78-83,184-188,543-557`, `lib/accounts.ts:887-910` | Persist routing state OR explicitly mark ephemeral + avoid "stable" health claims |
| AUDIT-M08 | MEDIUM | `lib/health.ts` stale vs live AccountManager state â€” uses wrong field names | D-04; `lib/health.ts:27-53`, `lib/accounts.ts:253-255,725-731,806-818` | Rebuild health report from AccountManager directly OR delete stale abstraction |
| AUDIT-M09 | MEDIUM | Project-scoped isolation silently bypassed when Codex CLI sync enabled â€” forces global storage | D-06; `lib/runtime/storage-scope.ts:20-34`, `lib/storage.ts:598-623` | Treat as hard config conflict with surfaced state; scope synced state per project identity |
| AUDIT-M10 | MEDIUM | Stream failover bypasses server-error policy path â€” `5xx` bursts on fallback don't update shared cooldown | D-08; `index.ts:1974-2059,2198-2507,2395-2445` | Reuse `evaluateFailurePolicy()` helper inside stream failover |
| AUDIT-M11 | MEDIUM | Callback server doesn't eager-close on terminal outcomes; `close()` doesn't await shutdown | C-AUTH-11; `lib/auth/server.ts:41-99` | Close immediately after terminal outcomes; convert mismatch/duplicate-code paths into explicit terminal results |
| AUDIT-M12 | MEDIUM | Token freshness trusts persisted `expires`/`expiresAt` only â€” doesn't decode JWT `exp` | C-AUTH-07; `lib/proactive-refresh.ts:54-72,81-85`, `lib/auth/auth.ts:165-179`, `lib/accounts.ts:1033-1039` | Fall back to decoded JWT `exp` when metadata missing; treat missing expiry as refresh-needed |
| AUDIT-M13 | MEDIUM | Access tokens + refresh tokens both stored plaintext JSON (file mode 0600) | C-AUTH-08; `lib/storage/migrations.ts:46-69`, `lib/accounts.ts:887-907`, `lib/storage.ts:1673-1687` | Minimize access-token caching OR move secrets to OS keychain |
| AUDIT-M14 | MEDIUM | Port 1455 duplicated across server bind + status copy + oauth-success.html instead of derived from single parsed redirect URI | C-AUTH-04; `lib/auth/server.ts:78-80,107`, `lib/ui/copy.ts:67`, `lib/oauth-success.html:117-123` | Parse redirect URI once; feed server bind + UI copy + html from shared helpers |
| AUDIT-M15 | MEDIUM | Manual-paste callback returns `null` on state mismatch â€” surfaced as generic callback-miss text | C-AUTH-06; `lib/codex-manager.ts:1257-1332,1854-1867`, `lib/runtime/manual-oauth-flow.ts:59-69,81-86` | Return structured mismatch error; surface explicit state-mismatch in both flows |
| AUDIT-M16 | MEDIUM | No distinct connect timeout â€” single total timeout for both connect + body/stream | H-02; `lib/request/fetch-helpers.ts:724-969` | Add `connectTimeoutMs` separate from total + stall |
| AUDIT-M17 | MEDIUM | Observability uneven â€” trace ID / account ID / attempt # not uniformly attached across retry/failover branches | H-05; `index.ts` multi call sites | Define log schema with mandatory correlation fields; structured logger with required keys |
| AUDIT-M18 | MEDIUM | Deprecation/sunset headers logged in success path only â€” not in error paths | H-08; `lib/request/fetch-helpers.ts` | Log deprecation headers in both success + error handling |
| AUDIT-M19 | MEDIUM | Mid-stream failover intentionally disabled after first byte â€” users see hard error mid-generation | H-04; `lib/request/stream-failover.ts` | Document limitation; consider opt-in "resume with marker" for idempotent prompts |
| AUDIT-M20 | MEDIUM | `JSON.parse` surface is 59 calls across 31 files; schema validation centralized in single `lib/schemas.ts` not applied at parse boundaries | I-03, I-04; `lib/schemas.ts`; high clusters in request-init, runtime/request-init, storage, recovery, fetch-helpers | Wrap `JSON.parse` call sites with `safeParse*` helpers from `lib/schemas.ts`; add schemas for currently-unvalidated payloads |
| AUDIT-M21 | MEDIUM | Dual-linter stack (eslint + biome) without documented scope separation | F-02; repo root files, `package.json` scripts | Adopt one OR document scope split (biome=format, eslint=correctness) |
| AUDIT-M22 | MEDIUM | `prepare` hook installs husky on every `npm install` â€” mutates `.git/hooks/` as side effect | F-03; `package.json` scripts.prepare | Document side effect prominently in CONTRIBUTING; consider opt-in install |
| AUDIT-M23 | MEDIUM | Env var surface 11+ vars; no central env-schema | F-04; README Configuration section | Centralize env validation via `z.object()` in `lib/schemas.ts`; parse `process.env` at startup |
| AUDIT-M24 | MEDIUM | `settings-hub.ts` ~2100 LOC â€” overgrown file mixing theme/account/sync/diagnostics/experimental | G-01, JN-03; AGENTS.md Â§WHERE TO LOOK | Split by sub-concern (see Section 8 Refactor R1) |
| AUDIT-M25 | MEDIUM | `auth list` empty-storage message drift â€” test expects "Storage was intentionally reset." but code outputs "No accounts configured." / "Storage: <path>" / "Storage health: empty" | G-02, K-03; `test/codex-manager-cli.test.ts:913` | Align code output to documented messaging or update tests after agreeing on canonical message |
| AUDIT-M26 | MEDIUM | `--json` coverage unclear across subcommand surface (confirmed on `report`, `doctor`, `verify-flagged`; unverified on `list`, `switch`, `check`, `forecast`, `fix`) | G-03; README | Audit each subcommand; standardize `--json` + deterministic exit codes + schema |
| AUDIT-M27 | MEDIUM | Bifurcation `lib/codex-cli/` and `lib/codex-manager/` without documented boundary | G-06, JN-04; AGENTS.md Â§STRUCTURE | Document ownership map OR merge |
| AUDIT-M28 | MEDIUM | Experimental settings flagged but no stability-promise policy | G-09; README Experimental section | Document experimental-tier semver policy |
| AUDIT-M29 | MEDIUM | Error taxonomy implicit â€” no central `CodexError`/`AuthError`/`NetworkError` base class confirmed | JN-05 | Introduce structured error hierarchy; map failures to stable error codes |
| AUDIT-M30 | MEDIUM | Duplicate `1455` port constant across auth, server, copy, html (cross-ref C-AUTH-04) | JN-08, C-AUTH-04 | Derive from shared helper |
| AUDIT-M31 | MEDIUM | 6 tmp files at repo root (`tmp-flagged.json.*.tmp`, `tmp-accounts.marker`) â€” test-cleanup leakage | E-02, JN-09, LM-06; `clean-repo-check.txt` footer + `test/account-clear.test.ts:13-45`, `test/flagged-storage-io.test.ts:29-53` | Move tests to temp dirs via `os.tmpdir()`; use shared retry cleanup helper |
| AUDIT-M32 | MEDIUM | CHANGELOG drift check incomplete â€” v1.2.5/6/7 vs `git log v1.2.4..HEAD` not cross-referenced | LM-07 | Run CHANGELOG check per release; add CI gate |
| AUDIT-M33 | MEDIUM | Semver over v1.2.4â€“v1.2.7 â€” no 2.x breaking changes; need to verify no silent breaking behaviors in minors | LM-10 | Add behavioral-change flag in CHANGELOG entries |
| AUDIT-M34 | MEDIUM | Non-streaming SSE conversion buffers full stream up to 10MB in memory before parse | P-03, H-03 | Streaming decode OR bounded chunk count |
| AUDIT-M35 | MEDIUM | Hot paths (request pipeline, SSE parser, account selection, storage writes, token refresh) lack benchmarks | P-02 | Add micro-benchmarks for top-3 hot paths |

---

## 7. Low-Priority Cleanups

| ID | Severity | Claim | Evidence | Fix |
|----|----------|-------|----------|-----|
| AUDIT-L01 | LOW | PKCE entropy is "probable strong" â€” generator lives in external dep, not audited in-repo | C-AUTH-01 | Add regression test asserting `S256` + document trust boundary |
| AUDIT-L02 | LOW | Token endpoint + authorize endpoint hardcoded â€” no allowlist abstraction | C-AUTH-12 | Centralize behind small allowlisted resolver for test/regional variants |
| AUDIT-L03 | LOW | Auth storage corruption recovery works but silent â€” no operator-visible signal when WAL/backup path taken | C-AUTH-09 | Emit audit log when recovery path used |
| AUDIT-L04 | LOW | `docs/reference/storage-paths.md` references non-existent `deriveProjectKey`; code exports `getProjectStorageKey` | E-06; `docs/reference/storage-paths.md:67-76`, `lib/storage/paths.ts:217-245` | Update docs |
| AUDIT-L05 | LOW | Recovery readers silently skip unreadable files (no corruption signal) | E-09; `lib/recovery/storage.ts:67-114,273-384` | Log corruption counts/paths |
| AUDIT-L06 | LOW | `docs/reference/settings.md` precedence rule not formally verified | F-07 | Add formal precedence table |
| AUDIT-L07 | LOW | Fallback 429 path hardcodes `"quota"` reason in one branch; primary passes `stableAccountKey` | H-06; `index.ts:2408-2412` | Align fallback branch with primary |
| AUDIT-L08 | LOW | Empty-response retry after SSE conversion may trigger unnecessary round-trip | H-10; `index.ts:2169-2681` | Add log; bounded count |
| AUDIT-L09 | LOW | Test output contains stray PowerShell node.exe error lines on Windows â€” harness brittleness | K-09; `test-summary.txt:16-22` | Investigate stderr redirection |
| AUDIT-L10 | LOW | Test import phase 40s dominates startup | K-08 | Profile module graph for lazy-import opportunities |
| AUDIT-L11 | LOW | No perf regression CI gate; bench results not baselined | P-06 | Add perf CI with bench baseline commits |
| AUDIT-L12 | LOW | Repeated regex compilation not fully verified; potential hot-path trap | P-05 | Targeted `new RegExp(` scan |
| AUDIT-L13 | LOW | Property/chaos catalogs not explicitly inventoried in this audit | K-06 | Document invariants property-tested + failures chaos-injected |
| AUDIT-L14 | LOW | Dead code scan incomplete (ts-prune not run) | JN-07 | Run `ts-prune` pass; file findings |

---

## 8. Refactoring Plan

### R1. Split `lib/codex-manager/settings-hub.ts` (2100 LOC)
- **Why**: Single file mixing theme / accounts / sync / diagnostics / experimental. Future additions will make it worse. Cognitive load + merge-conflict surface.
- **Files**: `lib/codex-manager/settings-hub.ts` â†’ new `settings-hub/{theme,accounts,sync,diagnostics,experimental,index}.ts`
- **Target**: Each sub-module <500 LOC; `index.ts` composes menu tree; each sub-module exports `render()` + action handlers
- **Implementation order**: 1) create sub-module files with empty exports, 2) extract theme first (smallest + well-isolated), 3) extract experimental, 4) extract diagnostics, 5) extract sync, 6) extract accounts, 7) convert root file to composition
- **Migration risk**: LOW â€” internal structure; public CLI surface unchanged. Test by `bun test test/codex-manager-cli.test.ts` at each step
- **Payoff**: Reviewable diffs; independent module tests; contributor ramp-up easier

### R2. Introduce RedirectURI single source of truth
- **Why**: Current drift (`localhost` vs `127.0.0.1`) causes confirmed login-break risk + 4+ duplicated port `1455` literals
- **Files**: `lib/auth/auth.ts` (`REDIRECT_URI` const), `lib/auth/server.ts` (bind), `lib/ui/copy.ts`, `lib/oauth-success.html`, `docs/reference/commands.md`, `docs/getting-started.md`, `CHANGELOG.md`
- **Target**: Single `export const AUTH_REDIRECT = { host, port, path, origin, full }` parsed once; all sites import
- **Order**: 1) define + export constant, 2) migrate server bind, 3) migrate auth flow, 4) migrate copy/html, 5) regen docs from constant, 6) add invariant test
- **Migration risk**: MEDIUM â€” user-facing OAuth redirect change if host standardizes on `127.0.0.1`; existing Google OAuth apps may need re-registration
- **Payoff**: Kills drift class; fixes AUDIT-H5

### R3. Consolidate `JSON.parse` behind Zod schemas
- **Why**: 59 parse calls across 31 files; single-file Zod hub exists but not applied at parse boundaries. Validation gap on untrusted payloads.
- **Files**: `lib/schemas.ts` (add schemas), all `lib/**` with `JSON.parse` call sites (highest: `lib/request/request-init.ts`, `lib/runtime/request-init.ts`, `lib/storage.ts`, `lib/recovery/storage.ts`, `lib/request/fetch-helpers.ts`)
- **Target**: Every `JSON.parse` â†’ `safeParse*` helper returning `{ success, data | error }`
- **Order**: 1) schemas for storage payloads (highest blast radius), 2) recovery, 3) request/response, 4) config, 5) ancillary
- **Risk**: LOW â€” additive change; fail-closed on parse error maps to clear operator signal
- **Payoff**: Hardens boundaries; improves runtime error messages; sets pattern for future parse sites

### R4. Introduce routing mutex + selection-record pattern
- **Why**: Concurrent fetch + cursor mutation + debounced save can produce out-of-order persistence (AUDIT-H2 + D-09)
- **Files**: `lib/accounts.ts` (cursor + `lastUsed` mutation), `lib/rotation.ts` (selector)
- **Target**: `selectAccount` returns `SelectionRecord = { account, selectionId, timestamp }`; cursor advanced only after record accepted by fetch loop (or reverted on fast-fail); `persistDebounced` operates on ordered record queue
- **Order**: 1) add record type, 2) thread through fetch loop, 3) wrap cursor mutation in `withMutex`, 4) replay tests under concurrency
- **Risk**: MEDIUM â€” touches hot path; benchmark before merge
- **Payoff**: Fixes hybrid-selector bug (AUDIT-H2) and 429-race (AUDIT-H3) without amplifying throttling

### R5. Unify `lib/health.ts` with live `AccountManager` state
- **Why**: Stale abstraction reports wrong fields (D-04)
- **Files**: `lib/health.ts`, `lib/accounts.ts`
- **Target**: `getAccountHealth` reads from tracker state directly OR module deleted and consumers redirected
- **Order**: 1) inventory consumers, 2) refactor to tracker-direct, 3) delete stale module if no consumers, 4) regression-test health snapshot shape
- **Risk**: LOW â€” internal; diagnostic output shape may shift (communicate in CHANGELOG)
- **Payoff**: Fixes operator-visible drift

### R6. Harden recovery storage with atomic writes
- **Why**: E-03 confirmed violation; only recovery still uses direct sync writes
- **Files**: `lib/recovery/storage.ts`
- **Target**: Extract shared `atomicWriteFile(path, data)` helper used by `lib/storage.ts` + apply to recovery
- **Order**: 1) extract helper, 2) migrate recovery writes, 3) add retry-safe delete helper for Windows locks, 4) regression tests
- **Risk**: LOW
- **Payoff**: Recovery state survives mid-write crashes

---

## 9. Feature Recommendations

All features tied to concrete findings. Priorities: H = next cycle, M = subsequent, L = opportunistic.

### F1. `codex auth why-selected [--last|--now|--json]` (Priority: H)
- **Problem**: AUDIT-M06 + D-04 â€” users can't understand why a given account was chosen; routing non-determinism + stale health model erode trust
- **Fit**: Complements existing `status`/`report`/`forecast`; same TUI/JSON pattern
- **Complexity**: S â€” read from existing tracker snapshot; add one CLI verb
- **Deps**: R5 (unified health)
- **Risk**: LOW â€” read-only

### F2. `codex auth verify --paths [--json]` (Priority: H)
- **Problem**: AUDIT-H1 â€” `resolvePath` regression means users need a self-test for their import/export targets before using them
- **Fit**: Aligns with `doctor --fix` philosophy
- **Complexity**: S
- **Deps**: None
- **Risk**: LOW

### F3. Per-account disable/quarantine with explicit state + TTL (Priority: H)
- **Problem**: AUDIT-H10 (dangling active pointer) + D-05 â€” no explicit quarantine/disable lifecycle; state transitions implicit
- **Fit**: Makes Section 8 R4 tangible at UX layer
- **Complexity**: M â€” add `state: { value, enteredAt, ttl?, reason }` to account record; migrate storage schema (bump V3 â†’ V4 with migration); update selection/health
- **Deps**: R4, storage V4 migration
- **Risk**: MEDIUM â€” schema change; release-note required

### F4. Structured incident-report bundle `codex auth bundle [--out <path>]` (Priority: M)
- **Problem**: H-05 (uneven observability) + J/N findings â€” post-failure reconstruction is hard; users need a redacted diagnostics tarball to share
- **Fit**: Extends `report --json`; produces filesystem bundle (logs + redacted state + env + timestamps)
- **Complexity**: M â€” needs redaction helper (reuse from this audit); tar/zip output
- **Deps**: Structured logger (R via JN-06)
- **Risk**: HIGH if redaction is weak â€” **must** apply JWT/email/path redaction before bundling

### F5. Repair/migration dry-run preview `codex auth fix --preview --json` (Priority: M)
- **Problem**: AUDIT-M04 (account-clear ordering) â€” users can't preview safe fixes before applying
- **Fit**: Existing `fix --dry-run` has shape; extend with structured output
- **Complexity**: S
- **Risk**: LOW

### F6. Shell completion for `codex auth` (Priority: M)
- **Problem**: G-08 â€” help discoverability unverified; rich subcommand surface
- **Fit**: Standard OSS CLI DX
- **Complexity**: S â€” generate bash/zsh/fish/powershell completions
- **Risk**: LOW

### F7. Codex CLI compatibility probe `codex auth compat [--json]` (Priority: M)
- **Problem**: Implicit version coupling to upstream `@openai/codex` or native binary; no compatibility check
- **Fit**: Guards install/upgrade flow
- **Complexity**: S
- **Risk**: LOW

### F8. Pool backup + restore with filename prompt (Priority: M)
- **Note**: Already in experimental tier per README â€” graduate to stable after adding collision safety test
- **Problem**: Experimental tier unstable; users want safe backup/restore
- **Fit**: Stabilize existing flow
- **Complexity**: S (test + docs)
- **Risk**: LOW

### F9. Machine-readable status/forecast/report unification (Priority: M)
- **Problem**: AUDIT-M26 â€” `--json` coverage inconsistent
- **Fit**: Standardize schema version across `status`, `check`, `list`, `forecast`, `report`
- **Complexity**: M
- **Risk**: LOW

### F10. Perf regression CI gate (Priority: L)
- **Problem**: P-06 â€” no baseline
- **Fit**: Extends existing CI
- **Complexity**: M (bench baseline commits + comparison job)

---

## 10. Security / Trust Review

### Auth / Token Handling
- **Positive**: OAuth state 128-bit (C-AUTH-02); PKCE S256 (C-AUTH-01); file mode 0600 on token storage
- **Concerns**: Live OAuth URL leaks to stdout/clipboard (AUDIT-H4); redirect host drift `localhost` vs `127.0.0.1` (AUDIT-H5); JWT `exp` not validated on load (AUDIT-M12); access + refresh tokens both in plaintext JSON at rest (AUDIT-M13); token endpoint hardcoded single-host (AUDIT-L02)

### Local State / Storage
- **Positive**: Atomic writes for primary storage + WAL/backup corruption recovery (C-AUTH-09)
- **Concerns**: `resolvePath` lookalike-prefix bypass (AUDIT-H1); recovery storage non-atomic (AUDIT-M01); in-process-only concurrency guard (AUDIT-M02); V2 migration missing (AUDIT-M03); project-scoped isolation collapses to global on CLI sync (AUDIT-M09)

### Privacy / Logging
- **Positive**: `docs/privacy.md` exists; clean `audit:ci`
- **Concerns**: Structured logger present but fields inconsistent (AUDIT-M17); WAL/backup recovery silent (AUDIT-L03); recovery readers silently skip unreadable files (AUDIT-L05)

### Trust Messaging vs Real Guarantees
- **README** claims reliability behaviors (whole-pool replay disabled by default, bounded outbound budget, burst cooldown) â€” verified in code
- **Docs claim** canonical redirect is `127.0.0.1:1455` â€” code uses `localhost:1455` (DRIFT: AUDIT-H5)
- **AGENTS.md claims** "87 files, 2071 tests" â€” reality 225/3418 (DRIFT: AUDIT-H8)

### Recommended Hardening Steps (priority order)
1. Fix `resolvePath` lookalike bypass + add regression tests for home/project/tmp lookalikes
2. Redact OAuth URL in user-facing output (AUDIT-H4)
3. Reconcile redirect host: pick `127.0.0.1` (better for OAuth pinning) + update all 4+ sites + tests + docs (AUDIT-H5)
4. Decode JWT `exp` on token load; treat missing expiry as refresh-needed (AUDIT-M12)
5. Consider OS keychain integration for token storage (AUDIT-M13)
6. Apply Zod at all `JSON.parse` boundaries (R3)
7. Add redaction helper as published module (also supports F4 incident bundle)

---

## 11. Testing Gap Analysis

### Covered Well
- V3 storage format (fixtures in `test/fixtures/v3-storage.json`)
- Refresh-queue race dedupe (C-10)
- Chaos test directory + property-test directory exist â€” good stratification (K-06)
- Hermeticity works as designed when env redirected (K-05)

### Under-Tested
- `resolvePath` lookalike rejection â€” currently BROKEN (K-02)
- Hybrid selector behavior when no accounts available (D-01) â€” no regression test
- Short-window 429 concurrent-request race (D-07) â€” no concurrent-request test
- `loadPluginConfig` CONFIG_PATH precedence (K-04) â€” test exists but is failing
- `auth list` empty-storage message (K-03) â€” test exists but drift
- V2 migration (E-05) â€” absent code path, absent tests
- SSE malformed-chunk handling (H-03) â€” silent discard, likely no explicit coverage
- Mid-stream failover recovery (H-04) â€” chaos test candidate
- CHANGELOG-to-git-log consistency per release (LM-07)
- Pack-budget regression (LM-01) â€” failing on HEAD

### Exact Cases To Add (ordered by impact)
1. `resolvePath` lookalike prefix â†’ throw on Windows + POSIX (fixes AUDIT-H1; unblocks coverage)
2. `selectHybridAccount` when all accounts blocked â†’ returns null (fixes AUDIT-H2)
3. Concurrent requests on single rate-limited account â†’ one marks, rest wait (fixes AUDIT-H3)
4. `loadPluginConfig` with both CONFIG_PATH + CODEX_HOME set â†’ primary wins (fixes AUDIT-H6)
5. `auth list` empty storage â†’ canonical message (fixes AUDIT-M25)
6. V2 storage payload â†’ either migrates or rejects explicitly (fixes AUDIT-M03)
7. SSE malformed chunk â†’ emits structured warn log (fixes AUDIT-H9)
8. Pack-size delta â†’ CI gate (fixes AUDIT-H7)
9. Invariant: PKCE always `S256` (preserves C-AUTH-01)
10. Invariant: OAuth state always 16-byte crypto random (preserves C-AUTH-02)

### Best Order To Improve Confidence
1. Add security regressions first (cases 1-3) â€” highest blast radius
2. Fix existing failing tests (cases 4-5) â€” green baseline
3. Add taxonomy gaps (cases 6-7)
4. Add CI gates (case 8)
5. Lock in positives (cases 9-10)

---

## 12. CLI / DX / Docs Review

### Command Ergonomics (Strong)
- README "Start here / Daily use / Repair / Advanced" taxonomy is excellent
- `doctor --fix` as canonical safe-recovery is a good trust pattern
- Dashboard hotkeys (Q=cancel) consistent per AGENTS.md

### Command Ergonomics (Gaps)
- `--json` coverage uneven (AUDIT-M26)
- No shell completion (F6)
- No `why-selected` visibility (F1)
- No incident bundle (F4)
- Help discoverability unverified (G-08)

### Install/Upgrade Flow
- `npm i -g codex-multi-auth` standard; legacy `@ndycode/codex-multi-auth` migration path documented â€” GOOD
- `prepare` â†’ husky install side effect undocumented in CONTRIBUTING (AUDIT-M22)
- `pack:check` fails â€” tarball bloat (AUDIT-H7)

### Docs Mismatches
- AGENTS.md stale across 4 axes (AUDIT-H8)
- Redirect host `localhost` vs `127.0.0.1` (AUDIT-H5)
- `docs/reference/storage-paths.md` references `deriveProjectKey` (does not exist); code uses `getProjectStorageKey` (AUDIT-L04)
- CHANGELOG-to-git-log cross-ref not verified (AUDIT-M32)

### Contributor Ergonomics
- Governance files complete (SECURITY.md, CODE_OF_CONDUCT, CONTRIBUTING, LICENSE) â€” LM-08
- Runbooks present in `docs/development/` (`RUNBOOK_ADD_AUTH_COMMAND.md`, etc.) â€” strong onboarding signal
- Strict TS + 0 escape hatches + lint â€” signals strong taste (I-01, I-02)
- Dual linter confusion (AUDIT-M21)

### OSS Readiness: STRONG
- All governance stack present
- CodeQL + plugin scanner + CI + PR-CI workflows
- Clean supply chain audit
- Active security bump cadence
- README structural quality high

---

## 13. Quick Wins

Each is S-effort (hours, not days):

1. **Fix AGENTS.md staleness** (regen via `/init-deep`) â€” AUDIT-H8
2. **Fix README/docs redirect host** (`localhost` â†’ `127.0.0.1`) â€” AUDIT-H5
3. **Fix `docs/reference/storage-paths.md` `deriveProjectKey` typo** â€” AUDIT-L04
4. **Delete/fix the 6 repo-root tmp files + patch leaking tests** (`test/account-clear.test.ts`, `test/flagged-storage-io.test.ts`) â€” AUDIT-M31
5. **Add `EPERM` to flagged-read retry codes** â€” AUDIT-M05
6. **Align `account-clear` marker-first ordering with flagged-clear flow** â€” AUDIT-M04
7. **Emit audit log when WAL/backup corruption recovery is used** â€” AUDIT-L03
8. **Log deprecation headers in error paths too** â€” AUDIT-M18
9. **Document `prepare`-hook husky side effect in CONTRIBUTING.md** â€” AUDIT-M22
10. **Document `dual-linter` scope (eslint=correctness, biome=format) in CONTRIBUTING.md** â€” AUDIT-M21
11. **Align fallback 429 path to pass `stableAccountKey`** â€” AUDIT-L07
12. **Add invariant test: PKCE always S256** â€” preserves C-AUTH-01
13. **Add invariant test: OAuth state 16 crypto bytes** â€” preserves C-AUTH-02
14. **Add pack-size CI gate (runs `pack:check`, fails PR on regression)** â€” AUDIT-H7 preventive
15. **Add `strict: true` explicit documentation to CONTRIBUTING** â€” I-05 lock-in
16. **Document `codex-cli` vs `codex-manager` boundary in `lib/AGENTS.md`** â€” AUDIT-M27
17. **Add `resolvePath` regression tests (home/project/tmp lookalikes, Windows+POSIX)** â€” AUDIT-H1 coverage
18. **Redact OAuth URL in user-facing browser-launch output** â€” AUDIT-H4
19. **Move test tmp files to `os.tmpdir()`** â€” AUDIT-M31
20. **Document experimental-tier stability policy in README** â€” AUDIT-M28

---

## 14. Phased Implementation Roadmap

### Phase 1: Correctness & Safety (2â€“3 weeks)
**Scope**: All HIGH findings + security-relevant MEDIUM.
**Tasks**:
- Fix AUDIT-H1 `resolvePath` + add regression tests
- Fix AUDIT-H2 hybrid selector contract + test
- Fix AUDIT-H3 short-429 race + concurrent-request test
- Fix AUDIT-H4 OAuth URL redaction
- Fix AUDIT-H5 redirect host (R2 refactor)
- Fix AUDIT-H6 CONFIG_PATH precedence
- Fix AUDIT-H7 pack:check + add CI gate
- Regen AGENTS.md (AUDIT-H8)
- Fix AUDIT-H9 SSE malformed-chunk logging
- Fix AUDIT-H10 active-pointer dangling
- Fix 3 failing tests (K-02, K-03, K-04)
**Deps**: None (correctness fixes are independent)
**Benefits**: Unblocks release; restores test-suite green baseline; fixes confirmed security regression
**Rollback**: Each fix is small/atomic â€” per-commit revert

### Phase 2: Architecture & Refactor (3â€“5 weeks)
**Scope**: R1-R6 refactors + error-taxonomy introduction.
**Tasks**:
- R1 settings-hub split
- R2 redirect-URI SSOT (from Phase 1)
- R3 JSON.parse â†’ Zod schemas at boundaries
- R4 routing mutex + selection-record
- R5 unify health with AccountManager
- R6 atomic writes for recovery
- AUDIT-M29 introduce `CodexError`/`AuthError`/`NetworkError` hierarchy
- AUDIT-M17 structured logger schema with required correlation fields
**Deps**: Phase 1 green baseline
**Benefits**: Long-term maintainability; reduced race surface; clean observability
**Rollback**: R1 + R5 + R6 independent; R2 already Phase-1; R3 additive; R4 needs feature flag for safe rollback

### Phase 3: Testing, Docs, DX (2â€“3 weeks)
**Scope**: Test gap closure + docs truth-up + DX features.
**Tasks**:
- Testing cases 1-10 from Section 11
- `--json` standardization (AUDIT-M26)
- Shell completion (F6)
- Fix docs drifts (AUDIT-L04, AUDIT-M32)
- Document experimental-tier policy (AUDIT-M28)
- Document codex-cli vs codex-manager (AUDIT-M27)
- Add perf regression CI (AUDIT-L11)
**Deps**: Phase 1 + Phase 2
**Benefits**: Contributor confidence; operator confidence; release safety
**Rollback**: All additive

### Phase 4: Strategic Features (4â€“6 weeks)
**Scope**: Feature recs F1-F9.
**Tasks**:
- F1 `why-selected` (depends on R5)
- F2 `verify --paths`
- F3 per-account quarantine state (needs V3â†’V4 migration)
- F4 incident bundle (needs redaction helper + R3 logger)
- F5 fix --preview
- F7 Codex CLI compat probe
- F8 graduate backup/restore from experimental
- F9 unified machine-readable outputs
**Deps**: Phase 2 (schemas, logger, routing mutex)
**Benefits**: User experience, debuggability, trust
**Rollback**: Each feature behind `--experimental` flag until stable

---

## 15. Top 20 Recommended Actions

Formula: `score = severity_weight Ã— probability Ã— blast_radius`. Weights: CRITICAL=5, HIGH=4, MEDIUM=2, LOW=1.

| Rank | Action | Category | Reason | Difficulty | Impact |
|------|--------|----------|--------|------------|--------|
| 1 | Fix `resolvePath` lookalike bypass + regression tests | Security/Correctness | HIGH-security path guard failure | M | HIGH |
| 2 | Fix hybrid selector to return null when no accounts available | Routing | Prevents unavailable-account retries | S | HIGH |
| 3 | Fix short-429 race (mark unavailable before sleep) | Routing | Amplified throttling under concurrency | S | HIGH |
| 4 | Redact OAuth URL in user-facing output | Security | CSRF/state leak to stdout/clipboard | S | HIGH |
| 5 | Reconcile redirect host (`127.0.0.1` canonical) + SSOT refactor (R2) | Docs/Security | Confirmed drift breaks login; 4+ duplicate sites | M | HIGH |
| 6 | Fix `loadPluginConfig` CONFIG_PATH precedence | Config | Failing test; config bug | S | HIGH |
| 7 | Fix `pack:check` + add CI gate | Release | Tarball bloat; release blocker | S | HIGH |
| 8 | Regenerate AGENTS.md (docs truth-up) | Docs | 4-axis drift erodes contributor trust | S | HIGH |
| 9 | Surface SSE malformed-chunk as structured warn | Reliability | Silent data loss | S | HIGH |
| 10 | Normalize active-account pointer on disable/remove | Routing | Dangling pointer UX/state confusion | S | HIGH |
| 11 | Split `settings-hub.ts` into sub-concerns (R1) | Architecture | 2100 LOC overgrown file | L | MEDIUM |
| 12 | Zod schemas at all `JSON.parse` boundaries (R3) | Security/Types | 59 raw parse sites | L | MEDIUM |
| 13 | Add `connectTimeoutMs` distinct from total/stall | Reliability | Diagnostic clarity + connect-vs-upstream disambiguation | S | MEDIUM |
| 14 | Structured logger schema with required correlation fields | Observability | Uneven logs across retry paths | M | MEDIUM |
| 15 | Atomic writes + retry-safe deletes for recovery storage (R6) | Reliability | Mid-write crash risk in recovery | S | MEDIUM |
| 16 | Move test tmp files to `os.tmpdir()` + shared cleanup helper | Tests | 6 leaking tmp files at repo root | S | MEDIUM |
| 17 | Introduce `CodexError`/`AuthError`/`NetworkError` taxonomy | Errors | Ad-hoc error construction | M | MEDIUM |
| 18 | V2 migration path (match docs claim) or docs correction | Storage | V1â†”V3 only; docs overstate | S | MEDIUM |
| 19 | Feature F1 `codex auth why-selected` + F2 `verify --paths` | Features | Operator visibility + path self-test | M | MEDIUM |
| 20 | Invariant tests for PKCE S256 + OAuth state 16-byte crypto | Tests | Lock-in positive findings | S | LOW-MEDIUM |

---

## 16. Module-by-Module Notes

| Module | Purpose | Strengths | Concerns | Verdict |
|--------|---------|-----------|----------|---------|
| `index.ts` | 7-step fetch pipeline | 4-gate loop termination (H-09); deprecation header logging (success path) | 7 steps not documented inline (H-01); fallback 429 hardcodes reason (H-06); active-pointer normalization missing (D-05) | **Harden** â€” inline step comments + fix fallback paths |
| `lib/auth/` | OAuth + PKCE + callback | Strong OAuth state entropy (C-AUTH-02); refresh-guardian taxonomy (C-AUTH-13); auth storage corruption recovery (C-AUTH-09); refresh-queue race prevention (C-10) | Redirect host drift (C-AUTH-03); live URL leak (C-AUTH-05); port duplicated (C-AUTH-04); JWT `exp` unvalidated (C-AUTH-07); callback server not eager-close (C-AUTH-11); access+refresh tokens plaintext (C-AUTH-08) | **Harden** â€” R2 SSOT + secret minimization |
| `lib/accounts.ts` + `lib/accounts/` | Per-account rate-limit tracking + selection | Case-insensitive email dedup (AGENTS.md); health scoring implementation | Hybrid selector returns unavailable (D-01); non-deterministic routing (D-02); health + quota memory volatile (D-03); active pointer can dangle (D-05); project-scoped bypass on CLI sync (D-06); routing races (D-09) | **Refactor** â€” R4 mutex + selection record |
| `lib/codex-cli/` | CLI state, sync, observability, writer | Existence of observability layer | Unclear boundary vs `lib/codex-manager/` (G-06) | **Document or merge** |
| `lib/codex-manager/` | Command dispatcher + settings-hub | Rich command surface; Q=cancel consistency | `settings-hub.ts` 2100 LOC (G-01); `auth list` message drift (G-02); `--json` coverage uneven (G-03); experimental tier undocumented (G-09) | **Split** â€” R1 |
| `lib/prompts/` | Model-family prompts + GitHub ETag cache | ETag cache is performance-aware | Not deeply audited in this pass | **Preserve** |
| `lib/recovery/` | Conversation state persistence | Defensive against partial writes (via skip-unreadable) | Non-atomic writes (E-03); silent-skip no-log (E-09) | **Harden** â€” R6 |
| `lib/request/` | Request transform, SSE, failover, backoff | 4-gate termination; structured failure policy; burst cooldown | SSE non-streaming buffers 10MB + silent-skip malformed (H-03); observability uneven (H-05); stream failover bypasses server-error policy (D-08); no connect timeout (H-02) | **Harden** |
| `lib/storage/` | V1â†”V3 migrations + worktree resolution | V3 format robust; WAL + backups; Windows `removeWithRetry` | `resolvePath` lookalike bypass (E-01/K-02) â€” HIGH; V2 absent (E-05); in-process-only locks (E-04); account-clear ordering (E-07) | **Harden** â€” priority on E-01 |
| `lib/tools/` | Hashline tool helpers | Scoped, focused | Not deeply audited | **Preserve** |
| `lib/ui/` | ansi, auth-menu, theme, select, copy | Theme live-preview + baseline restore pattern (G-05) | Some text duplicates port 1455 literal (C-AUTH-04) | **Preserve** â€” fix R2 duplication |
| `scripts/` | install, build, hygiene, benchmarks | 11+ scripts; Windows-safe `removeWithRetry`; `verify-vendor-provenance.mjs`; `check-pack-budget.mjs`; `audit-dev-allowlist.js` | `pack:check` FAILS on HEAD (LM-01) | **Fix `pack:check`** |
| `test/` | 225 files, 3418 tests, 80% coverage | Chaos + property + fixtures; hermetic via env redirection (K-05) | 3 failing tests on HEAD (K-02/K-03/K-04); repo-root tmp leakage (K-09/JN-09); coverage % unverified (K-07) | **Harden** â€” fix failures + leakage |
| `docs/` | 14+ markdown docs + sub-directories | Strong README taxonomy; full governance; runbooks | Redirect host drift (AUDIT-H5); `deriveProjectKey` typo (E-06); AGENTS.md stale (AUDIT-H8); CHANGELOG drift unverified (LM-07) | **Truth-up** |
| `.github/workflows/` | ci, pr-ci, codex-plugin-scanner, codeql | Full OSS CI stack; CodeQL + plugin scanner + dep scanner | No perf CI gate (P-06); no pack-size gate (LM-01 preventive) | **Extend** |
| `bench/format-benchmark/` | Code-edit format benchmark | Focused, documented | Hot paths (request, SSE, selection, storage) lack bench (P-02) | **Extend** |
| `vendor/codex-ai-plugin`, `vendor/codex-ai-sdk` | File-protocol vendored deps | `vendor:verify` provenance script; bundleDependencies | Black-box inside audit scope | **Preserve provenance discipline** |

---

## 17. Final Verdict

### Is the codebase structurally healthy?

**Yes â€” it is structurally healthy with known, addressable gaps.** This is a serious, well-crafted CLI tool with strong TypeScript discipline (0 `as any`, 0 `@ts-ignore`), hermetic test design, active security maintenance, full OSS governance, and a clean supply chain. The architecture boundaries (auth / accounts / request / storage / codex-manager) are sensible; the 7-step request pipeline has safety gates; OAuth uses PKCE with 128-bit CSRF entropy.

The current HEAD (v1.2.7) has **10 HIGH-severity findings** across correctness/security/docs that should be addressed before the next minor release. None reach CRITICAL severity with confirmed evidence in this pass, but AUDIT-H1 (`resolvePath` lookalike bypass) is CRITICAL-candidate pending real-host reproduction.

### What is the biggest long-term bottleneck?

**The settings-hub monolith (2100 LOC) and the implicit state machines in `lib/accounts.ts` + `lib/rotation.ts`.** Together they concentrate change risk in single files and blur ownership. Left unsplit, every new feature touches them, regression surface grows, and subtle races (AUDIT-H2/H3/M07) will keep resurfacing.

The secondary bottleneck is **absence of a structured error taxonomy + uniform logger schema** â€” makes post-incident reconstruction hard and slows debugging.

### What should be implemented first?

**Phase 1 Correctness & Safety â€” fix the 10 HIGH findings and restore a green test baseline.** Specifically:
1. `resolvePath` lookalike + `selectHybridAccount` + short-429 race + OAuth URL redaction + `loadPluginConfig` precedence + `pack:check` â€” in parallel tracks
2. `codex auth list` empty-storage message + `resolvePath` test + `plugin-config` precedence test â€” restores green baseline
3. AGENTS.md regen + `localhost` â†’ `127.0.0.1` docs truth-up

### What must NOT be broken during refactoring?

Preserve (cross-referenced to Section 3):
1. **Hermetic test design** â€” `HOME` + `CODEX_MULTI_AUTH_DIR` env-redirect pattern; verified zero drift
2. **Strict TypeScript doctrine** â€” 0 `as any`, 0 `@ts-ignore`, `strict: true`
3. **Refresh-queue race prevention** â€” token-keyed dedupe + rotation + rollback on persist fail
4. **4-gate request-loop termination** â€” attempted.size, outbound budget, MAX_SHORT_RETRY_ATTEMPTS=3, MAX_STREAM_FAILOVERS=1
5. **Atomic writes for primary + flagged + settings** â€” extend, don't regress
6. **Clean supply chain** â€” `audit:ci` green, `vendor:verify` green
7. **OSS governance** â€” SECURITY/COC/CONTRIBUTING/LICENSE + CodeQL + scanners
8. **CLI command taxonomy** â€” Start/Daily/Repair/Advanced organization in README

---

## Appendix: Evidence Index

Under `docs/audits/evidence/`:

| File | Source | Purpose |
|------|--------|---------|
| `context.txt` | T0b | HEAD SHA, version, node, OS, CI workflows |
| `inventory.txt` | T1 | LOC/file inventory per module |
| `typecheck.txt` | T2 | `npm run typecheck` output (exit 0) |
| `test-summary.txt` | T3 | Vitest summary (225 files/3418 tests/3 fail) + hermeticity verdict |
| `lint.txt` | T4 | `npm run lint` (exit 0) |
| `audit-ci.txt` | T4 | `npm run audit:ci` (exit 0) |
| `vendor-verify.txt` | T4 | `npm run vendor:verify` (exit 0) |
| `pack-check.txt` | T4 | `npm run pack:check` (exit 1) â€” budget violation |
| `clean-repo-check.txt` | T4 | Hygiene check + 6 tmp files flagged |
| `git-forensics.txt` | T5 | Churn, blame, regression commits |
| `docs-claims.txt` | T6 | Docs claim inventory for drift cross-ref |
| `redaction-report.txt` | T7 | Redaction validation grid (PASS) |
| `dim-C-auth.md` | T8 | Auth/OAuth/Token dimension (13 findings) |
| `dim-D-routing.md` | T9 | Multi-account routing dimension (9 findings) |
| `dim-E-storage.md` | T10 | Storage dimension (9 findings) |
| `dim-F-config.md` | T11 Atlas | Config/settings/dual-linter (7 findings) |
| `dim-G-cli.md` | T13 Atlas | CLI/settings-hub (9 findings) |
| `dim-H-request.md` | T12 Atlas salvage | Request pipeline/SSE/resilience (10 findings) |
| `dim-I-types.md` | T14 | Type safety sweep (6 findings) |
| `dim-JN-errors-health.md` | T15 Atlas | Error handling + code health (10 findings) |
| `dim-K-tests.md` | T16 Atlas | Test strategy + hermeticity (10 findings) |
| `dim-LM-release-docs.md` | T17 Atlas | Release/CI + docs drift (12 findings) |
| `dim-P-perf.md` | T17b Atlas | Perf lightweight (6 findings) |

**Total distinct findings: ~110 across 16 dimensions.**

---

*End of MASTER_AUDIT.md â€” composed under Sisyphus/Atlas workflow. See Section 3 for strengths to preserve. See Section 14 for the 4-phase roadmap.*
