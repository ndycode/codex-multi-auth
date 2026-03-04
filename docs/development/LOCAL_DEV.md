# Local Development Runbook

Canonical contributor workflow for setting up and validating this repository.

---

## Prerequisites

- Node.js `>=18`
- npm available in `PATH`
- git available in `PATH`

Verify environment:

```bash
npm run doctor:dev
```

---

## First Clone

From repo root:

```bash
npm run setup:dev
```

`setup:dev` runs:

1. environment checks (`doctor:dev`)
2. dependency install (`npm ci`)
3. validation gate (`npm run verify`)
4. docs integrity smoke (`npm test -- test/documentation.test.ts`)

---

## Daily Development

```bash
npm run verify
```

Use component commands when debugging failures:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Format repo config files (JSON/JSONC/YAML):

```bash
npm run format
```

---

## Common Failure Modes

- `doctor:dev` fails on missing npm/git:
  - ensure shell `PATH` includes Node.js and git executables
- `verify` fails on audit policy:
  - run `npm run audit:ci` to inspect blocking advisory output
- `test/documentation.test.ts` fails with missing `dist/lib/*.js`:
  - run `npm run build` and re-run the docs test

---

## CI Parity

CI uses `npm run verify:ci` for the matrix test gate.

Local equivalent:

```bash
npm run verify:ci
```
