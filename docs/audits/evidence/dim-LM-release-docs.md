# Dimensions L+M — Release / CI / OSS Readiness + Docs Drift

HEAD 1f6da97, v1.2.7. pack:check=FAIL. AGENTS.md stale.

**Composed by Atlas** from Wave 1 evidence + README + AGENTS.md self-audit. Redo subagent produced skeleton only.

| ID | Severity | Claim | Evidence | Confidence |
|----|----------|-------|----------|------------|
| LM-01 | HIGH | Release harness blocked: `pack:check` fails, so current package state is not releasable under repo policy. | `docs/audits/evidence/pack-check.txt:1-30` shows `npm run pack:check` exit `1` with `Failed to validate npm pack output: Required package content missing from npm pack output: dist/`. Workflow gates call this in `ci.yml:78-102` and `pr-ci.yml:53-60`. | High |
| LM-02 | HIGH | `AGENTS.md` metadata is stale and no longer matches current repo state. | `AGENTS.md:3-5` says `Generated: 2026-03-01`, `Commit: 9ac8a84`; current repo state is `HEAD 1f6da97` per `docs/audits/evidence/git-forensics.txt:2-4`. | High |
| LM-03 | HIGH | `AGENTS.md` still frames the docs/release surface around the pre-1.x era, so agent-facing repo guidance drifts from actual `v1.2.7`. | `AGENTS.md:31-35` describes `docs/releases/ # v0.1.0, v0.1.1, beta, legacy history`; actual package is `1.2.7` in `package.json:2-4`, and stable release docs exist for `v1.2.5`, `v1.2.6`, `v1.2.7` in `docs/releases/v1.2.5.md:1-13`, `v1.2.6.md:1-10`, `v1.2.7.md:1-10`. | High |
| LM-04 | HIGH | Agent/test-scale claims are badly stale: docs say `87 files, 2071 tests`; current audit evidence shows `225` test files and `3418` tests. | `AGENTS.md:73,97` and `CHANGELOG.md:150` still claim `87` / `2071`; current run evidence in `docs/audits/evidence/test-summary.txt:108-109` shows `Test Files ... (225)` and `Tests ... (3418)`. | High |
| LM-05 | MEDIUM | Root `CHANGELOG.md` is incomplete for the supported line and no longer tracks releases after `0.1.8`. | `CHANGELOG.md:6-10` says current stable line is `1.x` but top entry is `0.1.8`; link footer only covers `0.1.0` through `0.1.7` at `CHANGELOG.md:176-183`. Tags now include `v0.1.9`, `v1.1.10`, `v1.1.11`, `v1.2.0`..`v1.2.7` from `git tag --sort=version:refname`. `v1.2.4..HEAD` history contains release bumps such as `bf5d053 release: ship v1.2.0`, `ab76069 release: ship v1.2.6 forwarded observability fix`, `e275984 chore(release): bump version to 1.2.7 and publish notes`. | High |
| LM-06 | MEDIUM | Security/dependency docs have their own drift: `SECURITY.md` still names `hono 4.12.10` while package metadata now pins `4.12.14`. | `SECURITY.md:76-81` documents `hono: pinned to 4.12.10`; actual dependency and override are `4.12.14` in `package.json:154-167`. | High |
| LM-07 | LOW | CI coverage is broad and explicit across 4 workflows, with release, PR, static analysis, and plugin-quality gates already wired. | Workflow inventory: `.github/workflows/ci.yml`, `pr-ci.yml`, `codex-plugin-scanner.yml`, `codeql.yml`. `ci.yml:15-142` runs hygiene, `audit:ci`, lockfile floor, coverage, build, pack budget, vendor verify, Windows script typecheck, Codex smoke. `pr-ci.yml:15-109` mirrors most of that on PRs. `codex-plugin-scanner.yml:1-73` enforces plugin score/regression fixtures. `codeql.yml:1-34` runs scheduled and PR security analysis. | High |
| LM-08 | LOW | Current dependency audit gate is clean; release readiness issue is packaging/docs drift, not an active npm audit failure. | `docs/audits/evidence/audit-ci.txt:1-18` shows `npm run audit:ci` exit `0`, `npm audit --omit=dev --audit-level=high`, and `found 0 vulnerabilities`. | High |
| LM-09 | MEDIUM | Install/upgrade path depends on build artifacts and git-hook setup; wrapper behavior is robust for forwarded commands but auth commands still require built `dist/`. | `package.json:72-106` defines `prepublishOnly: npm run build` and `prepare: husky`; `bin` points `codex` to `scripts/codex.js` at `package.json:107-110`. `scripts/codex.js:84-105` hard-fails auth runtime loading when `../dist/lib/codex-manager.js` is missing (`Run: npm run build`), while `scripts/codex.js:108-125` keeps non-auth forwarding best-effort. | High |
| LM-10 | LOW | OSS readiness baseline exists and is easy to discover: security, contribution, and conduct docs are present, with explicit disclosure/process guidance. | Repo contains `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`. `SECURITY.md:41-53` defines private vulnerability reporting and 48h target response. `CONTRIBUTING.md:22-65` defines local setup and PR gate expectations. | High |
| LM-11 | LOW | Vendored dependency provenance is documented and enforced in CI, which improves OSS and release trust despite the current pack/docs issues. | `vendor/provenance.json:1-54` records generated date, component names, versions, roots, and file hashes for `@codex-ai/plugin` and `@codex-ai/sdk`. `package.json:102-103` exposes `vendor:verify`; CI calls it in `ci.yml:98-102` and `pr-ci.yml:56-60`. | High |
| LM-12 | LOW | Semver discipline across `v1.2.4` -> `v1.2.7` looks orderly in tags and release notes even though root changelog maintenance lagged. | Tags are linear: `v1.2.4`, `v1.2.5`, `v1.2.6`, `v1.2.7`. Release-note chain is intact via `docs/releases/v1.2.5.md:9-13`, `v1.2.6.md:9-10`, `v1.2.7.md:9-10`, each linking previous stable. | High |

