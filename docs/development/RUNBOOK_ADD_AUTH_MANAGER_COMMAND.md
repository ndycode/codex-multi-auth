# Runbook: Add an Auth Manager Command

Use this when adding a new `codex auth ...` command.

## Goal

Add a command without breaking the existing CLI surface, help text, JSON mode, or dashboard/menu behavior.

## Where to Change

- `lib/codex-manager.ts` — command parsing and dispatch
- `lib/codex-manager/` — extracted command/controller helpers when the command grows beyond trivial size
- `lib/cli.ts` — prompt-heavy shared CLI helpers when the command needs reusable interactive flows
- `docs/reference/commands.md` — command reference
- `test/codex-manager-cli.test.ts` — CLI behavior coverage
- `test/documentation.test.ts` — docs parity when command text/help changes

## Safe Workflow

1. Add the smallest possible parsing/dispatch change in `lib/codex-manager.ts`.
2. If the command has more than one logical branch, extract a helper under `lib/codex-manager/` instead of growing the main file.
3. Keep JSON output stable and explicit if the command already has `--json`.
4. Update command help text and `docs/reference/commands.md` in the same change.
5. Add or extend `test/codex-manager-cli.test.ts` for the new path.

## Compatibility Checks

- Preserve canonical command shape: `codex auth <subcommand>`
- Do not silently change existing help text unless docs/tests are updated too
- If adding flags, update both help text and command reference

## QA

- `npm run typecheck`
- `npm run lint -- lib/codex-manager.ts test/codex-manager-cli.test.ts docs/reference/commands.md test/documentation.test.ts`
- `npm run test -- test/codex-manager-cli.test.ts test/documentation.test.ts`
- For auth flows, never paste raw tokens/session headers in PRs, issues, or logs; redact sensitive output.
- Run the real command or `--help` path in Bash and inspect output
