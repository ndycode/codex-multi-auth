# Error Contract Reference

Error contract reference for user-facing CLI and exported helper behavior.

---

## CLI Error Contract

### Exit Codes

- `0`: successful execution
- `1`: usage error, invalid arguments, sync/persistence failure, or command failure

### Streams

- Human-readable command output is written to `stdout`.
- Argument/usage and failure diagnostics are written to `stderr`.
- On invalid command/arguments, usage text is printed with a non-zero exit code.

### Canonical Usage Errors

Examples:

- unknown subcommand: `Unknown command: <name>` plus usage
- `switch` with missing index: `Missing index. Usage: codex auth switch <index>`
- `switch` with invalid index: `Invalid index: <value>`

---

## JSON Mode Contract

The following commands support `--json` and produce pretty-printed JSON objects:

- `codex auth forecast --json`
- `codex auth report --json`
- `codex auth fix --json`
- `codex auth doctor --json`
- `codex auth verify-flagged --json`

Compatibility guarantees:

- Output is valid JSON.
- `command` field identifies the command family.
- Documented top-level sections remain stable unless a migration note is provided.

---

## HTTP/Error Mapping Contract (Fetch Helpers)

### Entitlement Mapping

- Upstream entitlement-like 404 payloads are normalized to `403` with `entitlement_error` payloads.
- Entitlement errors are not treated as rate limits.

### Rate-Limit Mapping

- Upstream usage-limit indicators normalize to rate-limit semantics.
- `handleErrorResponse` may return parsed `rateLimit.retryAfterMs` metadata.

### Response Normalization

- Error responses are normalized to JSON error payloads with a stable `error.message` field.
- Diagnostics may include request/correlation IDs when available.

---

## Options-Object Compatibility Contract

For selected exported helper APIs, options-object forms were added without removing positional signatures.

Supported dual-call forms include:

- `selectHybridAccount(...)` and `selectHybridAccount({ ... })`
- `exponentialBackoff(...)` and `exponentialBackoff({ ... })`
- `getTopCandidates(...)` and `getTopCandidates({ ... })`
- `createCodexHeaders(...)` and `createCodexHeaders({ ... })`
- `getRateLimitBackoffWithReason(...)` and `getRateLimitBackoffWithReason({ ... })`
- `transformRequestBody(...)` and `transformRequestBody({ ... })`

---

## Related

- [public-api.md](public-api.md)
- [commands.md](commands.md)
- [../troubleshooting.md](../troubleshooting.md)
- [../upgrade.md](../upgrade.md)
