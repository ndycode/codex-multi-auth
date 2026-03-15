---
name: codex-auth-manager
description: Use codex auth commands to inspect, log in, switch accounts, and run diagnostics safely.
---

# Codex Multi-Auth Account Manager

Use this skill when the user needs help with local Codex auth state.

Preferred commands:

- `codex auth status`
- `codex auth list`
- `codex auth switch <index>`
- `codex auth check`
- `codex auth forecast --live`
- `codex auth doctor --fix`

Safety notes:

- `codex auth login` opens a browser OAuth flow and should only be run with user approval.
- Reset or cleanup commands delete local state and should only be run when explicitly requested.
- The wrapper remains the runtime path for multi-account behavior; this plugin mainly improves discoverability inside official Codex.
