# Storage Paths Reference

Canonical and legacy file paths for account/settings/runtime data.

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

Notes:

- `~/.codex/multi-auth/*` is owned by this project.
- `~/.codex/auth.json` and `~/.codex/accounts.json` are owned by official Codex CLI.

---

## Project-Scoped Paths

When project-scoped behavior is enabled:

- `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`

`<project-key>` is derived from normalized project path + short hash.

---

## Legacy Compatibility

Legacy compatibility paths may still be discovered/read during migration.
These paths are migration-only and are not canonical for new setup.

Examples from older installs:

- `~/.opencode/`
- `~/DevTools/config/codex/`

---

## Verify Paths

```bash
codex auth status
codex auth list
```

---

## Related

- [../configuration.md](../configuration.md)
- [../upgrade.md](../upgrade.md)
- [../privacy.md](../privacy.md)
