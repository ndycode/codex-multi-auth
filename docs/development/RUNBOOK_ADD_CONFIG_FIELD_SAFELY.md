# Runbook: Add a Config Field Safely

Use this when introducing a new `pluginConfig` or dashboard setting field.

## Goal

Add a field without breaking defaults, migration behavior, settings persistence, or documentation parity.

## Where to Change

- `lib/config.ts` — runtime config resolution/defaults
- `lib/dashboard-settings.ts` or `lib/unified-settings.ts` — persisted settings shape
- `lib/codex-manager/settings-hub.ts` and extracted settings helpers — interactive editing if user-facing
- `docs/configuration.md` — user-facing config docs
- `docs/reference/settings.md` — settings reference
- `docs/development/CONFIG_FIELDS.md` — full field inventory
- `test/config.test.ts`, `test/dashboard-settings.test.ts`, `test/unified-settings.test.ts` — behavior coverage
- `test/documentation.test.ts` — docs parity

## Safe Workflow

1. Define the default in the owning config/settings module first.
2. Thread it through persistence and loading paths before exposing UI controls.
3. If user-facing, add the smallest possible settings UI path after the storage/config part is correct.
4. Document the field in both user docs and maintainer inventory.
5. Add tests for defaulting, persistence, and docs parity.

## Compatibility Checks

- New fields must have deterministic defaults.
- Do not change existing default values in the same PR unless that is the actual feature.
- Keep docs and code aligned in the same change.

## QA

- `npm run typecheck`
- `npm run lint -- lib/config.ts lib/dashboard-settings.ts lib/unified-settings.ts test/config.test.ts test/dashboard-settings.test.ts test/unified-settings.test.ts test/documentation.test.ts`
- Run the targeted test files that cover the field
- If the field is user-visible, exercise the real settings path manually
