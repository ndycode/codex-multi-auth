# Dimension P — Perf / Benchmarks (Lightweight)

HEAD 1f6da97, v1.2.7. NO benchmarks executed (per scope); static analysis only.

**Composed by Atlas** from evidence + inventory + architecture knowledge. Redo subagent produced skeleton only.

| ID | Severity | Claim | Evidence | Confidence |
|----|----------|-------|----------|------------|
| P-1 | Medium | Benchmark inventory exists but is narrow: edit-format benchmark + small runtime microbench only. | `bench/format-benchmark/**` has 3 source artifacts; `scripts/benchmark-edit-formats.mjs`, `scripts/benchmark-render-dashboard.mjs`, `scripts/benchmark-runtime-path.mjs`; npm scripts in `package.json:91-95`. | High |
| P-2 | Medium | Current coverage measures edit-format throughput/rendering plus a few runtime-path microcases, not end-to-end request or storage latency. | `docs/benchmarks/code-edit-format-benchmark.md:7-59`; `scripts/benchmark-runtime-path.mjs:117-140` covers `filterInput`, `cleanupToolDefinitions`, `accountHybridSelection_200`. | High |
| P-3 | Medium | Hot production paths lack dedicated benchmarks: SSE conversion/parser, error normalization, storage persistence, stream failover. | `lib/request/response-handler.ts:683-745`; `lib/request/fetch-helpers.ts:893-1077`; `lib/storage.ts:1639-1648,1880-1885`; `lib/request/stream-failover.ts`. | High |
| P-4 | Medium | Probable perf trap: non-streaming SSE path buffers full body, then splits/parses whole payload in second pass. | `lib/request/response-handler.ts:656-665`, `lib/request/response-handler.ts:696-718`. | High |
| P-5 | Medium | Probable perf trap: phase text rebuild does `map` + `filter` + `join` on every segment mutation, risking quadratic growth on long streamed outputs. | `lib/request/response-handler.ts:165-176`, called from `:193-200` and `:228`. | High |
| P-6 | Low | Probable perf trap: token bucket refund window cleanup allocates a new filtered array on every consume call. | `lib/rotation.ts:203-215`. | Medium |
| P-7 | Low | Probable perf trap: same error body can be JSON-parsed multiple times in one error-handling flow. | `lib/request/fetch-helpers.ts:897-910`, `:987-999`, `:1058-1068`. | High |
| P-8 | Low | Probable perf trap: hybrid account selection rebuilds a full `accountsWithMetrics` array for every selection request. | `lib/accounts.ts:668-687`; invoked from request path at `index.ts:1150`. | Medium |

## Bench Inventory

Bench-related source inventory found:

| Area | Files | Notes |
| --- | --- | --- |
| `bench/` fixtures/prompts/schema | `bench/format-benchmark/fixtures/TodoApp.tsx`; `bench/format-benchmark/prompts/hashline-v2.md`; `bench/format-benchmark/schema/summary.schema.json` | Input fixture + prompt + report schema for edit-format benchmark only. |
| Benchmark scripts | `scripts/benchmark-edit-formats.mjs`; `scripts/benchmark-render-dashboard.mjs`; `scripts/benchmark-runtime-path.mjs` | One end-to-end edit benchmark, one HTML renderer, one microbench runner. |
| Benchmark docs | `docs/benchmarks/code-edit-format-benchmark.md` | Human guide for edit-format benchmark workflow. |
| npm entrypoints | `package.json:91-95` | `bench:edit-formats`, `bench:edit-formats:smoke`, `bench:edit-formats:render`, `bench:runtime-path`, `bench:runtime-path:quick`. |

Bench count summary:

- `bench/**`: 3 files
- `scripts/benchmark-*.mjs`: 3 files
- `docs/benchmarks/*`: 1 file
- Total benchmark-related files discovered: 7

## Coverage Map

Existing benchmark coverage by area:

| Covered area | Evidence | Coverage note |
| --- | --- | --- |
| Code edit format throughput / output quality | `docs/benchmarks/code-edit-format-benchmark.md:7-59` | Measures latency, token/size overhead, success/error rates, output consistency, editing fidelity. |
| Edit benchmark orchestration + report/dashboard generation | `scripts/benchmark-edit-formats.mjs`; `scripts/benchmark-render-dashboard.mjs` | Focused on Codex edit-mode comparisons, not plugin runtime request path. |
| Runtime microbench: request preprocessing | `scripts/benchmark-runtime-path.mjs:117-133` | Covers `filterInput_*` and `cleanupToolDefinitions_*`. |
| Runtime microbench: account selection | `scripts/benchmark-runtime-path.mjs:134-139` | Covers `accountHybridSelection_200`. |

