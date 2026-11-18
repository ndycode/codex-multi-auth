# Storage Paths Reference

Canonical and compatibility paths for account, settings, cache, and logs.

---

## Canonical root

Default root: `~/.codex/multi-auth`

Override root: `CODEX_MULTI_AUTH_DIR=<path>`

When `CODEX_HOME` is set to a non-default directory, multi-auth resolves
strictly to `$CODEX_HOME/multi-auth` and does not scan `~/.codex/multi-auth`
for existing pools.

---

## Canonical files

| File | Default path |
| --- | --- |
| Unified settings | `~/.codex/multi-auth/settings.json` |
| Unified settings backup | `~/.codex/multi-auth/settings.json.bak` |
| Accounts | `~/.codex/multi-auth/openai-codex-accounts.json` |
| Accounts backup | `~/.codex/multi-auth/openai-codex-accounts.json.bak` |
| Accounts WAL | `~/.codex/multi-auth/openai-codex-accounts.json.wal` |
| Automatic-prime attempts | `<accounts-file>.automatic-checks.json` (hashed keys + attempt times) |
| Flagged accounts | `~/.codex/multi-auth/openai-codex-flagged-accounts.json` |
| Flagged accounts backup | `~/.codex/multi-auth/openai-codex-flagged-accounts.json.bak` |
| Quota cache | `~/.codex/multi-auth/quota-cache.json` |
| Runtime observability | `~/.codex/multi-auth/runtime-observability.json` |
| First-run setup marker | `~/.codex/multi-auth/first-run-setup.json` |
| Alternate / legacy plugin config | `~/.codex/multi-auth/config.json` |
| Usage ledger | `~/.codex/multi-auth/usage/usage-ledger.jsonl` |
| Usage ledger archives | `~/.codex/multi-auth/usage/usage-ledger.<timestamp>.jsonl` |
| Account policies | `~/.codex/multi-auth/account-policies.json` |
| Routing profiles | `~/.codex/multi-auth/routing-profiles.json` |
| Budget guards | `~/.codex/multi-auth/budget-guards.json` |
| Local bridge client tokens | `~/.codex/multi-auth/local-client-tokens.json` |
| API routes / credentials | `~/.codex/multi-auth/api-routes.json` (mode 0600) |
| API capability probe results | `~/.codex/multi-auth/api-capability-probes.json` |
| API capability probe leases (hashed credential/model keys) | `~/.codex/multi-auth/api-probe-locks/*.write-lock/` |
| Automatic API capability check claims | `~/.codex/multi-auth/automatic-api-checks.json` |
| Reset credits | `~/.codex/multi-auth/reset-credits.json` |
| Inference activity | `~/.codex/multi-auth/inference-activity/` |
| Cross-process refresh leases | `~/.codex/multi-auth/refresh-leases/` |
| Runtime app helper status | `~/.codex/multi-auth/runtime-rotation-app-helper.<pid>.json` |
| Runtime app helper owner metadata | `~/.codex/multi-auth/runtime-rotation-app-helper-owner.<pid>.json` |
| Persistent app bind directory | `~/.codex/multi-auth/app-bind/` |
| Named pool backups | `~/.codex/multi-auth/backups/` |
| Per-project account pools | `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json` |
| Logs | `~/.codex/multi-auth/logs/codex-plugin/` |
| Cache | `~/.codex/multi-auth/cache/` |
| Settings / config save locks | `~/.codex/multi-auth/*.lock` (transient) |
| Reset-intent markers | `~/.codex/multi-auth/*.reset-intent` (excluded from recovery candidates) |
| Codex CLI accounts | `~/.codex/accounts.json` |
| Codex CLI auth | `~/.codex/auth.json` |
| Codex CLI config | `~/.codex/config.toml` |

### First-run setup marker

`first-run-setup.json` records a one-shot marker on the first manager CLI
invocation after install and best-effort self-heals the packaged app bind +
launcher routing when runtime rotation is enabled. Concurrent first invocations
claim the marker with an exclusive create, so setup runs at most once; failures
are debug-logged and never block the user command.

The marker carries a `version`. A `version: 1` marker (written before the Codex
auth-store step existed) is migrated in place on the next invocation: only that
step is replayed, and app bind / launcher install are deliberately not rerun so
shortcuts the user removed stay removed. The migration takes no exclusive claim
because both the `config.toml` rewrite and the marker write are idempotent and
atomic. An unreadable or truncated marker is treated as pre-v2 and migrated the
same way rather than re-triggering full setup.

