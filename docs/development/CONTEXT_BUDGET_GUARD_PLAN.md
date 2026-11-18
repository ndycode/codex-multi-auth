# Implementation Plan: Context Budget Guard

Status: **implemented** on `feat/context-budget-guard`, ready for PR (see §12 for the delta between this plan and what actually shipped)
Target section: README → **Experimental Settings Highlights**; interactive Settings → Experimental menu
Feature flag default: **disabled** (opt-in, staged)

## 1. Problem

Codex sessions routed through this proxy resend their full conversation on
every non-background Responses call. When that history approaches the
model's context window, the *first* signal a user gets today is reactive:
`lib/context-overflow.ts` intercepts the upstream 400
(`context_length_exceeded` / `prompt_too_long`) *after* a request has already
failed, and returns a synthetic notice telling the user to run `/compact` or
`/clear`.

That is a good last-resort safety net, but it is a recovery mechanism, not a
prevention one. A session that is about to blow its context window gets no
warning until the wasted round-trip already happened. The ask here is a
**proactive** guard: track how full the current session's context is on every
turn, nudge at a soft threshold (default 65%), and — if the user pushes past
a hard threshold (default 69%) without compacting — pause the *next* forward
so the session never actually hits the upstream 400 in the first place.

The 65% / 69% split intentionally leaves headroom under the reactive
handler's trigger point (100%) and under most providers' own soft-compaction
behavior, so the guard fires while a `/compact` still has plenty of room to
work with.

## 2. Prior art in this codebase (why the design looks the way it does)

This is not a new architectural shape — it is the same shape as the existing
**preemptive quota scheduler**, pointed at a different resource:

| Concern | Existing analog | This feature |
| --- | --- | --- |
| Resource tracked | account rate-limit quota (5h/7d window, from `x-codex-*-used-percent` headers) | session context window (from Responses `usage.input_tokens` / `total_tokens`) |
| Tracker | `PreemptiveQuotaScheduler` (`lib/preemptive-quota-scheduler.ts`) | `ContextBudgetGuard` (new, same shape: `configure()` / `update()` / decision getter, per-key `Map`, `prune()`) |
| Threshold config | `remainingPercentThresholdPrimary/Secondary`, clamped 0–100 | `softPercent` / `hardPercent`, clamped 0–100, `soft < hard` invariant |
| Action at threshold | defer the request (`getDeferral`) | soft: non-blocking advisory; hard: synthetic pause response |
| Non-blocking notice channel | `x-codex-*-used-percent` response headers, `showRuntimeToast` | same two channels, reused as-is |
| Blocking notice channel | n/a (quota guard defers, it doesn't answer locally) | `lib/context-overflow.ts`'s synthetic-SSE-response technique (`createContextOverflowResponse`) |
| Cost/model tables with an enforced "don't guess" policy | `lib/usage/pricing.ts` (`MODEL_PRICING` + `UNPRICED_ROUTABLE_MODELS` + `test/usage-pricing-coverage.test.ts`) | `lib/context-budget/model-context-windows.ts` (`ESTIMATED_MODEL_CONTEXT_WINDOWS` + `UNESTIMATED_ROUTABLE_MODELS` + a matching coverage test — but see §3.1: unlike pricing, these are labeled estimates, not facts, and an explicit override always wins) |
| Settings wiring | `preemptiveQuota*` fields end-to-end in `lib/config.ts` / `lib/schemas.ts` | same four-file pattern, new field names |

Following these patterns is a real requirement, not a style preference:
`test/documentation.test.ts` and the coverage tests above already fail the
build when a new routable model or config field is wired inconsistently, so
matching the established shape is what makes this mergeable at all.

## 3. New modules

### 3.1 `lib/context-budget/model-context-windows.ts`

**This is the one place the design deliberately does *not* mirror
`lib/usage/pricing.ts`.** Pricing rates are published, contractual numbers —
hardcoding them is recording a fact. Context-window size is not: per
`docs/releases/v2.5.0.md` §"Where the model facts came from", this project
already knows and states in writing that "the context window \[the published
API docs\] advertise is for the API surface rather than the ChatGPT Codex
backend this wrapper actually talks to." Shipping a hardcoded
`"gpt-5.4": 400_000`-style table would assert a fact the maintainers have
already found to be unreliable for this exact backend — that is the sloppy
version of this feature, not the rock-solid one.

