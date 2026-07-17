# Storage Paths Reference

Canonical and compatibility paths for account, settings, cache, and logs.

---

## Canonical Root

Default root:

- `~/.codex/multi-auth`

Override root:

- `CODEX_MULTI_AUTH_DIR=<path>`

---

## Canonical Files

| File | Default path |
| --- | --- |
| Unified settings | `~/.codex/multi-auth/settings.json` |
| Unified settings backup | `~/.codex/multi-auth/settings.json.bak` |
| Accounts | `~/.codex/multi-auth/openai-codex-accounts.json` |
| Accounts backup | `~/.codex/multi-auth/openai-codex-accounts.json.bak` |
| Accounts WAL | `~/.codex/multi-auth/openai-codex-accounts.json.wal` |
| Flagged accounts | `~/.codex/multi-auth/openai-codex-flagged-accounts.json` |
| Flagged accounts backup | `~/.codex/multi-auth/openai-codex-flagged-accounts.json.bak` |
| Quota cache | `~/.codex/multi-auth/quota-cache.json` |
| Runtime observability | `~/.codex/multi-auth/runtime-observability.json` |
| First-run setup marker | `~/.codex/multi-auth/first-run-setup.json` |
| Alternate / legacy plugin config | `~/.codex/multi-auth/config.json` |
| Usage directory | `~/.codex/multi-auth/usage/` |
| Usage ledger | `~/.codex/multi-auth/usage/usage-ledger.jsonl` |
| Usage ledger archives | `~/.codex/multi-auth/usage/usage-ledger.<timestamp>.jsonl` |
| Account policies | `~/.codex/multi-auth/account-policies.json` |
| Routing profiles | `~/.codex/multi-auth/routing-profiles.json` |
| Budget guards | `~/.codex/multi-auth/budget-guards.json` |
| Local bridge client tokens | `~/.codex/multi-auth/local-client-tokens.json` |
| Cross-process refresh leases | `~/.codex/multi-auth/refresh-leases/` |
| Runtime app helper status | `~/.codex/multi-auth/runtime-rotation-app-helper.json` |
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

`first-run-setup.json` lives under the multi-auth root
(`getCodexMultiAuthDir()` / `~/.codex/multi-auth` by default). On the first
manager CLI invocation after install, the package records a one-shot marker and
best-effort self-heals packaged app bind + launcher routing when runtime
rotation is enabled. Concurrent first invocations claim the marker with an
exclusive create so setup runs at most once. Failures are debug-logged and never
block the user command. Deleting the marker can re-trigger first-run setup on
the next CLI run.

Ownership note:

- `~/.codex/multi-auth/*` is managed by this project.
- `~/.codex/accounts.json`, `~/.codex/auth.json`, and `~/.codex/config.toml` are managed by official Codex CLI.
- The `codex-multi-auth-codex` wrapper preserves that official CLI file-backed auth layout by forwarding non-auth commands with `-c cli_auth_credentials_store="file"`, unless the caller already set `cli_auth_credentials_store` explicitly.
- Set `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0` to opt out of that wrapper-injected file-store override and leave the downstream CLI auth store untouched.
- Runtime rotation may create a temporary shadow `CODEX_HOME` under the operating-system temp directory while a forwarded Codex command is running. The wrapper syncs refreshed official state files back to the original Codex home before cleanup.
- When `CODEX_HOME` is set to a non-default directory, multi-auth resolves strictly to `$CODEX_HOME/multi-auth` and does not scan `~/.codex/multi-auth` for existing pools.
- V3 account storage may also carry `pinnedAccountIndex` and `affinityGeneration` for CLI pin / session-affinity invalidation.

Compatibility note:

- This file-store forwarding keeps auth state readable from disk outside interactive terminals, so wrapper forwarding and non-TTY auth flows stay deterministic after the Ink migration.

> **Windows note:** The wrapper keeps the official Codex CLI file-store layout unchanged, so Windows `EPERM`/`EBUSY` retry handling still lives with the downstream CLI writes rather than this wrapper layer. Opting out with `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0` stops injecting the file-store override for future wrapper launches, but it does not rewrite or expose previously written CLI auth files beyond the standard `~/.codex/auth.json` and `~/.codex/accounts.json` locations.

Backup metadata:

- `getBackupMetadata()` reports deterministic snapshot lists for the canonical account pool (primary, WAL, `.bak`, `.bak.1`, `.bak.2`, and discovered manual backups) and flagged-account state (primary, `.bak`, `.bak.1`, `.bak.2`, and discovered manual backups). Cache-like artifacts and `.reset-intent` markers are excluded from recovery candidates.
- `settings.json.bak` stores the last valid unified settings snapshot before each write and is used as a recovery fallback when `settings.json` is unreadable.
- Flagged-account backup recovery is suppressed whenever the flagged reset marker is still present, so partial clears cannot revive previously cleared flagged entries.

Upgrade note:

