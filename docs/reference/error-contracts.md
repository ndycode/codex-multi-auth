# Error Contract Reference

Error contract reference for user-facing CLI behavior, JSON mode, the runtime
rotation proxy, and exported helper call shapes.

---

## CLI error contract

### Exit codes

- `0`: successful execution
- `1`: usage error, invalid arguments, sync/persistence failure, or command failure

Command-specific notes:

- `why-selected`: `0` when an account is selected, `1` when the pool is empty or
  every candidate is cooled down / blocked
- `verify` / `verify-flagged`: `0` when all selected modes pass, `1` otherwise
  (the exit code is the AND of the sub-reports)
- `budget check`: `1` when the checked budget currently blocks requests
- `usage`: `0` for a successful summary or rotation, `1` for invalid options or
  write failures
- Forced `--account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT` failures exit non-zero
  without launching Codex when the proxy is disabled or the selector matches no
  account

### Streams

- Human-readable command output → `stdout`
- Argument/usage and failure diagnostics → `stderr`
- Invalid command/arguments print usage and exit non-zero

### Canonical usage errors

- unknown subcommand: `Unknown command: <name>` plus usage
- `switch` missing index: `Missing index. Usage: codex-multi-auth switch <index>`
- `switch` invalid index: `Invalid index: <value>`

---

## JSON mode contract

The authoritative list of common `--json` command surfaces is the Common Flags
`--json` row in [commands.md](commands.md):

`limits`, `verify-flagged`, `verify`, `why-selected`, `best`, `forecast`,
`report`, `usage`, `budget`, `models`, `monitor`, `integrations`, `fix`,
`doctor`, `config explain`, `debug bundle`, `history`.

Those commands accept `--json` / `-j` and emit pretty-printed JSON (for nested
families such as `budget`, the subcommands that take the flag).

Examples:

```bash
codex-multi-auth forecast --json
codex-multi-auth report --json
codex-multi-auth fix --json
codex-multi-auth doctor --json
codex-multi-auth limits --json
codex-multi-auth verify-flagged --json
codex-multi-auth verify --paths --json
codex-multi-auth why-selected --json
codex-multi-auth best --json
codex-multi-auth usage --json
codex-multi-auth budget list --json
codex-multi-auth models --json
codex-multi-auth monitor --json
codex-multi-auth integrations --json
codex-multi-auth config explain --json
codex-multi-auth debug bundle --json
codex-multi-auth history --json
codex-multi-auth history show <id> --json
```

Additive `--json` surfaces outside the compact Common Flags row:

- `codex-multi-auth list` / `status --json`
- `codex-multi-auth bridge token ... --json`
- `codex-multi-auth uninstall --json`
- `codex-multi-auth rotation reset-rate-limits --json`
- `codex-multi-auth rotation reset-runtime --json`
- `codex-multi-auth account policy list --json`

Compatibility guarantees:

- Output is valid JSON.
- `command` identifies the command family when the payload is a command result
  object.
- Documented top-level sections remain stable unless a migration note is
  provided.

---

## HTTP/error mapping contract (fetch helpers)

### Entitlement mapping

- Upstream entitlement-like 404 payloads normalize to `403` with
  `entitlement_error` payloads.
- Entitlement errors are not treated as rate limits.

### Rate-limit mapping

- Upstream usage-limit indicators normalize to rate-limit semantics.
- `handleErrorResponse` may return parsed `rateLimit.retryAfterMs` metadata.

### Response normalization

- Error responses normalize to JSON error payloads with a stable
  `error.message` field.
- Diagnostics may include request/correlation IDs when available.

### Typed errors

The request layer's thrown errors use the typed hierarchy in `lib/errors.ts`
(base class `CodexError extends Error`, carrying a stable `code` string):

- `refreshAndUpdateToken` throws `CodexAuthError`
  (`code: "CODEX_AUTH_ERROR"`, message `Failed to refresh token,
  authentication required`) on any refresh failure. It carries a `retryable`
  boolean (transient network/lock failures retryable; invalid-grant style
  failures not) plus, where available, `cause` and `context`
  (`refreshFailureReason`, `statusCode`).
- Catch sites may rely on `instanceof CodexAuthError` (or the structural `code`)
  plus `retryable` to decide between re-attempting and forcing
  re-authentication.
- HTTP error responses are returned as normalized `Response` payloads, not
  thrown, so they intentionally have no `Error` class.

---

## Runtime rotation proxy error contract

The default-on localhost Responses proxy returns JSON error payloads with a
stable `error.code` field.

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `runtime_rotation_proxy_not_found` | `404` | Path/method outside the supported Responses/model-discovery surface |
| `runtime_rotation_proxy_unauthorized` | `401` | Local request missing the per-process proxy client key |
| `runtime_rotation_proxy_payload_too_large` | `413` | Request body exceeded the proxy safety cap |
| `codex_runtime_rotation_pool_exhausted` | `429` or `503` | No managed account can currently service the request |
| `codex_pinned_account_unavailable` | `503` | A pin is in force (manual `codex-multi-auth switch`, or forced per-invocation via `--account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT`) but the pinned account stays rate-limited, cooling down, disabled, or policy-blocked after live blocker checks and bounded retries. Pins never rotate to another account |
| `codex_runtime_rotation_proxy_error` | `500` | Proxy failed before forwarding the request |

