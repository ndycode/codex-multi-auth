# Security Policy

## Supported Versions

Security updates are provided for the current maintained release line.

| Version line | Status |
| --- | --- |
| `0.x` latest | Supported |
| pre-`0.x` historical branches | Not supported |

---

## Security Model

`codex-multi-auth` handles OAuth credentials and account metadata locally.

Key controls:

- PKCE-based OAuth flow.
- Local storage under `~/.codex/multi-auth` (or `CODEX_MULTI_AUTH_DIR`).
- Refresh-token lifecycle management and account health isolation.
- No project-owned telemetry backend.

---

## Operator Security Practices

- Do not share `~/.codex/` directories.
- Never commit auth files, logs, or cache artifacts.
- Review connected apps in ChatGPT settings periodically.
- Enable debug/body logging only for short-lived troubleshooting sessions.

Sensitive logging toggles:

- `ENABLE_PLUGIN_REQUEST_LOGGING=1` (metadata)
- `CODEX_PLUGIN_LOG_BODIES=1` (raw bodies; sensitive)

---

## Vulnerability Reporting

If you discover a vulnerability:

1. Do not open a public issue.
2. Contact the maintainer privately via GitHub profile contact channel.
3. Include:
   - vulnerability description
   - reproduction steps
   - impact assessment
   - suggested mitigation (optional)

Target response time: within 48 hours.

---

## Responsible Disclosure

- Fixes are prepared before public disclosure.
- Reporter attribution is provided unless anonymity is requested.
- Disclosure timing is coordinated to reduce user risk.

---

## Out of Scope

The following are not treated as vulnerabilities in this repository:

- OpenAI platform outages.
- Account/subscription entitlement limitations.
- Expected upstream rate limiting.
- Requests to bypass OpenAI terms or controls.

---

## Dependency and Release Hygiene

Before release and after dependency changes:

```bash
npm run audit:ci
npm run lint
npm run typecheck
npm test
npm run build
```

---

## Questions

For non-vulnerability security questions, open a GitHub discussion.

---

This project is not affiliated with OpenAI.
For OpenAI platform security concerns, contact OpenAI directly.