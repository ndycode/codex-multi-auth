# Documentation Structure

This file describes how docs are organized in this repository.

## Repository-level docs

- `README.md` - Main entry point for users
- `CHANGELOG.md` - Release history
- `CONTRIBUTING.md` - Contribution workflow
- `SECURITY.md` - Security reporting policy
- `AGENTS.md` - AI agent instructions for this codebase

## docs/ (site + user/developer guides)

```text
docs/
  index.md                     # documentation landing page
  README.md                    # docs portal / navigation
  getting-started.md           # install + first-run guide
  configuration.md             # full config reference
  troubleshooting.md           # operational debugging guide
  privacy.md                   # data handling notes
  development/
    ARCHITECTURE.md            # technical design
    CONFIG_FLOW.md             # config resolution internals
    CONFIG_FIELDS.md           # config field semantics
    TESTING.md                 # testing strategy and commands
    TUI_PARITY_CHECKLIST.md    # auth dashboard UI parity checks
```

## config/ (copy-paste templates)

- `config/opencode-modern.json` - OpenCode v1.0.210+ variant-based template
- `config/opencode-legacy.json` - OpenCode v1.0.209 and below template
- `config/minimal-opencode.json` - minimal debug template
- `config/README.md` - template-selection guide

## Notes

- `dist/` is build output and not a documentation source of truth.
- `tmp*` files are release scratch artifacts and not part of user docs.
- For user-facing guidance, start with `README.md` or `docs/getting-started.md`.