Pool-exhausted responses include `reason`, `retry_after_ms`, an
`account_skip_reasons` map keyed by account index, and a hint to run
`codex-multi-auth rotation status`. Pinned-account-unavailable responses mirror
that shape plus `pinnedAccountIndex`, a structured `reason` (for example
`rate-limited`, `cooling-down:auth-failure`, `circuit-open`, `disabled`,
`workspace-disabled`, `policy-blocked`, `missing`, `auth-failure`,
`network-error`, `server-error`, or `null` when none was recorded), and a
human-readable `message` that appends the blocker in parentheses (issue #486).

**Pinned retry budget:** for pinned requests the attempt budget is
`min(retryAllAccountsMaxRetries + 1, 4)` with 250ms/500ms/1s backoff, not the
raw setting — each retry is another copy of the same non-idempotent request to
the same upstream. A 16-selection-pass ceiling bounds the whole loop, including
branches that do not increment the transient-attempt counter.

**Cooldown waiver:** a pinned retry waives the pinned account's own
*cooldown*, and only the cooldown — every transient failure branch cools the
account before the next pass, so honoring it would end the loop after one
attempt. Rate limits, an open circuit, a disabled account, and workspace/policy
blocks still stop the retry; the cooldown stays on the account for other
requests and for `retry_after_ms`; and the waiver applies only from the second
pass onward — a pin *already* cooling down when the request arrives returns
`codex_pinned_account_unavailable` with no upstream call.

**Recovery fields on pinned responses:**

| Field | Type | Meaning |
| --- | --- | --- |
| `pin_source` | `"forced"` \| `"manual"` \| `null` | How the pin was set. `manual` came from `codex-multi-auth switch` and clears with `unpin`; `forced` came from the session launcher (`--account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT`) and `unpin` will NOT clear it — relaunch to select a different account. `message` carries the matching remedy |
| `reset_at` | ISO-8601 string \| `null` | When the pinned account next becomes selectable: the latest of its active rate-limit record for the request's family+model, any active cooldown, and its circuit breaker's next-admission deadline. `null` when nothing bounds recovery, deliberately so under permanent blockers (`disabled`, `workspace-disabled`, `policy-blocked`, `missing`, token invalidation) |
| `retry_after_ms` | number \| `null` | The same moment as ms from now. This is the *latest* bound for the single pinned account; `codex_runtime_rotation_pool_exhausted` reports the *earliest* recovery across the pool. Advisory only — never emitted as a `Retry-After` header |

Account policy pause/drain is enforced through runtime policy evaluation and
contributes to selection skip reasons such as `policy-blocked`.

---

### Rate-limit cache deadlines

The rate-limit contribution to `reset_at` / `retry_after_ms` is a local
revalidation deadline, at most one hour after the rejection, not a promise that
the subscription window has reset. Quota snapshots keep the server reset time
for display. A later cooldown or circuit-breaker deadline may still block use.

## Options-object compatibility contract

For selected exported helpers, options-object forms were added without removing
positional signatures.

Supported dual-call forms:

- `selectHybridAccount(...)` and `selectHybridAccount({ ... })`
- `exponentialBackoff(...)` and `exponentialBackoff({ ... })`
- `getTopCandidates(...)` and `getTopCandidates({ ... })`
- `createCodexHeaders(...)` and `createCodexHeaders({ ... })`
- `getRateLimitBackoffWithReason(...)` and `getRateLimitBackoffWithReason({ ... })`
- `transformRequestBody(...)` and `transformRequestBody({ ... })`

Invalid named-parameter calls (missing or wrongly typed required fields, or
unknown keys) throw a native `TypeError` with a `<helper> requires ...`
message — for example, `createCodexHeaders` throws
`TypeError: createCodexHeaders requires accountId and accessToken`. This is a
deliberate shared convention across the dual-call helpers, not wrapped in a
`CodexError` subclass.

---

## Typed error classes

`lib/errors.ts` exports the `CodexError` hierarchy: `CodexApiError`,
`CodexAuthError`, `CodexNetworkError`, `CodexValidationError`,
`CodexRateLimitError`, `StorageError`, `CodexUnavailableError`. Every subclass
carries a stable string `code` (the `ErrorCode` constants) plus class-specific
fields, so callers branch on `instanceof` or `code` rather than message text.

Startup-validation guarantees backed by these types:

- `startRuntimeRotationProxy` throws `CodexValidationError` with
  `field: "clientApiKey"` when no client API key is supplied, and with
  `field: "host"` (offending host in `context.host`) for a non-loopback bind.
- `savePluginConfig` aborts with `StorageError` (`code: "UNREADABLE"`, `path` =
  the config file, actionable `hint`, read-classifier message as `cause`) when
  the existing config file cannot be read.

Messages are unchanged from earlier releases; only the classes tightened.

---

## Related

- [public-api.md](public-api.md)
- [commands.md](commands.md)
- [../troubleshooting.md](../troubleshooting.md)
- [../upgrade.md](../upgrade.md)
