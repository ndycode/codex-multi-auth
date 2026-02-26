# TUI Parity Checklist

Checklist for auth dashboard behavior and keyboard ergonomics.

## Target UX

`codex auth login` should open one interactive dashboard with clear sections and beginner defaults.

## Menu Structure

Expected top-level sections in order:

1. `Quick Start`
2. `Advanced Checks`
3. `Accounts`
4. `Danger zone`

Expected core actions:

- `Add account (OAuth login)`
- `Quick check account health (recommended)`
- `Forecast best account`
- `Auto-fix common issues (safe mode)`
- `Verify all accounts (full refresh test)`
- `Verify flagged accounts`
- `Delete all accounts`

## Account Row Expectations

Each row should show:

- numeric index
- account email/label
- optional `[current]`
- status badge (`active`, `ok`, `rate-limited`, `cooldown`, `disabled`, `flagged`, `error`, `unknown`)
- usage hint (`used today`, `used yesterday`, etc.)

## Keyboard Behavior

Global (auth dashboard):

- `Up/Down`: move
- `Enter`: confirm
- `Esc`/`Q`: cancel/back
- `H`/`?`: toggle help text
- `/`: search prompt
- `1-9`: set selected account as current directly

Action hotkeys (auth dashboard):

- `A`: add account
- `C`: quick check
- `P`: forecast
- `X`: auto-fix
- `V`: verify all
- `G` or `F`: verify flagged

Account detail hotkeys (account screen):

- `S`: set current
- `R`: refresh account
- `E`: enable/disable
- `D`: delete account

## Safety and Confirmation

- Deleting one account requires confirm.
- Refreshing one account requires confirm.
- `Delete all accounts` requires typed confirmation: `DELETE`.
- Ctrl+C should exit cleanly and restore terminal state.

## Data and Runtime Parity

- Any account mutation writes storage immediately.
- Active index and per-family indices stay valid after changes.
- Cache/manager reload occurs after storage mutation.
- Live account sync should keep long-running sessions updated.

## Release Checklist

- `npm run typecheck`
- `npm test`
- Manual smoke:
  - login/add account
  - set current via number hotkey
  - run check/forecast/fix from hotkeys
  - enable/disable and verify rotation impact
  - delete-all confirmation gate works

## Non-Goals

- Reintroducing provider-specific OpenCode auth menus.
- Vim-style keybinding complexity.
