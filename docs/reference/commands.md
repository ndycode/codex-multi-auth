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

## Primary Commands

| Command | Description |
| --- | --- |
| `codex auth login` | Open interactive auth dashboard, including login, restore, settings, and dashboard paths and links to diagnostics commands |
| `codex auth list` | List saved accounts and active account |
| `codex auth status` | Print short runtime/account summary |
| `codex auth switch <index>` | Set active account by index |
| `codex auth check` | Run quick account health check |
| `codex auth features` | Print implemented feature summary |
| `codex auth restore-backup` | Open the backup restore picker directly |

---

## Advanced Commands

| Command | Description |
| --- | --- |
| `codex auth verify-flagged` | Verify flagged accounts and optionally restore healthy accounts |
| `codex auth forecast` | Forecast best account by readiness/risk |
| `codex auth report` | Generate full health report |
| `codex auth fix` | Apply safe account storage fixes |
| `codex auth doctor` | Run diagnostics and optional repairs |

---

## Common Flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--json` | verify-flagged, forecast, report, fix, doctor | Print machine-readable output |
| `--live` | forecast, report, fix | Use live probe before decisions/output |
| `--dry-run` | verify-flagged, fix, doctor | Preview without writing storage |
| `--model <model>` | forecast, report, fix | Specify model for live probe paths |
| `--out <path>` | report | Write report output to file |
| `--fix` | doctor | Apply safe repairs |
| `--no-restore` | verify-flagged | Verify only; do not restore healthy flagged accounts |

---

## Compatibility and Non-TTY Behavior

- `codex` remains the primary wrapper entrypoint. It routes `codex auth ...` and the compatibility aliases to the multi-auth runtime, and forwards every other command to the official `@openai/codex` CLI.
- In non-TTY or host-managed sessions, including `CODEX_TUI=1`, `CODEX_DESKTOP=1`, `TERM_PROGRAM=codex`, or `ELECTRON_RUN_AS_NODE=1`, auth flows degrade to deterministic text behavior.
- The non-TTY fallback keeps `codex auth login` predictable: it defaults to add-account mode, skips the extra "add another account" prompt, and auto-picks the default workspace selection when a follow-up choice is needed.

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

- List Appearance: `Enter Toggle | Number Toggle | M Sort | L Layout | S Save | Q Back (No Save)`
- Details Line: `Enter Toggle | 1-3 Toggle | [ ] Reorder | S Save | Q Back (No Save)`
- Results & Refresh: `Enter Select | 1-3 Delay | P Pause | L AutoFetch | F Status | T TTL | S Save | Q Back (No Save)`
- Colors: `Enter Select | 1-2 Base | S Save | Q Back (No Save)`
- Advanced Backend Controls: `Enter Open | 1-4 Category | S Save | R Reset | Q Back (No Save)`

---

## Workflow Packs

Interactive dashboard workflows:

- Backup restore: `codex auth login` -> `Restore From Backup`
- Startup recovery prompt: interactive `codex auth login` TTY flow only, then confirm restore when recoverable named backups are found before OAuth
- Sync preview and apply: `codex auth login` -> `Settings` -> `Codex CLI Sync`
- Stable settings path: `codex auth login` -> `Settings` -> `Everyday Settings`
- Advanced settings path: `codex auth login` -> `Settings` -> `Advanced & Operator`

---

Health and planning:

```bash
codex auth check
codex auth forecast --live --model gpt-5-codex
codex auth report --live --json
```

Repair and recovery:

```bash
codex auth restore-backup
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
