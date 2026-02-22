# TUI Parity Checklist (Codex Multi-Auth)

Use this checklist to keep `codex-multi-auth` aligned with the Antigravity-style auth TUI pattern, while preserving Codex-specific logic and storage behavior.

## Scope

- Match interaction shape and operator experience.
- Do not copy provider-specific business logic from Antigravity.
- Keep Codex storage/auth semantics as source of truth.

## Menu Structure Parity

- `opencode auth login` -> provider -> login method -> account dashboard.
- Dashboard sections exist in this order:
  - `Actions`
  - `Accounts`
  - `Danger zone`
- Core actions visible:
  - `Add account`
  - `Check quotas`
  - `Deep probe accounts`
  - `Verify flagged accounts`
  - `Start fresh`
  - `Delete all accounts`
- Account row format includes:
  - numeric index
  - account label/email
  - state badges (`[current]`, `[active]`, `[ok]`, `[rate-limited]`, `[disabled]`, `[flagged]`)
  - usage hint (`used today`, `used yesterday`, etc.)

## Keyboard and Navigation Parity

- `Up/Down` moves selection.
- `Enter` confirms selected item.
- `Esc` returns/back/cancel.
- Ctrl+C exits gracefully without corrupting terminal state.
- Cursor visibility restored on exit from menu.

## Account Detail Menu Parity

- Selecting an account opens account detail actions:
  - `Enable/Disable account`
  - `Refresh account` (re-auth that account)
  - `Delete this account`
  - `Back`
- Destructive actions require confirmation.
- `Delete all accounts` requires explicit typed confirmation (`DELETE`).

## Health/Quota Check Parity

- `Check quotas` scans all active accounts and prints per-account results.
- `Deep probe` performs stricter validation and surfaces richer diagnostic output.
- Output includes index progress (`[i/N]`) and per-account status (`OK`, `ERROR`, `DISABLED`).
- Summary line always shown at end (`ok/error/disabled` counts).

## Flagged/Disabled State Parity

- Invalid-refresh accounts are moved to flagged storage.
- `Verify flagged accounts` can restore accounts that refresh successfully.
- Disabled accounts remain visible but are skipped from active rotation and health execution paths.
- Account manager never selects disabled accounts as current/next candidate.

## Persistence and Cache Behavior

- Storage writes occur after:
  - account add/update/delete
  - enable/disable toggle
  - flagged pool migration/restore
- In-memory account manager caches are invalidated after any account pool mutation.
- Import flow invalidates both cached manager object and pending manager promise.

## V2 Rollout Controls

- Default behavior: Codex-style TUI is enabled.
- Opt-out is supported through config/env:
  - `codexTuiV2: false`
  - `CODEX_TUI_V2=0`
- Visual controls:
  - `codexTuiColorProfile`: `truecolor` / `ansi256` / `ansi16`
  - `codexTuiGlyphMode`: `ascii` / `unicode` / `auto`

## Tooling Parity

- `codex-list` reflects account states and active selection.
- `codex-status` shows per-family active index and account-level state details.
- `codex-import` and `codex-export` remain compatible with multi-account storage.

## Verification Checklist (Before Release)

- `npm run -s typecheck` passes.
- `npm test` passes.
- Manual smoke run:
  - login -> dashboard appears
  - add account works
  - check quotas runs and summarizes
  - disable account prevents rotation to it
  - verify flagged restores a recoverable account
  - delete-all requires typed confirmation and clears active + flagged pools

## Non-Goals

- Replicating Antigravity Google token semantics.
- Sharing storage files with unrelated plugins.
- Editing Antigravity repo files as part of Codex plugin maintenance.
