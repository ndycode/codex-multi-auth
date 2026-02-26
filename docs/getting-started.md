# Getting Started

Beginner setup for Codex multi-account OAuth.

## Prerequisites

- Node.js 18+
- Official Codex CLI package: `@openai/codex`
- OpenCode (optional, if using plugin integration)

## Install

```bash
npm install -g @openai/codex codex-multi-auth
```

## Login Your First Account

```bash
codex auth login
```

What happens:

1. Browser opens for OAuth.
2. You approve access.
3. Terminal returns to account dashboard.
4. Your real email should appear in account rows.

## Add More Accounts

Run login again:

```bash
codex auth login
```

Verify:

```bash
codex auth list
```

## OpenCode Integration

Auto-install config:

```bash
codex-multi-auth-opencode-install --modern
```

Manual `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["codex-multi-auth@latest"]
}
```

Test:

```bash
opencode run "hello" --model=openai/gpt-5.2 --variant=medium
```

## First-Day Commands

```bash
codex auth list
codex auth status
codex auth switch 2
codex auth check
codex auth forecast --live
codex auth fix --dry-run
codex auth doctor --fix
```

## If You See Placeholder Emails

```bash
codex auth doctor --fix
codex auth list
```

## Next

- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [privacy.md](privacy.md)