- Restore workflows now distinguish between unreadable state and intentionally cleared state. `settings.json.bak` is only used when `settings.json` exists but cannot be read, while flagged-account backups stay suppressed whenever the reset marker survives a partial clear.
- Operators validating a restore or clear flow should use `codex-multi-auth verify-flagged`, `codex-multi-auth fix --dry-run`, and `codex-multi-auth doctor --fix` to confirm what will be recovered, what stays cleared, and whether manual repair is still needed.
- Maintainers validating the on-disk upgrade behavior can run `npm run build` plus `npm test -- --run test/unified-settings.test.ts test/storage-recovery-paths.test.ts test/storage-flagged.test.ts` before shipping backup or restore changes.

---

## Project-Scoped Account Paths

When project-scoped behavior is enabled:

- `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`

`<project-key>` is derived as:

- sanitized project folder basename (max 40 chars)
- `-`
- first 12 chars of `sha256(normalized project path)`

On Windows, normalization lowercases drive/path segments before hashing.
Implementation reference: `lib/storage/paths.ts` (`getProjectStorageKey`).

**Worktree behavior:**

- Standard repositories: identity is the project root path.
- Linked Git worktrees: identity is the shared repository root, so all worktrees for the same repo share one account pool.
- Non-Git directories: identity falls back to the detected project path.

---

## Legacy Compatibility Paths

Older installations may still have compatibility-read paths during migration. These are migration-only and not canonical for new setup.

Examples:

- `~/DevTools/config/codex/`
- older pre-`~/.codex/multi-auth` custom roots

---

## Runtime Rotation Paths

Runtime rotation adds local state only when enabled or when a helper has recently run.

| Path | Purpose |
| --- | --- |
| `~/.codex/multi-auth/runtime-observability.json` | request counters, last selected runtime account metadata, and cooldown context for status/report commands |
| `~/.codex/multi-auth/runtime-rotation-app-helper.json` | wrapper-launched `codex app` helper state, idle timeout, request count, and last-account metadata |
| `~/.codex/multi-auth/app-bind/runtime-rotation-app-bind.json` | persistent packaged-app bind state |
| `~/.codex/multi-auth/app-bind/codex-config-backup.json` | backup metadata for restoring the real Codex `config.toml` |
| `~/.codex/multi-auth/app-bind/runtime-rotation-app-bind-status.json` | persistent app router status |
| `~/.codex/multi-auth/app-bind/runtime-rotation-app-router.log` | persistent app router log |
| `~/.codex/multi-auth/first-run-setup.json` | one-shot first CLI run marker for app bind / launcher self-heal |

The app bind writes a provider entry to the real `~/.codex/config.toml` only after taking a backup. `codex-multi-auth rotation disable` and `codex-multi-auth rotation unbind-app` restore the backup and remove the router startup entry.

---

## Local Governance and Bridge Paths

| Path | Purpose |
| --- | --- |
| `~/.codex/multi-auth/usage/` | Directory for the local usage ledger and rotated archives |
| `~/.codex/multi-auth/usage/usage-ledger.jsonl` | Append-only local usage metadata ledger |
| `~/.codex/multi-auth/usage/usage-ledger.<timestamp>.jsonl` | Archived ledgers produced by `codex-multi-auth usage rotate` |
| `~/.codex/multi-auth/account-policies.json` | Hashed-account policy metadata for tags, weights, pause, drain, and notes (`codex-multi-auth account ...`) |
| `~/.codex/multi-auth/routing-profiles.json` | Project-aware profile preferences keyed with `getProjectStorageKey` |
| `~/.codex/multi-auth/budget-guards.json` | Local budget limits evaluated from usage summaries (`codex-multi-auth budget ...`) |
| `~/.codex/multi-auth/local-client-tokens.json` | Local bridge token hashes and prefixes only (`codex-multi-auth bridge token ...`) |

The local bridge is loopback-only and exposes `/health`, `/v1/models`, and
`/v1/responses`. Plain client tokens are shown only by `codex-multi-auth bridge token
create` or `codex-multi-auth bridge token rotate`; the token store persists hashes.

Policy pause/drain entries in `account-policies.json` are enforced at selection
time by `evaluateRuntimePolicy` (blocked accounts are excluded from hybrid
rotation).

---

## Named Backup Exports

Experimental named backup exports are written under the local plugin-owned backup namespace beside the active accounts file:

- global root: `~/.codex/multi-auth/backups/<name>.json`
- project root: `~/.codex/multi-auth/projects/<project-key>/backups/<name>.json`

Rules:

- `.json` is appended when omitted
- backup names may only contain letters, numbers, `_`, and `-`
- path separators and `..` are rejected
- `.rotate.`, `.tmp`, and `.wal` names are rejected
- existing files are not overwritten unless a lower-level force path is used explicitly

---

## oc-chatgpt Target Paths

Experimental sync targets the companion `oc-chatgpt-multi-auth` storage layout:

- global target: `~/.opencode/openai-codex-accounts.json`
- project target: `~/.opencode/projects/<project-key>/openai-codex-accounts.json`
- target backups: `~/.opencode/backups/` or project-local `backups/` beside the target account file

---

## Verification Commands

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
