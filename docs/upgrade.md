# Upgrade Guide

Migration notes for users moving from older OpenCode-first flows to the current Codex CLI workflow.

## What Changed

| Area | Old | New |
| --- | --- | --- |
| Primary auth workflow | `opencode auth login` | `codex auth login` |
| Account listing | mixed OpenCode/plugin menu flows | `codex auth list` |
| Active account switch | manual or mixed | `codex auth switch <index>` |
| Plugin runtime path | `~/.opencode/openai-codex-auth-config.json` (legacy) | `~/.opencode/codex-multi-auth-config.json` |
| Account storage path | legacy mixed OpenCode/plugin files | `~/.opencode/openai-codex-accounts.json` |

## Path Migration

New primary paths:

- `~/.opencode/codex-multi-auth-config.json`
- `~/.opencode/openai-codex-accounts.json`
- `~/.opencode/projects/<project-key>/openai-codex-accounts.json`

Legacy paths are still checked for compatibility during migration:

- `~/.opencode/openai-codex-auth-config.json`

## Recommended Migration Sequence

1. Install/refresh Codex CLI:

```bash
npm install -g @openai/codex
```

1. From repository source, rebuild and link latest plugin CLI:

```bash
npm install
npm run build
npm link
```

1. Re-authenticate account pool:

```bash
codex auth login
```

1. Validate state:

```bash
codex auth list
codex auth doctor --fix
```

1. Refresh OpenCode config with current template:

```bash
codex-multi-auth --modern
```

## OpenCode Config Check

Expected plugin entry in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["codex-multi-auth"]
}
```

## Post-Upgrade Verification

```bash
codex auth forecast --live
codex auth report --json
opencode run "hello" --model=openai/gpt-5.1 --variant=medium
```

## Troubleshooting

If migration looks inconsistent:

- run `codex auth doctor --json`
- compare with [troubleshooting.md](troubleshooting.md)

