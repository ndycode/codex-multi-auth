# Refactor Review Program

Reviewer-first execution plan for breaking down the large runtime surfaces without mixing architecture changes, behavior changes, and operational hardening in the same pull request.

* * *

## Working Rules

1. Use one isolated worktree for the full campaign.
2. Create one branch per pull request inside that worktree.
3. Rebase each branch on current `main` before opening the next pull request.
4. Keep extraction pull requests behavior-preserving unless a blocking bug forces a follow-up patch.
5. Preserve stable facades while internals move:
   - `index.ts`
   - `lib/codex-manager.ts`
   - `lib/storage.ts`
   - `lib/index.ts`
6. Do not combine code motion with policy changes, command-surface changes, or publish-surface changes.

* * *

## Review Standards

- One architectural question per pull request.
- Prefer file extraction and import rewiring over broad rewrites.
- Avoid style-only churn outside touched files.
- Avoid speculative helpers that do not yet have a second caller.
- Keep pull request descriptions literal and short.
- Call out what intentionally did not change.

* * *

## Pull Request Train

### PR0: guardrails-and-runbooks

Goal: raise confidence before moving large files.

Scope:

- add black-box characterization tests around the runtime entry path in `index.ts`
- add stronger command-dispatch coverage around `lib/codex-manager.ts`
- add broader recovery and persistence coverage around `lib/storage.ts`
- add maintainer runbooks for:
  - adding a new auth or manager command
  - adding a new config field safely
  - changing routing or account-selection policy safely

Do not include:

- file extraction
- command changes
- config surface changes
- CI policy changes

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm test -- test/index.test.ts test/index-retry.test.ts test/codex-manager-cli.test.ts test/storage.test.ts test/storage-async.test.ts test/storage-recovery-paths.test.ts test/paths.test.ts`
- `npm test -- test/documentation.test.ts`

Acceptance:

- reviewers can point to explicit regression coverage for runtime, manager, and storage before any structural move lands

### PR1: manager-command-split

Goal: split command handlers out of `lib/codex-manager.ts` while keeping the current CLI facade stable.

Target structure:

- `lib/codex-manager/commands/login.ts`
- `lib/codex-manager/commands/check.ts`
- `lib/codex-manager/commands/forecast.ts`
- `lib/codex-manager/commands/report.ts`
- `lib/codex-manager/commands/fix.ts`
- `lib/codex-manager/commands/doctor.ts`

Scope:

- extract command-specific logic into dedicated modules
- keep argument parsing and exported CLI entry in `lib/codex-manager.ts`
- introduce small shared command types only when needed by two or more handlers

Do not include:

- settings-hub moves
- new command behavior
- storage refactors

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm test -- test/codex-manager-cli.test.ts test/documentation.test.ts`

Acceptance:

- command dispatch remains stable
- reviewers can diff old command bodies against new handler modules without tracing unrelated UI code

### PR2: settings-screen-split

Goal: split `lib/codex-manager/settings-hub.ts` by screen and support service.

Target structure:

- `lib/codex-manager/screens/dashboard.ts`
- `lib/codex-manager/screens/settings/account-list.ts`
- `lib/codex-manager/screens/settings/summary-line.ts`
- `lib/codex-manager/screens/settings/menu-behavior.ts`
- `lib/codex-manager/screens/settings/theme.ts`
- `lib/codex-manager/screens/settings/backend-controls.ts`
- `lib/codex-manager/state/*`
- `lib/codex-manager/io/*`

Scope:

- extract panel controllers and supporting state
- isolate IO concerns such as prompts, terminal writes, clipboard, and browser helpers
- keep current hotkeys, cancel semantics, and save semantics unchanged

Do not include:

- new settings
- new visual behavior
- manager command changes

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm test -- test/codex-manager-cli.test.ts test/cli-auth-menu.test.ts test/auth-menu-hotkeys.test.ts test/ui-runtime.test.ts test/ui-theme.test.ts`

Acceptance:

- each settings panel is reviewable in isolation
- current interactive behavior remains stable under existing tests

### PR3: storage-subsystem-split

Goal: split `lib/storage.ts` internally while preserving the current storage API and on-disk contracts.

Target structure:

- `lib/storage/repository.ts`
- `lib/storage/backups.ts`
- `lib/storage/restore.ts`
- `lib/storage/flags.ts`
- `lib/storage/locks.ts`

Scope:

- move file IO, backup rotation, restore helpers, and lock orchestration behind dedicated modules
- keep `lib/storage/paths.ts` and `lib/storage/migrations.ts` as existing specialization points
- keep `lib/storage.ts` as the stable facade during the release line

Do not include:

- storage format changes
- new backup commands
- selection-policy changes

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm test -- test/storage.test.ts test/storage-async.test.ts test/storage-recovery-paths.test.ts test/paths.test.ts test/runtime-paths.test.ts`

