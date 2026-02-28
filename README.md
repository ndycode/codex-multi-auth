# codex-multi-auth

[![npm version](https://img.shields.io/npm/v/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)
[![npm downloads](https://img.shields.io/npm/dw/codex-multi-auth.svg)](https://www.npmjs.com/package/codex-multi-auth)

Multi-account OAuth manager for the official OpenAI Codex CLI with resilient routing, quota-aware selection, and terminal-first diagnostics.

---

## Why This Project

`codex-multi-auth` helps you run Codex CLI workflows with multiple ChatGPT OAuth accounts while keeping operations local-first and auditable.

Core outcomes:

- Consistent `codex auth ...` operations for login, switching, repair, and reporting.
- Quota-aware and health-aware account selection.
- Recovery tooling for stale tokens, broken account pools, and routing drift.
- Practical operator controls without modifying official Codex CLI internals.

---

## Quick Start

Install official Codex CLI and this plugin:

```bash
npm i -g @openai/codex
npm i -g codex-multi-auth
```

If you previously installed the scoped prerelease package:

```bash
npm uninstall -g @ndycode/codex-multi-auth
```

Validate command routing:

```bash
codex --version
codex auth status
```

Add your first account:

```bash
codex auth login
codex auth list
codex auth check
```

---

## Command Quick Reference

| Command | Purpose |
| --- | --- |
| `codex auth login` | Open interactive account dashboard |
| `codex auth list` | Show accounts and active selection |
| `codex auth switch <index>` | Set active account by index |
| `codex auth check` | Fast account/session health pass |
| `codex auth forecast --live` | Recommend best next account with live probe |
| `codex auth fix --dry-run` | Preview non-destructive account repairs |
| `codex auth fix --live --model gpt-5-codex` | Run repairs with live probe model |
| `codex auth doctor --fix` | Diagnose and apply safe auto-fixes |
| `codex auth report --live --json` | Emit machine-readable operations report |

Full command and hotkey reference: [docs/reference/commands.md](docs/reference/commands.md)

---

## Documentation Map

User track:

- [docs/getting-started.md](docs/getting-started.md)
- [docs/features.md](docs/features.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [docs/privacy.md](docs/privacy.md)
- [docs/upgrade.md](docs/upgrade.md)

Reference track:

- [docs/reference/commands.md](docs/reference/commands.md)
- [docs/reference/settings.md](docs/reference/settings.md)
- [docs/reference/storage-paths.md](docs/reference/storage-paths.md)

Maintainer track:

- [docs/README.md](docs/README.md)
- [docs/development/ARCHITECTURE.md](docs/development/ARCHITECTURE.md)
- [docs/development/CONFIG_FIELDS.md](docs/development/CONFIG_FIELDS.md)
- [docs/development/CONFIG_FLOW.md](docs/development/CONFIG_FLOW.md)
- [docs/development/TESTING.md](docs/development/TESTING.md)

---

## Compliance and Security

- Use only official OAuth flows.
- Do not share local auth files from `~/.codex/multi-auth`.
- Review [SECURITY.md](SECURITY.md) before reporting vulnerabilities.

---

## Support Checklist

```bash
codex auth doctor --fix
codex auth check
codex auth forecast --live
codex auth report --live --json
```

If issues persist, follow [docs/troubleshooting.md](docs/troubleshooting.md) and include outputs in your issue report.