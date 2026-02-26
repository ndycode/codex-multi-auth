# Upgrade Guide

Migration notes for users moving from older OpenCode-first flows to the current Codex CLI workflow.

## What Changed

| Area | Old | New |
| --- | --- | --- |
| Primary auth workflow | `opencode auth login` | `codex auth login` |
| Account listing | mixed OpenCode/plugin menu flows | `codex auth list` |
| Active account switch | manual or mixed | `codex auth switch <index>` |
| Plugin runtime path | legacy `.opencode` config files | `~/.codex/multi-auth/config.json` |
| Account storage path | legacy `.opencode` account JSON | `~/.codex/multi-auth/openai-codex-accounts.json` |

## Path Migration

New primary paths:

- `~/.codex/multi-auth/config.json`
- `~/.codex/multi-auth/openai-codex-accounts.json`
- `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`

Legacy paths are still checked for compatibility during migration:

- `~/.codex/codex-multi-auth-config.json`
- `~/.opencode/codex-multi-auth-config.json`
- `~/.opencode/openai-codex-auth-config.json`

## Recommended Migration Sequence

1. Install/refresh Codex CLI:

```bash
npm install -g @openai/codex
```

2. From repository source, rebuild and link latest plugin CLI:

```bash
npm install
npm run build
npm link
```

3. Re-authenticate account pool:

```bash
codex auth login
```

4. Validate state:

```bash
codex auth list
codex auth doctor --fix
```

5. Refresh OpenCode config with current template:

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
opencode run "hello" --model=openai/gpt-5.2 --variant=medium
```

## Troubleshooting

If migration looks inconsistent:

- run `codex auth doctor --json`
- compare with [troubleshooting.md](troubleshooting.md)
