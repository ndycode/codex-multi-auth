# Upgrade Guide

Migrate safely from older command/path layouts to the current Codex-first workflow.

* * *

## What Changed

| Area | Older flow | Current flow |
| --- | --- | --- |
| Primary auth command | mixed legacy command forms | `codex auth ...` |
| Main account menu | mixed command/UI paths | `codex auth login` dashboard |
| Settings location | split config files | unified `~/.codex/multi-auth/settings.json` |
| Canonical accounts path | mixed legacy storage | `~/.codex/multi-auth/openai-codex-accounts.json` |

Compatibility note:

- Legacy files are still read when discovered for migration compatibility.

* * *

## Current Canonical Paths

- `~/.codex/multi-auth/settings.json`
- `~/.codex/multi-auth/openai-codex-accounts.json`
- `~/.codex/multi-auth/openai-codex-flagged-accounts.json`
- `~/.codex/multi-auth/quota-cache.json`

Legacy compatibility paths may still appear in older environments and are migrated automatically.

* * *

## Recommended Migration Sequence

1. Refresh Codex CLI and this project:

```bash
npm install -g @openai/codex
npm install
npm run build
npm link
```

2. Confirm command routing:

```bash
codex --version
codex auth status
```

3. Re-login and rebuild account pool:

```bash
codex auth login
codex auth check
```

4. Validate active behavior:

```bash
codex auth list
codex auth forecast --live
```

5. (Optional) refresh plugin-host config:

```bash
codex-multi-auth --modern
```

* * *

## Post-Upgrade Verification

```bash
codex auth report --live --json
codex auth doctor --fix --dry-run
```

Optional plugin-host smoke test (only if you use host mode):

```bash
<run your plugin-host smoke command in your host environment>
```

* * *

## Common Upgrade Problems

| Problem | Action |
| --- | --- |
| `codex auth` not found | `where codex`, ensure wrapper path is active |
| Old command habits | Use `codex auth ...` as canonical workflow |
| Accounts look stale | `codex auth doctor --fix` then re-login impacted accounts |
| Mixed path confusion | Check [reference/storage-paths.md](reference/storage-paths.md) |

* * *

## Related

- [getting-started.md](getting-started.md)
- [troubleshooting.md](troubleshooting.md)
- [reference/storage-paths.md](reference/storage-paths.md)
