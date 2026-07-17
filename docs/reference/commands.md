# Command Reference

Complete command, flag, and hotkey reference for `codex-multi-auth` (package `2.6.1`).

---

## Published binaries

The package ships four `bin` entrypoints:

| Binary | Role |
| --- | --- |
| `codex-multi-auth` | Primary account-manager CLI (`status`, `login`, `switch`, `rotation`, diagnostics, repair, …) |
| `codex-multi-auth-codex` | Forwarding wrapper: handles `auth ...` locally; forwards every other command to the official `@openai/codex` CLI, with optional runtime rotation and `--account` pinning |
| `codex-multi-auth-app-launcher` | User-level packaged Codex app launcher routing helper (Windows shortcuts / macOS wrapper app) |
| `mcodex` | Convenience launcher over `codex-multi-auth-codex` with optional `--monitor` and `--tmux` modes |

See also [public-api.md](public-api.md) for Tier A surface and stability.

---

## Canonical Command Family

Primary operations use `codex-multi-auth ...`.

Compatibility forms are supported for migrations and wrapper-routed environments:

- `codex-multi-auth auth ...`
- `codex-multi-auth-codex auth ...`
- `codex auth ...` when this package's wrapper has explicitly been installed or aliased as `codex`
- `codex multi auth ...`
- `codex multi-auth ...`
- `codex multiauth ...`

---

## Start Here

| Command | Description |
| --- | --- |
| `codex-multi-auth login` | Open interactive auth dashboard |
| `codex-multi-auth status` | Print short runtime/account summary |
| `codex-multi-auth check` | Run quick account health check |

---

## Daily Use

| Command | Description |
| --- | --- |
| `codex-multi-auth list` | List saved accounts and active account |
| `codex-multi-auth switch <index>` | Set active account by index and pin it for runtime routing |
| `codex-multi-auth unpin` | Clear the manual pin set by `switch` and resume hybrid rotation |
| `codex-multi-auth forecast` | Forecast best account by readiness/risk |
| `codex-multi-auth best` | Pick and optionally sync the best account (clears any manual pin) |
| `codex-multi-auth account ...` | Manage local account policy metadata |
| `codex-multi-auth workspace <account> [workspace]` | List an account's tracked workspaces, or set its active workspace |

> Sticky session affinity: `switch`, `unpin`, and `best` all bump an
> `affinityGeneration` counter in storage that the runtime rotation proxy
> observes via the same mtime-cached read path it uses for the manual pin.
> When the proxy sees a higher generation than its in-memory tracker, it
> drops every entry in its session-affinity store. Net effect: a manual
> change reaches the next desktop-app request even mid-conversation, instead
> of being shadowed for up to 20 minutes by a per-thread account lock that
> would otherwise glue the chat to whichever account first responded. See
> issue #474.

---

## Repair

| Command | Description |
| --- | --- |
| `codex-multi-auth verify-flagged` | Verify flagged accounts and optionally restore healthy accounts |
| `codex-multi-auth verify [--paths|--flagged|--all]` | Self-test storage path chain and sandbox probes; optionally delegate flagged verification |
| `codex-multi-auth fix` | Apply safe account storage fixes |
| `codex-multi-auth doctor` | Run diagnostics and optional repairs |
| `codex-multi-auth uninstall` | Reverse first-run setup and residual artifacts (run before `npm uninstall`) |
| `codex-multi-auth config explain` | Print effective config values and their sources |
| `codex-multi-auth init-config [modern|legacy|minimal]` | Print a starter config template |
| `codex-multi-auth debug bundle` | Print a bundled runtime/debug snapshot |

---

## Advanced

| Command | Description |
| --- | --- |
| `codex-multi-auth features` | Print implemented feature summary |
| `codex-multi-auth report` | Generate full health report |
| `codex-multi-auth usage` | Summarize local usage ledger rows |
| `codex-multi-auth budget ...` | Manage local budget guard limits |
| `codex-multi-auth bridge token ...` | Manage local bridge bearer tokens |
| `codex-multi-auth integrations` | Generate local bridge client snippets |
| `codex-multi-auth models` | Inspect local model/account capability views |
| `codex-multi-auth monitor` | Aggregate runtime, usage, policy, quota, model, and project state |
| `codex-multi-auth why-selected [--now|--last]` | Explain which account the selector picks now or via the last persisted runtime snapshot |
| `codex-multi-auth history [list\|show <id>]` | List every local Codex session across all providers, bypassing the `model_provider` filtering that hides threads in `codex resume` while runtime rotation / app bind is active |
| `codex-multi-auth rotation enable\|disable\|status\|bind-app\|unbind-app` | Manage the default-on runtime Responses proxy for live Codex account rotation |
| `codex-multi-auth rotation reset-rate-limits [--all \| --account <idx>]` | Clear local rate-limit cooldowns for all accounts or one account |

