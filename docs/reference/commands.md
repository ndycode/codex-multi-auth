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
| `codex auth login` | Open interactive auth dashboard |
| `codex auth list` | List saved accounts and active account |
| `codex auth status` | Print short runtime/account summary |
| `codex auth switch <index>` | Set active account by index |
| `codex auth check` | Run quick account health check |
| `codex auth features` | Print implemented feature summary |

---

## Advanced Commands

| Command | Description |
| --- | --- |
| `codex auth verify-flagged` | Verify flagged accounts and optionally restore healthy accounts |
| `codex auth forecast` | Forecast best account by readiness/risk |
| `codex auth report` | Generate full health report |
| `codex auth fix` | Apply safe account storage fixes |
| `codex auth doctor` | Run diagnostics and optional repairs |
| `codex auth rotate-secrets` | Re-encrypt account secrets using current encryption key |
| `codex auth telemetry` | Show local telemetry summary and recent events |

---

## Common Flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--json` | verify-flagged, forecast, report, fix, doctor, rotate-secrets, telemetry | Print machine-readable output |
| `--live` | forecast, report, fix | Use live probe before decisions/output |
| `--dry-run` | verify-flagged, fix, doctor | Preview without writing storage |
| `--model <model>` | forecast, report, fix | Specify model for live probe paths |
| `--out <path>` | report | Write report output to file |
| `--fix` | doctor | Apply safe repairs |
| `--no-restore` | verify-flagged | Verify only; do not restore healthy flagged accounts |
| `--page-size <n>` | list, status (`--json`) | Page size for JSON list output (1-200) |
| `--cursor <cursor>` | list, status (`--json`) | Cursor token for JSON list pagination |
| `--idempotency-key <key>` | rotate-secrets | Safe retry key for automation |
| `--since-hours <hours>` | telemetry | Include events newer than this many hours |
| `--limit <n>` | telemetry | Max events to include in report |

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

| Key | Action |
| --- | --- |
| `Enter` | Toggle/select/open |
| `1-9` | Quick toggle for numbered options |
| `S` | Save |
| `R` | Reset |
| `Q` | Back/cancel without saving draft changes |
| `[` / `]` | Reorder fields in summary settings |
| `+` / `-` | Adjust focused numeric backend setting |

---

## Workflow Packs

Health and planning:

```bash
codex auth check
codex auth forecast --live --model gpt-5-codex
codex auth report --live --json
```

Repair and recovery:

```bash
codex auth fix --dry-run
codex auth fix --live --model gpt-5-codex
codex auth doctor --fix
codex auth rotate-secrets --json --idempotency-key "$CI_JOB_ID"
```

---

## Related

- [../features.md](../features.md)
- [public-api.md](public-api.md)
- [error-contracts.md](error-contracts.md)
- [settings.md](settings.md)
- [../troubleshooting.md](../troubleshooting.md)
