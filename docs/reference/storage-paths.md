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
| Accounts | `~/.codex/multi-auth/openai-codex-accounts.json` |
| Accounts backup | `~/.codex/multi-auth/openai-codex-accounts.json.bak` |
| Accounts WAL | `~/.codex/multi-auth/openai-codex-accounts.json.wal` |
| Flagged accounts | `~/.codex/multi-auth/openai-codex-flagged-accounts.json` |
| Flagged accounts backup | `~/.codex/multi-auth/openai-codex-flagged-accounts.json.bak` |
| Quota cache | `~/.codex/multi-auth/quota-cache.json` |
| Logs | `~/.codex/multi-auth/logs/codex-plugin/` |
| Cache | `~/.codex/multi-auth/cache/` |
| Codex CLI accounts | `~/.codex/accounts.json` |
| Codex CLI auth | `~/.codex/auth.json` |

Ownership note:

- `~/.codex/multi-auth/*` is managed by this project.
- `~/.codex/accounts.json` and `~/.codex/auth.json` are managed by official Codex CLI.
- The `codex` wrapper preserves that official CLI file-backed auth layout by forwarding non-auth commands with `-c cli_auth_credentials_store="file"`, unless the caller already set `cli_auth_credentials_store` explicitly.
- Set `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0` to opt out of that wrapper-injected file-store override and leave the downstream CLI auth store untouched.

Compatibility note:

- This file-store forwarding keeps auth state readable from disk outside interactive terminals, so wrapper forwarding and non-TTY auth flows stay deterministic after the Ink migration.

> **Windows note:** The wrapper keeps the official Codex CLI file-store layout unchanged, so Windows `EPERM`/`EBUSY` retry handling still lives with the downstream CLI writes rather than this wrapper layer. Opting out with `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0` stops injecting the file-store override for future wrapper launches, but it does not rewrite or expose previously written CLI auth files beyond the standard `~/.codex/auth.json` and `~/.codex/accounts.json` locations.

Backup metadata:

- `getBackupMetadata()` reports deterministic snapshot lists for the canonical account pool (primary, WAL, `.bak`, `.bak.1`, `.bak.2`, and discovered manual backups) and flagged-account state (primary, `.bak`, `.bak.1`, `.bak.2`, and discovered manual backups). Cache-like artifacts and `.reset-intent` markers are excluded from recovery candidates.

---

## Project-Scoped Account Paths

When project-scoped behavior is enabled:

- `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`

`<project-key>` is derived as:

- sanitized project folder basename (max 40 chars)
- `-`
- first 12 chars of `sha256(normalized project path)`

On Windows, normalization lowercases drive/path segments before hashing.
Implementation reference: `lib/storage/paths.ts` (`deriveProjectKey`).

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
codex auth status
codex auth list
```

---

## Related

- [../configuration.md](../configuration.md)
- [../upgrade.md](../upgrade.md)
- [../privacy.md](../privacy.md)