---

## Common Flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--account <index\|email\|id>` | `codex-multi-auth-codex` (forwarded Codex runs) | Force one account for this invocation only; the session never rotates and persisted `switch` state is untouched. Requires the runtime rotation proxy. See [Force an account for one invocation](#force-an-account-for-one-invocation) |
| `--device-auth` | login | Use the OpenAI Codex device-code flow for remote/headless login (mutually exclusive with `--manual` / `--no-browser`) |
| `--manual`, `--no-browser` | login | Skip browser launch and use manual callback flow (mutually exclusive with `--device-auth`) |
| `--json` | verify-flagged, verify, why-selected, best, forecast, report, usage, budget, models, monitor, integrations, fix, doctor, config explain, debug bundle, history | Print machine-readable output |
| `--csv` | usage | Print or write CSV bucket output |
| `--explain` | forecast, report | Include reasoning details (forecast text/JSON, report text) |
| `--live` | best, forecast, report, fix | Use live probe before decisions/output |
| `--dry-run` | verify-flagged, verify (with `--flagged`/`--all`), fix, doctor, uninstall | Preview without writing storage |
| `--model <model>` | best, forecast, report, fix | Specify model for live probe paths |
| `--out <path>` | report, usage | Write report output to file |
| `--since <time>` | usage | Filter local usage rows by timestamp, ISO date, or relative duration |
| `--by <group>` | usage | Group usage by model, account, project, outcome, or day |
| `--kind <name>` | integrations | Select one snippet kind: opencode, openclaw, python, curl, or env |
| `--write <path>` | init-config, config template | Write template output to a file instead of stdout |
| `--fix` | doctor | Apply safe repairs |
| `--no-restore` | verify-flagged, verify (with `--flagged`/`--all`) | Verify only; do not restore healthy flagged accounts |
| `--paths` | verify | Run storage-path resolution chain and sandbox-probe self-test |
| `--flagged` | verify | Delegate to flagged-account verification (alias of `verify-flagged`) |
| `--all` | verify | Run both `--paths` and `--flagged` together |
| `--now`, `-n` | why-selected | Recompute the current selection from live state (default) |
| `--last`, `-l` | why-selected | Recompute selection from current state and attach the last persisted runtime snapshot |
| `--clear-accounts` | uninstall | Also remove stored account credentials (irreversible) |

Additional `--json` surfaces not listed in the compact Common Flags row above include `uninstall` and `rotation reset-rate-limits` / `rotation reset-runtime`. Treat the Common Flags `--json` row as the authoritative list for documentation tests; the extra surfaces are additive diagnostics/cleanup helpers.

Default live-probe model when `--model` is omitted is `gpt-5.6-sol` (`DEFAULT_PROBE_MODEL`). Request routing defaults remain on `gpt-5.5` (`DEFAULT_MODEL`).

---

## Force an account for one invocation

`codex-multi-auth-codex --account <selector>` pins a single account for that one
forwarded Codex run — useful when you keep separate pools (for example, personal
and work accounts) and want a specific invocation to use a specific account (for
example, when driving Codex from another tool). The selector is one of:

- a **1-based index** (`--account 2`, matching the numbering in `codex-multi-auth list`),
- an **email** (`--account work@example.com`), or
- an **account id** (`--account acc_...`).

An all-digit selector is always treated as a 1-based index, so an account whose
id is purely numeric cannot be targeted by id — use its index or email instead.

`CODEX_MULTI_AUTH_FORCE_ACCOUNT=<selector>` has the same effect for tools that set
environment variables more easily than command-line flags; the `--account` flag
wins when both are present.

The pin is **ephemeral and fail-hard**:

- It applies only to this invocation and never changes the persisted `switch` pin,
  so concurrent sessions with different `--account` values do not interfere.
