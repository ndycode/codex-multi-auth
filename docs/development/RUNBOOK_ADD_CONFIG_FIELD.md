# Runbook: Add Config Field

Checklist for adding a new configuration field while preserving precedence, migration expectations, and documentation parity. For the deeper safety path (settings UI, persistence, Windows notes), see [RUNBOOK_ADD_CONFIG_FIELD_SAFELY.md](RUNBOOK_ADD_CONFIG_FIELD_SAFELY.md).

* * *

## Goal

Add one field with a clear source of truth and keep config behavior explainable (`codex-multi-auth config explain` must show it correctly).

* * *

## Primary Files

- `lib/config.ts` — `DEFAULT_PLUGIN_CONFIG` + getter
- `lib/schemas.ts` — field schema
- `docs/configuration.md`
- `docs/development/CONFIG_FIELDS.md`
- `docs/development/CONFIG_FLOW.md`
- `test/config.test.ts`
- `test/plugin-config.test.ts`
- `test/config-explain.test.ts` — `CONFIG_EXPLAIN_ENTRIES` ⇆ `DEFAULT_PLUGIN_CONFIG` parity is enforced
- `test/documentation.test.ts` — documented `CODEX_*`/`MCODEX_*`/`OC_*` names must exist in source

* * *

## Implementation Steps

1. Add the field in `lib/config.ts` with an explicit default in `DEFAULT_PLUGIN_CONFIG` and a `get*` getter that applies env override → config value → default → clamp.
2. Add the field to `CONFIG_EXPLAIN_ENTRIES` so `config explain` reports `{key, value, defaultValue, source, envNames}` for it.
3. Decide whether it is:
   - stable user-facing
   - advanced
   - internal only
4. Keep precedence explicit: env var → config file → fallback file / unified settings → hardcoded default → min/max clamp.
5. Add tests for:
   - default resolution
   - config file resolution
   - environment override behavior
   - invalid value handling when relevant (invalid fields are dropped with a one-time warning on load)
6. Update `docs/configuration.md` with user-facing guidance.
7. Update `docs/development/CONFIG_FIELDS.md` with field inventory details — every backticked env name there must exist in `lib/`/`scripts/`/`index.ts` source.
8. Update `docs/development/CONFIG_FLOW.md` when source selection or precedence changes.

* * *

## Validation

```bash
npm run lint
npm run typecheck
npm test -- test/config.test.ts test/plugin-config.test.ts test/config-explain.test.ts test/documentation.test.ts
npm run build
```

Then run `codex-multi-auth config explain` (and `--json`) once to confirm the field reports its value, default, and source correctly.

* * *

## Review Checklist

- field has one documented default
- precedence is documented and tested (env → file → default → clamp)
- environment variable naming is consistent
- `config explain` output covers the field and tests stay green
- user docs and maintainer docs agree
- no hidden migration behavior was introduced