So the window source is **override-first, estimate-second, never silently
authoritative**:

```ts
// Best-effort starting points ONLY — explicitly not verified against the
// ChatGPT Codex backend (see docs/releases/v2.5.0.md). Every value here
// exists so the guard has somewhere to start for a user who has not set an
// override; it is never treated as ground truth, and getEffectiveContextWindow
// always prefers a configured override over this table.
const ESTIMATED_MODEL_CONTEXT_WINDOWS: Record<string, number> = { ... };

// Routable models with no reasonable estimate at all. getEffectiveContextWindow
// returns null for these absent an override, and the guard treats null as
// "cannot evaluate; skip" — never a guessed percentage.
export const UNESTIMATED_ROUTABLE_MODELS = [...] as const;

export function getEffectiveContextWindow(
  model: string | null | undefined,
  overrides: Record<string, number> | undefined,
): number | null {
  // 1. explicit user override (contextBudgetGuardModelWindowOverrides) always wins
  // 2. ESTIMATED_MODEL_CONTEXT_WINDOWS as a fallback starting point
  // 3. null (guard no-ops for this model) if neither is present
}
```

The corresponding settings field,
`contextBudgetGuardModelWindowOverrides: Record<string, number>` (see §5),
is not a nice-to-have here — it is the **primary**, trustworthy path for
anyone who has actually observed their real ceiling, and the README /
settings docs for this field must say so explicitly rather than presenting
it as an edge-case escape hatch.

A coverage test (`test/context-budget-window-coverage.test.ts`), structured
like `test/usage-pricing-coverage.test.ts`, still fails if a model appears in
the router's model map but in neither `ESTIMATED_MODEL_CONTEXT_WINDOWS` nor
`UNESTIMATED_ROUTABLE_MODELS` — so a newly added model can't silently end up
in an unconsidered state; it must be a deliberate estimate or a deliberate
"we don't know."

**Explicitly out of scope for this PR:** an auto-learning ceiling that
tightens its own estimate from observed `context_length_exceeded` failures
(via `lib/context-overflow.ts`) would remove even the estimate's guesswork
over time, and fits this codebase's persisted-state patterns
(`lib/usage/ledger.ts`, `lib/runtime/quota-*`) well. It is a good follow-up,
not part of this change — adding a new persisted store, migration, and
learning/decay policy is a separate review surface and isn't needed to
satisfy the 65%/69% ask.

### 3.2 `lib/context-budget-guard.ts`

```ts
export interface ContextBudgetSnapshot {
  model: string;
  totalTokens: number;
  updatedAt: number;
}

export interface ContextBudgetOptions {
  enabled?: boolean;
  softPercent?: number;   // default 65
  hardPercent?: number;   // default 69
}

interface ContextBudgetPressure {
  percent: number;
  totalTokens: number;
  windowTokens: number;
  windowSource: "override" | "estimate";
  model: string;
}
export type ContextBudgetAdvisory =
  | { level: "ok" }
  | ({ level: "soft" } & ContextBudgetPressure)
  | ({ level: "hard" } & ContextBudgetPressure);

export class ContextBudgetGuard {
  configure(options: ContextBudgetOptions): void;
  /** Record the latest known context size for a session key, from that turn's usage. */
  update(key: string, snapshot: ContextBudgetSnapshot): void;
  /** Evaluate before forwarding the NEXT request on this session key. */
  getAdvisory(key: string, now?: number): ContextBudgetAdvisory;
  /** Drop stale sessions so the Map does not grow unbounded (mirrors scheduler.prune()). */
  prune(now?: number): number;
}
```

