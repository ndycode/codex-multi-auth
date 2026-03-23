# Runbook: Add Auth Command

Safe workflow for adding a new `codex auth ...` command without expanding scope or breaking the existing CLI contract.

* * *

## Goal

Add one new command path while keeping:

- `codex auth ...` as the canonical command family
- current help text and aliases aligned with docs
- JSON and human-readable output predictable
- command behavior covered by targeted tests

* * *

## Primary Files

- `lib/codex-manager.ts`
- `docs/reference/commands.md`
- `README.md` when user-visible workflow changes
- `test/codex-manager-cli.test.ts`
- `test/documentation.test.ts`

* * *

## Implementation Steps

1. Add the command logic in `lib/codex-manager.ts` or the current command handler module.
2. Keep usage text literal and copy-pasteable.
3. Reuse existing storage, refresh, and quota helpers instead of adding new command-local state.
4. Add or extend CLI tests in `test/codex-manager-cli.test.ts` for:
   - success path
   - invalid input or missing args
   - JSON mode if supported
   - non-interactive behavior if relevant
5. Update `docs/reference/commands.md` with the command and flags.
6. Update `README.md` only when the command changes the recommended user workflow.
7. Update `test/documentation.test.ts` if new command text must stay aligned across docs and runtime usage text.

* * *

## Validation

```bash
npm run lint
npm run typecheck
npm test -- test/codex-manager-cli.test.ts test/documentation.test.ts
npm run build
```

* * *

## Review Checklist

- command name is consistent across runtime and docs
- help text matches actual flags
- no unrelated settings or storage changes were mixed in
- JSON output is stable if exposed
- tests cover failure paths, not only the happy path