- The session never rotates. If the chosen account is rate-limited or otherwise
  unavailable, the request fails rather than silently using a different account.
- It requires the [runtime rotation proxy](../configuration.md#runtime-rotation-proxy).
  If the proxy is disabled (or `CODEX_MULTI_AUTH_BYPASS=1`), or the selector does
  not match a configured account, the wrapper exits non-zero without launching
  Codex.

---

## `mcodex`

Convenience launcher published as the `mcodex` bin. It spawns the sibling
`codex-multi-auth-codex` wrapper (`scripts/codex.js`) with no bash dependency.

```bash
mcodex [codex-args...]                 # default: forward to codex-multi-auth-codex
mcodex --monitor                       # live-refresh account list via `watch`
mcodex --tmux [-t] [--live-accounts] [codex-args...]
```

Modes:

- **Default**: forward all remaining args to `scripts/codex.js` (same stack as `codex-multi-auth-codex`).
- **`--monitor`**: run `watch -n <interval> codex-multi-auth list`. Interval defaults to `5` seconds; override with `MCODEX_MONITOR_INTERVAL` (positive number only). If `watch` is missing, `mcodex` exits `1` with an install hint.
- **`--tmux` / `-t`**: open or attach a tmux session (default name `mcodex`, override with `MCODEX_TMUX_SESSION`) that runs the codex wrapper. Optional `--live-accounts` (only after `--tmux`/`-t`) opens a split that refreshes the account list when `watch` is available. History limit defaults to `50000` (`MCODEX_TMUX_HISTORY_LIMIT`). If `tmux` is missing, `mcodex` warns and forwards without tmux.

---

## `codex-multi-auth account`

Stores local account policy metadata used by runtime selection and budget
governance. Policy keys are hashed from account identity; raw account ids and
raw emails are not stored in the policy file.

Usage:

```bash
codex-multi-auth account tag <index> <tag>
codex-multi-auth account untag <index> <tag>
codex-multi-auth account weight <index> <0..10>
codex-multi-auth account pause <index>
codex-multi-auth account unpause <index>
codex-multi-auth account drain <index>
codex-multi-auth account undrain <index>
codex-multi-auth account note <index> <text>
codex-multi-auth account policy list [--json]
```

Notes:

- `pause` and `drain` are enforced by runtime policy (`evaluateRuntimePolicy`):
  paused or drained accounts are blocked from hybrid selection and rotation.
  Unpause / undrain clear those blocks. A manual pin can still target a specific
  account; policy-blocked accounts surface as unavailable when selection would
  otherwise choose them.
- `weight` accepts values from `0` to `10`; default is `1`. Higher weight adds a
  small score boost during hybrid selection.
- `tag` values are normalized to lowercase filesystem-safe labels and can
  interact with routing-profile preferred/avoid tags.

---

## `codex-multi-auth workspace`

```bash
codex-multi-auth workspace <account>             # list the account's tracked workspaces
codex-multi-auth workspace <account> <workspace> # set the active workspace for that account
```

Lists or sets the active workspace for one saved account. Both arguments are
1-based indexes as shown by `codex-multi-auth list` and the workspace listing.
With only an account index, prints the workspaces that account can rotate
between (for example a personal Plus seat and a business/team seat under the
same email, issue #491). With a workspace index too, persists that workspace
as the account's active selection.

---

## `codex-multi-auth uninstall`

Reverses first-run setup and residual host artifacts. Run this **before**
`npm uninstall -g codex-multi-auth` — npm@7+ no longer fires `preuninstall`
lifecycle scripts reliably, so cleanup is operator-driven.

```bash
codex-multi-auth uninstall [--dry-run] [--json] [--clear-accounts]
```

Behavior:

- Unbinds the persistent packaged Codex app runtime rotation bind when present
- Removes managed OS launcher routing (`codex-multi-auth-app-launcher --remove` path)
- Strips this package from Codex plugin config (`Codex.json`) when present
- Clears the package cache under the Codex cache tree when safe
- With `--clear-accounts`, also removes stored multi-auth account credentials
  (irreversible)
- `--dry-run` previews actions without writing
- `--json` prints a machine-readable summary of removed / would-remove paths

Recommended order:

```bash
codex-multi-auth uninstall
npm uninstall -g codex-multi-auth
```

---

## `codex-multi-auth usage`

Summarizes the local usage ledger. Rows are local-only metadata and do not
contain prompts, tokens, auth headers, raw account emails, or raw sensitive
account ids.

Usage:

```bash
codex-multi-auth usage [--since <time|duration>] [--by <model|account|project|outcome|day>] [--json|--csv] [--out <path>]
codex-multi-auth usage rotate [--if-larger-than-bytes <bytes>] [--json]
```

Flags:

- `--since`: filter rows by Unix milliseconds, ISO date, or relative duration
  such as `24h`, `7d`, or `2w`.
- `--by`: group summary output by `model`, `account`, `project`, `outcome`, or
  `day`. Default: `model`.
- `--json`, `-j`: emit machine-readable JSON including the summary and rows.
- `--csv`: emit CSV bucket output.
- `--out`: write the rendered output to a file.
- `rotate`: move the current ledger to a timestamped archive.
- `--if-larger-than-bytes`: skip rotation unless the current ledger is larger
  than the provided byte threshold.

Exit code: `0` for successful summary or rotation, `1` for invalid options or
write failures.

---

## Local governance commands

These commands are local-only and operate on files under `~/.codex/multi-auth`.

```bash
codex-multi-auth budget limit <key> --window <hour|day|week|month> [--max-requests <n>] [--max-tokens <n>] [--max-cost-usd <n>]
codex-multi-auth budget check <key> [--json]
codex-multi-auth budget list [--json]
codex-multi-auth models [--json] [--model <model>]
codex-multi-auth monitor [--json]
```

`monitor` aggregates runtime observability, usage, policy, routing profile,
budget, model matrix, quota cache, and current project context. `models`
reports neutral account labels and does not expose raw account emails.

---

## Local bridge commands

The optional local bridge exposes only `/health`, `/v1/models`, and
`/v1/responses` on loopback. Forwarded bridge requests require a bearer token
by default.

```bash
codex-multi-auth bridge token create [--label <label>]
codex-multi-auth bridge token list
codex-multi-auth bridge token rotate <id>
codex-multi-auth bridge token revoke <id>
codex-multi-auth integrations [--kind <opencode|openclaw|python|curl|env>] [--base-url <url>] [--model <model>] [--json]
```

Plain local bridge tokens are printed only on `create` and `rotate`. The token
store persists SHA-256 hashes plus prefixes and labels.

Generated snippets use `CODEX_MULTI_AUTH_LOCAL_KEY`. The Python snippet uses
`client.responses.create`.

---

## `codex-multi-auth history`

Lists local Codex sessions by reading the rollout files under
`<codex-home>/sessions` (default `~/.codex/sessions`, honoring `CODEX_HOME`)
directly. Codex's own `codex resume` view filters threads by the `model_provider`
recorded in each session; while runtime rotation or app bind is active that
provider is `codex-multi-auth-runtime-proxy`, so sessions created under the
native `openai` provider (or vice versa) are hidden from `resume` even though
the files are still present. This command shows every session regardless of
provider, which is the fix for "history not shared across accounts" reports —
the split is by provider name, not by account.

Usage:

```bash
codex-multi-auth history [list] [--json]
codex-multi-auth history show <session-id> [--json]
```

`list` (the default when no subcommand is given) prints each session's
`updated_at`, `model_provider`, id, thread name, and cwd, most-recent first.
`show <id>` prints the provider/originator metadata and the first few user
messages for a single session. Reopen any session with `codex resume <id>`.

This command is read-only, performs no network calls, and never mutates Codex or
multi-auth state.

---

## `codex-multi-auth why-selected`

Explains which account the rotation selector would pick right now, with
per-candidate scoring. Useful for reproducing rotation decisions from support
bundles or scripted diagnostics.

Usage:

```bash
codex-multi-auth why-selected [--now | --last] [--json]
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

## `codex-multi-auth rotation`

Manages the default-on runtime Responses proxy used by forwarded official Codex sessions. This is separate from normal `codex-multi-auth switch`: the proxy can rotate managed accounts between backend Responses requests while a Codex session stays open.

Usage:

```bash
codex-multi-auth rotation enable
codex-multi-auth rotation disable
codex-multi-auth rotation status
codex-multi-auth rotation bind-app
codex-multi-auth rotation unbind-app
codex-multi-auth rotation reset-rate-limits [--all | --account <idx>] [--dry-run] [--json]
codex-multi-auth rotation reset-runtime [--json]
```

Behavior:

- `enable` persists `codexRuntimeRotationProxy=true`, binds the packaged desktop app to the same persistent localhost router, and routes supported user-level app shortcuts when possible.
- `disable` persists `codexRuntimeRotationProxy=false` and removes the persistent packaged-app bind.
- `status` prints the effective setting, environment override state, automatic Codex app helper state, persistent Codex app bind state, account count, current account, disabled accounts, cooldowns, and rate-limit waits.
- `bind-app` repairs or installs the persistent packaged-app bind without changing the stored rotation setting.
- `unbind-app` removes the persistent packaged-app bind and restores the backed-up Codex config.
- `reset-rate-limits` clears local rate-limit cooldowns for every account (`--all`) or one 1-based account index (`--account`).
- `reset-runtime` clears transient runtime observability counters used by status/report.
- `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` disables the proxy for the current process without changing settings.

When enabled, the wrapper creates a temporary shadow `CODEX_HOME/config.toml` with a custom provider named `codex-multi-auth-runtime-proxy`, starts a `127.0.0.1` proxy on a random port, and forwards official Codex Responses traffic through that provider. This applies to CLI request commands plus `codex app-server` and `codex app` when they are launched through the wrapper. Existing behavior is unchanged while the setting and env override are off.

If every managed account is temporarily unavailable, the proxy returns `codex_runtime_rotation_pool_exhausted` with a retry hint pointing back to `codex-multi-auth rotation status`.

Packaged desktop app support uses a reversible bind instead of patching app files. It backs up the real Codex `config.toml`, writes the same custom provider to the real Codex home, starts a localhost-only router, and installs a user login startup entry: a Startup `.cmd` on Windows or a LaunchAgent on macOS. The provider uses a local app-bind client token and `requires_openai_auth=false`, which keeps the selected multi-auth account out of the runtime composer while preserving router last-account telemetry for codex-multi-auth status and quota views. Package install/update runs the same bind by default when runtime rotation is enabled and a Codex desktop app is detected; set `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` to skip that self-heal or `CODEX_MULTI_AUTH_APP_BIND_INSTALL=1` to force it. Global install/update also routes supported user-level app launchers by default; set `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` to skip launcher routing. Installed wrappers may perform a best-effort daily npm version check during normal forwarded Codex startup; if a newer release exists, they only print `npm install -g codex-multi-auth@latest` and never mutate the package install.

Because packaged app bind changes the real Codex `model_provider` to `codex-multi-auth-runtime-proxy`, current Codex Desktop builds can hide older local threads that were indexed under the original provider. This is a visibility/provider-filtering limitation, not expected data loss: rollout files, `session_index.jsonl`, and Codex SQLite state normally remain under `~/.codex`. If you need to browse old Desktop history, run `codex-multi-auth rotation unbind-app` or `codex-multi-auth rotation disable`, reopen Codex, and re-bind when you want app-level rotation again.

Model speed/reasoning controls also remain Codex-owned. For wrapper-launched CLI sessions, set `model_reasoning_effort` in `~/.codex/config.toml` or pass `-c model_reasoning_effort=<level>`; the app bind does not add a separate Desktop speed selector.

The app launcher routing helper is also available directly as `codex-multi-auth-app-launcher`. On Windows, it retargets existing user-level `Codex` shortcuts and taskbar pins to the wrapper while backing up their original target for restore. On macOS, it creates or removes a user-level `Codex Multi Auth.app` wrapper because Dock entries cannot safely launch a shell command directly. It does not patch the official app files. Use `codex-multi-auth-app-launcher --remove` to restore backed-up Windows shortcuts or remove the managed macOS wrapper.

If Windows exposes Codex only as a packaged `shell:AppsFolder` entry, shortcut routing may still report that there is no retargetable `.lnk`. The persistent app bind is the path that makes those packaged entries use rotation when the official app is opened directly.

---

## `codex-multi-auth verify`

Supersedes `codex-multi-auth verify-flagged` as a single entry point for
installation self-tests. `verify-flagged` continues to work as a
back-compat alias.

Usage:

```bash
codex-multi-auth verify --paths [--json]
codex-multi-auth verify --flagged [--json] [--dry-run] [--no-restore]
codex-multi-auth verify --all [--json] [--dry-run] [--no-restore]
```

Flags:

- `--paths`: run the storage-path resolution chain (`process.cwd`,
  `findProjectRoot`, `resolveProjectStorageIdentityRoot`,
  `getProjectStorageKey`, `getProjectConfigDir`,
  `getProjectGlobalConfigDir`) and a sandbox self-test that verifies
  `resolvePath` accepts paths inside home and temp directories but rejects
  a synthetic outside-sandbox escape candidate.
- `--flagged`: delegate to flagged-account verification (same behavior and
  flags as `codex-multi-auth verify-flagged`).
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

- `codex-multi-auth login` remains browser-first by default.
- `codex-multi-auth login --device-auth` uses OpenAI Codex device-code login. It prints `https://auth.openai.com/codex/device` and a one-time code, then polls for completion without opening a browser or starting the local callback server.
- `codex-multi-auth login --manual` and `codex-multi-auth login --no-browser` force the manual callback flow instead of launching a browser.
- `CODEX_AUTH_NO_BROWSER=1` suppresses browser launch for automation/headless sessions. False-like values such as `0` and `false` do not disable browser launch by themselves.
- In non-TTY/manual shells, pass the full redirect URL on stdin, for example: `echo "http://127.0.0.1:1455/auth/callback?code=..." | codex-multi-auth login --manual`.
- `codex-multi-auth forecast --explain` now keeps the explain breakdown visible in text mode even when dashboard settings hide recommendation summary lines. Pair it with `--json` for machine-readable reasoning snapshots.
- `codex-multi-auth switch <index>` now also pins the chosen account for runtime routing. The desktop-app rotation proxy honors the pin on every request and hard-fails with HTTP 503 `codex_pinned_account_unavailable` when the pinned account is rate-limited or otherwise unavailable. Run `codex-multi-auth unpin` (or `codex-multi-auth best`) to clear the pin and resume hybrid rotation. See issue #474.
- Account `pause` / `drain` policy is enforced by `evaluateRuntimePolicy` during selection (blocked accounts are skipped).
- Live diagnostic probes default to `gpt-5.6-sol`; pass `--model gpt-5.5` (or another supported id) to override.
- No new npm scripts or storage migration steps were introduced for this auth-flow update.

---

## Compatibility and Non-TTY Behavior

- `codex-multi-auth` is the primary account-manager entrypoint and accepts bare subcommands such as `status`, `login`, and `rotation status`.
- `codex-multi-auth-codex` is the optional forwarding wrapper. It handles `auth ...` locally and forwards every other command to the official `@openai/codex` CLI.
- `mcodex` is a convenience alias that forwards to `codex-multi-auth-codex` by default, with optional `--monitor` / `--tmux` modes.
- `codex --version` reports the official `@openai/codex` CLI version when the official CLI owns the `codex` name.
- `codex-multi-auth --version` and `codex-multi-auth -v` report the installed manager package version.
- In non-TTY or host-managed sessions, including `CODEX_TUI=1`, `CODEX_DESKTOP=1`, `TERM_PROGRAM=codex`, or `ELECTRON_RUN_AS_NODE=1`, auth flows degrade to deterministic text behavior.
- The non-TTY fallback keeps `codex-multi-auth login` predictable: it defaults to add-account mode, skips the extra "add another account" prompt, and auto-picks the default workspace selection when a follow-up choice is needed.
- `codex-multi-auth login --device-auth` is the preferred remote/headless login path because it needs only a browser on any device plus the printed one-time code.
- `codex-multi-auth login --manual` keeps the login flow usable in browser-restricted shells by printing the OAuth URL and accepting manual callback input instead of trying to open a browser.
- In non-TTY/manual shells, provide the full redirect URL on stdin, for example: `echo "http://127.0.0.1:1455/auth/callback?code=..." | codex-multi-auth login --manual`.

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
codex-multi-auth check
codex-multi-auth forecast --live --explain --model gpt-5.6-sol
codex-multi-auth report --live --json
```

Repair and recovery:

```bash
codex-multi-auth fix --dry-run
codex-multi-auth fix --live --model gpt-5.5
codex-multi-auth doctor --fix
```

---

## Related

- [../features.md](../features.md)
- [public-api.md](public-api.md)
- [error-contracts.md](error-contracts.md)
- [settings.md](settings.md)
- [../troubleshooting.md](../troubleshooting.md)
