# OpenAI Codex Auth Plugin for OpenCode

[![npm version](https://img.shields.io/npm/v/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)
[![npm downloads](https://img.shields.io/npm/dw/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)

OAuth plugin for OpenCode that lets you use ChatGPT Plus/Pro rate limits with models like `gpt-5.2`, `gpt-5-codex`, and `gpt-5.1-codex-max` (plus optional entitlement-gated Spark IDs and legacy Codex aliases).

> [!NOTE]
> **Renamed from `opencode-openai-codex-auth-multi`** — If you were using the old package, update your config to use `codex-multi-auth` instead. The rename was necessary because OpenCode blocks plugins containing `opencode-openai-codex-auth` in the name.

## What You Get

- **GPT-5.2, GPT-5 Codex, GPT-5.1 Codex Max** and all GPT-5.x variants via ChatGPT OAuth
- **Multi-account support** — Add up to 20 ChatGPT accounts, health-aware rotation with automatic failover
- **Codex CLI source-of-truth sync** — Reads canonical accounts from `~/.codex/accounts.json`, with compatibility mirror state for plugin runtime metadata
- **Click-to-switch** — Switch accounts directly from the OpenCode TUI
- **Strict tool validation** — Automatically cleans schemas for compatibility with strict models
- **Auto-update notifications** — Get notified when a new version is available
- **27 template model presets** — Full variant system with reasoning levels (none/low/medium/high/xhigh)
- **Prompt caching** — Session-based caching for faster multi-turn conversations
- **Usage-aware errors** — Friendly messages with rate limit reset timing
- **Plugin compatible** — Works alongside other OpenCode plugins (oh-my-opencode, dcp, etc.)

## Documentation & Repository Map

Start here if you are implementing or auditing changes:

- [Docs Portal](docs/README.md) - central navigation
- [Repository Scope Map](docs/development/REPOSITORY_SCOPE.md) - canonical ownership and extension points
- [Architecture](docs/development/ARCHITECTURE.md) - request pipeline and protocol behavior
- [Configuration Guide](docs/configuration.md) - all runtime options
- [Testing Guide](docs/development/TESTING.md) - test coverage and verification workflow

### Scope ownership (high level)

| Path | Responsibility |
| --- | --- |
| `index.ts` | Plugin entry, request orchestration, tool registration |
| `lib/auth/` | OAuth login, callback handling, token lifecycle |
| `lib/request/` | Request normalization, backend fetch behavior, SSE response handling |
| `lib/prompts/` | Codex/OpenCode prompt bridge and prompt sync logic |
| `lib/storage/` | Account persistence paths and migrations |
| `lib/codex-cli/` | Codex CLI account/state synchronization |
| `test/` | Unit, integration, and property tests |
| `scripts/` | Build and install helper scripts |
| `config/` | User config templates (modern/legacy/minimal) |
| `docs/` | User and developer documentation |
| `dist/` | Generated build output (do not edit by hand) |

### AGENTS hierarchy

- `AGENTS.md` applies repository-wide.
- `lib/AGENTS.md` applies to `lib/**`.
- `test/AGENTS.md` applies to `test/**`.

### Quick tree

```text
.
|-- index.ts
|-- lib/
|-- test/
|-- scripts/
|-- config/
|-- docs/
`-- dist/ (generated)
```
---

<details open>
<summary><b>Terms of Service Warning — Read Before Installing</b></summary>

> [!CAUTION]
> This plugin uses OpenAI's official OAuth authentication (the same method as OpenAI's official Codex CLI) for personal development use with your ChatGPT Plus/Pro subscription.
>
> **This plugin is for personal development only:**
> - Not for commercial services, API resale, or multi-user applications
> - For production use, see [OpenAI Platform API](https://platform.openai.com/)
>
> **By using this plugin, you acknowledge:**
> - This is an unofficial tool not endorsed by OpenAI
> - Users are responsible for compliance with [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use/)
> - You assume all risks associated with using this plugin

</details>

---

## Installation

<details open>
<summary><b>For Humans</b></summary>

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the codex-multi-auth plugin and add the OpenAI model definitions to ~/.config/opencode/opencode.json by following: https://raw.githubusercontent.com/ndycode/codex-multi-auth/main/README.md
```

**Option B: One-command install**

```bash
npx -y codex-multi-auth@latest
```

This writes the config to `~/.config/opencode/opencode.json`, backs up existing config, and clears the plugin cache.

> Want legacy config (OpenCode v1.0.209 and below)? Add `--legacy` flag.

**Option C: Manual setup**

1. **Add the plugin** to `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugin": ["codex-multi-auth@latest"]
   }
   ```

2. **Login** with your ChatGPT account:

   ```bash
   opencode auth login
   ```

3. **Add models** — Copy the [full configuration](#models) below

4. **Use it:**

   ```bash
   opencode run "Hello" --model=openai/gpt-5.2 --variant=medium
   ```

</details>

<details>
<summary><b>For LLM Agents</b></summary>

### Step-by-Step Instructions

1. Edit the OpenCode configuration file at `~/.config/opencode/opencode.json`
   
   > **Note**: This path works on all platforms. On Windows, `~` resolves to your user home directory (e.g., `C:\Users\YourName`).

2. Add the plugin to the `plugin` array:
   ```json
   {
     "plugin": ["codex-multi-auth@latest"]
   }
   ```

3. Add the model definitions from the [Full Models Configuration](#full-models-configuration-copy-paste-ready) section

4. Set `provider` to `"openai"` and choose a model

### Verification

```bash
opencode run "Hello" --model=openai/gpt-5.2 --variant=medium
```

</details>

---

## Models

### Model Reference

| Model | Variants | Notes |
|-------|----------|-------|
| `gpt-5.2` | none, low, medium, high, xhigh | Latest GPT-5.2 with reasoning levels |
| `gpt-5-codex` | low, medium, high | Canonical Codex model for code generation (default: high) |
| `gpt-5.3-codex-spark` | low, medium, high, xhigh | Spark IDs are supported by the plugin, but access is entitlement-gated by account/workspace |
| `gpt-5.1-codex-max` | low, medium, high, xhigh | Maximum context Codex |
| `gpt-5.1-codex` | low, medium, high | Standard Codex |
| `gpt-5.1-codex-mini` | medium, high | Lightweight Codex |
| `gpt-5.1` | none, low, medium, high | GPT-5.1 base model |

Config templates intentionally omit Spark model IDs by default to reduce entitlement failures on unsupported accounts. Add Spark manually only if your workspace is entitled.

**Using variants:**
```bash
# Modern OpenCode (v1.0.210+)
opencode run "Hello" --model=openai/gpt-5.2 --variant=high

# Legacy OpenCode (v1.0.209 and below)
opencode run "Hello" --model=openai/gpt-5.2-high
```

<details>
<summary><b>Full Models Configuration (Copy-Paste Ready)</b></summary>

Add this to your `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["codex-multi-auth@latest"],
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "reasoningSummary": "auto",
        "textVerbosity": "medium",
        "include": ["reasoning.encrypted_content"],
        "store": false
      },
      "models": {
        "gpt-5.2": {
          "name": "GPT 5.2 (OAuth)",
          "limit": { "context": 272000, "output": 128000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "none": { "reasoningEffort": "none" },
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "xhigh": { "reasoningEffort": "xhigh" }
          }
        },
        "gpt-5-codex": {
          "name": "GPT 5 Codex (OAuth)",
          "limit": { "context": 272000, "output": 128000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" }
          },
          "options": {
            "reasoningEffort": "high",
            "reasoningSummary": "detailed"
          }
        },
        "gpt-5.1-codex-max": {
          "name": "GPT 5.1 Codex Max (OAuth)",
          "limit": { "context": 272000, "output": 128000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "xhigh": { "reasoningEffort": "xhigh" }
          }
        },
        "gpt-5.1-codex": {
          "name": "GPT 5.1 Codex (OAuth)",
          "limit": { "context": 272000, "output": 128000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" }
          }
        },
        "gpt-5.1-codex-mini": {
          "name": "GPT 5.1 Codex Mini (OAuth)",
          "limit": { "context": 272000, "output": 128000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" }
          }
        },
        "gpt-5.1": {
          "name": "GPT 5.1 (OAuth)",
          "limit": { "context": 272000, "output": 128000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "none": { "reasoningEffort": "none" },
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" }
          }
        }
      }
    }
  }
}
```

Optional Spark model block (manual add only when entitled):
```json
"gpt-5.3-codex-spark": {
  "name": "GPT 5.3 Codex Spark (OAuth)",
  "limit": { "context": 272000, "output": 128000 },
  "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
  "variants": {
    "low": { "reasoningEffort": "low" },
    "medium": { "reasoningEffort": "medium" },
    "high": { "reasoningEffort": "high" },
    "xhigh": { "reasoningEffort": "xhigh" }
  }
}
```

For legacy OpenCode (v1.0.209 and below), use `config/opencode-legacy.json` which has individual model entries like `gpt-5.2-low`, `gpt-5.2-medium`, etc.

</details>

---

## Multi-Account Setup

Add multiple ChatGPT accounts for higher combined quotas. The plugin uses **health-aware rotation** with automatic failover and supports up to 20 accounts.

```bash
opencode auth login  # Run again to add more accounts
```

---

## Account Management Tools

The plugin provides built-in tools for managing your OpenAI accounts. These are available directly in OpenCode — just ask the agent or type the tool name.

> **Note:** Tools were renamed from `openai-accounts-*` to `codex-*` in v4.12.0 for brevity.
>
> **Default v1 surface:** `codex-list`, `codex-switch`, `codex-status`, `codex-health`.
> Advanced admin tools (`codex-metrics`, `codex-refresh`, `codex-remove`, `codex-export`, `codex-import`) are hidden by default and can be enabled with `CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS=1`.

### Hashline Editing (Plain OpenCode)

This plugin now provides a true hashline editing engine on plain OpenCode by overriding `edit` and adding `hashline_read`.

Use this standard flow:

1. Read hashline refs:

```
hashline_read path="src/file.ts"
```

2. Edit with hash-verified refs:

```
edit path="src/file.ts" lineRef="L42#deadbeef" operation="replace" content="new code"
```

3. Optional range edit:

```
edit path="src/file.ts" lineRef="L42#deadbeef" endLineRef="L44#feedcafe" operation="replace" content="replacement block"
```

4. Legacy fallback (still supported):

```
edit path="src/file.ts" oldString="from" newString="to"
```

No extra plugin is required. This works with plain OpenCode + `codex-multi-auth`.

---

### codex-list

List all configured accounts with their status.

```
codex-list
```

**Output:**
```
OpenAI Accounts (3 total):

  [1] user@gmail.com (active)
  [2] work@company.com
  [3] backup@email.com

Use codex-switch to change active account.
```

---

### codex-switch

Switch to a different account by index (1-based).

```
codex-switch index=2
```

**Output:**
```
Switched to account [2] work@company.com
```

---

### codex-status

Show detailed status including rate limits and health scores.

```
codex-status
```

**Output:**
```
OpenAI Account Status:

[1] user@gmail.com (active)
    Health: 100/100
    Rate Limit: 45/50 requests remaining
    Resets: 2m 30s
    Last Used: 5 minutes ago

[2] work@company.com
    Health: 85/100
    Rate Limit: 12/50 requests remaining
    Resets: 8m 15s
    Last Used: 1 hour ago
```

---

### Advanced Admin Tools (Optional)

The following tools are available only when:

```bash
CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS=1 opencode
```

---

### codex-metrics

Show live runtime metrics (request counts, latency, errors, rotations) for the current plugin process.

```
codex-metrics
```

**Output:**
```
Codex Plugin Metrics:

Uptime: 12m
Total upstream requests: 84
Successful responses: 77
Failed responses: 7
Average successful latency: 842ms
```

---

### codex-health

Check if all account tokens are still valid (read-only check).

```
codex-health
```

**Output:**
```
Checking 3 account(s):

  ✓ [1] user@gmail.com: Healthy
  ✓ [2] work@company.com: Healthy
  ✗ [3] old@expired.com: Token expired

Summary: 2 healthy, 1 unhealthy
```

---

### codex-refresh

Refresh all OAuth tokens and save them to disk. Use this after long idle periods.

```
codex-refresh
```

**Output:**
```
Refreshing 3 account(s):

  ✓ [1] user@gmail.com: Refreshed
  ✓ [2] work@company.com: Refreshed
  ✗ [3] old@expired.com: Failed - Token expired

Summary: 2 refreshed, 1 failed
```

**Difference from health check:** `codex-health` only validates tokens. `codex-refresh` actually refreshes them and saves new tokens to disk.

---

### codex-remove

Remove an account by index. Useful for cleaning up expired accounts.

```
codex-remove index=3
```

**Output:**
```
Removed: [3] old@expired.com

Remaining accounts: 2
```

---

### codex-export

Export all accounts to a portable JSON file. Useful for backup or migration.

```
codex-export path="~/backup/accounts.json"
```

**Output:**
```
Exported 3 account(s) to ~/backup/accounts.json
```

---

### codex-import

Import accounts from a JSON file (exported via `codex-export`). Merges with existing accounts.

```
codex-import path="~/backup/accounts.json"
```

**Output:**
```
Imported 2 new account(s) (1 duplicate skipped)

Total accounts: 4
```

---

### Quick Reference

| Tool | What It Does | Example |
|------|--------------|---------|
| `codex-list` | List all accounts | "list my accounts" |
| `codex-switch` | Switch active account | "switch to account 2" |
| `codex-status` | Show rate limits & health | "show account status" |
| `codex-health` | Validate tokens (read-only) | "check account health" |
| `codex-metrics` | Show runtime metrics (advanced, env-gated) | "show plugin metrics" |
| `codex-refresh` | Refresh & save tokens (advanced, env-gated) | "refresh my tokens" |
| `codex-remove` | Remove an account (advanced, env-gated) | "remove account 3" |
| `codex-export` | Export accounts to file (advanced, env-gated) | "export my accounts" |
| `codex-import` | Import accounts from file (advanced, env-gated) | "import accounts from backup" |
| `hashline_read` | Read hashline refs for deterministic edits | "show hashline refs for src/file.ts" |
| `edit` | Hashline-capable edit engine (or legacy oldString/newString) | "replace lineRef L42#... with new content" |

---

## Rotation Behavior

**How rotation works:**
- Health scoring tracks success/failure per account
- Token bucket prevents hitting rate limits
- Hybrid selection prefers healthy accounts with available tokens
- Always retries when all accounts are rate-limited (waits for reset with live countdown)
- 20% jitter on retry delays to avoid thundering herd
- Auto-removes accounts after 3 consecutive auth failures (new in v4.11.0)
- Active-account writeback to Codex CLI happens on:
  - explicit user selection (`codex-switch` / account-select event)
  - successful routed upstream requests
  - it does **not** write during failed failover attempts

**Codex CLI source of truth (default):**

By default, account identity and active selection are sourced from `~/.codex/accounts.json`.
The plugin keeps compatibility/runtime metadata in its own storage file and reconciles with Codex CLI state.

When sync is enabled (`CODEX_MULTI_AUTH_SYNC_CODEX_CLI=1`, default), per-project account storage overrides are ignored and global storage is used.
Legacy env `CODEX_AUTH_SYNC_CODEX_CLI` is still accepted for compatibility and logs a deprecation warning.

**Storage locations:**
- Codex CLI canonical state: `~/.codex/accounts.json`
- Plugin mirror/runtime metadata: `~/.opencode/openai-codex-accounts.json`
- Plugin config: `~/.opencode/codex-multi-auth-config.json`

---

## Troubleshooting

> **Quick reset**: Most issues can be resolved by deleting `~/.opencode/auth/openai.json` and running `opencode auth login` again.

### Configuration Paths (All Platforms)

OpenCode uses `~/.config/opencode/` on **all platforms** including Windows.

| File | Path |
|------|------|
| Main config | `~/.config/opencode/opencode.json` |
| Auth tokens | `~/.opencode/auth/openai.json` |
| Codex CLI accounts (canonical) | `~/.codex/accounts.json` |
| Plugin account metadata (global mirror) | `~/.opencode/openai-codex-accounts.json` |
| Plugin config | `~/.opencode/codex-multi-auth-config.json` |
| Debug logs | `~/.opencode/logs/codex-plugin/` |

> **Windows users**: `~` resolves to your user home directory (e.g., `C:\Users\YourName`).

---

<details>
<summary><b>401 Unauthorized Error</b></summary>

**Cause:** Token expired or not authenticated.

**Solutions:**
1. Re-authenticate:
   ```bash
   opencode auth login
   ```
2. Check auth file exists:
   ```bash
   cat ~/.opencode/auth/openai.json
   ```

</details>

<details>
<summary><b>Browser Doesn't Open for OAuth</b></summary>

**Cause:** Port 1455 conflict or SSH/WSL environment.

**Solutions:**
1. **Manual URL paste:**
   - Re-run `opencode auth login`
   - Select **"ChatGPT Plus/Pro (manual URL paste)"**
   - Paste the full redirect URL (including `#code=...`) after login

2. **Check port availability:**
   ```bash
   # macOS/Linux
   lsof -i :1455
   
   # Windows
   netstat -ano | findstr :1455
   ```

3. **Stop Codex CLI if running** — Both use port 1455

</details>

<details>
<summary><b>Model Not Found</b></summary>

**Cause:** Missing provider prefix or config mismatch.

**Solutions:**
1. Use `openai/` prefix:
   ```bash
   # Correct
   --model=openai/gpt-5.2
   
   # Wrong
   --model=gpt-5.2
   ```

2. Verify model is in your config:
   ```json
   { "models": { "gpt-5.2": { ... } } }
   ```

</details>

<details>
<summary><b>Unsupported Codex Model for ChatGPT Account</b></summary>

**Error example:** `Bad Request: {"detail":"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."}`

**Cause:** Active workspace/account is not entitled for the requested Codex model.

**Solutions:**
1. Re-auth to refresh workspace selection (most common Spark fix):
   ```bash
   opencode auth login
   ```
2. Add another entitled account/workspace. The plugin will try remaining accounts/workspaces before model fallback.
3. Enable automatic fallback only if you want degraded-model retries when Spark is not entitled:
   ```bash
   CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback opencode
   ```
4. Use custom fallback chain in `~/.opencode/codex-multi-auth-config.json`:
   ```json
   {
     "unsupportedCodexPolicy": "fallback",
     "fallbackOnUnsupportedCodexModel": true,
     "unsupportedCodexFallbackChain": {
       "gpt-5-codex": ["gpt-5.2-codex"],
       "gpt-5.3-codex": ["gpt-5-codex", "gpt-5.2-codex"],
       "gpt-5.3-codex-spark": ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"]
     }
   }
   ```
5. Verify effective upstream model when needed:
   ```bash
   ENABLE_PLUGIN_REQUEST_LOGGING=1 CODEX_PLUGIN_LOG_BODIES=1 opencode run "ping" --model=openai/gpt-5.3-codex-spark
   ```
   The UI can keep showing your selected model while fallback is applied internally.

</details>

<details>
<summary><b>Rate Limit Exceeded</b></summary>

**Cause:** ChatGPT subscription usage limit reached.

**Solutions:**
1. Wait for reset (plugin shows timing in error message)
2. Add more accounts: `opencode auth login`
3. Switch to a different model family

</details>

<details>
<summary><b>Multi-Turn Context Lost</b></summary>

**Cause:** Old plugin version or missing config.

**Solutions:**
1. Update plugin:
   ```bash
   npx -y codex-multi-auth@latest
   ```
2. Ensure config has:
   ```json
   {
     "include": ["reasoning.encrypted_content"],
     "store": false
   }
   ```

</details>

<details>
<summary><b>OAuth Callback Issues (Safari/WSL/Docker)</b></summary>

**Safari HTTPS-only mode:**
- Use Chrome or Firefox instead, or
- Temporarily disable Safari > Settings > Privacy > "Enable HTTPS-only mode"

**WSL2:**
- Use VS Code's port forwarding, or
- Configure Windows → WSL port forwarding

**SSH / Remote:**
```bash
ssh -L 1455:localhost:1455 user@remote
```

**Docker / Containers:**
- OAuth with localhost redirect doesn't work in containers
- Use SSH port forwarding or manual URL flow

</details>

---

## Plugin Compatibility

### oh-my-opencode

Works alongside oh-my-opencode. No special configuration needed.

```json
{
  "plugin": [
    "codex-multi-auth@latest",
    "oh-my-opencode@latest"
  ]
}
```

### @tarquinen/opencode-dcp

List this plugin before dcp:

```json
{
  "plugin": [
    "codex-multi-auth@latest",
    "@tarquinen/opencode-dcp@latest"
  ]
}
```

### Plugins You Don't Need

- **openai-codex-auth** — Not needed. This plugin replaces the original.

---

## Configuration

Create `~/.opencode/codex-multi-auth-config.json` for optional settings:

### Model Behavior

| Option | Default | What It Does |
|--------|---------|--------------|
| `codexMode` | `true` | Uses Codex-OpenCode bridge prompt (synced with latest Codex CLI) |
| `codexTuiV2` | `true` | Enables Codex-style terminal UI output (set `false` for legacy output) |
| `codexTuiColorProfile` | `truecolor` | Terminal color profile for Codex UI (`truecolor`, `ansi256`, `ansi16`) |
| `codexTuiGlyphMode` | `ascii` | Glyph mode for Codex UI (`ascii`, `unicode`, `auto`) |
| `fastSession` | `false` | Forces low-latency settings per request (`reasoningEffort=none/low`, `reasoningSummary=auto`, `textVerbosity=low`) |
| `fastSessionStrategy` | `hybrid` | `hybrid` speeds simple turns but keeps full-depth on complex prompts; `always` forces fast tuning on every turn |
| `fastSessionMaxInputItems` | `30` | Max input items kept when fast tuning is applied |

### Account Settings (v4.10.0+)

| Option | Default | What It Does |
|--------|---------|--------------|
| `perProjectAccounts` | `true` | Legacy setting. When Codex CLI sync is enabled (default), this is ignored and global storage is used. |
| `toastDurationMs` | `5000` | How long toast notifications stay visible (ms) |

### Retry Behavior

| Option | Default | What It Does |
|--------|---------|--------------|
| `retryAllAccountsRateLimited` | `true` | Wait and retry when all accounts are rate-limited |
| `retryAllAccountsMaxWaitMs` | `0` | Max wait time (0 = unlimited) |
| `retryAllAccountsMaxRetries` | `Infinity` | Max retry attempts |
| `unsupportedCodexPolicy` | `strict` | Unsupported-model behavior: `strict` (return entitlement error) or `fallback` (retry next model in fallback chain) |
| `fallbackOnUnsupportedCodexModel` | `false` | Legacy fallback toggle mapped to `unsupportedCodexPolicy` (prefer using `unsupportedCodexPolicy`) |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` | Legacy compatibility toggle for the `gpt-5.3-codex -> gpt-5.2-codex` edge when generic fallback is enabled |
| `unsupportedCodexFallbackChain` | `{}` | Optional per-model fallback-chain override (map of `model -> [fallback1, fallback2, ...]`) |
| `fetchTimeoutMs` | `60000` | Request timeout to Codex backend (ms) |
| `streamStallTimeoutMs` | `45000` | Abort non-stream parsing if SSE stalls (ms) |

Default unsupported-model fallback chain (used when `unsupportedCodexPolicy` is `fallback`):
- `gpt-5.3-codex -> gpt-5-codex -> gpt-5.2-codex`
- `gpt-5.3-codex-spark -> gpt-5-codex -> gpt-5.3-codex -> gpt-5.2-codex` (applies if you manually select Spark model IDs)
- `gpt-5.2-codex -> gpt-5-codex`
- `gpt-5.1-codex -> gpt-5-codex`

### Environment Variables

```bash
DEBUG_CODEX_PLUGIN=1 opencode                    # Enable debug logging
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode         # Log request metadata
CODEX_PLUGIN_LOG_BODIES=1 opencode               # Include raw request/response payloads in request logs (sensitive)
CODEX_PLUGIN_LOG_LEVEL=debug opencode            # Set log level (debug|info|warn|error)
CODEX_MODE=0 opencode                            # Temporarily disable bridge prompt
CODEX_TUI_V2=0 opencode                          # Disable Codex-style UI (legacy output)
CODEX_TUI_COLOR_PROFILE=ansi16 opencode          # Force UI color profile
CODEX_TUI_GLYPHS=unicode opencode                # Override glyph mode (ascii|unicode|auto)
CODEX_AUTH_PREWARM=0 opencode                    # Disable startup prewarm (prompt/instruction cache warmup)
CODEX_AUTH_FAST_SESSION=1 opencode               # Enable faster response defaults
CODEX_AUTH_FAST_SESSION_STRATEGY=always opencode # Force fast mode for all prompts
CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS=24 opencode # Tune fast-mode history window
CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback opencode # Enable generic unsupported-model fallback
CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1 opencode # Legacy fallback toggle (prefer policy var above)
CODEX_AUTH_FALLBACK_GPT53_TO_GPT52=0 opencode    # Disable only the legacy gpt-5.3 -> gpt-5.2 edge
CODEX_MULTI_AUTH_SYNC_CODEX_CLI=0 opencode       # Disable Codex CLI source-of-truth sync (not recommended)
CODEX_AUTH_SYNC_CODEX_CLI=0 opencode             # Legacy sync env (deprecated; use CODEX_MULTI_AUTH_SYNC_CODEX_CLI)
CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS=1 opencode   # Expose advanced codex-* admin tools
CODEX_AUTH_FETCH_TIMEOUT_MS=120000 opencode      # Override request timeout
CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=60000 opencode # Override SSE stall timeout
```

For all options, see [docs/configuration.md](docs/configuration.md).

---

---

## Documentation

- [Docs Portal](docs/README.md) - Navigation hub for all docs
- [Getting Started](docs/getting-started.md) - Complete installation guide
- [Configuration](docs/configuration.md) - All configuration options
- [Troubleshooting](docs/troubleshooting.md) - Common issues and fixes
- [Architecture](docs/development/ARCHITECTURE.md) - How the plugin works
- [Repository Scope Map](docs/development/REPOSITORY_SCOPE.md) - Path ownership, module boundaries, extension points
- [Documentation Structure](docs/DOCUMENTATION.md) - How docs are organized in this repo

---

## Credits

- [numman-ali/opencode-openai-codex-auth](https://github.com/numman-ali/opencode-openai-codex-auth) by [numman-ali](https://github.com/numman-ali) — Original plugin
- [ndycode](https://github.com/ndycode) — Multi-account support and maintenance

## License

MIT License. See [LICENSE](LICENSE) for details.

<details>
<summary><b>Legal</b></summary>

### Intended Use

- Personal / internal development only
- Respect subscription quotas and data handling policies
- Not for production services or bypassing intended limits

### Warning

By using this plugin, you acknowledge:

- **Terms of Service risk** — This approach may violate ToS of AI model providers
- **No guarantees** — APIs may change without notice
- **Assumption of risk** — You assume all legal, financial, and technical risks

### Disclaimer

- Not affiliated with OpenAI. This is an independent open-source project.
- "ChatGPT", "GPT-5", "Codex", and "OpenAI" are trademarks of OpenAI, L.L.C.

</details>
