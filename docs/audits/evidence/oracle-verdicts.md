# Oracle Verdicts — codex-multi-auth@1.2.7 Master Audit

**Reviewer**: Oracle (independent architectural verdict)
**Base**: `docs/audits/MASTER_AUDIT.md` §4/§5/§8 + dim-C/D/E/H deep-dives
**HEAD**: `1f6da97` · 2026-04-17

Independent, adversarial review of the audit's severity calls, refactor priorities, and architectural posture. Verdicts below cite AUDIT-IDs and file:line refs; every severity adjustment is grounded in evidence from the four highest-risk dimension files.

---

## 1. Severity Classification Review

### 1.1 HIGH findings — confirmed vs overclassified

Walkthrough of §5 HIGHs with independent verdict:

| ID | Audit call | Oracle verdict | Reasoning |
|----|-----------|----------------|-----------|
| AUDIT-H1 | HIGH (security-relevant) | **ELEVATE → CRITICAL-candidate** (confirmed pending reproduction) | See §1.2 below. |
| AUDIT-H2 | HIGH | **CONFIRM HIGH** | dim-D D-01 cites `lib/rotation.ts:379-392` + `lib/accounts.ts:668-697` + `index.ts:1149-1157`. Three independent code paths + confirmed confidence. Directly erodes failover guarantee. |
| AUDIT-H3 | HIGH | **CONFIRM HIGH** | dim-D D-07 `index.ts:2089-2114`. Concurrent-request amplification is a real operational hazard; "confirmed" confidence. Keep HIGH. |
| AUDIT-H4 | HIGH | **CONFIRM HIGH** | dim-C C-AUTH-05 cites three file sites (`codex-manager.ts:1825-1841`, `auth.ts:15-20,262-269`, `browser.ts:158-177`). State + code_challenge in stdout/clipboard is a live-secret surface leak; keep HIGH. |
| AUDIT-H5 | HIGH | **CONFIRM HIGH (borderline)** | dim-C C-AUTH-03 is confirmed drift. Severity is HIGH *because* it can break login in provider configurations pinned on host literal; not because current live breakage is proven. Reasonable HIGH; do not demote. |
| AUDIT-H6 | HIGH | **DEMOTE → MEDIUM** | F-01/K-04 is a failing test on a **config precedence bug that users can work around** by setting only one env var. Evidence is strong (test failure), but blast radius is narrow: legacy `CODEX_HOME` users with a stale file. No data loss / no security impact. Classify MEDIUM-with-failing-test, fix in Phase 1 anyway. |
| AUDIT-H7 | HIGH | **CONFIRM HIGH** | LM-01: `pack:check` FAILS exit=1 on HEAD. Tarball bloat → unintended files in published npm artifact = potential credential/script leak into supply chain. HIGH is correct; arguably even CRITICAL if inspection reveals secrets in tarball (follow-up verification needed). |
| AUDIT-H8 | HIGH | **DEMOTE → MEDIUM** | LM-02 docs staleness (v0.1.x / 87 files vs v1.2.7 / 225 files). Documentation drift, not runtime behavior. Harm is contributor confusion + agent misbehavior, not user-facing. MEDIUM fits; escalate if AGENTS.md drives critical delegation paths. |
| AUDIT-H9 | HIGH | **DEMOTE → MEDIUM** | H-03: SSE malformed-chunk silent discard + 10MB buffer. Evidence is "likely no explicit coverage" and dim-H itself marks the same finding MEDIUM in its detailed table (dim-H line 38, row AUDIT-H03). Master audit is internally inconsistent — demote to MEDIUM and reconcile. |
| AUDIT-H10 | HIGH | **DEMOTE → MEDIUM** | D-05 dangling active pointer. Evidence confirmed; impact is "UI/automation holds stale active index" — visible bug, no credential or data-loss dimension. Operator-facing friction, MEDIUM-caliber. |

**HIGH adjustments summary**: 1 elevated (H1 → CRITICAL-candidate), 4 demoted to MEDIUM (H6, H8, H9, H10), 5 confirmed (H2, H3, H4, H5, H7). Net: HIGH count moves from 10 → 6.

### 1.2 Should AUDIT-H1 be elevated to CRITICAL?

**Verdict: YES — elevate to CRITICAL-candidate; convert to CRITICAL once reproduction on real host paths is captured.**

Reasoning:

