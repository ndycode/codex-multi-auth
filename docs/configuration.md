# Configuration

This page covers both OpenCode config and plugin runtime config.

## Config Files

| Layer | Path | Purpose |
| --- | --- | --- |
| OpenCode global config | `~/.config/opencode/opencode.json` | Plugin registration and provider options |
| OpenCode project override | `<project>/.opencode/opencode.json` | Per-project model behavior |
| Plugin runtime config | `~/.opencode/codex-multi-auth-config.json` | Account rotation, TUI, resilience tuning |

Legacy plugin config fallback path still loads if present:

- `~/.opencode/openai-codex-auth-config.json`

## Minimal OpenCode Config

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["codex-multi-auth"],
  "provider": {
    "openai": {
      "options": {
        "store": false,
        "reasoningEffort": "medium",
        "reasoningSummary": "auto",
        "textVerbosity": "medium",
        "include": ["reasoning.encrypted_content"]
      }
    }
  }
}
```

## Recommended Plugin Runtime Config

`~/.opencode/codex-multi-auth-config.json`:

```json
{
  "codexMode": true,
  "codexTuiV2": true,
  "codexTuiColorProfile": "truecolor",
  "codexTuiGlyphMode": "ascii",
  "fastSession": false,
  "fastSessionStrategy": "hybrid",
  "retryAllAccountsRateLimited": true,
  "unsupportedCodexPolicy": "strict",
  "perProjectAccounts": true,
  "liveAccountSync": true,
  "sessionAffinity": true,
  "proactiveRefreshGuardian": true,
  "fetchTimeoutMs": 60000,
  "streamStallTimeoutMs": 45000
}
```

## High-Impact Keys

| Key | Default | Why it matters |
| --- | --- | --- |
| `codexMode` | `true` | Replaces generic system prompts with Codex bridge prompts |
| `codexTuiV2` | `true` | Enables highlighted auth dashboard UI |
| `fastSession` | `false` | Reduces latency by trimming stateless payloads |
| `fastSessionStrategy` | `hybrid` | `hybrid` keeps safer behavior than `always` |
| `retryAllAccountsRateLimited` | `true` | Automatically rotates/waits across account pool |
| `unsupportedCodexPolicy` | `strict` | `fallback` enables model downgrade chain |
| `perProjectAccounts` | `true` | Per-project account isolation |
| `liveAccountSync` | `true` | Reloads account manager without restart on file changes |
| `sessionAffinity` | `true` | Keeps sessions on stable account when possible |
| `proactiveRefreshGuardian` | `true` | Background token refresh before expiry |
| `fetchTimeoutMs` | `60000` | Network hard timeout |
| `streamStallTimeoutMs` | `45000` | Stream inactivity timeout |

## Environment Variable Overrides

| Variable | Effect |
| --- | --- |
| `CODEX_MODE=0/1` | Disable/enable Codex mode |
| `CODEX_TUI_V2=0/1` | Disable/enable TUI v2 |
| `CODEX_TUI_COLOR_PROFILE=truecolor&#124;ansi256&#124;ansi16` | TUI color profile |
| `CODEX_TUI_GLYPHS=ascii&#124;unicode&#124;auto` | TUI glyph style |
| `CODEX_AUTH_FAST_SESSION=0/1` | Fast-session toggle |
| `CODEX_AUTH_FAST_SESSION_STRATEGY=hybrid&#124;always` | Fast-session policy |
| `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=strict&#124;fallback` | Unsupported model policy |
| `CODEX_MULTI_AUTH_SYNC_CODEX_CLI=0/1` | Disable/enable Codex CLI state sync |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=<ms>` | Fetch timeout override |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=<ms>` | Stream stall timeout override |
| `DEBUG_CODEX_PLUGIN=1` | Debug logs |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | Request logging |
| `CODEX_PLUGIN_LOG_BODIES=1` | Raw payload logging (sensitive) |

## Storage Paths

| Data | Path |
| --- | --- |
| Accounts (global) | `~/.opencode/openai-codex-accounts.json` |
| Accounts (per-project) | `~/.opencode/projects/<project-key>/openai-codex-accounts.json` |
| Flagged accounts | `~/.opencode/openai-codex-flagged-accounts.json` |
| Logs | `~/.opencode/logs/codex-plugin/` |
| Cache | `~/.opencode/cache/` |

## Validation Commands

```bash
codex auth list
codex auth report --json
codex auth doctor --fix --dry-run
```

## Upstream Auth-Merge Note

The OpenCode upstream proposal in [OPENCODE_PR_PROPOSAL.md](OPENCODE_PR_PROPOSAL.md) recommends this policy when multiple plugins register auth methods for the same provider:

- deterministic plugin order by plugin name (case-insensitive sort)
- primary loader from sorted index `0`
- merged auth method list deduped by `id + label`

## Related

- [getting-started.md](getting-started.md)
- [troubleshooting.md](troubleshooting.md)
- [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md)