Behavior notes (all mirrored from `PreemptiveQuotaScheduler`'s existing,
audited edge-case handling):

- `getAdvisory` returns `"ok"` when disabled, when there is no snapshot yet
  for the key (first turn of a session — never block on absence of data),
  or when `getEffectiveContextWindow(model, overrides)` is `null` for that model.
- Percent is computed once, at `update()` time, from that call's own model —
  never recomputed later against a different model's window, so a mid-session
  model switch can't produce a stale or wrong percentage.
- `softPercent` and `hardPercent` are independently clamped to `[0, 100]`,
  and `configure()` refuses a config where `soft >= hard` by clamping soft to
  `hard - 1` (same defensive-clamp style as `clampInt` in the quota
  scheduler) rather than throwing — a bad settings value degrades to "guard
  fires later than intended," never to a crash.
- `prune()` is called lazily off `update()`, same 60s cadence as
  `PreemptiveQuotaScheduler.maybePrune`, keyed off session inactivity.

### 3.3 `lib/context-budget-response.ts` (and the `lib/synthetic-response.ts` extraction)

Reuses `lib/context-overflow.ts`'s synthetic-SSE-response technique — same
OpenAI Responses `response.*` event dialect, same `response.created` →
`output_item.added` → `output_text.delta/done` → `response.completed` shape,
same `200 OK` (never fail the session on our own notice). Rather than copy
that ~70-line SSE builder a second time, it was extracted verbatim into a new
shared `lib/synthetic-response.ts` (`createSyntheticSseResponse`), and
`lib/context-overflow.ts` was refactored to call it too — same observable
behavior (its existing tests pass unchanged), one audited builder instead of
two independently-maintained copies. Two differences from the overflow
handler's use of it:

- **Soft (65%)** does *not* get a synthetic response at all. It is
  non-blocking: the real request is forwarded unchanged, and the advisory
  rides along on a new response header (`x-codex-context-budget-percent`,
  added next to the existing `x-codex-*-used-percent` headers already in
  `sanitizeResponseHeadersForLog`'s allowlist) plus a best-effort
  `showRuntimeToast(client, ..., "warning")` when a TUI client is attached.
  This is the "smooth" half of the ask — most sessions never notice it fired.
- **Hard (69%)** short-circuits the *next* request before it reaches
  upstream, the same way `handleContextOverflow` already intercepts a 400 —
  except this fires pre-flight instead of post-response, so the wasted
  round-trip and the upstream error never happen. Message text is the
  existing `CONTEXT_OVERFLOW_MESSAGE` copy plus a one-line "(context budget
  guard: paused before the limit)" so the two code paths are visibly related
  in the transcript, not two unexplained different warnings.
- The hard-threshold pause is **self-clearing**: once the user runs
  `/compact` or `/clear` and the next real turn reports a lower
  `totalTokens`, `update()` overwrites the snapshot and `getAdvisory()`
  returns `"ok"` again on the following request. There is no separate
  "acknowledge" step, no stuck flag to reset by hand — this is the "swift"
  half of the ask, matching how the failover scheduler's cooldowns clear
  themselves once the underlying signal recovers.

## 4. Pipeline integration — TWO pipelines, not one

The original draft of this plan only looked at `index.ts`'s plugin-loader
`fetch()` override. Implementation surfaced a second, independent forwarding
path that needed the same wiring: **`lib/runtime-rotation-proxy.ts`**, the
localhost Responses proxy used by `codexRuntimeRotationProxy`, which is
**enabled by default** per the README. It has its own `PreemptiveQuotaScheduler`
instance, its own usage-ledger scanning, and — notably — it does not call
`handleContextOverflow` at all (the reactive context-overflow handler is only
wired into the `index.ts` path). Shipping the guard in only one of the two
would have made it dead code for most real installs, since rotation is the
default-on path. Both are wired, each with their own `ContextBudgetGuard`
instance (matching how each already has its own `PreemptiveQuotaScheduler`
instance — no shared mutable state between the two pipelines):

