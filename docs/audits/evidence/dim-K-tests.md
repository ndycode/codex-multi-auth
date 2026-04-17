# Dimension K — Test Strategy + Risk-to-Coverage + Hermeticity

HEAD 1f6da97, v1.2.7. Test inventory: **225 files / 3418 tests / 3 failing** (captured Wave 1 hermetic run).

**Composed by Atlas** — T16 agent failed to produce deliverable despite 3m49s budget.

| ID | Severity | Claim | Evidence | Confidence |
|----|----------|-------|----------|------------|
| K-01 | HIGH | **AGENTS.md test-count drift**: claims "87 files, 2071 tests"; actual 225 files / 3418 tests (2.6×) — cross-ref LM-02 | `docs/audits/evidence/test-summary.txt` line 7; `AGENTS.md` §OVERVIEW | confirmed |
| K-02 | HIGH-SECURITY | `test/paths.test.ts:846` FAILS — `resolvePath()` does NOT reject lookalike prefix paths outside home directory (expected throw, got undefined) — import/export path-guard bypass (cross-ref E-01) | `test/paths.test.ts:842-846`, `lib/storage/paths.ts:333-357`, `test-summary.txt` | confirmed |
| K-03 | MEDIUM | `test/codex-manager-cli.test.ts:913` FAILS — `auth list` empty-storage message mismatch (cross-ref G-02) | `test-summary.txt`, `test/codex-manager-cli.test.ts:913` | confirmed |
| K-04 | MEDIUM | `test/plugin-config.test.ts:417` FAILS — `loadPluginConfig` CONFIG_PATH precedence bug (cross-ref F-01) | `test-summary.txt`, `test/plugin-config.test.ts:417` | confirmed |
| K-05 | LOW | **Hermeticity: CLEAN** — zero delta in `~/.codex/multi-auth/` after hermetic `npm test` run under `HOME=.audit-tmp/home`, `CODEX_MULTI_AUTH_DIR=.audit-tmp/codex-home` — good test design (preserve) | `docs/audits/evidence/test-summary.txt` HERMETICITY section | confirmed |
| K-06 | LOW | Test suite breadth: chaos tests in `test/chaos/`, property tests in `test/property/`, fixture data in `test/fixtures/` — good stratification (preserve) | AGENTS.md §STRUCTURE; inventory.txt | confirmed |
| K-07 | MEDIUM | Coverage % not captured — coverage run likely failed on Windows (known v8 coverage issue); no actual coverage percent verified against 80% threshold | `package.json` scripts.test:coverage | probable |
| K-08 | MEDIUM | Duration profile: 225 files in 11.9s test phase + 40.25s import — import dominates, suggests large module graph and potentially slow test startup (low priority but noteworthy) | `test-summary.txt` Duration line | confirmed |
| K-09 | LOW | Test output contains stray node.exe PowerShell error lines ("<HOME>\DevTools\scoop\apps\nodejs\current/node.exe" NativeCommandError) — test harness brittleness on Windows | `test-summary.txt` lines 16-22 | confirmed |
| K-10 | LOW | Fixtures include `v3-storage.json` per AGENTS.md — V3 migration coverage good; V2 migration absent (cross-ref E-05) | AGENTS.md §STRUCTURE; dim-E E-05 | confirmed |

## Risk-to-Coverage Map (by dimension)

| Dimension | Area | Coverage Signal | Risk |
|-----------|------|-----------------|------|
| C (Auth) | OAuth/refresh | Likely `test/auth-*.test.ts`, `test/refresh-queue-*.test.ts` | Refresh race dedupe verified (dim-C C-10); token-leak URL test coverage unclear (cross-ref C-AUTH-05) |
| D (Routing) | Account selection/failover | Likely `test/accounts-*.test.ts`, `test/rotation-*.test.ts`, `test/circuit-breaker*.test.ts` | Hybrid selector bug (D-01) — needs targeted test; short-429 race (D-07) — needs concurrent-request test |
| E (Storage) | V1/V3 migration, atomicity | `test/fixtures/v3-storage.json`, `test/paths.test.ts`, `test/account-clear.test.ts`, `test/flagged-storage-io.test.ts` | resolvePath lookalike FAILS (K-02/E-01); recovery storage non-atomic (E-03) — no regression coverage |
| H (Request) | Pipeline, SSE, retry | Likely `test/request-*.test.ts`, `test/stream-failover*.test.ts` | SSE malformed-chunk silent skip (H-03) — no explicit coverage verified; mid-stream failover (H-04) — chaos test candidate |

## Verdicts
- **3 failing tests** are all real regressions with user-facing impact; K-02 is SECURITY-elevated
- **Docs drift** (K-01) is most impactful docs issue for contributor trust
- **Hermeticity clean** is the strongest positive signal — preserve the `CODEX_MULTI_AUTH_DIR`/`HOME` env pattern
- **Coverage gate**: 80% threshold per AGENTS.md is unverified on Windows — probable no-signal