## Notes

- Primary release blocker: `pack:check` failure reason is `Required package content missing from npm pack output: dist/`.
- Docs drift count in this audit: 5 material drifts (`AGENTS.md` metadata, `AGENTS.md` release-era framing, stale test scale, frozen root changelog, stale `SECURITY.md` Hono version note).
- CI workflow count in this audit: 4 (`ci.yml`, `pr-ci.yml`, `codex-plugin-scanner.yml`, `codeql.yml`).
| LM-01 | HIGH | `npm run pack:check` FAILS exit=1 on current HEAD — pack budget violation; published tarball likely includes unintended files | `docs/audits/evidence/pack-check.txt` exit=1 | confirmed |
| LM-02 | HIGH | AGENTS.md stale across 4 axes: claims v0.1.x / Commit 9ac8a84 / Generated 2026-03-01 / "87 files, 2071 tests" — reality: v1.2.7 / HEAD 1f6da97 / 225 test files / 3418 tests (2.6×) | `AGENTS.md` §OVERVIEW vs `docs/audits/evidence/context.txt` | confirmed |
| LM-03 | MEDIUM | 4 CI workflows present: `ci.yml`, `pr-ci.yml`, `codex-plugin-scanner.yml`, `codeql.yml` — good security posture (CodeQL + plugin scanner) | context.txt | confirmed |
| LM-04 | LOW | `npm run audit:ci` PASSES — no HIGH/CRITICAL CVEs in current dep tree | `audit-ci.txt` exit=0 | confirmed |
| LM-05 | LOW | `npm run vendor:verify` PASSES — vendored `codex-ai-plugin` / `codex-ai-sdk` integrity intact | `vendor-verify.txt` exit=0 | confirmed |
| LM-06 | MEDIUM | `clean:repo:check` PASSES but 6 tmp files at repo root — pattern may be allowlisted, but real test-leakage exists (cross-ref E-02, JN-09) | `clean-repo-check.txt`, repo root listing | confirmed |
| LM-07 | MEDIUM | CHANGELOG drift check incomplete — v1.2.5/6/7 entries exist; full `git log v1.2.4..HEAD` cross-ref not completed by agent | `CHANGELOG.md`, `docs/releases/v1.2.x.md`, `git-forensics.txt` | probable |
| LM-08 | LOW | Governance files present: SECURITY.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md, LICENSE — OSS readiness good | `docs/README.md` Governance + repo root | confirmed |
| LM-09 | LOW | Recent security-dep bumps at HEAD (hono 4.12.14, vite ^7.3.2) — active security maintenance | `git log` recent commits; `git-forensics.txt` | confirmed |
| LM-10 | MEDIUM | Semver over v1.2.4–v1.2.7: minor/patch only, no 2.x breaking — install stability good; need cross-ref to verify no silent breaking behaviors in minors | `docs/releases/v1.2.*.md` | probable |
| LM-11 | LOW | README structural quality strong — <details> sections, tables, Quick Start, 60s-recovery, Command Toolkit by Start/Daily/Repair/Advanced, Dashboard Hotkeys, Storage Paths, Configuration env table | README.md | confirmed |
| LM-12 | HIGH | Docs-to-code drift (cross-ref C-AUTH-03): docs claim canonical redirect `127.0.0.1:1455`; code uses `localhost:1455` | `lib/auth/auth.ts:12`, `docs/reference/commands.md:84,98`, CHANGELOG | confirmed |

## Verdicts
- **Release blocker**: LM-01 pack:check fail must be fixed before next release
- **Docs truth-up**: LM-02 AGENTS.md + LM-12 redirect drift must be corrected
- **Overall OSS health**: STRONG — governance, active security maintenance, clean CI, clean audit:ci
- **Preserve**: CodeQL scanning, dep scanner workflow, security bump cadence
