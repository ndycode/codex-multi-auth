# Command Reference

Complete command, flag, and hotkey reference for `codex-multi-auth`.

---

## Canonical Command Family

Primary operations use `codex auth ...`.

Compatibility aliases are supported:

- `codex multi auth ...`
- `codex multi-auth ...`
- `codex multiauth ...`

---

## Start Here

| Command | Description |
| --- | --- |
| `codex auth login` | Open interactive auth dashboard |
| `codex auth status` | Print short runtime/account summary |
| `codex auth check` | Run quick account health check |

---

## Daily Use

| Command | Description |
| --- | --- |
| `codex auth list` | List saved accounts and active account |
| `codex auth switch <index>` | Set active account by index |
| `codex auth forecast` | Forecast best account by readiness/risk |
| `codex auth best` | Pick and optionally sync the best account |

---

## Repair

| Command | Description |
| --- | --- |
| `codex auth verify-flagged` | Verify flagged accounts and optionally restore healthy accounts |
| `codex auth fix` | Apply safe account storage fixes |
| `codex auth doctor` | Run diagnostics and optional repairs |
| `codex auth config explain` | Print effective config values and their sources |
| `codex auth init-config [modern|legacy|minimal]` | Print a starter config template |
| `codex auth debug bundle` | Print a bundled runtime/debug snapshot |

---

## Advanced

| Command | Description |
| --- | --- |
| `codex auth features` | Print implemented feature summary |
| `codex auth report` | Generate full health report |

---

## Common Flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--manual`, `--no-browser` | login | Skip browser launch and use manual callback flow |
| `--json` | verify-flagged, best, forecast, report, fix, doctor, config explain, debug bundle | Print machine-readable output |
| `--explain` | forecast, report | Include reasoning details (forecast text/JSON, report text) |
| `--live` | best, forecast, report, fix | Use live probe before decisions/output |
| `--dry-run` | verify-flagged, fix, doctor | Preview without writing storage |
| `--model <model>` | best, forecast, report, fix | Specify model for live probe paths |
| `--out <path>` | report | Write report output to file |
| `--write <path>` | init-config, config template | Write template output to a file instead of stdout |
| `--fix` | doctor | Apply safe repairs |
| `--no-restore` | verify-flagged | Verify only; do not restore healthy flagged accounts |

---

## Upgrade Notes

- `codex auth login` remains browser-first by default.
- `codex auth login --manual` and `codex auth login --no-browser` force the manual callback flow instead of launching a browser.
- `CODEX_AUTH_NO_BROWSER=1` suppresses browser launch for automation/headless sessions. False-like values such as `0` and `false` do not disable browser launch by themselves.
- In non-TTY/manual shells, pass the full redirect URL on stdin, for example: `echo "http://127.0.0.1:1455/auth/callback?code=..." | codex auth login --manual`.
- `codex auth forecast --explain` now keeps the explain breakdown visible in text mode even when dashboard settings hide recommendation summary lines. Pair it with `--json` for machine-readable reasoning snapshots.
- No new npm scripts or storage migration steps were introduced for this auth-flow update.

---

## Compatibility and Non-TTY Behavior

- `codex` remains the primary wrapper entrypoint. It routes `codex auth ...` and the compatibility aliases to the multi-auth runtime, and forwards every other command to the official `@openai/codex` CLI.
- `codex --version` reports the official `@openai/codex` CLI version.
- `codex-multi-auth --version` and `codex-multi-auth -v` report the installed wrapper package version.
- In non-TTY or host-managed sessions, including `CODEX_TUI=1`, `CODEX_DESKTOP=1`, `TERM_PROGRAM=codex`, or `ELECTRON_RUN_AS_NODE=1`, auth flows degrade to deterministic text behavior.
- The non-TTY fallback keeps `codex auth login` predictable: it defaults to add-account mode, skips the extra "add another account" prompt, and auto-picks the default workspace selection when a follow-up choice is needed.
- `codex auth login --manual` keeps the login flow usable in browser-restricted shells by printing the OAuth URL and accepting manual callback input instead of trying to open a browser.
- In non-TTY/manual shells, provide the full redirect URL on stdin, for example: `echo "http://127.0.0.1:1455/auth/callback?code=..." | codex auth login --manual`.

---

## Dashboard Hotkeys

### Main Dashboard

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move selection |
| `Enter` | Select/open |
| `1-9` | Quick switch visible/source account |
| `/` | Search accounts |
| `?` | Toggle help |
| `Q` | Back/cancel |

### Account Details

| Key | Action |
| --- | --- |
| `S` | Set current account |
| `R` | Refresh/re-login account |
| `E` | Enable/disable account |
| `D` | Delete account |
| `Q` | Back |

### Settings Screens

Settings screen hotkeys are panel-specific:

- Account List View: `Enter Toggle | Number Toggle | M Sort | L Layout | S Save | Q Back (No Save)`
- Summary Line: `Enter Toggle | 1-3 Toggle | [ ] Reorder | S Save | Q Back (No Save)`
- Menu Behavior: `Enter Select | 1-3 Delay | P Pause | L AutoFetch | F Status | T TTL | S Save | Q Back (No Save)`
- Color Theme: `Enter Select | 1-2 Base | S Save | Q Back (No Save)`
- Backend Controls: `Enter Open | 1-4 Category | S Save | R Reset | Q Back (No Save)`

---

## Workflow Packs

Health and planning:

```bash
codex auth check
codex auth forecast --live --explain --model gpt-5-codex
codex auth report --live --json
```

Repair and recovery:

```bash
codex auth fix --dry-run
codex auth fix --live --model gpt-5-codex
codex auth doctor --fix
```

---

## Related

- [../features.md](../features.md)
- [public-api.md](public-api.md)
- [error-contracts.md](error-contracts.md)
- [settings.md](settings.md)
- [../troubleshooting.md](../troubleshooting.md)
