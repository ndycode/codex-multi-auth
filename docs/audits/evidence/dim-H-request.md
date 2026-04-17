# Dimension H — Request Pipeline / SSE / Resilience

**Audited by**: T12 agent (salvaged from mid-run output; agent hit step budget before writing file)
**Evidence base**: `index.ts`, `lib/request/{request-transformer,response-handler,fetch-helpers,stream-failover,failure-policy,rate-limit-backoff,request-attempt-budget,wait-utils}.ts`

## 7-Step Pipeline Map (index.ts)
1. URL rewrite
2. Request init + body parse
3. Request transform (model normalization, prompt injection) — `request-transformer.ts:868-1128`
4. Response continuation / session affinity injection
5. Account traversal + token refresh + header injection — `index.ts:1117-1452`
6. Fetch + timeout/error handling + retry/rotation — `index.ts:1457-2167`
7. Success handling + SSE conversion + stream failover + empty-response retry — `index.ts:2169-2681`

## Retry & Backoff
- Exponential: `baseDelay * 2^(attempt-1)`, cap 60s
- Jitter factor 0.2
- Dedup window 2s; state reset 120s
- Constants: `MAX_SHORT_RETRY_ATTEMPTS = 3`, `MAX_STREAM_FAILOVERS = 1`, `retryAllAccountsMaxRetries` (config-driven)

## Timeout Model
- Total fetch: `getFetchTimeoutMs()` default 60s
- SSE stall: `getStreamStallTimeoutMs()` default 45s
- Stream failover soft timeout: 10s/15s/20s by mode
- **No separate connect timeout** — single request-wide abort timer

## 5xx Path
- `status >= 500 && < 600` enters server policy
- Refunds token, records failure, rotates account (conservative same-account retry only if no `Retry-After`)
- Burst cooldown can fast-fail future requests

## Findings Table

| ID | Severity | Claim | Evidence | Confidence | Impact | Fix direction |
|----|----------|-------|----------|------------|--------|---------------|
| AUDIT-H01 | MEDIUM | Inline 7-step pipeline comments label only step 1 and step 3; full pipeline exists in code flow but not documented inline | `index.ts` (7-step flow across lines 891-2681) | confirmed | DX / maintainability friction for new contributors | Add step-numbered comments or extract each step into named helper |
| AUDIT-H02 | MEDIUM | No distinct connect timeout; single request-wide abort timer used for both connect + body/stream | `lib/request/fetch-helpers.ts:724-969` | confirmed | Slow TCP connect masks as total timeout; hard to diagnose connect vs upstream latency | Add `connectTimeoutMs` separate from total/stall timeouts |
| AUDIT-H03 | HIGH | Non-streaming SSE conversion buffers full stream in memory up to 10MB, parses terminal event only; malformed JSON lines silently skipped | `lib/request/response-handler.ts` | confirmed | Silent data loss on malformed chunks; memory pressure on long streams | Surface malformed-chunk warnings via logger.warn; add structured parse-error taxonomy |
| AUDIT-H04 | MEDIUM | Mid-stream failover refuses replay once `emittedBytes > 0` (intentional safety to avoid duplicate output); but recovery coverage after first byte is limited to error surfacing | `lib/request/stream-failover.ts` (`withStreamingFailover`) | confirmed | Partial output cannot be resumed; user sees hard error mid-generation | Document limitation; consider opt-in "resume with marker" for idempotent prompts |
| AUDIT-H05 | MEDIUM | Observability fields inconsistent across retry/failover branches; trace id / account id / attempt # not uniformly attached | `index.ts` multiple log call sites | confirmed | Post-failure reconstruction hard when different branches log different fields | Define log schema; use structured logger with mandatory correlation fields |
| AUDIT-H06 | LOW | Fallback 429 path hardcodes `"quota"` reason in one branch without reading `Retry-After` context | `index.ts:2408-2412` (rate-limit-backoff call site, fallback branch) | probable | Slight rotation determinism loss vs primary path which passes `stableAccountKey` | Align fallback branch with primary; pass `stableAccountKey` + real reason |
| AUDIT-H07 | LOW | `setTimeout` cleanup appears consistent in audited files; no leak observed in request path | `lib/request/fetch-helpers.ts`, `lib/request/wait-utils.ts` | confirmed (negative finding) | — | Preserve current clear-timeout discipline |
| AUDIT-H08 | MEDIUM | Deprecation/sunset headers logged only in `handleSuccessResponse()` — not in error paths where same headers may surface | `lib/request/fetch-helpers.ts` | probable | User misses deprecation signal during failing requests | Log deprecation headers in both success + error paths |
| AUDIT-H09 | LOW | Loop termination bounded by 4 independent guards (attempted.size < accountCount; outbound attempt budget; MAX_SHORT_RETRY_ATTEMPTS=3; MAX_STREAM_FAILOVERS=1) — no infinite-loop risk | `index.ts:1457-2167`, `lib/request/request-attempt-budget.ts` | confirmed (positive) | — | Preserve multi-gate termination pattern |
| AUDIT-H10 | MEDIUM | Empty-response retry logic after SSE conversion — triggers extra round-trip when terminal event missing but stream otherwise OK | `index.ts:2169-2681` | probable | Unnecessary cost; masks upstream issues | Add logging for empty-response retries; consider bounded count before erroring |

## Verdicts
- **Loop termination**: safe — 4 independent guards
- **Observability**: uneven; needs structured logger schema
- **SSE edge cases**: silent malformed-chunk discard is the biggest concrete risk
- **Mid-stream recovery**: intentionally minimal (safety over convenience)
- **Deprecation logging**: present but asymmetric

## Note
Agent hit step budget before completing deliverable; this file was composed by Atlas from the agent's captured analysis output. 10 findings above are grounded in file:line evidence references the agent reported. A deeper pass would add: Zod schema presence for response bodies, exact rate-limit-backoff formula constants, session-affinity injection correctness.