- **Trust boundary**: `resolvePath()` in `lib/storage/paths.ts:333-357` is the path-guard for import/export operations. Audit's own severity rubric (§Severity Rubric) defines CRITICAL as "token/auth corruption, data loss, unsafe credential handling, or core trust breakage." A path-guard that does not reject lookalike-prefix paths maps to **"unsafe credential handling"** and **"core trust breakage"** — import routines touching approved roots can write credentials outside those roots or read from attacker-controlled siblings.
- **Evidence quality**: `test/paths.test.ts:842-846` FAILS on HEAD. This is not "probable" — it is a failing regression gate in the repository itself. Confidence is maximal.
- **Blast radius**: `resolvePath()` gates both import AND export (E-01) — read and write surfaces are affected. Local-access attacker can create a lookalike directory (e.g. `~/.codex-multi-auth-evil/` vs `~/.codex/multi-auth/`) that bypasses the guard.
- **Why audit left it HIGH**: §4 states "elevated to HIGH-SECURITY pending reproduction on real host paths." Oracle position: the failing test **is** the reproduction at code level. Missing step is a concrete exploit walk-through, but the guard invariant is already violated.

**Recommendation**: Reclassify as CRITICAL in §4. Block next release on fix. Add pack:check gate (H7) to same release.

### 1.3 MEDIUM findings under-classified (should be HIGH)

| ID | Current | Oracle call | Reason |
|----|---------|-------------|--------|
| AUDIT-M09 | MEDIUM | **ELEVATE → HIGH** | "Project-scoped isolation silently bypassed when Codex CLI sync enabled" (`lib/runtime/storage-scope.ts:20-34`). Silent cross-project credential leak: users who chose per-project isolation discover only via audit that enabling sync collapses to global. `setStoragePath(null)` with one-time warn matches "silent trust breakage" class. Peer to H4/H5. |
| AUDIT-M13 | MEDIUM | **ELEVATE → HIGH (conditional)** | Plaintext access+refresh tokens at rest (file mode 0600). MEDIUM defensible given 0600, but paired with H1 path-guard regression, combined blast radius is credential exfiltration. If H1 is fixed and keychain integration is out of scope, MEDIUM stands. If H1 ships unfixed, M13 functionally becomes HIGH. |
| AUDIT-M02 | MEDIUM | **Hold at MEDIUM but flag** | In-process-only concurrency guard. Two concurrent CLI processes racing on shared files is realistic (multi-terminal). Borderline. Ship MEDIUM but require advisory lock before shipping F3 (quarantine state) to avoid compounding. |
| AUDIT-M08 | MEDIUM | **Hold at MEDIUM** | Stale `lib/health.ts` field names (D-04). Operator-visible drift only; no runtime impact. MEDIUM correct. |
| AUDIT-M31 | MEDIUM | **Hold at MEDIUM** | 6 tmp files at repo root from leaking tests. DX + hygiene, not runtime risk. MEDIUM correct. |

**Under-classification summary**: M09 ELEVATE → HIGH (confirmed), M13 ELEVATE → HIGH conditional on H1.

### 1.4 Adjustments count

**Severity adjustments: 7**
- Elevated: 2 (H1 → CRITICAL-candidate, M09 → HIGH)
- Conditional elevation: 1 (M13 → HIGH if H1 ships unfixed)
- Demoted: 4 (H6, H8, H9, H10 → MEDIUM)

---

## 2. Top-3 Refactor Verdict

Ranked by `risk_reduction × evidence_strength × sequencing_unlock`.

### Rank 1 — R2: RedirectURI single source of truth

- **Why this vs alternatives**: R2 is the **only refactor on the list that directly fixes a confirmed HIGH (H5)** while simultaneously resolving 4+ duplicated literals (AUDIT-M14/M30, C-AUTH-04). Alternative R1 (settings-hub split) reduces cognitive load but closes zero bugs. R2 prevents a whole *class* of future drift (port/host/scheme changes), not just today's instance.
- **Expected risk reduction**: HIGH. Eliminates the AUDIT-H5 login-break class permanently + kills C-AUTH-04/M14/M30 duplication. Any future change to `:1455` or `127.0.0.1` becomes mechanical.
- **Implementation sequencing**: Must precede R4 (routing mutex touches hot path; do not bundle with a user-facing host change). Recommend shipping R2 in its own PR with explicit CHANGELOG entry — existing OAuth app registrations may break on host standardization (audit §8 R2 notes MEDIUM migration risk correctly).
- **Cost**: Small (≤1 day). 6 sites per §8 R2.

### Rank 2 — R3: Consolidate `JSON.parse` behind Zod schemas

