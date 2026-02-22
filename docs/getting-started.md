# Getting Started

Complete installation and setup guide for the OpenCode OpenAI Codex Auth Plugin.

---

<details open>
<summary><b>Before You Begin</b></summary>

> [!CAUTION]
> **This plugin is for personal development use only.** It uses OpenAI's official OAuth authentication for individual coding assistance with your ChatGPT Plus/Pro subscription.
>
> **Not intended for:** Commercial services, API resale, multi-user applications, or any use that violates [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use/).
>
> For production applications, use the [OpenAI Platform API](https://platform.openai.com/).

</details>

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **OpenCode** | [Installation guide](https://opencode.ai) |
| **ChatGPT Plus or Pro** | Required for Codex access |
| **Node.js 20+** | For OpenCode runtime |

---

## Installation

<details open>
<summary><b>Option A: One-Command Install (Recommended)</b></summary>

Works on **Windows, macOS, and Linux**:

```bash
npx -y codex-multi-auth@latest
```

This:
- Writes config to `~/.config/opencode/opencode.json`
- Backs up existing config
- Clears OpenCode plugin cache

**Legacy OpenCode (v1.0.209 and below)?**
```bash
npx -y codex-multi-auth@latest --legacy
```

</details>

<details>
<summary><b>Option B: Install from Source</b></summary>

```bash
git clone https://github.com/ndycode/codex-multi-auth.git
cd codex-multi-auth
npm ci
npm run build
```

Point OpenCode at the local build output:

```json
{
  "plugin": ["file:///absolute/path/to/codex-multi-auth/dist"]
}
```

> **Note**: Must point to `dist/` folder (built output), not root.

</details>

---

## Setup Steps

### Step 1: Add Plugin to Config

Edit `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["codex-multi-auth@latest"]
}
```

> If you installed from source, use the `file://` path instead.

### Step 2: Authenticate

```bash
opencode auth login
```

1. Select **"OpenAI"**
2. Choose **"ChatGPT Plus/Pro (Codex Subscription)"**
3. Browser opens automatically for OAuth flow
4. Log in with your ChatGPT account
5. Done! Token saved to `~/.opencode/auth/openai.json`

<details>
<summary><b>OAuth Not Working?</b></summary>

**Port conflict:**
- Stop Codex CLI if running (both use port 1455)
- Check: `lsof -i :1455` (macOS/Linux) or `netstat -ano | findstr :1455` (Windows)

**SSH/WSL/Remote:**
- Select **"ChatGPT Plus/Pro (Manual URL Paste)"**
- Paste the full redirect URL after login

</details>

### Step 3: Add Model Configuration

Use one of the provided config files:

| OpenCode Version | Config File |
|------------------|-------------|
| v1.0.210+ (modern) | `config/opencode-modern.json` |
| v1.0.209 and below | `config/opencode-legacy.json` |

Copy the relevant config to your `~/.config/opencode/opencode.json`.

The shipped templates include 27 presets in modern mode and 22 presets in legacy mode, and intentionally omit Spark IDs. Add `gpt-5.3-codex-spark` manually only when your workspace is entitled.

<details>
<summary><b>Why use the full config?</b></summary>

- GPT-5 models need proper configuration to work reliably
- Full configs include `limit` metadata for OpenCode UI features
- Minimal configs are for debugging only

</details>

### Step 4: Test It

```bash
# Modern OpenCode (v1.0.210+)
opencode run "write hello world to test.txt" --model=openai/gpt-5.2 --variant=medium
opencode run "write hello world to test.txt" --model=openai/gpt-5-codex --variant=medium

# Legacy OpenCode (v1.0.209 and below)
opencode run "write hello world to test.txt" --model=openai/gpt-5.2-medium

# Or start interactive session
opencode
```

You'll see all 27 GPT-5.x variants in the model selector!

If `gpt-5-codex` or `gpt-5.3-codex-spark` returns an unsupported-model entitlement error, re-auth with `opencode auth login` or add another entitled account/workspace first. The plugin tries remaining accounts/workspaces before model fallback. See [Configuration](configuration.md) for strict vs fallback policy controls.

If you manually add Spark IDs and want to confirm effective upstream routing, run with `ENABLE_PLUGIN_REQUEST_LOGGING=1 CODEX_PLUGIN_LOG_BODIES=1` and inspect `~/.opencode/logs/codex-plugin/request-*-after-transform.json`.

---

## Available Models

| Model | Variants | Notes |
|-------|----------|-------|
| `gpt-5.2` | none, low, medium, high, xhigh | Latest GPT-5.2 |
| `gpt-5-codex` | low, medium, high | Canonical Codex for code generation |
| `gpt-5.3-codex-spark` | low, medium, high, xhigh | Optional manual model; entitlement-gated by account/workspace |
| `gpt-5.1-codex-max` | low, medium, high, xhigh | Maximum context |
| `gpt-5.1-codex` | low, medium, high | Standard Codex |
| `gpt-5.1-codex-mini` | medium, high | Lightweight |
| `gpt-5.1` | none, low, medium, high | Base model |

**Total: 27 template presets** with 272k context / 128k output (+ optional Spark IDs when entitled).

---

## Configuration Locations

OpenCode checks multiple config files in order:

| Priority | Location | Use Case |
|----------|----------|----------|
| 1 | `./.opencode.json` | Project-specific |
| 2 | Parent directories | Monorepo |
| 3 | `~/.config/opencode/opencode.json` | Global defaults |

**Recommendation**: Plugin in global config, model/agent overrides in project config.

---

## Updating the Plugin

<details>
<summary><b>From npm</b></summary>

OpenCode caches plugins. Re-run the installer:

```bash
npx -y codex-multi-auth@latest
```

</details>

<details>
<summary><b>From source</b></summary>

```bash
cd codex-multi-auth
git pull
npm ci
npm run build
```

</details>

**When to update:**
- New features released
- Bug fixes available
- Security updates

**Check for updates**: [Releases Page](https://github.com/ndycode/codex-multi-auth/releases)

---

## Verifying Installation

### Check Plugin is Loaded

```bash
opencode --version
# Should not show any plugin errors
```

### Check Authentication

```bash
cat ~/.opencode/auth/openai.json
# Should show OAuth credentials
```

### Test API Access

```bash
# Enable logging to verify requests
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.2

# Check logs
ls ~/.opencode/logs/codex-plugin/
```

---

## Next Steps

- [Configuration Guide](configuration.md) — Advanced config options
- [Troubleshooting](troubleshooting.md) — Common issues and solutions
- [Architecture](development/ARCHITECTURE.md) — Technical deep dive

**Back to**: [Documentation Home](index.md) | [Main README](../README.md)
