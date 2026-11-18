# Documentation Style Guide

Style contract for all docs in this repository. Enforcement is partially executable — `test/documentation.test.ts` pins naming scopes, required literals, and link integrity.

---

## Goals

1. Fast onboarding for first-time operators.
2. Precise references for maintainers and automation users.
3. Stable wording for commands, flags, paths, and version policy.
4. Consistent structure across user and maintainer docs.
5. High-confidence discoverability without keyword stuffing or unsupported ranking claims.

---

## Page Template

User-facing docs should generally follow:

1. Title and one-line lead.
2. Quick path commands.
3. Core operational workflow.
4. Troubleshooting or failure handling.
5. Related links.

Use short sections and scan-friendly tables where they improve clarity. Simple ASCII diagrams are welcome for request/storage flows — keep them inside fenced `text` blocks.

---

## Writing Rules

1. Prefer direct, actionable language.
2. Use runnable command examples.
3. Explain expected outcomes after critical commands.
4. Keep terminology consistent with runtime names (`runtime-rotation proxy`, `shadow CODEX_HOME`, `managed account`, `evaluateRuntimePolicy`).
5. Avoid speculative language when behavior is deterministic; mark advisory/best-effort behavior (budgets, capability suppression) explicitly instead of overstating guarantees.
6. Put the user problem in the first paragraph before implementation detail.
7. Cite real module paths (`lib/runtime-rotation-proxy.ts`) in maintainer docs so claims stay greppable.

---

## Discoverability Rules

1. Root README and docs landing pages should naturally include `Codex CLI`, `multi-account OAuth`, `account switching`, `health checks`, `runtime rotation`, `diagnostics`, and `recovery` when those topics are in scope.
2. Use descriptive page titles such as `codex-multi-auth Features` instead of generic titles on public docs.
3. Do not promise search rankings. Improve discoverability through accurate titles, first paragraphs, package metadata, internal links, and GitHub topics.
4. Do not repeat keyword lists in every section. Search terms should appear only where they help a developer understand the page.
5. Keep the repository description, package description, README lead, and `docs/development/GITHUB_DISCOVERABILITY.md` aligned.

---

## Command and Path Rules

1. Canonical command family is `codex-multi-auth ...` — always as one hyphenated word, in prose and in examples.
2. Canonical runtime root is `~/.codex/multi-auth`.
3. Runtime rotation must be described as default-on unless the release policy changes.
4. Legacy command/path references belong only in migration contexts.
5. Compatibility aliases (spelled-out or variant-hyphenated forms of the command) belong only in `docs/reference/commands.md`, `docs/troubleshooting.md`, and `docs/upgrade.md` — the test suite fails any other doc that contains them.
6. Keep command flags aligned with runtime usage text (`lib/codex-manager/help.ts`).
7. The scoped package name appears only in explicit legacy migration notes (`README.md`, `getting-started.md`, `troubleshooting.md`, `upgrade.md`, and the two `v0.1.0*` release docs).

---

## Maintainer Rules

1. Behavior changes must update docs and tests together.
2. New flags/settings/paths must be reflected in `docs/reference/*`.
3. New environment variables documented in `docs/development/CONFIG_FIELDS.md` or `docs/reference/settings.md` must exist in `lib/`/`scripts/`/`index.ts` — the test suite extracts every backticked `CODEX_*`/`MCODEX_*`/`OC_*` name and checks it against source.
4. Migration-impacting changes must update `docs/upgrade.md`.
5. Governance-impacting changes must review `SECURITY.md` and `CONTRIBUTING.md`.
6. Keep PR/issue templates aligned with validation gates.
7. Historical snapshots (`docs/releases/`, `docs/audits/`, `docs/development/implementation-plans/`, `docs/design/`) are append-only; correct them with new artifacts, not rewrites.

---

## Anti-Patterns

Avoid:

- non-runnable command snippets
- conflicting path guidance across docs
- legacy-first onboarding language
- undocumented behavior drift between runtime and docs
- absolute claims about advisory behavior (budgets overshoot under concurrency; say so)
- naming the package or command in any form besides `codex-multi-auth` outside the allowed alias/legacy scopes above
