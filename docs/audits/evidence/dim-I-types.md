# Dimension I — Type Safety + Runtime Validation

HEAD 1f6da97, v1.2.7. Typecheck PASS (tsc --noEmit exit 0).

| ID | Severity | Claim | Evidence | Confidence |
|----|----------|-------|----------|------------|
| I-01 | LOW | Forbidden `as any` escape hatch absent in audited source. | `ast_grep_search` pattern `$E as any` over `lib/` + `index.ts` returned 0 matches. Repo AGENTS says 0 allowed. | High |
| I-02 | LOW | Type suppression directives absent in audited source. | Grep `@ts-ignore|@ts-expect-error|@ts-nocheck` over `lib/` + `index.ts` returned 0 matches. | High |
| I-03 | MEDIUM | Raw `JSON.parse` surface remains large and mostly outside schema entrypoints. | Grep count found 59 `JSON.parse(` calls across 31 `lib/**/*.ts` files. `ast_grep_search` on `lib/` returned 59 hits. Highest clusters: `lib/request/request-init.ts` (5), `lib/runtime/request-init.ts` (5), `lib/storage.ts` (4), `lib/recovery/storage.ts` (4), `lib/request/fetch-helpers.ts` (4). | High |
| I-04 | MEDIUM | Runtime validation exists, but Zod usage is centralized rather than pervasive at parse boundaries. | Grep `z\.object|from 'zod'|from "zod"` found 10 matches in 1 file: `lib/schemas.ts`. That file defines `PluginConfigSchema`, account storage schemas, token schemas, `OAuthTokenResponseSchema`, plus `safeParse*` helpers. | High |
| I-05 | LOW | `strictNullChecks` effectively enabled. | `tsconfig.json` sets `"strict": true` at line 11. TypeScript enables `strictNullChecks` under `strict` unless explicitly disabled; no explicit `strictNullChecks: false` present. | High |
| I-06 | LOW | Current tree still typechecks cleanly under compiler gate. | `npm run typecheck` executed `tsc --noEmit` and exited 0 on HEAD. | High |

## Evidence Notes

- `lib/schemas.ts:1-320` is current Zod hub. Validation coverage strongest for config, account storage, token result, and OAuth token payload shapes.
- `JSON.parse` call sites often cast to `unknown` first and then pass through normalizers or record guards, but colocated schema validation is not standard. Examples: `lib/storage/storage-parser.ts:34`, `lib/dashboard-settings.ts:424`, `lib/config.ts:253`, `lib/auth/auth.ts:176`.
- Audit result for forbidden TypeScript escape hatches is clean in requested scope: 0 `as any`, 0 suppression comments.
- Weak-validation pressure concentrates in storage, request parsing, runtime replay/recovery, and settings persistence codepaths.

## Exact Counts

- `as any`: 0
- `@ts-ignore|@ts-expect-error|@ts-nocheck`: 0
- `JSON.parse` in `lib/`: 59 across 31 files
- Zod matches: 10 in 1 file (`lib/schemas.ts`)
- `strictNullChecks`: enabled via `strict: true`
