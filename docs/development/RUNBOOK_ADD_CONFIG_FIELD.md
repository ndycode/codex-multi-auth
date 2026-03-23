# Runbook: Add Config Field

Checklist for adding a new configuration field while preserving precedence, migration expectations, and documentation parity.

* * *

## Goal

Add one field with a clear source of truth and keep config behavior explainable.

* * *

## Primary Files

- `lib/config.ts`
- `docs/configuration.md`
- `docs/development/CONFIG_FIELDS.md`
- `docs/development/CONFIG_FLOW.md`
- `test/config.test.ts`
- `test/plugin-config.test.ts`
- `test/documentation.test.ts`

* * *

## Implementation Steps

1. Add the field in `lib/config.ts` with an explicit default.
2. Decide whether it is:
   - stable user-facing
   - advanced
   - internal only
3. Keep precedence explicit:
   - config file source
   - fallback config source when applicable
   - environment override layer
4. Add tests for:
   - default resolution
   - config file resolution
   - environment override behavior
   - invalid value handling when relevant
5. Update `docs/configuration.md` with user-facing guidance.
6. Update `docs/development/CONFIG_FIELDS.md` with field inventory details.
7. Update `docs/development/CONFIG_FLOW.md` when source selection or precedence changes.
8. Extend `test/documentation.test.ts` if docs parity should remain locked.

* * *

## Validation

```bash
npm run lint
npm run typecheck
npm test -- test/config.test.ts test/plugin-config.test.ts test/documentation.test.ts
npm run build
```

* * *

## Review Checklist

- field has one documented default
- precedence is documented and tested
- environment variable naming is consistent
- user docs and maintainer docs agree
- no hidden migration behavior was introduced
