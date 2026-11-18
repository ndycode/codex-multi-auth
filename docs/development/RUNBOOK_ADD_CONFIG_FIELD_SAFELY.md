# Runbook: Add a Config Field Safely

Use this when introducing a new `pluginConfig` or dashboard setting field. Companion short version: [RUNBOOK_ADD_CONFIG_FIELD.md](RUNBOOK_ADD_CONFIG_FIELD.md).

* * *

## Goal

Add a field without breaking defaults, migration behavior, settings persistence, or documentation parity.

* * *

## Where to Change

- `lib/config.ts` — runtime config resolution/defaults (`DEFAULT_PLUGIN_CONFIG`, `get*` getters, `CONFIG_EXPLAIN_ENTRIES`)
- `lib/schemas.ts` — env/config schema validation and typed field contracts
- `lib/dashboard-settings.ts` or `lib/unified-settings.ts` — persisted settings shape (`settings.json`, `version:1` forced on write)
- `lib/codex-manager/settings-hub/` — interactive editing panels if user-facing
- `docs/configuration.md` — user-facing config docs
- `docs/reference/settings.md` — settings reference
- `docs/development/CONFIG_FIELDS.md` — full field inventory
- `test/config.test.ts`, `test/dashboard-settings.test.ts`, `test/unified-settings.test.ts`, `test/config-explain.test.ts` — behavior coverage
- `test/documentation.test.ts` — docs parity (every documented `CODEX_*`/`MCODEX_*`/`OC_*` name must exist in source)

* * *

## How Resolution Works

`loadPluginConfig` resolves in order: `CODEX_MULTI_AUTH_CONFIG_PATH` file (when set and existing) → `<multi-auth>/settings.json` `pluginConfig` section → legacy config-path ladder → `DEFAULT_PLUGIN_CONFIG` merge (invalid fields dropped with a one-time warning, unknown keys dropped on load). Per-setting getters then apply env override → config value → default → clamp. `savePluginConfig` writes through the shared CAS machinery (`json-store-lock.ts`: in-process queue + `wx` lockfile + mtime CAS), preserving unknown keys.

* * *

## Safe Workflow

1. Define the default in the owning config/settings module first.
2. Thread it through persistence and loading paths before exposing UI controls.
3. Register it in `CONFIG_EXPLAIN_ENTRIES` so `codex-multi-auth config explain` reports `{key, value, defaultValue, source, envNames}`.
4. If user-facing, add the smallest possible settings-hub UI path after the storage/config part is correct — panels preview before apply and `Q` cancels without save.
5. Document the field in both user docs and the maintainer inventory.
6. Add tests for defaulting, persistence, `config explain` parity, and docs parity.

* * *

## Compatibility Checks

- New fields must have deterministic defaults.
- Do not change existing default values in the same PR unless that is the actual feature.
- Keep docs and code aligned in the same change.
- Recheck the Windows persistence notes when the field is written to disk; `EBUSY`/`EPERM`/`EAGAIN` retry behavior must stay documented and covered.
- Store merges are shallow-patch over a fresh read (settings) or per-key union-by-`updatedAt` (policies/budgets/profiles); a field that needs different merge semantics needs that decided explicitly, not inherited by accident.

* * *

## Validation

```bash
npm run typecheck
npm run lint -- lib/config.ts lib/schemas.ts lib/dashboard-settings.ts lib/unified-settings.ts
npm test -- test/config.test.ts test/plugin-config.test.ts test/dashboard-settings.test.ts test/unified-settings.test.ts test/config-explain.test.ts test/documentation.test.ts
npm run build
```

Run `codex-multi-auth config explain [--json]` once; if the field is user-visible, exercise the real settings path manually (set, save, reload, `Q`-cancel).

* * *

## Review Checklist

- default is deterministic and documented in one place
- precedence (env → file → default → clamp) is implemented and tested
- `CONFIG_EXPLAIN_ENTRIES` ⇆ `DEFAULT_PLUGIN_CONFIG` parity holds
- persistence writes go through the queue + lockfile + CAS machinery, never a bare write
- docs inventory updated; no backticked env name without a source reference
- settings-hub panel (if any) previews before apply and restores on `Q`
