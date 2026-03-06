# Public API Contract

Public API contract for `codex-multi-auth`.

---

## Stability Tiers

This project uses tiered API stability.

### Tier A: Stable APIs

Stable APIs are covered by semver compatibility guarantees and must remain backward-compatible inside the `0.x` line unless explicitly documented.

- Package root plugin entrypoint exports:
  - `OpenAIOAuthPlugin`
  - `OpenAIAuthPlugin`
  - default export (alias of `OpenAIOAuthPlugin`)
- CLI surface:
  - `codex auth ...` command family
  - documented flags and aliases in `reference/commands.md`
- Persistent user-facing config and storage contracts documented in:
  - `reference/settings.md`
  - `reference/storage-paths.md`

### Tier B: Compatibility APIs

Compatibility APIs are exported for ecosystem continuity but are not treated as first-class product entrypoints.

- Deep module exports from `dist/lib/index.js` and `lib/index.ts` barrel re-exports.
- Existing positional signatures remain supported.
- New options-object alternatives are preferred for new callers.

Compatibility policy for Tier B:

- Additive changes are allowed.
- Existing exported symbols must not be removed in this release line.
- Deprecated usage may be documented, but hard removals require a major version transition plan.

### Tier C: Internal APIs

Internal APIs are any non-exported internals and implementation details not covered by Tier A or Tier B.

- No compatibility guarantee.
- May change at any time if Tier A/Tier B behavior remains intact.

---

## Preferred Calling Style

For exported functions with many positional parameters, use options-object forms when available.

Examples of additive options-object alternatives:

- `selectHybridAccount({ ... })`
- `exponentialBackoff({ ... })`
- `getTopCandidates({ ... })`
- `createCodexHeaders({ ... })`
- `getRateLimitBackoffWithReason({ ... })`
- `transformRequestBody({ ... })`

Positional signatures are preserved for backward compatibility.

---

## API Standards Baseline

Where this repository exposes machine-readable command output or future HTTP endpoints, use these defaults:

- Versioning:
  - include `schemaVersion` in JSON command output.
  - increment schema version only when contract shape changes.
- Idempotency:
  - mutating automation flows should support caller-provided idempotency keys.
  - repeated requests with the same idempotency key should not duplicate side effects.
- Pagination:
  - list-style payloads should prefer cursor-based pagination (`nextCursor`, `hasMore`) over offset-only paging.
  - response envelopes should include stable paging metadata even for empty result sets.

This project currently applies the versioning baseline to JSON command outputs and documents idempotency/pagination standards for future API expansion.

---

## Semver Guidance

- Breaking Tier A change: `MAJOR`
- Additive Tier A change: `MINOR`
- Tier A bug fix or doc-only clarification: `PATCH`
- Tier B additive compatibility improvement: usually `PATCH` or `MINOR` depending on caller impact

This repository currently ships on a `0.x` line, but breaking changes still require explicit migration documentation and review sign-off.

---

## Migration Rules

For any future intentional contract break:

1. Identify affected callers and command workflows.
2. Provide migration path with concrete before/after examples.
3. Update:
   - `README.md`
   - `docs/upgrade.md`
   - affected `docs/reference/*`
   - release notes and changelog
4. Add tests proving both old and new behavior during transition windows when feasible.

---

## Related

- [commands.md](commands.md)
- [error-contracts.md](error-contracts.md)
- [settings.md](settings.md)
- [storage-paths.md](storage-paths.md)
- [../upgrade.md](../upgrade.md)
