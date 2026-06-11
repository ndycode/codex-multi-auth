# SwiftBar Quota Plugin (macOS)

A menu bar widget for [SwiftBar](https://github.com/swiftbar/SwiftBar) that shows
per-account Codex quota from the local codex-multi-auth cache.

```text
⚡88·[90]          ← menu bar title: 5h-window remaining % per account,
                     brackets mark the account currently serving requests
```

Opening the menu renders one card per managed account:

```text
╭──────────────────────────────────╮
│ ● account-a               ACTIVE │
│ 5h █████████░   88%  → 4h 42m    │
│ 7d ████████░░   83%  → 6d 18h    │
╰──────────────────────────────────╯
╭──────────────────────────────────╮
│ ○ account-b                 IDLE │
│ 5h █████████░   90%  → 4h 33m    │
│ 7d █████████░   86%  → 8h 16m    │
╰──────────────────────────────────╯
```

- Green card / `●` / `ACTIVE`: the account the runtime rotation router last
  served a request with (falls back to the stored active index).
- `5h` / `7d`: the two Codex quota windows — bar, remaining percent, and a
  countdown to the window reset (`4h 42m` style).
- Rows turn orange below 30% remaining and red below 10%.

## Install

```bash
brew install --cask swiftbar          # if not installed
mkdir -p ~/.swiftbar-plugins
cp contrib/swiftbar/codex-quota.5m.sh ~/.swiftbar-plugins/
chmod +x ~/.swiftbar-plugins/codex-quota.5m.sh
open -a SwiftBar                      # pick ~/.swiftbar-plugins as the plugin folder
```

## Data source and refresh model

The plugin reads the local quota cache (`quota-cache.json`), account store, and
runtime observability files under `~/.codex/multi-auth/` (or
`CODEX_MULTI_AUTH_DIR`). Reading the cache costs **zero quota**: the cache is
updated passively from the rate-limit headers of real Codex traffic flowing
through the rotation proxy, and by explicit live checks.

- The `5m` in the filename is SwiftBar's re-read interval (cache only).
- The menu re-reads the cache every time it is opened (`refreshOnOpen`).
- **Live refresh** in the menu runs `codex-multi-auth check`, which sends one
  minimal probe per account and consumes a small amount of quota.

## Notes

- macOS only (SwiftBar). Card borders require a Menlo-native glyph set; if you
  edit the card interior, avoid CJK or emoji — they render in a fallback font
  with non-integer widths and break the right border alignment.
- The cache file formats are internal to codex-multi-auth and may change
  between versions; the plugin fails soft (shows `⚡?`) when they do.
- Account names shown are the local-part of each account email.
