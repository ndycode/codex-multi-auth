# TUI Parity Checklist

Checklist for keeping the auth dashboard consistent, beginner-friendly, and predictable.

* * *

## UX Target

1. New users can complete add/check/switch without docs.
2. Focus and key behavior are stable across all menus.
3. Action feedback is clear and non-duplicative.
4. Colors and labels are consistent across screens.

* * *

## Main Dashboard Structure

Required sections:

1. Quick Actions
2. Advanced Checks
3. Saved Accounts
4. Danger Zone

Required action set:

- Add New Account
- Run Health Check
- Pick Best Account
- Auto-Repair Issues
- Settings
- Refresh/Verify problem accounts

* * *

## Account Row Behavior

Each row should support:

- account identity (email/name)
- optional status/current badges
- last-used summary
- quota summary bars (5h/7d)
- optional cooldown text
- clear selected-row highlight

No duplicate focus indicators should be rendered.

* * *

## Keyboard Behavior

Main menu minimum:

- `Up/Down`
- `Enter`
- `Q`
- `/` search
- `?` help
- `1-9` quick switch

Account detail minimum:

- `S` set current
- `R` refresh login
- `E` enable/disable
- `D` delete
- `Q` back

Settings screens:

- stable focus after toggle
- no cursor reset on simple update
- save/back behavior deterministic

* * *

## Auth Flow Parity

Add-account flow must support:

1. Browser-first OAuth.
2. Manual/incognito callback paste flow.
3. Safe cancel path returning to menu.
4. No unhandled abort/CTRL+C stack traces in normal cancel behavior.

* * *

## Result Screen Quality

1. No duplicated "Press Enter" lines.
2. No stale text remnants after transitions.
3. Auto-return messaging should not block user control.
4. Errors should be normalized and readable.

* * *

## Data/Runtime Parity

1. Displayed account state matches storage and active selection.
2. Smart sort matches configured mode.
3. Quick-switch follows configured row-index policy.
4. Auto-fetch status is visible when running.

* * *

## Release Checklist

Before release:

1. Walk all menu paths manually.
2. Validate hotkeys in terminal variants.
3. Check color/focus consistency across all result screens.
4. Ensure settings persist and reload correctly.
5. Confirm command aliases still route correctly.

* * *

## Non-Goals

- Perfect clone of official Codex UI internals.
- Terminal feature parity beyond supported input/color modes.
