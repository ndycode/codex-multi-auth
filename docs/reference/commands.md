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
| `codex auth verify [--paths|--flagged|--all]` | Self-test storage path chain and sandbox probes; optionally delegate flagged verification |
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
| `codex auth why-selected [--now|--last]` | Explain which account the selector picks now or via the last persisted runtime snapshot |

---

## Common Flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--manual`, `--no-browser` | login | Skip browser launch and use manual callback flow |
| `--json` | verify-flagged, verify, why-selected, best, forecast, report, fix, doctor, config explain, debug bundle | Print machine-readable output |
| `--explain` | forecast, report | Include reasoning details (forecast text/JSON, report text) |
| `--live` | best, forecast, report, fix | Use live probe before decisions/output |
| `--dry-run` | verify-flagged, verify (with `--flagged`/`--all`), fix, doctor | Preview without writing storage |
| `--model <model>` | best, forecast, report, fix | Specify model for live probe paths |
| `--out <path>` | report | Write report output to file |
| `--write <path>` | init-config, config template | Write template output to a file instead of stdout |
| `--fix` | doctor | Apply safe repairs |
| `--no-restore` | verify-flagged, verify (with `--flagged`/`--all`) | Verify only; do not restore healthy flagged accounts |
| `--paths` | verify | Run storage-path resolution chain and sandbox-probe self-test |
| `--flagged` | verify | Delegate to flagged-account verification (alias of `verify-flagged`) |
| `--all` | verify | Run both `--paths` and `--flagged` together |
| `--now`, `-n` | why-selected | Recompute the current selection from live state (default) |
| `--last`, `-l` | why-selected | Recompute selection from current state and attach the last persisted runtime snapshot |

---

## `codex auth why-selected`

Explains which account the rotation selector would pick right now, with
per-candidate scoring. Useful for reproducing rotation decisions from support
bundles or scripted diagnostics.

Usage:

```bash
codex auth why-selected [--now | --last] [--json]
```

Flags:

- `--now`, `-n` (default): recompute the selection from live state.
- `--last`, `-l`: recompute from live state and attach the last persisted
  runtime observability snapshot as metadata on the JSON payload.
- `--json`, `-j`: emit machine-readable JSON; otherwise prints a
  human-readable selected account summary plus a sorted candidate list.

Exit codes: `0` when an account is selected, `1` when no account can be
selected (for example, pool is empty or every account is cooled down).

JSON output shape:

```json
{
  "command": "why-selected",
  "mode": "now",
  "ok": true,
  "availableCount": 2,
  "totalCount": 3,
  "quotaKey": "chatgpt-5-codex",
  "config": { "...selector weights and PID offsets..." },
  "selected": {
    "index": 0,
    "oneBasedIndex": 1,
    "email": "...",
    "accountId": "...",
    "enabled": true,
    "available": true,
    "health": 100,
    "tokens": 80,
    "hoursSinceUsed": 1.2,
    "capabilityBoost": 0,
    "pidBonus": 0,
    "score": 100.5,
    "selectionReason": "best score",
    "lastSwitchReason": "...",
    "lastRateLimitReason": "...",
    "cooldownReason": "..."
  },
  "candidates": [ { "index": 0, "oneBasedIndex": 1, "...": "..." } ],
  "runtimeSnapshot": {
    "lastSwitchReason": "...",
    "lastRateLimitReason": "...",
    "cooldownReason": "...",
    "generatedAt": 0
  }
}
```

The `runtimeSnapshot` field is present only with `--last`. `selected` is
`null` when `ok` is `false`.

---

## `codex auth verify`

Supersedes `codex auth verify-flagged` as a single entry point for
installation self-tests. `verify-flagged` continues to work as a
back-compat alias.

Usage:

```bash
codex auth verify --paths [--json]
codex auth verify --flagged [--json] [--dry-run] [--no-restore]
codex auth verify --all [--json] [--dry-run] [--no-restore]
```

Flags:

- `--paths`: run the storage-path resolution chain (`process.cwd`,
  `findProjectRoot`, `resolveProjectStorageIdentityRoot`,
  `getProjectStorageKey`, `getProjectConfigDir`,
  `getProjectGlobalConfigDir`) and a sandbox self-test that verifies
  `resolvePath` accepts paths inside home and temp directories but rejects
  a synthetic outside-sandbox escape candidate.
- `--flagged`: delegate to flagged-account verification (same behavior and
  flags as `codex auth verify-flagged`).
- `--all`: run `--paths` followed by `--flagged` in the same invocation.
- `--json`, `-j`: emit machine-readable JSON.
- `--dry-run`, `--no-restore`: forwarded to `verify-flagged` when
  `--flagged` or `--all` is specified.

`--paths` and `--flagged` cannot be combined; use `--all` to run both.

Exit code: `0` when all selected modes pass, `1` otherwise.

JSON output shape:

```json
{
  "command": "verify",
  "mode": "paths",
  "ok": true,
  "paths": {
    "command": "verify",
    "mode": "paths",
    "ok": true,
    "steps": [
      { "name": "process.cwd", "input": null, "output": "/workspace", "ok": true }
    ],
    "sandboxTests": [
      { "name": "sandbox-accept-home", "input": "...", "rejected": false, "ok": true },
      { "name": "sandbox-accept-tmp",  "input": "...", "rejected": false, "ok": true },
      { "name": "sandbox-reject-escape","input": "...", "rejected": true,  "ok": true }
    ]
  },
  "flaggedExitCode": 0
}
```

`mode` is `"paths"`, `"flagged"`, or `"all"`. `paths` is present only when
`--paths` or `--all` is used; `flaggedExitCode` is present only when
`--flagged` or `--all` is used.

The `sandbox-reject-escape` probe resets the storage-path state at the
start of the command and constructs its escape candidate outside the home,
temp, and project roots to stay robust when invoked from pathological
working directories (for example, POSIX `cwd=/`). When no candidate path
can be constructed that is guaranteed outside every sandbox root, the
probe is recorded as skipped with `ok: true` rather than a spurious
failure.

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
