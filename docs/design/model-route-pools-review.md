# Model route pools: integration review

## Review scope and release caveats

This is a focused native self-review, not an independent review. The review fixes
and broader routing changes have been integrated locally. This review does not
claim deployment or a new live desktop acceptance test.

## RISK: MEDIUM

The change affects credential selection, paid inference, continuation history,
and persistent account state. Explicit API and ZDR aliases remain isolated from
ordinary subscription traffic. ZDR classification is operator-supplied and does
not establish provider retention approval.

## FINDINGS

1. **HIGH — resolved:** API aliases dispatch before OAuth selection; unavailable
   explicit pools fail closed. Request compression is decoded with bounded sizes
   before model and credential routing. Fresh upstream credentials replace local
   authentication headers, and response headers use an allowlist.
2. **HIGH — resolved:** Native credential revocation is adopted exactly. Brief
   cached-storage grace only serves independently authenticated clients; stale
   snapshots cannot authenticate managed bearers. Binding and desktop credential
   writes share a cross-process lock.
3. **HIGH — resolved:** Account inventory edits survive in-flight requests and
   repeated stale saves through locked, identity-based three-way persistence.
   Manager replacement preserves mutex mode, runtime cooldowns and rate limits.
   Saved workspace preferences are reconciled separately from request telemetry.
4. **HIGH — resolved:** WebSocket handshakes and creates use the existing auth and
   routing pipeline. Continuation state is bounded per connection; pool boundaries
   and upstream ownership are enforced. No retry after accepted generation; orphan
   tool results require a full-context retry. Warm-up flags do not leak into turns.
5. **MEDIUM — resolved:** Catalogs isolate client versions, bound discovery fan-out
   to three, honor Retry-After, and distinguish unknown access from a confirmed
   missing model. Requested effort/speed combinations are checked per workspace.
   Picker metadata can be cached. Routing fails open: only a successfully
   fetched catalog (the last good one, whatever its age) excludes a model, and a
   catalog 429 backoff is capped at 15 minutes.
6. **MEDIUM — resolved:** A stored `switch` pin stays strict in native mode
   (as in #702), and so do explicit invocation pins; automatic reset-credit
   redemption never moves traffic off a pin. Checks complete tiny probes for unused personal subscriptions; ordinary
   requests have no special 100% priority. Ordinary eligible
   subscriptions precede the 5% reserve; API credentials never become an implicit
   paid fallback. Runtime quota events update subsequent selections.
7. **MEDIUM — bounded:** Capability probes are opt-in and billable, use a small
   fixed prompt, and are concurrency-limited. Discovery is not proof that every
   tool or endpoint works. Runtime capability failures are learned without treating
   transient authentication or throttling errors as missing entitlements.
8. **MEDIUM — release validation outstanding:** Wrapper/helper tests still fail
   in the full suite. The deterministic failures also occur on the base. The stress case failed twice
   on the integrated tree, then passed with only diagnostic assertion text changed;
   it also passes on the base. Its intermittency remains unresolved. This work does not
   broaden helper startup behavior or silently skip those tests.
9. **LOW — deferred:** Experimental ZDR voice is excluded pending endpoint and
   real-audio acceptance. No project/section routing, in-app account indicator, or
   desktop binary modification is included.

## Verification

- Current validation results and outstanding suite failures are tracked in
  [PR #705](https://github.com/ndycode/codex-multi-auth/pull/705).
- Typecheck and lint passed. Production dependency audit reports zero
  vulnerabilities; development audit passes its allowlist.
- Hono and nanoid security updates are included; WebSocket dependencies are pinned.
- Added lines contain no private account names, identifiers, credentials or private
  model/program labels. Email fixtures use reserved example domains.
- No live account configuration, desktop binary or installed router was changed
  during this integration. Publication and deployment status are tracked in the PR.
