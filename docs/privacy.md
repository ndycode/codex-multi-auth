# Privacy & Data Handling

This page explains how the OpenCode OpenAI Codex Auth Plugin handles your data and protects your privacy.

## Overview

This plugin prioritizes user privacy and data security. We believe in transparency about data handling and giving you full control over your information.

---

## What We Collect

**Nothing.** This plugin does not collect, store, or transmit usage data to third parties.

- ❌ No telemetry
- ❌ No analytics
- ❌ No usage tracking
- ❌ No personal information collection

---

## Data Storage

All data is stored **locally on your machine**:

### OAuth Tokens
- **Location:** `~/.opencode/auth/openai.json`
- **Contents:** Access tokens, refresh tokens, expiration timestamps
- **Managed by:** OpenCode's credential management system
- **Security:** File permissions restrict access to your user account

### Cache Files
- **Location:** `~/.opencode/cache/`
- **Contents:**
  - `codex-instructions.txt` - Codex system instructions (fetched from GitHub)
  - `codex-instructions-meta.json` - ETag and timestamp metadata
- **Purpose:** Reduce GitHub API calls and improve performance
- **TTL:** 15 minutes (automatically refreshes when stale)

### Debug Logs
- **Location:** `~/.opencode/logs/codex-plugin/`
- **Contents:** Request/response metadata logs (only when `ENABLE_PLUGIN_REQUEST_LOGGING=1` is set)
- **Includes:**
  - Request metadata (model, flags, response status, timing)
  - Raw request/response payloads only when `CODEX_PLUGIN_LOG_BODIES=1` is also set
  - Timestamps
  - Configuration used
- **⚠️ Warning:** Logs may contain your prompts and model responses - handle with care

---

## Data Transmission

### Direct to OpenAI
All API requests go **directly from your machine to OpenAI's servers**:
- ✅ No intermediary proxies
- ✅ No third-party data collection
- ✅ HTTPS encrypted communication
- ✅ OAuth-secured authentication

### What Gets Sent to OpenAI
When you use the plugin, the following is transmitted to OpenAI:
- Your prompts and conversation history
- OAuth access token (for authentication)
- ChatGPT account ID (from token JWT)
- Configuration options (reasoning effort, verbosity, etc.)
- Model selection

**Note:** This is identical to what the official OpenAI Codex CLI sends.

### What Does NOT Get Sent
- ❌ Your filesystem contents (unless explicitly requested via tools)
- ❌ Personal information beyond what's in your prompts
- ❌ Usage statistics or analytics
- ❌ Plugin version or system information

---

## Third-Party Services

### GitHub API
The plugin fetches Codex instructions from GitHub:
- **URL:** `https://api.github.com/repos/openai/codex/releases/latest`
- **Purpose:** Get latest Codex system instructions
- **Frequency:** Once per 15 minutes (cached with ETag)
- **Data sent:** HTTP GET request (no personal data)
- **Rate limiting:** 60 requests/hour (unauthenticated)

### OpenAI Services
All interactions with OpenAI go through:
- **OAuth:** `https://chatgpt.com/oauth`
- **API:** `https://chatgpt.com/backend-api/conversation`

See [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/) for how OpenAI handles data.

---

## Your Data Rights

You have complete control over your data:

### Delete OAuth Tokens
```bash
opencode auth logout
# Or manually:
rm ~/.opencode/auth/openai.json
```

### Delete Cache Files
```bash
rm -rf ~/.opencode/cache/
```

### Delete Logs
```bash
rm -rf ~/.opencode/logs/codex-plugin/
```

### Revoke OAuth Access
1. Visit [ChatGPT Settings → Authorized Apps](https://chatgpt.com/settings/apps)
2. Find "OpenCode" or "Codex CLI"
3. Click "Revoke"

This immediately invalidates all access tokens.

---

## Security Measures

### Token Protection
- **Local storage only:** Tokens never leave your machine except when sent to OpenAI for authentication
- **File permissions:** Auth files are readable only by your user account
- **No logging:** OAuth tokens are never written to debug logs
- **Automatic refresh:** Expired tokens are refreshed automatically

### PKCE Flow
The plugin uses **PKCE (Proof Key for Code Exchange)** for OAuth:
- Prevents authorization code interception attacks
- Industry-standard security for OAuth 2.0
- Same method used by OpenAI's official Codex CLI

### HTTPS Encryption
All network communication uses HTTPS:
- OAuth authorization: Encrypted
- API requests: Encrypted
- Token refresh: Encrypted

---

## Compliance

### OpenAI's Privacy Policy
When using this plugin, you are subject to:
- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/)
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)

**Your responsibility:** Ensure your usage complies with OpenAI's policies.

### GDPR Considerations
This plugin:
- ✅ Does not collect personal data
- ✅ Does not process data on behalf of third parties
- ✅ Stores data locally under your control
- ✅ Provides clear data deletion mechanisms

However, data sent to OpenAI is subject to OpenAI's privacy practices.

---

## Transparency

### Open Source
The entire plugin source code is available at:
- **GitHub:** [https://github.com/ndycode/codex-multi-auth](https://github.com/ndycode/codex-multi-auth)


You can:
- Review all code
- Audit data handling
- Verify no hidden telemetry
- Inspect network requests

### No Hidden Behavior
- No obfuscated code
- No minified dependencies
- All network requests are documented
- Debug logging shows exactly what's sent to APIs

---

## Questions?

For privacy-related questions:
- **Plugin-specific:** [GitHub Issues](https://github.com/ndycode/codex-multi-auth/issues)

- **OpenAI data handling:** [OpenAI Support](https://help.openai.com/)
- **Security concerns:** See [SECURITY.md](../SECURITY.md)

---

**Last Updated:** 2025-10-12

**Back to:** [Documentation Home](index.md) | [Getting Started](getting-started.md)