- **Why this vs alternatives**: R3 is **additive, fail-closed, and scales** to 59 parse sites across 31 files (AUDIT-M20). The single-file Zod hub already exists (`lib/schemas.ts`), so the refactor is adoption not design. R4 (routing mutex) has higher immediate routing-correctness payoff but medium migration risk on the hot path. R3 has LOW risk and unlocks F4 (incident bundle), F9 (unified `--json` outputs), and the larger "trust at boundaries" pattern. R5 (unify health) and R6 (atomic recovery writes) are smaller scope with narrower payoff.
- **Expected risk reduction**: MEDIUM-HIGH cumulative. Every unvalidated `JSON.parse` is a latent corruption/crash vector. Fail-closed semantics turn silent corruption into clear operator signals. Compounds across release cycles.
- **Implementation sequencing**: Per §8 R3: storage payloads first (highest blast radius — `lib/storage.ts`, `lib/recovery/storage.ts`), then request/response, then config, then ancillary. Can proceed in parallel with R1/R2/R5 — independent surfaces.
- **Cost**: Medium (spread across 5-10 PRs; per-site diffs small).

### Rank 3 — R4: Routing mutex + selection-record pattern

- **Why this vs alternatives**: R4 is the structural fix for **three HIGH findings simultaneously** (AUDIT-H2 hybrid-selector, AUDIT-H3 short-429 race, AUDIT-D09 cursor race). Point-fixes to H2/H3 are possible (§5 lists tactical fixes) but the race substrate remains. R4 attacks the class. R1 is higher LOC but purely cognitive — no bugs close. R5 closes one MEDIUM (D-04). R6 closes one MEDIUM (E-03). R4's ratio of HIGH-findings-closed per unit of work is the best of the refactor set.
- **Expected risk reduction**: HIGH. Selection-record + mutex closes the race-free selection contract. Prevents regression surface — any new router feature inherits the invariant.
- **Implementation sequencing**: **Must land AFTER R2 (host canonicalization stable) and at LEAST prototype of R3 (parsed persistence).** R4 touches the request hot path — benchmark before merge (§8 R4 notes this). Feature-flagged rollout recommended: `routingMutex: "enabled" | "legacy"` for one release cycle with default enabled. Pair with AUDIT-H2 + H3 point-fixes in the same PR so user-visible HIGH-bug list empties in one release.
- **Cost**: Medium-Large (needs race-property tests + concurrent-request regression coverage from §11 cases 2, 3).

### Why not R1/R5/R6 in top-3

- **R1 settings-hub split**: Valuable (2100 LOC → 5 × 500 LOC) but closes **zero** bugs; high merge-conflict absorption cost if delayed. Ship as Phase-2 LOW-risk chore.
- **R5 health unify**: One MEDIUM closed (D-04). Narrow payoff. Follow R3 (parse safety) because health logs will be shaped by R3's schemas anyway.
- **R6 recovery atomic writes**: One MEDIUM closed (E-03). Small, low-risk, quick-win candidate. Bundle into Phase-1 quick wins rather than top-3 strategic.

---

## 3. Contradictions Across dim-*.md Files

Found **3 contradictions** plus 1 soft inconsistency.

### 3.1 AUDIT-H9 / H-03 severity inconsistency

- §5 line 200: marks AUDIT-H9 as **HIGH**.
- `dim-H-request.md` line 38 (row AUDIT-H03): marks same finding as **MEDIUM**.
- Identical claim (SSE non-streaming buffer 10MB + silent malformed-chunk discard).
- **Resolution**: dim-H is ground-truth authoring file. Demote to MEDIUM (consistent with §1.1 above).

### 3.2 Storage migration version coverage claim

- §1 Executive / §2 System Map: "V1↔V3 migrations" (Master line 120).
- `AGENTS.md` §NOTES: "V1/V2 → V3 upgrade" claim.
- `dim-E-storage.md` E-05 line 17: "Active code supports storage versions `1` and `3` only; no active `V2` migration path found despite repository docs claiming `V1/V2 -> V3`."
- **Resolution**: E-05 correct. AGENTS.md overstates. Implement V2 handler or fix docs (tracked as AUDIT-M03).

### 3.3 Refresh-queue race prevention scope

- dim-C C-AUTH-10: "Refresh queue race prevention is implemented correctly" (confirmed; §3 Master line 67 lists as positive).
- dim-D D-09: "Refresh races are reduced, but routing races remain. Cursor, active index, `lastUsed`, and debounced save snapshots are mutated without coordination primitive."
- **Not a direct contradiction** but a **scope clarification gap** readers can miss. §3 "Already Strong" should read: "Refresh-queue race prevention (routing races remain — see D-09)."

### 3.4 Soft inconsistency — resolvePath reproduction status

