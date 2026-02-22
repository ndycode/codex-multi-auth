# Documentation

Welcome to the OpenCode OpenAI Codex Auth Plugin documentation!

## For Users

- **[Getting Started](getting-started.md)** - Installation, configuration, and quick start
- **[Configuration Guide](configuration.md)** - Complete config reference
- **[Troubleshooting](troubleshooting.md)** - Common issues and debugging
- **[Changelog](../CHANGELOG.md)** - Version history and release notes

## For Developers

Explore the engineering depth behind this plugin:

- **[Repository Scope Map](development/REPOSITORY_SCOPE.md)** - Canonical path ownership and extension points
- **[Architecture](development/ARCHITECTURE.md)** - Technical design, request pipeline, AI SDK compatibility
- **[Configuration System](development/CONFIG_FLOW.md)** - How config loading and merging works
- **[Config Fields Guide](development/CONFIG_FIELDS.md)** - Understanding config keys, `id`, and `name`
- **[Testing Guide](development/TESTING.md)** - Test scenarios, verification procedures, integration testing
- **[TUI Parity Checklist](development/TUI_PARITY_CHECKLIST.md)** - Auth dashboard/UI parity requirements for future changes

## Documentation Meta

- **[Documentation Structure](DOCUMENTATION.md)** - How docs are organized in this repository

## Key Architectural Decisions

This plugin bridges two different systems with careful engineering:

1. **AI SDK Compatibility** - Filters `item_reference` (AI SDK construct) for Codex API compatibility
2. **Stateless Operation** - ChatGPT backend requires `store: false`, verified via testing
3. **Full Context Preservation** - Sends complete message history (IDs stripped) for LLM context (with optional fast-session trimming)
4. **Stale-While-Revalidate Caching** - Keeps prompt/instruction fetches fast while avoiding GitHub rate limits; optional startup prewarm for first-turn latency
5. **Per-Model Configuration** - Enables quality presets with quick switching
6. **Fast Session Mode** - Optional low-latency tuning (clamps reasoning/verbosity on trivial turns) without changing defaults
7. **Entitlement-Aware Fallback Flow** - Unsupported models try remaining accounts/workspaces first, then optional fallback chain if enabled

**Testing**: large Vitest suite with enforced 80% coverage threshold plus integration coverage

---

**Quick Links**: [GitHub](https://github.com/ndycode/codex-multi-auth) | [npm](https://www.npmjs.com/package/codex-multi-auth) | [Issues](https://github.com/ndycode/codex-multi-auth/issues)
