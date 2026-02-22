# Security Policy

## Supported Versions

We provide security updates for the latest version of the plugin.

| Version | Supported          |
| ------- | ------------------ |
| Latest  | ✅ Active support |
| < 1.0   | ❌ No longer supported |

## Security Considerations

### OAuth Token Security

This plugin handles sensitive OAuth tokens. To protect your security:

✅ **What we do:**
- Store tokens securely via opencode's credential management
- Use PKCE-secured OAuth 2.0 flows
- Never transmit tokens to third parties
- Implement automatic token refresh
- Use industry-standard authentication practices

⚠️ **What you should do:**
- Never share your `~/.opencode/` directory
- Do not commit OAuth tokens to version control
- Regularly review authorized apps at [ChatGPT Settings](https://chatgpt.com/settings/apps)
- Use `opencode auth logout` when done on shared systems
- Enable debug logging (`ENABLE_PLUGIN_REQUEST_LOGGING=1`) only when troubleshooting

### Reporting a Vulnerability

If you discover a security vulnerability:

1. **DO NOT open a public issue**
2. Email the maintainer directly (check GitHub profile for contact)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We aim to respond to security reports within 48 hours.

### Responsible Disclosure

We follow responsible disclosure practices:
- Security issues are patched before public disclosure
- Reporter receives credit (unless anonymity is requested)
- Timeline for disclosure is coordinated with reporter

### Security Best Practices

When using this plugin:

- **Personal use only:** Do not use for commercial services
- **Respect rate limits:** Avoid excessive automation
- **Monitor usage:** Review your ChatGPT usage regularly
- **Keep updated:** Use the latest version for security patches
- **Secure your machine:** This plugin is as secure as your development environment
- **Review permissions:** Understand what the plugin can access via OAuth

### Out of Scope

The following are **not** security vulnerabilities:
- Issues related to violating OpenAI's Terms of Service
- Rate limiting by OpenAI's servers
- Authentication failures due to expired subscriptions
- OpenAI API or service outages

### Third-Party Dependencies

This plugin minimizes dependencies for security:
- **Only dependency:** `@openauthjs/openauth` (for OAuth handling)
- Regular dependency updates for security patches
- No telemetry or analytics dependencies

## Questions?

For security questions that are not vulnerabilities, open a discussion thread on GitHub.

---

**Note:** This plugin is not affiliated with OpenAI. For OpenAI security concerns, contact OpenAI directly.
