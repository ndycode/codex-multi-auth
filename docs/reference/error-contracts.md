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
- `switch` with missing index: `Missing index. Usage: codex-multi-auth switch <index>`
- `switch` with invalid index: `Invalid index: <value>`

---

## JSON Mode Contract

The following commands support `--json` and produce pretty-printed JSON objects:

- `codex-multi-auth forecast --json`
- `codex-multi-auth report --json`
- `codex-multi-auth fix --json`
- `codex-multi-auth doctor --json`
- `codex-multi-auth verify-flagged --json`

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

### Typed Errors

The request layer's thrown errors are backed by the typed hierarchy in `lib/errors.ts` (base class `CodexError`, which extends `Error` and carries a stable `code` string):

- `refreshAndUpdateToken` throws `CodexAuthError` (`code: "CODEX_AUTH_ERROR"`) with the message `Failed to refresh token, authentication required` on any refresh failure. The error carries a `retryable` boolean (transient network/lock failures are retryable; invalid-grant style failures are not) and, where available, `cause` and `context` (`refreshFailureReason`, `statusCode`).
- Catch sites may rely on `instanceof CodexAuthError` (or the structural `code` property) plus `retryable` to decide whether to re-attempt or force re-authentication.
- HTTP error responses are returned as normalized `Response` payloads (see above), not thrown, so they intentionally have no `Error` class.

---

## Runtime Rotation Proxy Error Contract

The default-on localhost Responses proxy returns JSON error payloads with a stable `error.code` field.

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `runtime_rotation_proxy_not_found` | `404` | Request path or method is outside the supported Responses/model discovery surface |
| `runtime_rotation_proxy_unauthorized` | `401` | Local request did not include the per-process proxy client key |
| `runtime_rotation_proxy_payload_too_large` | `413` | Request body exceeded the proxy safety cap |
| `codex_runtime_rotation_pool_exhausted` | `429` or `503` | No managed account can currently service the runtime request |
| `codex_pinned_account_unavailable` | `503` | A manual pin is set (via `codex-multi-auth switch`) but the pinned account is rate-limited, cooling down, disabled, or blocked by policy. Run `codex-multi-auth status` for details, or `codex-multi-auth unpin` to allow rotation |
| `codex_runtime_rotation_proxy_error` | `500` | Proxy failed before forwarding the request |

Pool exhaustion includes a `reason`, `retry_after_ms`, and a hint to run `codex-multi-auth rotation status`. Pinned-account-unavailable responses include a `pinnedAccountIndex` field identifying the pinned account, a structured `reason` field carrying the runtime skip reason (for example `rate-limited`, `cooling-down:auth-failure`, `circuit-open`, `disabled`, `workspace-disabled`, `policy-blocked`, `missing`, `already-attempted`) or `null` when no reason was recorded, and an `account_skip_reasons` map keyed by account index that mirrors the pool-exhausted response shape. The human-readable `message` appends the same reason in parentheses when present (see issue #486).

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

Invalid named-parameter calls (missing or wrongly typed required fields, or unknown keys) throw a native `TypeError` with a `<helper> requires ...` message — for example, `createCodexHeaders` throws `TypeError: createCodexHeaders requires accountId and accessToken`. This is a deliberate, shared convention across the dual-call helpers and is not wrapped in a `CodexError` subclass.

---

## Typed Error Classes

`lib/errors.ts` exports a `CodexError` hierarchy (`CodexApiError`, `CodexAuthError`, `CodexNetworkError`, `CodexValidationError`, `CodexRateLimitError`, `StorageError`, `CodexUnavailableError`). Every subclass carries a stable string `code` (the `ErrorCode` constants) plus class-specific fields, so callers can branch on `instanceof` or `code` instead of message text.

Startup-validation guarantees backed by these types:

- `startRuntimeRotationProxy` throws `CodexValidationError` with `field: "clientApiKey"` when no client API key is supplied, and `CodexValidationError` with `field: "host"` (offending host in `context.host`) when asked to bind a non-loopback host. Messages are unchanged from earlier releases; only the class tightened.
- `savePluginConfig` aborts with `StorageError` (`code: "UNREADABLE"`, `path` = the config file, actionable `hint`, read-classifier message as `cause`) when the existing config file cannot be read. Messages are unchanged from earlier releases; only the class tightened.

---

## Related

- [public-api.md](public-api.md)
- [commands.md](commands.md)
- [../troubleshooting.md](../troubleshooting.md)
- [../upgrade.md](../upgrade.md)