Not covered by existing benches:

- SSE parser / `convertSseToJson()` end-to-end response cost
- streaming capture path in `createResponseIdCapturingStream()`
- error-body normalization and retry metadata extraction in `handleErrorResponse()`
- persistent storage save path (`saveAccounts()` / `saveAccountsToDisk()`)
- backup rotation / journal write cost
- stream failover / retry-policy overhead

## Benchmark Doc Check

- `docs/benchmarks/code-edit-format-benchmark.md` measures edit-format throughput and render behavior for Codex-oriented editing workloads.
- It documents latency, token/size overhead, success/error rates, output consistency, and editing fidelity checks: `docs/benchmarks/code-edit-format-benchmark.md:7-59`.
- Last updated on disk: `2026-04-17 07:46` local time (`Get-Item docs/benchmarks/code-edit-format-benchmark.md`).

## Hot Paths Without Benches

Likely hot paths currently lacking dedicated perf coverage:

- Request success path SSE conversion: `lib/request/response-handler.ts:683-745`
- SSE incremental capture path for streaming: `lib/request/response-handler.ts:761-805`
- Error normalization / rate-limit parsing: `lib/request/fetch-helpers.ts:893-1077`
- Account selection on live request path: `index.ts:1150`, `lib/accounts.ts:660-697`
- Persistent account save path and backup rotation: `lib/storage.ts:1639-1648`, `lib/storage/account-save.ts:34-76`
- Stream failover orchestration: `lib/request/stream-failover.ts`

## Probable Perf Traps

1. `lib/request/response-handler.ts:696-718`
Static read: non-streaming path accumulates `fullText` with repeated string concatenation, then reparses whole SSE payload via `parseSseStream()`. Cost shape: extra memory copy + full second scan.

2. `lib/request/response-handler.ts:165-176`
`rebuildPhaseText()` rebuilds aggregate phase text with `map`/`filter`/`join`. It is triggered from `setPhaseTextSegment()` and fallback branch of `appendPhaseTextSegment()` at `:193-200` and `:228`. Cost shape: repeated O(n) reconstruction during long incremental outputs.

3. `lib/rotation.ts:203-215`
`TokenBucketTracker.tryConsume()` filters the recent-consumption array every request. Cost shape: per-request allocation proportional to refund-window event count.

4. `lib/request/fetch-helpers.ts:897-910`, `:987-999`, `:1058-1068`
One error response body can be parsed three times: initial `errorBody`, 404 remap check, and rate-limit parse. Cost shape: repeated sync JSON parse on same payload.

5. `lib/accounts.ts:668-687`
`getCurrentOrNextForFamilyHybrid()` builds a fresh `accountsWithMetrics` array on each selection. Cost shape: full-pool allocation/scoring every request even when pool state is mostly stable.

## Scope Note

No new benchmarks run. No timing claims made. Advisory only, based on source inspection and existing benchmark inventory.
| P-01 | LOW | `bench/format-benchmark/` is sole active benchmark target — focused on code-edit format comparison | `bench/format-benchmark/**`, `docs/benchmarks/code-edit-format-benchmark.md` | confirmed |
| P-02 | MEDIUM | Hot paths with NO benchmark: (a) `index.ts` 7-step request pipeline, (b) SSE parser `lib/request/response-handler.ts`, (c) account selection `lib/rotation.ts`, (d) storage writes `lib/storage.ts`, (e) token refresh `lib/refresh-queue.ts` — no perf SLA verified under load | AGENTS.md §WHERE TO LOOK; bench tree inspection | probable |
| P-03 | MEDIUM | Non-streaming SSE conversion buffers full stream in memory up to 10MB (cross-ref H-03) — large-body latency risk | dim-H finding H-03 | confirmed |
| P-04 | MEDIUM | 59 `JSON.parse()` calls across 31 files (cross-ref I-03); some in hot paths (request body, storage read, config load) — sync parse of large bodies blocks event loop | dim-I I-03 | probable |
| P-05 | LOW | Repeated regex compilation — not fully verified (needs targeted `new RegExp(` scan) | Static pattern | probable |
| P-06 | LOW | No perf regression CI gate — every bench run one-shot; no baseline commits | `.github/workflows/` (no perf CI job found) | probable |

## Verdicts
- **Biggest likely perf risk**: SSE parser memory buffering (P-03, cross-ref H-03)
- **Biggest observability gap**: no perf regression CI (P-06)
- **Hot paths lacking bench**: request pipeline + SSE + account selection + storage — consider adding micro-benchmarks

## Scope notes
Per audit guardrails: no new benchmarks executed. All findings static/inferred ("probable") — follow-up targeted bench pass warranted.