- §4 Critical: "elevated to HIGH-SECURITY pending reproduction on real host paths."
- `dim-E-storage.md` E-01: "known regression remains open" (test failing at HEAD).
- The failing unit test **is** code-level reproduction. §4 language implies further work needed; E-01 asserts evidence is already sufficient.
- **Resolution**: §4 wording should accept failing test as reproduction and elevate per §1.2.

---

## 4. Assumptions Needing Validation

Audit made these inferences without full evidence:

### 4.1 `pack:check` failure has been inspected

§5 AUDIT-H7 cites `pack-check.txt` but master audit does not enumerate *what* files are leaking into the tarball. **Assumption**: this is oversize only, not secret-leaking. **Required validation**: inspect `pack-check.txt` and the packed tarball manifest for `.env`, `test/fixtures/`, `.codex/`, or dev-only artifacts. If tokens or account JSON fixtures are in the tarball, H7 is CRITICAL, not HIGH.

### 4.2 PKCE entropy quality

§3 + C-AUTH-01: "Entropy source lives in external dependency code not audited here." Marked LOW + "probable." **Assumption**: external dep's `generatePKCE()` uses `node:crypto`-equivalent source. **Required validation**: pin dependency name + version, audit its source, add regression test `expect(pkce.method).toBe('S256')`. Without this, the "probable strong" verdict is unearned.

### 4.3 Dim-H composition provenance

`dim-H-request.md` line 3: "Audited by T12 agent (salvaged from mid-run output; agent hit step budget before writing file)." Evidence base listed but 10 findings are "grounded in file:line evidence references the agent reported" — no second reviewer verified citations. **Assumption**: AUDIT-H9/M16-M19 file:line refs are accurate. **Required validation**: spot-check 3 citations (e.g. `response-handler.ts` 10MB buffer, `stream-failover.ts` emittedBytes guard) before acting on Phase-1 fixes.

### 4.4 Hermeticity verdict durability

§3 claims hermeticity "verified" via K-05 — tests don't leak to real `~/.codex/multi-auth/` when env-redirected. **Assumption**: all 3418 tests honor redirection. **Required validation**: the 6 leaking tmp files at repo root (AUDIT-M31) indicate **some tests write to `process.cwd()` instead of `os.tmpdir()`**. Hermeticity claim is narrower than stated — accurate for `HOME`/`CODEX_MULTI_AUTH_DIR`, NOT for CWD. Qualify §3 accordingly.

### 4.5 Zod schema hub "centralized but not applied"

AUDIT-M20 cites `lib/schemas.ts` as the hub. **Assumption**: hub is comprehensive enough to cover existing parse sites. **Required validation**: count schemas in `lib/schemas.ts` vs unique payload shapes across 59 parse sites. R3 cost estimate depends on this ratio.

### 4.6 No CRITICAL findings assertion

§4: "No CRITICAL-severity findings with confirmed evidence." This holds **only if** H1 is not reclassified per §1.2. If H1 is CRITICAL, §4 needs a rewrite.

---

## 5. Overall Architectural Verdict

### Verdict: **HEALTHY (with one CRITICAL-candidate regression)**

The codebase is structurally mature: strict TypeScript discipline, hermetic tests, atomic writes on primary storage, multi-gate request-loop termination, OSS governance complete, active security bump cadence. The architecture can be trusted as a foundation. The 1 CRITICAL-candidate (H1) and 6 remaining HIGH findings (after Oracle's adjustments) are **localized regressions and drift**, not foundational flaws.

### One-liners

- **Biggest long-term bottleneck**: **`settings-hub.ts` at 2100 LOC + absence of routing mutex** (R1 + R4). Together they bound future velocity — new settings features compound the monolith, and every routing feature risks regressing H2/H3-class races without the selection-record primitive.

- **What to fix first**: **AUDIT-H1 `resolvePath` lookalike bypass** — single CRITICAL-candidate, fix is small (harden `isWithinDirectory()` + regression tests). Block the next release on this, paired with AUDIT-H7 `pack:check` gate so published artifacts are known-clean.

- **What must not break**: **Refresh-queue race dedupe (`lib/refresh-queue.ts`) + atomic writes on primary/flagged/settings storage + 4-gate request-loop termination (`index.ts`).** Three unstated load-bearing invariants; any refactor (especially R4) must preserve them with regression tests before merge.

---

**Oracle DONE** · Severity adjustments: **7** · Top-3 refactors: **R2 (RedirectURI SSOT), R3 (JSON.parse → Zod), R4 (routing mutex + selection-record)** · Overall verdict: **HEALTHY (one CRITICAL-candidate pending: AUDIT-H1)**
