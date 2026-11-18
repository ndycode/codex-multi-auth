# Runbook: Add Auth Command

Safe workflow for adding a new `codex-multi-auth ...` command without expanding scope or breaking the existing CLI contract. For the full dispatch contract and the two-registry trap, see [RUNBOOK_ADD_AUTH_MANAGER_COMMAND.md](RUNBOOK_ADD_AUTH_MANAGER_COMMAND.md).

* * *

## Goal

Add one new command path while keeping:

- `codex-multi-auth ...` as the canonical command family
- current help text and aliases aligned with docs
- JSON and human-readable output predictable
- command behavior covered by targeted tests

* * *

## Primary Files

- `lib/codex-manager/commands/<name>.ts` — command implementation
- `lib/codex-manager.ts` — `CLI_COMMAND_HANDLERS` registration
- `lib/codex-manager/account-manager-commands.ts` — `ACCOUNT_MANAGER_COMMANDS` registration (required for the bare `codex-multi-auth <name>` form)
- `lib/codex-manager/help.ts` — `printUsage()` text
- `docs/reference/commands.md`
- `README.md` when user-visible workflow changes
- `test/codex-manager-cli.test.ts`
- `test/documentation.test.ts`
- `docs/upgrade.md` when the command changes user-visible behavior or a documented workflow
- `package.json` scripts, when the command adds or changes a build/test entrypoint referenced by docs

* * *

## Implementation Steps

1. Add the command logic as a module under `lib/codex-manager/commands/`, then register it in **both** `CLI_COMMAND_HANDLERS` and `ACCOUNT_MANAGER_COMMANDS`.
2. Keep usage text literal and copy-pasteable, and add the line to `printUsage()` in `lib/codex-manager/help.ts` under the section matching its role (Start here / Daily use / Repair / Diagnostics / Advanced).
3. Reuse existing storage, refresh, and quota helpers instead of adding new command-local state.
4. Take collaborators as an injected `deps` object so the command stays testable.
5. Add or extend CLI tests in `test/codex-manager-cli.test.ts` for:
   - success path under **both** dispatch forms (`codex-multi-auth auth <name>` and bare `codex-multi-auth <name>`)
   - invalid input or missing args
   - JSON mode if supported
   - non-interactive behavior if relevant
6. Update `docs/reference/commands.md` with the command and flags.
7. Update `README.md` only when the command changes the recommended user workflow.
8. Update `test/documentation.test.ts` if new command text must stay aligned across docs and runtime usage text.

* * *

## Validation

```bash
npm run lint
npm run typecheck
npm test -- test/codex-manager-cli.test.ts test/documentation.test.ts
npm run build
```

Then run the real command or its `--help` path once and inspect the output.

* * *

## Review Checklist

- command name is consistent across runtime and docs
- registered in both `CLI_COMMAND_HANDLERS` and `ACCOUNT_MANAGER_COMMANDS` (bare form works)
- help text matches actual flags
- no unrelated settings or storage changes were mixed in
- JSON output is stable if exposed
- tests cover failure paths, not only the happy path