A *failed* auth-store step deliberately leaves the marker pre-v2 so the next
invocation retries it — otherwise one transient Windows `EPERM`/`EBUSY` on a
locked `config.toml` would strand the CLI on keychain mode permanently. This
applies to the initial setup too: if that step fails there, the marker records
the older version and the next run replays only that step. A `skipped` result
does advance the version — the normal outcome for a config already pinned to
`"file"` and for an explicit `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0`
opt-out. Deleting the marker can re-trigger first-run setup on the next CLI
run.

### Ownership notes

- `~/.codex/multi-auth/*` is managed by this project; `~/.codex/accounts.json`,
  `~/.codex/auth.json`, and `~/.codex/config.toml` are managed by the official
  Codex CLI.
- The `codex-multi-auth-codex` wrapper preserves the official file-backed auth
  layout by forwarding non-auth commands with
  `-c cli_auth_credentials_store="file"` — unless the caller already set it —
  keeping auth state readable from disk for non-TTY flows.
- The `-c` override only covers processes the wrapper launches. Third-party
  front-ends exec the official binary directly and read `~/.codex/config.toml`,
  so the *persisted* top-level value is reconciled to `"file"` at three points:
  first-run setup, wrapper startup before forwarding, and `doctor --fix`.
- Only the top-level assignment is rewritten: a `cli_auth_credentials_store`
  inside `[profiles.*]` is left as authored, a missing top-level key is
  inserted above the first table, existing line endings are preserved (CRLF
  stays CRLF), and `'file'` is recognized as already-correct.
- `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0` opts out of both the `-c`
  injection and the wrapper-startup config reconcile.
  `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0` opts out of every
  `config.toml` rewrite (first-run, switch/login sync, `doctor --fix`) while
  leaving the per-invocation `-c` override in place.
- Neither the keychain nor the `security` CLI is ever read or written —
  reading a keychain item would itself raise the prompt this exists to
  eliminate. Credentials saved by an earlier `codex login` stay where they are,
  are no longer read once the store is pinned to `"file"`, and can be removed
  manually via Keychain Access.
- Runtime rotation may create a temporary shadow `CODEX_HOME` under the OS temp
  directory while a forwarded command runs; the wrapper syncs refreshed
  official state files back to the original home before cleanup.
- Interactive TUI sessions are the exception: they run against the canonical
  `CODEX_HOME` with `-c` provider overrides, so session history and SQLite
  state are read/written in place and `config.toml` is never rewritten. Two
  interactive sessions can therefore run concurrently against the same state —
  identical to running the official CLI twice; no lock is taken (covered by a
  regression test in `test/codex-bin-wrapper.test.ts`).
- V3 account storage may also carry `pinnedAccountIndex` and
  `affinityGeneration` for CLI pin / session-affinity invalidation.

> **Windows note:** the wrapper keeps the official file-store layout unchanged,
> so `EPERM`/`EBUSY` retry handling lives with downstream CLI writes. The
> wrapper-startup `config.toml` reconcile writes through the same atomic rename
> with retries; if it still fails the failure is swallowed because the
> per-invocation `-c` override already protects that run.

### Backup metadata

- `getBackupMetadata()` reports deterministic snapshot lists for the canonical
  account pool (primary, WAL, `.bak`, `.bak.1`, `.bak.2`, discovered manual
  backups) and flagged-account state (same minus WAL). Cache-like artifacts and
  `.reset-intent` markers are excluded from recovery candidates.
- `settings.json.bak` stores the last valid unified settings snapshot and is
  used as a recovery fallback only when `settings.json` exists but cannot be
  read.
- Flagged-account backup recovery is suppressed whenever the flagged reset
  marker survives a partial clear — restore distinguishes unreadable state from
  intentionally cleared state.

Validate restore/clear flows with `codex-multi-auth verify-flagged`,
`codex-multi-auth fix --dry-run`, and `codex-multi-auth doctor --fix`.

---

## Project-scoped account paths

When project-scoped behavior is enabled:

- `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`

`<project-key>` = sanitized project folder basename (max 40 chars) + `-` +
first 12 chars of `sha256(normalized project path)`. On Windows, normalization
lowercases drive/path segments before hashing. Implementation:
`lib/storage/paths.ts` (`getProjectStorageKey`).

Worktree behavior:

- Standard repositories: identity is the project root path.
- Linked Git worktrees: identity is the shared repository root — all worktrees
  of one repo share one account pool.
- Non-Git directories: identity falls back to the detected project path.

---

## Legacy compatibility paths

Migration-only, not canonical for new setups:

- `~/DevTools/config/codex/`
- older pre-`~/.codex/multi-auth` custom roots

---

## Runtime rotation paths

Runtime rotation adds local state only when enabled or when a helper recently
ran.

