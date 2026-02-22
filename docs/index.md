# OpenCode OpenAI Codex Auth Plugin

[![npm version](https://img.shields.io/npm/v/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)
[![Tests](https://github.com/ndycode/codex-multi-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/ndycode/codex-multi-auth/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)

> Access GPT-5 Codex through your ChatGPT Plus/Pro subscription in OpenCode

---

<details open>
<summary><b>Usage Notice</b></summary>

> [!CAUTION]
> **This plugin is for personal development use only.** It uses OpenAI's official OAuth authentication (the same method as OpenAI's official Codex CLI) for individual coding assistance with your ChatGPT Plus/Pro subscription.
>
> **Not for:** Commercial services, API resale, or multi-user applications. For production use, see [OpenAI Platform API](https://platform.openai.com/).
>
> Users are responsible for compliance with [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use/).

</details>

---

## Quick Links

### For Users

| Guide | Description |
|-------|-------------|
| [Getting Started](getting-started.md) | Complete installation and setup |
| [Configuration](configuration.md) | Advanced config options and patterns |
| [Troubleshooting](troubleshooting.md) | Debug techniques and common issues |
| [Privacy & Data](privacy.md) | How your data is handled |
| [Release Notes](https://github.com/ndycode/codex-multi-auth/releases) | Version history |

### For Developers

| Guide | Description |
|-------|-------------|
| [Repository Scope Map](development/REPOSITORY_SCOPE.md) | Canonical ownership map for paths and extension points |
| [Architecture](development/ARCHITECTURE.md) | Technical design, AI SDK compatibility |
| [Config System](development/CONFIG_FLOW.md) | Configuration loading and merging |
| [Config Fields](development/CONFIG_FIELDS.md) | Understanding config keys and fields |
| [Testing Guide](development/TESTING.md) | Test scenarios and verification |
| [TUI Parity Checklist](development/TUI_PARITY_CHECKLIST.md) | Auth dashboard/UI parity requirements |

---

## Quick Start

```bash
# 1. Install
npx -y codex-multi-auth@latest

# 2. Authenticate
opencode auth login

# 3. Use it
opencode run "Hello" --model=openai/gpt-5.2 --variant=medium
```

For detailed setup, see [Getting Started](getting-started.md).

---

## Features

| Feature | Description |
|---------|-------------|
| **OAuth Authentication** | Secure ChatGPT Plus/Pro login |
| **27 Template Presets** | GPT-5.2, 5.3-Codex, 5.1-Codex-Max, 5.1-Codex, 5.1-Codex-Mini, 5.1 (plus optional manual Spark IDs) |
| **Variant System** | Works with OpenCode v1.0.210+ variants and legacy presets |
| **Multi-Account** | Auto-rotation when rate-limited |
| **Per-Model Config** | Different reasoning effort per model |
| **Multi-Turn** | Full conversation history with stateless backend |
| **Fast Session Mode** | Optional low-latency tuning for quick interactive turns |
| **Comprehensive Tests** | 1500+ tests (80% coverage threshold) + integration tests |

---

## Why This Plugin?

**Use your ChatGPT subscription instead of OpenAI API credits**

| Benefit | Description |
|---------|-------------|
| No separate API key | Uses ChatGPT OAuth |
| Access Codex models | Through ChatGPT Plus/Pro |
| Same auth as Codex CLI | Official OAuth flow |
| Full feature parity | With Codex CLI |

---

## How It Works

The plugin intercepts OpenCode's OpenAI SDK requests and transforms them for the ChatGPT backend API:

```
OpenCode SDK Request
        ↓
    OAuth Token Management (auto-refresh)
        ↓
    Request Transformation (SDK → Codex API)
        ↓
    AI SDK Compatibility (filter constructs)
        ↓
    Stateless Operation (store: false)
        ↓
ChatGPT Codex Backend
```

See [Architecture](development/ARCHITECTURE.md) and [TUI Parity Checklist](development/TUI_PARITY_CHECKLIST.md) for technical details and UI parity criteria.

---

## Support

| Resource | Link |
|----------|------|
| Issues | [GitHub Issues](https://github.com/ndycode/codex-multi-auth/issues) |
| Releases | [Release Notes](https://github.com/ndycode/codex-multi-auth/releases) |
| Repository | [GitHub](https://github.com/ndycode/codex-multi-auth) |

---

## Credits

| Contributor | Role |
|-------------|------|
| [numman-ali](https://github.com/numman-ali) | Original plugin author |
| [ndycode](https://github.com/ndycode) | Multi-account support and maintenance |

---

## License

MIT License with Usage Disclaimer — See [LICENSE](../LICENSE) for details.

**Trademark Notice:** Not affiliated with OpenAI. ChatGPT, GPT-5, Codex, and OpenAI are trademarks of OpenAI, L.L.C.
