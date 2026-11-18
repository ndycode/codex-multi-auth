# Runbook: Add an Auth Manager Command

Use this when adding a new `codex-multi-auth ...` command. Companion short version: [RUNBOOK_ADD_AUTH_COMMAND.md](RUNBOOK_ADD_AUTH_COMMAND.md).

* * *

## Goal

Add a command without breaking the existing CLI surface, help text, JSON mode, or dashboard/menu behavior.

* * *

## Where to Change

- `lib/codex-manager/commands/<name>.ts` — the command implementation (one module per command)
- `lib/codex-manager.ts` — register the handler in the `CLI_COMMAND_HANDLERS` map
- `lib/codex-manager/account-manager-commands.ts` — add the name to `ACCOUNT_MANAGER_COMMANDS`
- `lib/codex-manager/help.ts` — `printUsage()` text, plus any per-command usage/arg parser
- `lib/cli.ts` — prompt-heavy shared CLI helpers when the command needs reusable interactive flows
- `docs/reference/commands.md` — command reference
- `test/codex-manager-cli.test.ts` — CLI behavior coverage
- `test/documentation.test.ts` — docs parity when command text/help changes

* * *

## How Dispatch Actually Works

`runCodexMultiAuthCli` (`lib/codex-manager.ts`) is a two-stage lookup, not an `if (command === …)` chain:

1. **Bare-subcommand normalization.** If `argv[0]` is not `auth` but *is* a member of `ACCOUNT_MANAGER_COMMANDS`, the args are rewritten to `["auth", ...argv]`. Everything downstream assumes an `auth` root.
2. **Handler lookup.** The command is looked up in `CLI_COMMAND_HANDLERS`, a `ReadonlyMap<string, CliCommandHandler>`. Keys are exact-match and unique, so lookup order cannot change semantics. Per-invocation dependency factories are called *inside* each handler so they are constructed at dispatch time.

> **The trap:** the two registries are separate. Registering only in `CLI_COMMAND_HANDLERS` gives you a working `codex-multi-auth auth <name>` but a broken bare `codex-multi-auth <name>` — the bare form falls through to `printUsage()` and exits `1`. Add the name to both.

Aliases point at the same handler (`status` and `list` share `runListOrStatusCommand`). Sub-dispatched commands (`config`, `debug`, `budget`, `account`, `rotation`, `bridge`, `usage`, `resets`, `history`) branch on `rest[0]` inside their own handler and must print `Unknown … command:` and return `1` for an unrecognised subcommand.

Every mutating command calls `setStoragePath(null)` first — mutations always operate on the **global** pool, never a project-scoped one.

* * *

## Safe Workflow

1. Implement the command as its own module under `lib/codex-manager/commands/`, exporting a `run<Name>Command(args, deps)` function that returns a `number` exit code (strictly `0`/`1`).
2. Register it in `CLI_COMMAND_HANDLERS` **and** `ACCOUNT_MANAGER_COMMANDS`.
3. Add the command line to `printUsage()` in `lib/codex-manager/help.ts`, under the section that matches its role (Start here / Daily use / Repair / Diagnostics / Advanced).
4. Take collaborators as an injected `deps` object rather than importing singletons directly — this is what keeps the command testable.
5. Keep JSON output stable and explicit if the command has `--json`; JSON mode is per-command, and exit codes stay `0`/`1`.
6. Update `docs/reference/commands.md` in the same change.
7. Add or extend `test/codex-manager-cli.test.ts` with a case for **each dispatch form**: `codex-multi-auth auth <name>` *and* the bare `codex-multi-auth <name>`. Only the bare-form case catches a missing `ACCOUNT_MANAGER_COMMANDS` entry — a handler-only registration passes the `auth`-prefixed test and still ships broken.
8. If the command exercises token refresh or storage writes, add deterministic coverage for the refresh race and for Windows `EBUSY`/`EPERM` cleanup rather than relying on timing.

* * *

## Compatibility Checks

- Preserve canonical command shape: `codex-multi-auth <subcommand>` (bare) and `codex-multi-auth auth <subcommand>` (explicit).
- Do not silently change existing help text unless docs/tests are updated too.
- If adding flags, update both help text and command reference.
- Interactive prompts must stay TTY-gated (`select()` throws off-TTY); non-interactive callers get `--json` or flag-driven paths.

* * *

## Validation

```bash
npm run typecheck
npm run lint                 # ts + scripts/**/*.{js,mjs} only — do not pass markdown paths
npm test -- test/codex-manager-cli.test.ts test/documentation.test.ts
npm run build
```

Then run the real command or its `--help` path and inspect output. For auth flows, never paste raw tokens/session headers in PRs, issues, or logs.

* * *

## Review Checklist

- both registries updated; bare and `auth`-prefixed dispatch both covered by tests
- handler returns `number` exit code; failure paths return `1`, never throw past the dispatcher
- deps injected, not imported singletons
- usage text lives in `printUsage()` and matches the parser
- docs (`commands.md`, README if user-visible) updated in the same change
- no account emails or tokens can reach output/log lines
