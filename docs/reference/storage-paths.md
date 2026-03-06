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
| Quota cache | `~/.codex/multi-auth/quota-cache.json` |
| Background job DLQ | `~/.codex/multi-auth/background-job-dlq.jsonl` |
| Logs | `~/.codex/multi-auth/logs/codex-plugin/` |
| Cache | `~/.codex/multi-auth/cache/` |
| Codex CLI accounts | `~/.codex/accounts.json` |
| Codex CLI auth | `~/.codex/auth.json` |

Security note:

- Current secure format (`version: 4`) stores keychain references (`refreshTokenRef`, `accessTokenRef`) instead of raw token values in account storage files.
- Set `CODEX_SECRET_STORAGE_MODE=plaintext` only for controlled migration/testing environments.

Ownership note:

- `~/.codex/multi-auth/*` is managed by this project.
- `~/.codex/accounts.json` and `~/.codex/auth.json` are managed by official Codex CLI.

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
