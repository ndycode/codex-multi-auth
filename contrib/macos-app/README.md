# Native Menu Bar App (macOS)

A native SwiftUI menu bar app showing per-account Codex quota from the local
codex-multi-auth cache. It is an alternative to the SwiftBar plugin in
`contrib/swiftbar/` with one key advantage: **it refreshes live while the
panel is open.**

```text
menu bar:  ⚡68%        ← active account's 5h-window remaining

panel (click to open):
┌─────────────────────────────┐
│ ● account-a          ACTIVE │
│ 5h ▓▓▓▓▓▓▓▓░  68%     4h 24m │
│ 7d ▓▓▓▓▓▓▓▓░  79%     6d 18h │
├─────────────────────────────┤
│ ○ account-b            IDLE │
│ 5h ▓▓▓▓▓▓▓▓▓  90%     4h 14m │
│ 7d ▓▓▓▓▓▓▓▓▓  86%     7h 58m │
├─────────────────────────────┤
│ updating…          [Refresh]│
└─────────────────────────────┘
```

## Why a native app (vs. the SwiftBar plugin)

SwiftBar/xbar render the dropdown as an `NSMenu`. macOS does not repaint an
`NSMenu` while it is held open (menu tracking mode), so a probe triggered on
open cannot visibly update the panel — you have to close and reopen to see new
numbers.

This app uses SwiftUI `MenuBarExtra` with `.menuBarExtraStyle(.window)`, which
renders the panel as a regular window. On open it shows cached values instantly,
kicks off a background `codex-multi-auth check`, and updates the cards **in
place** when the probe returns — no reopen needed.

## Behavior

- **Menu bar title**: `⚡<n>%` — the active account's 5h-window remaining
  percent (active account resolved from runtime observability, falling back to
  the stored active index). Refreshes from cache on a timer.
- **On open**: renders the cache immediately, then runs one live
  `codex-multi-auth check` if the cache is older than 60s, updating live.
- **Refresh button**: forces a live check on demand.
- Reading the cache costs no quota; the live check sends one minimal probe per
  account. Rows turn orange below 30% remaining and red below 10%.

## Requirements

- macOS 13 (Ventura) or newer
- Swift toolchain — Xcode or the Command Line Tools (`xcode-select --install`)
- `codex-multi-auth` on `PATH`

## Build & install

```bash
contrib/macos-app/build.sh            # compiles and installs ~/Applications/CodexQuota.app
open ~/Applications/CodexQuota.app    # launch
```

The build shells out to `swiftc` and assembles a minimal `.app` bundle (no
Xcode project). The bundle is ad-hoc signed so Gatekeeper allows the
locally-built binary to run.

### Autostart at login (optional)

```bash
sed "s|HOME_PLACEHOLDER|$HOME|" contrib/macos-app/local.codex.quota.plist \
  > ~/Library/LaunchAgents/local.codex.quota.plist
launchctl load ~/Library/LaunchAgents/local.codex.quota.plist
```

> If you override `CODEX_MULTI_AUTH_DIR` in your shell profile, note that
> LaunchAgents don't source shell profiles. Uncomment the
> `EnvironmentVariables` block in the plist and set the path explicitly,
> otherwise autostart falls back to `~/.codex/multi-auth`.

## Notes

- Data source is the same local files as the SwiftBar plugin: `quota-cache.json`,
  `openai-codex-accounts.json`, and `runtime-observability.json` under
  `~/.codex/multi-auth/` (honors `CODEX_MULTI_AUTH_DIR`).
- The cache formats are internal to codex-multi-auth and may change between
  versions; the app fails soft (`⚡?`) when fields are missing.
- `contrib/` is outside the npm `files` whitelist, so the published package is
  unchanged.