**`index.ts`** (plugin-loader `fetch()`):
1. *Pre-flight* — right after `sessionAffinityKey` is computed (before account
   selection), `contextBudgetGuard.getAdvisory(sessionAffinityKey ?? "")`; a
   `"hard"` result returns `createContextBudgetPauseResponse(advisory)`
   directly from the `fetch()` override, skipping the upstream call entirely.
2. *Recording usage* — inside the existing `onUsage` callback already passed
   to the success-handling call (the same one `usageDeferral.onUsage` feeds
   the usage ledger from), also call `contextBudgetGuard.update(...)`. No new
   scanning pass.
3. *Soft header* — on the returned `successResponse`, if the advisory
   captured at pre-flight time was `"soft"`, rebuild the response with
   `buildContextBudgetHeaders(advisory)` merged into its headers (cheap:
   `new Response(successResponse.body, { ...headers })`, no body buffering).

**`lib/runtime-rotation-proxy.ts`** (`handleRequestInner`):
1. *Pre-flight* — right after the request `context` (with `sessionKey`,
   `model`) is built and policy-checked, before `buildUpstreamUrl`, gated on
   `isResponsesRequest`. A `"hard"` result records a `blocked` usage-ledger
   row and writes `createContextBudgetPauseResponse(advisory)` straight to
   `res`, never reaching the account-selection loop — deliberately outside
   that loop, since which account serves the request has no bearing on how
   full its context already is.
2. *Recording usage* — right where `usageScanner.result()` is already read
   for the usage ledger, also call `contextBudgetGuard.update(...)` when a
   model and session key are present.
3. *Soft header* — `forwardStreamingResponse` (shared by both request paths
   in this file) gained an optional `extraHeaders` parameter; the
   responses-path call site passes `buildContextBudgetHeaders(advisory)` when
   the pre-flight advisory was `"soft"`.

Both pipelines reuse their existing session-identity concept as the guard's
map key (`sessionAffinityKey` / `context.sessionKey`) — no new session-identity
concept was introduced.

## 5. Settings wiring (four-file pattern, copied from `preemptiveQuota*`)