Acceptance:

- public storage behavior is unchanged
- backup, WAL, migration, and worktree identity tests remain green

### PR4: runtime-phase-extraction

Goal: reduce `index.ts` to wiring plus exported plugin class.

Target structure:

- `runtime/bootstrap.ts`
- `runtime/account-selection.ts`
- `runtime/request-pipeline.ts`
- `runtime/retry-and-failover.ts`
- `runtime/metrics.ts`
- `runtime/shutdown.ts`

Scope:

- extract explicit runtime phases from `index.ts`
- introduce a typed request context passed phase-to-phase
- keep request semantics stable by reusing the current helper modules under `lib/request/*`

Do not include:

- decision-trace feature work
- export-surface changes
- behavior tuning

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm test -- test/index.test.ts test/index-retry.test.ts test/fetch-helpers.test.ts test/request-transformer.test.ts test/response-handler.test.ts test/failure-policy.test.ts test/stream-failover.test.ts test/live-account-sync.test.ts test/session-affinity.test.ts test/proactive-refresh.test.ts`

Acceptance:

- `index.ts` is mostly composition
- runtime phases are named and individually testable

### PR5: decision-trace-and-explain

Goal: add explicit reasoning surfaces after runtime data flow is already structured.

Scope:

- add stable internal decision context data for model normalization, account selection, fast-session trimming, fallback, and failover
- add explain-mode plumbing for diagnostics-first surfaces before broad user-facing expansion

Do not include:

- policy rewrites
- command-surface redesign

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm test -- test/forecast.test.ts test/codex-routing.test.ts test/request-transformer.test.ts test/failure-policy.test.ts test/index.test.ts`

Acceptance:

- diagnostics answer why a request was shaped or rerouted, not only what happened

### PR6: export-governance

Goal: reduce accidental semver burden without breaking the current release line.

Scope:

- add conservative package subpath exports such as `./auth`, `./storage`, `./config`, `./request`, and `./cli`
- keep current root and barrel compatibility exports during the release line
- add API or export contract snapshots

Do not include:

- internal runtime refactors
- publish artifact cleanup beyond what is needed for export tests

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm test -- test/public-api-contract.test.ts test/documentation.test.ts`
- `npm run build`

Acceptance:

- supported public entrypoints are explicit
- compatibility exports remain available

### PR7: operator-hardening

Goal: land the noisy operational improvements after the architecture settles.

Scope:

- add `codex auth config explain`
- add `codex auth debug bundle`
- add config template initialization flow
- add Node 22 smoke coverage to PR CI
- add `npm pack --dry-run --json` publish-budget validation
- add vendored provenance manifest and verification command
- add script type-checking strategy for critical JS entry scripts

Do not include:

- more architectural extraction unless directly required by the new commands

Validation:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

Acceptance:

- operator diagnostics improve without muddying the core refactor train

* * *

## Review Heuristics

- Prefer pull requests that stay under roughly 500 changed lines unless most of the diff is obvious extraction.
- If a pull request needs both a move and a fix, split the fix unless the refactor is blocked without it.
- Keep new module names responsibility-based, not utility-based.
- Avoid repo-wide import churn until the end of the train.
- Write pull request titles as literal statements of the boundary that changed.

* * *

## Branch Naming

- `plan/refactor-review-program`
- `refactor/pr0-guardrails-and-runbooks`
- `refactor/pr1-manager-command-split`
- `refactor/pr2-settings-screen-split`
- `refactor/pr3-storage-subsystem-split`
- `refactor/pr4-runtime-phase-extraction`
- `refactor/pr5-decision-trace`
- `refactor/pr6-export-governance`
- `refactor/pr7-operator-hardening`

* * *

## Worktree Flow

1. Create the isolated worktree from `main`.
2. Cut one branch per pull request in that worktree.
3. Open the pull request.
4. Once it is merged or intentionally parked, rebase from current `main`.
5. Start the next branch in the same worktree.

This keeps filesystem state simple while still preserving reviewer-friendly pull request boundaries.
