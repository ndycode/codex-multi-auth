# Command Reference

Complete CLI and hotkey reference for `codex-multi-auth`.

---

## Canonical Command Family

Use `codex auth ...` for account operations.

Compatibility aliases:

- `codex multi auth ...`
- `codex multi-auth ...`
- `codex multiauth ...`

---

## Primary Commands

| Command | Description |
| --- | --- |
| `codex auth login` | Open interactive auth dashboard |
| `codex auth list` | List saved accounts and active account |
| `codex auth status` | Short status summary |
| `codex auth switch <index>` | Set active account by index |
| `codex auth check` | Run quick account health check |
| `codex auth features` | Print implemented feature list |

---

## Advanced Commands

| Command | Description |
| --- | --- |
| `codex auth verify-flagged` | Verify flagged accounts and optionally restore healthy ones |
| `codex auth forecast` | Forecast best account by readiness/risk |
| `codex auth report` | Generate full health report |
| `codex auth fix` | Apply safe account storage fixes |
| `codex auth doctor` | Run diagnostics and optional fixes |

Common flags:

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--json` | verify-flagged/forecast/report/fix/doctor | machine-readable output |
| `--live` | forecast/report | use live quota/session probes |
| `--dry-run` | verify-flagged/fix/doctor | preview without mutation |
| `--fix` | doctor | apply repairs |
| `--model <model>` | forecast/report | choose forecast model |
| `--out <path>` | report | write report file |
| `--no-restore` | verify-flagged | verify only, do not restore |

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
| `R` | Refresh/re-login this account |
| `E` | Enable/disable |
| `D` | Delete account |
| `Q` | Back |

### Settings Screens

| Key | Action |
| --- | --- |
| `Enter` | Toggle/select/open |
| `1-9` | Quick toggle for numbered options |
| `S` | Save |
| `R` | Reset |
| `Q` | Back or Save+Back (context dependent) |
| `[` / `]` | Reorder fields in summary settings |
| `+` / `-` | Adjust focused numeric backend setting |

---

## Useful Workflows

Health workflow:

```bash
codex auth check
codex auth forecast --live
codex auth report --live --json
```

Repair workflow:

```bash
codex auth fix --dry-run
codex auth fix
codex auth doctor --fix
```

---

## Related

- [../features.md](../features.md)
- [settings.md](settings.md)
- [../troubleshooting.md](../troubleshooting.md)
