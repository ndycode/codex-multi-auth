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
| Logs | `~/.codex/multi-auth/logs/codex-plugin/` |
| Cache | `~/.codex/multi-auth/cache/` |
| Codex CLI accounts | `~/.codex/accounts.json` |
| Codex CLI auth | `~/.codex/auth.json` |

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

## Experimental Local Backup Paths

The `Experimental` -> `Save Pool Backup` action exports a JSON snapshot of the current local account pool into a sibling `backups/` directory next to the active storage file.

Examples:

- global pool: `~/.codex/multi-auth/backups/<name>.json`
- project pool: `~/.codex/multi-auth/projects/<project-key>/backups/<name>.json`

Filename rules:

- prompts for a filename and appends `.json` when omitted
- rejects separators, traversal (`..`), rotation-style names containing `.rotate.`, and temporary suffixes ending in `.tmp` or `.wal`
- collisions fail safely instead of overwriting by default

---

## Experimental Sync Target Paths

The `Experimental` -> `Sync Accounts to oc-chatgpt-multi-auth` flow detects the target root in this order:

- `OC_CHATGPT_MULTI_AUTH_DIR`
- default global root: `~/.opencode`
- project root: `~/.opencode/projects/<project-key>`

For each target root, the sync preview/apply flow reads or writes:

- target accounts: `<root>/openai-codex-accounts.json`
- target backups: `<root>/backups/`

Detection notes:

- sync prefers roots with account artifacts, then falls back to storage signals such as `backups/` or `projects/`
- when multiple candidate roots contain artifacts or signals, sync blocks and only shows guidance instead of applying changes
- preview/apply keeps the destination active selection and preserves destination-only accounts

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
- [settings.md](settings.md)
- [../upgrade.md](../upgrade.md)
- [../privacy.md](../privacy.md)