| Path | Purpose |
| --- | --- |
| `~/.codex/multi-auth/runtime-observability.json` | Request counters, last selected runtime account metadata, cooldown context for status/report commands (mode 0600) |
| `~/.codex/multi-auth/runtime-rotation-app-helper.<pid>.json` | Wrapper-launched `codex app` helper state — one file per helper; the un-suffixed legacy name is still read. Terminal stamps persist until a launch or `rotation unbind-app` sweeps dead-PID files |
| `~/.codex/multi-auth/runtime-rotation-app-helper-owner.<pid>.json` | Helper owner identity; removed on clean helper exit, swept with the status files |
| `~/.codex/multi-auth/app-bind/runtime-rotation-app-bind.json` | Persistent packaged-app bind state |
| `~/.codex/multi-auth/app-bind/codex-config-backup.json` | Backup metadata for restoring the real Codex `config.toml` |
| `~/.codex/multi-auth/app-bind/runtime-rotation-app-bind-status.json` | Persistent app router status |
| `~/.codex/multi-auth/app-bind/runtime-rotation-app-router.log` | Persistent app router log |
| `~/.codex/multi-auth/first-run-setup.json` | One-shot first-CLI-run marker (versioned; v1 migrates in place) |

The app bind writes a provider entry to the real `~/.codex/config.toml` only
after taking a backup. `codex-multi-auth rotation disable` and
`codex-multi-auth rotation unbind-app` restore the backup and remove the router
startup entry. `unbind-app` also sweeps orphaned helper status/owner metadata —
it is the recovery path when helpers accumulate with no new launches — while
preserving, with a warning, records whose PID is still live.

---

## Local governance and bridge paths

| Path | Purpose |
| --- | --- |
| `~/.codex/multi-auth/usage/` | Local usage ledger directory and rotated archives |
| `~/.codex/multi-auth/usage/usage-ledger.jsonl` | Append-only local usage metadata ledger |
| `~/.codex/multi-auth/usage/usage-ledger.<timestamp>.jsonl` | Archives produced by `codex-multi-auth usage rotate` |
| `~/.codex/multi-auth/account-policies.json` | Hashed-account policy metadata: tags, weights, pause, drain, notes (`codex-multi-auth account ...`) |
| `~/.codex/multi-auth/routing-profiles.json` | Project-aware profile preferences keyed by `getProjectStorageKey` (file-only; no write command) |
| `~/.codex/multi-auth/budget-guards.json` | Local budget limits evaluated from usage summaries (`codex-multi-auth budget ...`) |
| `~/.codex/multi-auth/local-client-tokens.json` | Local bridge token hashes and prefixes only (`codex-multi-auth bridge token ...`) |

The local bridge is loopback-only and exposes `/health`, `/v1/models`,
`/v1/responses`, and `/v1/decisions`. Plaintext tokens are shown only by `bridge token create` /
`rotate`; the store persists hashes.

Policy pause/drain entries in `account-policies.json` are enforced at selection
time by `evaluateRuntimePolicy` — blocked accounts are excluded from hybrid
rotation.

---

## Named backup exports

Experimental named backup exports are written under the backup namespace beside
the active accounts file:

- global root: `~/.codex/multi-auth/backups/<name>.json`
- project root: `~/.codex/multi-auth/projects/<project-key>/backups/<name>.json`

Rules:

- `.json` is appended when omitted
- names may only contain letters, numbers, `_`, and `-`
- path separators and `..` are rejected
- `.rotate.`, `.tmp`, and `.wal` names are rejected
- existing files are not overwritten unless a lower-level force path is used
  explicitly

---

## oc-chatgpt target paths

Experimental sync targets the companion `oc-codex-multi-auth` (formerly
`oc-chatgpt-multi-auth`) storage layout, root overridable with
`OC_CODEX_MULTI_AUTH_DIR` (the legacy `OC_CHATGPT_MULTI_AUTH_DIR` name is still
accepted as a fallback). Both account filenames are detected — the current
`oc-codex-multi-auth-accounts.json` and the legacy
`openai-codex-accounts.json` — preferring the current name when a root holds
both:

- global target: `~/.opencode/oc-codex-multi-auth-accounts.json`
- project target: `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json`
- legacy equivalents: `openai-codex-accounts.json` in the same locations
- target backups: `~/.opencode/backups/` or project-local `backups/` beside the
  target account file

---

## Verification commands

```bash
codex-multi-auth status
codex-multi-auth list
codex-multi-auth verify --paths
```

---

## Related

- [../configuration.md](../configuration.md)
- [../upgrade.md](../upgrade.md)
- [../privacy.md](../privacy.md)
- [commands.md](commands.md)
- [settings.md](settings.md)
