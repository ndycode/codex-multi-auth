# Storage Paths Reference

Canonical and legacy file paths for account/settings/runtime data.

* * *

## Canonical Root

Default root:

- `~/.codex/multi-auth`

Override root:

- `CODEX_MULTI_AUTH_DIR=<path>`

* * *

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

Notes:

- `~/.codex/multi-auth/*` is owned by this project.
- `~/.codex/auth.json` and `~/.codex/accounts.json` are owned by official Codex CLI and may be synced by this project.

* * *

## Project-Scoped Account Paths

When project-scoped behavior is enabled, account files are namespaced under:

- `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`

`<project-key>` is derived from normalized project path + short hash.

* * *

## Legacy Compatibility Paths

Legacy compatibility paths may still be detected/read during migration.
Exact legacy path values are internal compatibility details and are not part of the canonical user workflow.

Example legacy roots that might be discovered in older installs:

- `~/.opencode/`
- `~/DevTools/config/codex/`

Canonical behavior should be documented against `~/.codex/multi-auth`.

* * *

## Verify Paths in Your Environment

```bash
codex auth status
codex auth list
```

Inspect files manually if needed.

* * *

## Related

- [../configuration.md](../configuration.md)
- [../upgrade.md](../upgrade.md)
- [../privacy.md](../privacy.md)
