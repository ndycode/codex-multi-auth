# CLI/UI Deepsearch Audit

Date: 2026-02-27  
Scope: `index.ts`, `lib/**`, `test/**`, `docs/**` (excluding `dist/**`)

## Objective

Capture a comprehensive map of implemented CLI/UI behavior, highlight useful advanced capabilities, and identify actionable gaps while refactoring settings UX.

## Method

- Searched command and feature surfaces across `index.ts`, `lib/codex-manager.ts`, and `lib/codex-manager/settings-hub.ts`.
- Cross-checked with test coverage in `test/codex-manager-cli.test.ts` and related suites.
- Scanned for unresolved implementation markers (`TODO`, `FIXME`, `HACK`, `XXX`) in source paths.

## High-Value Features Confirmed

- Unified interactive settings hub covering:
  - account list rendering and sort/layout behavior
  - summary row field ordering and visibility
  - return timing + quota refresh behavior
  - theme palette/accent preview and persistence
  - advanced backend controls (sync, retry, quota thresholds, timeouts, recovery)
- Per-project account storage toggle (`perProjectAccounts`) with scoped path routing.
- Session resilience controls (`sessionRecovery`, `autoResume`) integrated with runtime recovery hooks.
- Quota-aware behavior:
  - cached quota snapshots
  - live quota probing
  - quota-based forecast/report/fix flows
  - preemptive quota scheduler and deferral support
- Account health safeguards:
  - circuit breaker support
  - rate-limit reason handling
  - hybrid account selection using health + token buckets.

## UX/Behavior Findings Applied In This Refactor

- `Q` in settings sub-panels now consistently cancels/backs out without saving draft changes.
- Draft-saving side effects on each toggle were removed from settings loops.
- Theme preview keeps live feedback while restoring baseline theme on cancel.
- Help copy and command reference were updated to match the new `Q` semantics.

## Upgrade Notes

- User-visible change: `Q` in settings sub-panels is now `cancel/back` and does not save draft changes.
- Migration/update action: users who previously relied on `Q` to save must use `S` to save before exiting each settings panel.
- Regression reference: the no-save-on-cancel contract is covered in `test/codex-manager-cli.test.ts` (cancel-path regression test).

## NPM Scripts Impact

- None. No new npm scripts were added, removed, or renamed.
- Existing validation flow remains unchanged: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

## Test Coverage Notes

- Existing integration-style CLI settings test already validates multi-section persistence paths.
- Added regression coverage proving `Q` cancel discards modified drafts across account-list, summary-fields, behavior, theme, and backend flows without persisting dashboard/backend settings.

## Search Findings

- No unresolved `TODO`/`FIXME` markers were found in primary runtime source paths (`index.ts`, `lib/**`, `test/**`).
- Non-runtime benchmark artifacts contain `TODO` text as fixture content (`bench/**`, `scripts/bench-format/**`), not production debt.

## Follow-Up Opportunities

- Split additional settings-specific helpers from `lib/codex-manager.ts` to continue reducing file size and ownership overlap.
- Add focused unit tests for `settings-hub.ts` actions (`onInput` mappings, category transitions, numeric clamping) to reduce reliance on broad CLI integration tests.
- Add a short architecture note linking `codex-manager.ts` to `settings-hub.ts` for future contributors.