| File | Change |
| --- | --- |
| `lib/schemas.ts` | `contextBudgetGuardEnabled: z.boolean().optional()`, `contextBudgetGuardSoftPercent: z.number().min(0).max(100).optional()`, `contextBudgetGuardHardPercent: z.number().min(0).max(100).optional()` |
| `lib/config.ts` | defaults (`false`, `65`, `69`) in the plugin-config default block; `getContextBudgetGuardEnabled` / `getContextBudgetGuardSoftPercent` / `getContextBudgetGuardHardPercent` getters via `resolveBooleanSetting` / `resolveNumberSetting`, each with an env override (`CODEX_AUTH_CONTEXT_BUDGET_GUARD_ENABLED`, `CODEX_AUTH_CONTEXT_BUDGET_SOFT_PCT`, `CODEX_AUTH_CONTEXT_BUDGET_HARD_PCT`); three matching entries in the settings registry list (the one `preemptiveQuotaEnabled` etc. live in) so `config explain` reports them — `test/config-explain.test.ts`-style parity is what caught this class of drift before (see the `config-01/config-07` comment already in `lib/config.ts`) |
| `docs/configuration.md` | add the three fields to the example JSON block and the field list |
| `docs/reference/settings.md` | add a three-row table entry, same format as the `preemptiveQuota*` rows |
| `docs/development/CONFIG_FIELDS.md` | add to the maintainer field inventory |
| `README.md` | add env vars to the runtime-overrides table (optional — the existing `preemptiveQuota*` env vars aren't listed there either, so this may intentionally stay settings-only surface) |

Default is `contextBudgetGuardEnabled: false` — this ships **disabled**,
consistent with the README's framing of the Experimental section
("staged features," "intentionally non-destructive by default").

## 6. Experimental Settings UI

Per the request, this lands in the **Experimental** menu
(`lib/codex-manager/experimental-settings-*.ts`), not Backend Controls where
`preemptiveQuota*` lives — this guard is explicitly staged/opt-in, not a
default-on backend safety net.

Shipped scope is deliberately smaller than the original draft: only an
on/off toggle, not separate menu controls for the two percentages.
`softPercent`/`hardPercent`/`modelWindowOverrides` are settings-file/env-only.
Two independent `[`/`]`-style adjusters (one per threshold) would have
doubled the menu's already-busy hotkey surface for a knob most users will
never touch — the number that matters day-to-day is on/off, and anyone
tuning the percentages precisely is already comfortable editing
`settings.json` directly (`docs/reference/settings.md#experimental`,
`docs/development/CONFIG_FIELDS.md`). Revisit if real usage shows the
default 65/69 split needs more accessible tuning than that.

- `experimental-settings-schema.ts`: added `{ type: "toggle-context-budget-guard" }` to `ExperimentalSettingsAction`, plus hotkey `"4"` in `mapExperimentalMenuHotkey` (menu numbering: `1` sync, `2` backup, `3` refresh guard, `4` context budget guard).
- `experimental-settings-prompt.ts`: added a menu row (`${formatDashboardSettingState(draft.contextBudgetGuardEnabled)} ${copy.experimentalContextBudgetGuard}`) and the `toggle-context-budget-guard` branch, following the existing `toggle-refresh-guardian` pattern exactly — reads/writes `draft.contextBudgetGuardEnabled` on the same draft object the panel already saves as a whole.
- `lib/ui/ui-copy.ts`: added `experimentalContextBudgetGuard: "Enable Context Budget Guard"` and updated `experimentalHelpMenu` to mention `4 Budget`.
- `experimental-settings-entry.ts` / `unified-settings-controller.ts`: **no changes needed** — both are thin pass-throughs that already forward the full `PluginConfig` draft and the full `copy` object; adding a field to an object already being forwarded needed no new plumbing there.
- `README.md` → **Experimental Settings Highlights**: added the bullet describing the guard, linking to `docs/features.md#context-budget-guard-experimental`.

## 7. Tests

- `test/context-budget-guard.test.ts` — unit tests for `ContextBudgetGuard`: disabled-by-default no-op, no-snapshot-yet no-op, unestimated-model no-op, soft/hard threshold crossing, self-clearing after usage drops, `soft >= hard` degradation, an override for a different model never leaking onto an unestimated one, evaluating against the latest turn's model (not a stale one after a mid-session model switch), prune/expiry, `forget()`, empty-key no-op.
- `test/context-budget-window-coverage.test.ts` — every routable model (from `MODEL_PROFILES`) appears in exactly one of `ESTIMATED_MODEL_CONTEXT_WINDOWS` / `UNESTIMATED_ROUTABLE_MODELS`, mirroring `test/usage-pricing-coverage.test.ts`; plus override-wins-for-an-unestimated-model and null-with-no-override cases.
- `test/context-budget-response.test.ts` — synthetic pause response is a `200`, carries the plugin-notice headers, includes model/percent/recovery-commands in the message, labels an override- vs. estimate-sourced window differently, and round-trips through the real `convertSseToJson` client parser (same check `test/context-overflow.test.ts` does) — plus a `buildContextBudgetHeaders` formatting test.
- `test/plugin-config.test.ts` — added the four new default fields to the five full-`toEqual` default-config comparisons that broke without them.
- `test/index.test.ts` — added the four new getters to the existing `../lib/config.js` mock block.
- `test/loader-setup.test.ts` — added the `applyContextBudgetGuardSettings` step and its expected position in `applyLoaderRuntimeSetup`'s call order.
- `test/experimental-settings-schema.test.ts` / `test/experimental-settings-prompt.test.ts` — hotkey `"4"` mapping, and a toggle-and-save case mirroring the existing refresh-guardian one.
- Deliberately **not** added: a dedicated property test file. The unit tests above already cover the guard's threshold/clamp/degradation invariants directly and exhaustively over a small, enumerable state space (two thresholds, three advisory levels, a handful of edge cases) — a property test would mostly restate the same assertions with generated inputs rather than find new failure classes, unlike `test/property/context-overflow.property.test.ts`'s job of fuzzing arbitrary upstream response bodies/text. Revisit if a real bug surfaces that only a property test would have caught.
- `test/documentation.test.ts` — ran clean with no changes needed; the doc edits in §5/§6 didn't trip its parity checks.

## 8. Edge cases and safety (reviewed against the failover code's own audit comments)

- **Unknown model** → guard is a no-op for that turn unless an override is configured (never assert a window size as fact, same reasoning as `UNPRICED_ROUTABLE_MODELS`'s comment in `lib/usage/pricing.ts`, sharpened further per §3.1 since even the "known" models here are estimates, not published facts).
- **First turn of a session** → no snapshot yet, `getAdvisory` returns `"ok"`; the guard cannot block a session it hasn't observed.
- **Model switched mid-session** → percent is computed against the model of the turn that produced it, not recomputed later, so switching to a larger-window model naturally clears a soft/hard state on the next real turn without special-casing.
- **`CODEX_MULTI_AUTH_BYPASS=1`** → pipeline already skips the multi-auth intercept entirely in this mode; the guard must not run either, since there is no proxy-owned response path to answer on.
- **Clock skew / stale snapshot** → `update()` timestamps are monotonic per-process (`Date.now()`), same trust model the quota scheduler already uses for `updatedAt`; no cross-process clock trust is introduced.
- **Session key churn** (session-affinity forgetting a key on account rotation) → a forgotten key simply means the guard starts cold for that key, same as quota scheduler behavior; never a stuck pause.
- **Streaming abort mid-response** → if the client aborts before `usage` is observed, `update()` is simply never called for that turn; the guard's state stays at its last known-good value, it does not zero out or guess.

## 9. Files touched (actual, on `feat/context-budget-guard`)

```
lib/context-budget/model-context-windows.ts          (new)
lib/context-budget-guard.ts                           (new)
lib/context-budget-response.ts                        (new)
lib/synthetic-response.ts                              (new — shared SSE builder, extracted)
lib/runtime/context-budget-settings.ts                 (new — config-to-guard wiring adapter)
lib/context-overflow.ts                                (refactored onto lib/synthetic-response.ts, no behavior change)
lib/config.ts                                          (defaults, getters, registry entries)
lib/schemas.ts                                         (zod fields)
lib/runtime/loader-setup.ts                            (new applyContextBudgetGuardSettings step)
index.ts                                               (guard instance, 3 pipeline touch points)
lib/runtime-rotation-proxy.ts                           (guard instance, 3 pipeline touch points)
lib/runtime/rotation-proxy-state.ts                     (contextBudgetGuard field)
lib/request/stream-failover-runtime.ts                  (forwardStreamingResponse extraHeaders param)
lib/request/response-metadata.ts                        (new header in the log-sanitize allowlist)
lib/codex-manager/experimental-settings-schema.ts       (menu action + hotkey)
lib/codex-manager/experimental-settings-prompt.ts       (menu row + toggle handling)
lib/ui/ui-copy.ts                                       (copy string + help-line update)
README.md                                               (Experimental Settings Highlights bullet)
docs/features.md                                        (new Context Budget Guard section)
docs/reference/settings.md                              (Experimental section + field table)
docs/development/CONFIG_FIELDS.md                       (Context Budget Guard field inventory)
test/context-budget-guard.test.ts                       (new)
test/context-budget-window-coverage.test.ts             (new)
test/context-budget-response.test.ts                    (new)
test/plugin-config.test.ts                              (5 default-config comparisons updated)
test/index.test.ts                                      (config mock updated)
test/loader-setup.test.ts                               (call-order expectation updated)
test/experimental-settings-schema.test.ts               (hotkey test)
test/experimental-settings-prompt.test.ts               (toggle test)
config/schema/config.schema.json                        (regenerated via `npm run generate:schema`)
```

Not touched, despite appearing in the original draft's table: `docs/configuration.md`
(its example JSON and field list are curated subsets, not exhaustive — the new
fields don't meet the bar the existing curated entries do, same as most other
`lib/config.ts` fields that aren't listed there either) and
`lib/codex-manager/experimental-settings-entry.ts` / `unified-settings-controller.ts`
(pass-throughs needed no changes — see §6).

## 10. Validation checklist (from `docs/development/implementation-plans/pr-description-template.md`)

- [x] `npm run lint` — clean (`lint:ts` + `lint:scripts`).
- [x] `npm run typecheck` — clean.
- [x] `npm test` — 5589/5604 relevant tests pass. The remaining 15 failures
      (`test/runtime-paths.test.ts`, `test/paths.test.ts`,
      `test/codex-bin-wrapper.test.ts`, `test/install-codex-auth.test.ts`,
      `test/codex-manager-history-command.test.ts`) are Windows-path-separator
      assertions that fail identically on a clean `main` checkout in this
      Linux sandbox — confirmed via `git stash` before making any changes.
      Pre-existing, unrelated to this feature.
- [x] `npm test -- test/documentation.test.ts` — passes unchanged.
- [x] `npm run build` (`tsc` + `generate:schema`) — clean; `config.schema.json` regenerated.
- [ ] Manual: enable the guard, drive a real session past 65% then 69% context usage, confirm the soft notice is non-disruptive and the hard pause's synthetic response reads correctly in a real Codex CLI session (not just the SSE unit shape). **Not done** — needs a live OpenAI-authenticated session with a real long-running conversation; out of reach in this environment.

## 11. Risk and rollback

- **Risk level:** low. Ships disabled by default; when disabled every new
  code path is a no-op (`getAdvisory` short-circuits on `enabled: false`
  before touching any state).
- **Rollback:** flip `contextBudgetGuardEnabled` back to `false` (or
  `CODEX_AUTH_CONTEXT_BUDGET_GUARD_ENABLED=0`) — no data migration, no
  persisted state beyond an in-memory `Map` that is safe to drop.

## 12. Plan vs. actual — summary of what changed during implementation

Three things surfaced while building this that the original draft got wrong
or left open, in descending order of how much they changed the shape of the
work:

1. **Two forwarding pipelines, not one** (§4). The draft only looked at
   `index.ts`. `lib/runtime-rotation-proxy.ts` — the default-on rotation
   proxy — needed its own wiring, since it's the path most real traffic
   actually takes and it doesn't share any state with `index.ts`'s pipeline.
2. **Model context-window sizes are estimates, not facts** (§3.1). The draft's
   first version hardcoded numbers exactly the way `lib/usage/pricing.ts`
   hardcodes prices. This project's own release notes disprove that those
   numbers are known for this backend, so the table was redesigned as
   override-first / estimate-second before any code was written against it.
3. **The interactive menu ships smaller than drafted** (§6): a single on/off
   toggle, not per-threshold `[`/`]` adjusters. Settings-file/env tuning
   covers the rest without doubling the Experimental menu's hotkey surface.

Everything else — the `PreemptiveQuotaScheduler`-shaped tracker, the
synthetic-SSE-response pause mechanism, the four-file settings pattern, the
disabled-by-default posture — landed as designed.
