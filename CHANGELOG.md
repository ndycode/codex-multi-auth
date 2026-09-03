# Changelog

All notable changes to this project are documented in this file.
Dates use ISO format (`YYYY-MM-DD`).

This repository's current stable release line is `2.x`. Full release notes live in [`docs/releases/`](docs/releases/) — this file is the short version. Pre-`0.1.0` iteration history is archived in [`docs/releases/legacy-pre-0.1-history.md`](docs/releases/legacy-pre-0.1-history.md).

## [Unreleased]

### Added

- GPT-6 Astra is a first-class model family. `gpt-6-astra` and the long-horizon
  `gpt-6-astra-aeon` each resolve to their own canonical id with the frontier
  reasoning ladder (`low` through `max`, plus `ultra`, which is rewritten to
  `max` on the wire exactly as upstream Codex does). Bare `gpt-6` and `astra`
  resolve to the flagship, and `none`/`minimal` are coerced up to `low` because
  Astra does not accept them. A dedicated GPT-6 resolver claims every id the
  alias table does not name, including the `gpt-6-astra-pro` plan tier, dated
  snapshots, and any tier OpenAI adds later, so an unrecognised GPT-6 id can
  never fall through to GPT-5.5. That silent downgrade is the exact failure
  v2.5.0 had to fix for GPT-5.6, one major version down. `aeon` deliberately
  keeps its own id rather than collapsing into the flagship: it is a
  behaviourally different model, not a rename. Both shipped config templates
  carry the two models, and the `codex-multi-auth-codex` wrapper mirrors the
  same map, with a model-by-effort parity suite pinning the two together
- The Daybreak cyber models from the upstream Codex catalog
  (`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, plus `daybreak-blue`
  and `daybreak-red` shorthands) resolve to their own ids. Their slugs carry
  neither a `codex` nor a `gpt 5` token, so every resolver declined them and
  asking for the cyber-permissive model silently ran GPT-5.5. An unrecognised
  Daybreak id resolves to `blue`, the defensive variant, so a typo cannot
  upgrade a caller into the permissive one. They stay out of the picker
  templates, matching their `visibility: hide` upstream
- `gpt-6-astra` is priced at its published launch rate, $10 per 1M input and $50
  per 1M output on the standard service tier. No cached-input rate was
  published, so cached tokens bill at the full input rate, which over-states
  cost and makes a `maxCostUsd` budget trip early rather than late. OpenAI's
  Fast service tier is 2x standard, and no row in this table has ever carried a
  service-tier dimension, so a session billed at that tier is under-counted by
  half for Astra exactly as it already is for `gpt-5.6-sol` and every other
  priced model. Nothing in this repo selects that tier: `fastSession` is a local
  latency setting that lowers reasoning effort, not OpenAI's billed Fast mode.
  `gpt-6-astra-aeon` and both Daybreak models
  have no published rate and are listed in `UNPRICED_ROUTABLE_MODELS` rather
  than guessed at, so a cost budget fails closed while they are in the window
- An unsupported-model fallback chain for Astra: `gpt-6-astra` steps to
  `gpt-5.6-sol`, and `gpt-6-astra-aeon` steps to the flagship first, since that
  is still GPT-6 Astra without the long-horizon behaviour. Astra rolls out org
  by org, so an account that is not entitled yet gets a real unsupported-model
  response for it. The chain is opt-in (`fallbackOnUnsupportedCodexModel`
  defaults to `false`) and fires only on that response, so it never swaps the
  model out from under a request the account could have served
- `gpt-5.6-sol` gains its own chain entry to `gpt-5.5`. The chain is walked one
  hop at a time (`index.ts` reassigns the model and passes that as the next
  `requestedModel`), so a model with no entry of its own ends the walk. GPT-5.6
  shipped without one, which would have stranded the Astra path a rung short of
  a model every account has. Terra and Luna stay without entries: nothing steps
  into them
- All four new models are listed in `UNESTIMATED_ROUTABLE_MODELS`. OpenAI
  published two different context windows for Astra on launch day, 1.05M for the
  API surface and 272K for Codex, and this wrapper talks to the Codex backend.
  Set `contextBudgetGuardModelWindowOverrides` once you know your real ceiling

### Fixed

- The `codex-multi-auth-codex` wrapper resolves codex model ids that its
  explicit list does not name, matching lib. Its final clause tested
  `model === "codex"` where `resolveCodexCatalogModel` tests for the `codex`
  substring, so ids such as `gpt-6-codex` resolved to nothing in the wrapper
  while lib resolved them to the current codex model
- The wrapper buckets Daybreak ids into the `gpt-5.2` prompt family for status
  instead of returning no family at all. Their slug matched none of
  `resolveModelFamilyForStatus`'s branches
- `resolveModelFamilyForStatus` strips the provider prefix before classifying.
  Every branch is a `startsWith`, and `resolveStatusModel` forwards the raw
  `--model` value, so `openai/gpt-6` matched none of them and status routing
  fell back to `activeIndex` instead of the family index. This affected
  `openai/gpt-5.6-sol` and `openai/gpt-5.1` the same way before GPT-6 existed
- `gpt6`, written with no separator, resolves to Astra rather than GPT-5.5.
  `tokenizeModelId` splits on non-alphanumeric runs, so it produced a single
  `gpt6` token, the `gpt` + `6` pair never formed, and the id fell to
  `DEFAULT_MODEL` while still passing `capability-policy`'s catalog gate. Gate
  and resolver now agree on it
- `capability-policy`'s catalog gate matches the tokenizer's separator rule.
  It tested a hand-picked `[-_\s]` where `tokenizeModelId` splits on any run of
  non-alphanumerics, so `gpt.6-turbo` and `gpt---5` kept their raw string as the
  policy key while routing resolved them to a canonical model, leaving the store
  tracking a key no request reads. It is still narrow enough that `gpt-4o`,
  `gpt-4.5-preview` and `gpt.4-turbo` do not reach the resolver

## [2.10.0] - 2026-08-31

A pinned account gets a real bounded retry instead of a single attempt, and a new opt-in guard can pause a session before it overflows the model's context window. [Full notes](docs/releases/v2.10.0.md).

### Added

- Context Budget Guard, experimental and shipping **disabled**. Enable it from Settings → Experimental or with `contextBudgetGuardEnabled`. It tracks how full each session's context window is from the tokens each turn actually carries (`input_tokens` plus the reasoning-stripped output, never `total_tokens`) and answers the next request locally with a `/compact` notice once usage crosses `contextBudgetGuardHardPercent`, before that request costs an upstream round-trip. A soft threshold attaches a non-blocking `x-codex-context-budget-percent` header instead. Window sizes are best-effort estimates, not published facts, so `contextBudgetGuardModelWindowOverrides` always wins and a model with no estimate is skipped rather than guessed at. The pause is one-shot per measurement: it drops what it recorded as it fires, so the `/compact` turn it asks for is never blocked by it ([#681](https://github.com/ndycode/codex-multi-auth/pull/681))

### Fixed

- A pinned request retries a transient upstream failure instead of returning `codex_pinned_account_unavailable` on the first one. Every transient branch cools the account down before the next selection pass, and selection refuses a cooling-down pin, so the retry budget could never be spent. A pinned retry now waives that account's own cooldown, and only from the second pass of the same request, with 250ms/500ms/1s backoff and a cap of `min(retryAllAccountsMaxRetries + 1, 4)` upstream attempts. Rate limits, open circuits, disabled accounts and policy blocks all still stop it, the cooldown still applies to every other request and still sets `retry_after_ms`, and a pin already cooling down on arrival is still refused without an upstream call ([#683](https://github.com/ndycode/codex-multi-auth/pull/683))
- A pinned request is no longer refused by the local token bucket. That bucket spreads load across the selectable pool, and a pin has no alternative account, so a drained bucket could only reject a request the pinned account could serve. Circuit-breaker admission still applies, and the bucket is neither consumed nor refunded for a pin ([#682](https://github.com/ndycode/codex-multi-auth/pull/682))
- `account_skip_reasons` names the admission gate that actually rejected a request. The reason was re-derived from account state afterwards, which reports the first blocker it finds — so a drained bucket on a cooling-down account was reported as the cooldown, and a rejection from a half-open circuit whose probe another request had just claimed was reported as an exhausted bucket ([#682](https://github.com/ndycode/codex-multi-auth/pull/682))
- A context-window override below 1 token is dropped instead of being stored as a window of zero. `contextBudgetGuardModelWindowOverrides` validated positivity on the raw value and floored afterwards, so any value in `(0, 1)` was accepted by the schema and then silently ignored ([#681](https://github.com/ndycode/codex-multi-auth/pull/681))

## [2.9.2] - 2026-08-30

A maintenance release with no runtime, CLI, or configuration changes: `npm run typecheck:scripts` failed on every clean checkout. [Full notes](docs/releases/v2.9.2.md).

### Fixed

- `npm run typecheck:scripts` builds generated output before it runs the compiler. `scripts/codex-multi-auth.js` imports `../dist/lib/codex-manager.js` and `tsconfig.scripts.json` typechecks that file with `checkJs`, so on a fresh clone the script stopped with `TS2307: Cannot find module '../dist/lib/codex-manager.js'`. The build now lives in the script itself, matching `pack:check`, `coverage`, `bench:runtime-path` and `generate:schema`, which covers all three CI call sites and a clean local tree in one place ([#680](https://github.com/ndycode/codex-multi-auth/pull/680), thanks [@smpark00](https://github.com/smpark00))

### Changed

- `CONTRIBUTING.md` lists `npm run typecheck:scripts` in the documented local gate, now that it works from a clean checkout ([#680](https://github.com/ndycode/codex-multi-auth/pull/680))
- The `validate` CI job drops a build step made redundant by the script change, leaving per-job compile counts unchanged, and `test/ci-workflows.test.ts` derives its build-ordering guard over every job in `ci.yml` instead of a hardcoded pair, reading steps by YAML key position so a commented-out or `if:`-guarded build cannot satisfy it ([#680](https://github.com/ndycode/codex-multi-auth/pull/680))

## [2.9.1] - 2026-08-28

A `--cost` budget can no longer be silently defeated by the models most worth capping, and refreshing one account from the login dashboard stops disturbing the others. [Full notes](docs/releases/v2.9.1.md).

### Added

- `codex-multi-auth login --account <index|email|account_id>` re-authenticates exactly one saved account, leaving the active selection, every per-family rotation position, and a manual `switch` pin untouched. The write is refused if the OAuth identity is not the account you named, so the previous credentials stay intact. Implies `--preserve-selection`, and cannot be combined with `--org` ([#679](https://github.com/ndycode/codex-multi-auth/pull/679), thanks [@fnmendez](https://github.com/fnmendez))

### Fixed

- A `--cost` budget is enforced for models with no published price instead of counting them as free. 2.9.0 fixed the guard comparing `0 >= limit`, but eight of the fifteen routable model ids (`gpt-5.4-pro`, `gpt-5.5-pro`, `gpt-5.2-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5.1` — every `pro` tier among them) had no `MODEL_PRICING` entry, so their rows priced to `null`, aggregated as `$0.00`, and a cost cap never fired: two million tokens on `gpt-5.5-pro` passed a `--cost 1` cap. Usage summaries now carry `unpricedRequests` and a `--cost` limit fails closed with `cost limit cannot be evaluated`. The missing rates are deliberately not guessed — a wrong figure would move the trip point rather than fix it ([fe9b0d1](https://github.com/ndycode/codex-multi-auth/commit/fe9b0d16))
- A plain `login` no longer resets every model family's rotation position onto the account just signed in. Families track which account they are on independently, so one that had rotated away from a rate-limited account kept its own position; adding an account discarded that. Families that were following the global selection still follow it ([fe9b0d1](https://github.com/ndycode/codex-multi-auth/commit/fe9b0d16))
- Refreshing an account from the login dashboard no longer rewrites the native `~/.codex/auth.json` unconditionally. Refreshing account 3 while account 1 was active handed plain `codex` account 3's credentials, silently switching accounts; the sync now runs only when the refreshed account is the one Codex is using — which also means refreshing the active account does update it, where a selection-preserving refresh previously left it on expired tokens ([#679](https://github.com/ndycode/codex-multi-auth/pull/679))
- Refreshing a disabled account no longer returns it to rotation. The merge set `enabled: true` unconditionally, so topping up a credential silently undid a deliberate disable; a targeted refresh now preserves the flag and says the account is still out of rotation ([#679](https://github.com/ndycode/codex-multi-auth/pull/679))

## [2.9.0] - 2026-08-25

`budget set --cost` and `--tokens` were accepted but never enforced, a dead network path counted against account health, and account removal left live sessions routed to the wrong account. [Full notes](docs/releases/v2.9.0.md).

### Added

- The usage ledger records real token counts and cost. Both the runtime rotation proxy and the plugin host read the upstream `usage` object out of the response as it streams past, so `codex-multi-auth usage` reports actual consumption instead of zeros ([#678](https://github.com/ndycode/codex-multi-auth/pull/678))
- Transport failures emit a trace-correlated `proxyLog.error` line. That path never throws, so it previously produced no structured log entry at all ([#677](https://github.com/ndycode/codex-multi-auth/pull/677))

### Fixed

- `maxTokens` and `maxCostUsd` budget limits are enforced. Every ledger row recorded zero tokens and zero cost, so the guard compared `0 >= limit` and never fired — `budget set --cost 50` allowed unlimited spend, with only `--requests` doing anything ([#678](https://github.com/ndycode/codex-multi-auth/pull/678))
- Reasoning tokens are subtracted out of the output bucket before recording. The upstream reports `output_tokens` inclusive of `output_tokens_details.reasoning_tokens` while the cost estimator prices the two as disjoint, so recording both raw would bill reasoning twice and trip a cost cap early ([#678](https://github.com/ndycode/codex-multi-auth/pull/678))
- A streaming request's ledger row is written when the stream ends rather than when the handler returns, which is the only point at which its token counts exist. A client that disconnects mid-stream still records a row, without counts ([#678](https://github.com/ndycode/codex-multi-auth/pull/678))
- An upstream transport failure before response headers no longer feeds the account's circuit breaker or health tracker. A socket reset, TLS drop, or fetch timeout is a property of the network path, not of the account, and three of them used to open that account's breaker for ~30s during an outage that affected every account equally ([#677](https://github.com/ndycode/codex-multi-auth/pull/677))
- Deleting an account, restoring a backup, and the automatic removal of revoked-token accounts bump `affinityGeneration`. Session affinity is keyed by account index, so without the bump a running proxy kept routing in-flight conversations to whatever account slid into the vacated slot ([#678](https://github.com/ndycode/codex-multi-auth/pull/678))
- Two accounts with neither an `accountId` nor an email no longer share one account-policy entry. Both hashed the literal `"unknown"`, so pausing, draining, or tagging one applied to all of them; the key now falls back to the refresh token and remains independent of account position ([#678](https://github.com/ndycode/codex-multi-auth/pull/678))
- `withStreamingFailover` respects consumer backpressure. It enqueued every chunk as fast as the upstream delivered it, so a slow client buffered the whole response in memory — a 50-chunk stream was fully drained for a consumer that had read one chunk ([#678](https://github.com/ndycode/codex-multi-auth/pull/678))
- A transport failure records a runtime skip reason for the account it happened on, instead of clearing the skip-reason overlay that `forecast` and `report` read ([#677](https://github.com/ndycode/codex-multi-auth/pull/677))

## [2.8.7] - 2026-08-21

`codex "your prompt"` took the slow shadow-home startup path, prompt text after `--` was parsed as configuration, and the pinned-account 503 called every recovery deadline a limit reset. [Full notes](docs/releases/v2.8.7.md).

### Fixed

- A root TUI launch carrying the optional initial prompt (`codex "your prompt"`) keeps the canonical `CODEX_HOME`. It was classified as a subcommand launch and took the shadow home, whose omitted SQLite state made Codex rebuild its whole thread index from rollouts before submitting the prompt you had already typed ([#674](https://github.com/ndycode/codex-multi-auth/pull/674))
- A prompt forced with `--` is treated as a prompt, so `codex -- exec` opens a session whose prompt is the word "exec" rather than dispatching the exec subcommand — matching how Codex itself parses it ([#674](https://github.com/ndycode/codex-multi-auth/pull/674))
- The launcher no longer reads flags out of prompt text: `--account`, `-m`/`--model`, and `--config=` written after a `--` are left alone instead of being stripped, treated as settings, or rewritten in place on a retry ([#674](https://github.com/ndycode/codex-multi-auth/pull/674))
- Wrapper-injected options are placed on the option side of `--` instead of appended. Appending put them in the subcommand's positional list, so `codex exec -- ...` failed with `unexpected argument '-c' found`, `codex sandbox -- echo hi` passed the pair to the sandboxed command, and `codex mcp add t -- echo hi` wrote it into that server's stored `args` in `config.toml` ([#674](https://github.com/ndycode/codex-multi-auth/pull/674))
- The pinned-account 503 words its recovery deadline by the blocker actually holding the account — circuit breaker, cooldown, or rate limit — instead of calling every deadline a recorded limit reset, which made provider outages read as blown subscription quotas ([#676](https://github.com/ndycode/codex-multi-auth/pull/676))
- That wording is taken from the pin's live runtime state rather than the retry loop's selection verdict, so the common case where the pinned account 429s mid-request no longer reports the internal token `already-attempted` with a deadline attributed to nothing ([#676](https://github.com/ndycode/codex-multi-auth/pull/676))
- The quota phrasing is used only when the rate limit is what bounds recovery; when a cooldown or breaker ends later, the deadline is worded neutrally ([#676](https://github.com/ndycode/codex-multi-auth/pull/676))

### Changed

- `docs/development/ARCHITECTURE.md` and `docs/development/CONFIG_FLOW.md` describe the interactive-TUI branch as covering prompt-bearing launches, matching the routing the wrapper now performs ([#674](https://github.com/ndycode/codex-multi-auth/pull/674))

## [2.8.6] - 2026-08-16

`forecast --model` reported an account `ready` while every request to it failed, and the pinned-account 503 told forced pins to run a command that clears nothing. [Full notes](docs/releases/v2.8.6.md).

### Fixed

- `forecast`, `best`, and `report` with `--model` check that model's prompt family instead of a hardwired `codex` family. An account held down by a live limit for the family you asked about no longer reports `ready` with no reasons ([#670](https://github.com/ndycode/codex-multi-auth/pull/670))
- Those commands no longer report a delay caused by a rate limit on a *different* model in the same family — availability now uses exactly the two keys account selection consults ([#670](https://github.com/ndycode/codex-multi-auth/pull/670))
- When a family-wide and a model-specific limit are both active, the reported wait is the later one rather than the earlier, so the stated time is actually usable ([#670](https://github.com/ndycode/codex-multi-auth/pull/670))
- A recorded `rate-limited` state backed by a live limit for the requested family is no longer discarded as stale ([#670](https://github.com/ndycode/codex-multi-auth/pull/670))
- The pinned-account 503 no longer advises `unpin` for a pin set by `--account` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT`, which `unpin` cannot clear. Forced pins are told to relaunch ([#671](https://github.com/ndycode/codex-multi-auth/pull/671))
- That 503 now reports when the account recovers, taking the latest of its rate limit, cooldown, and circuit-breaker deadline ([#671](https://github.com/ndycode/codex-multi-auth/pull/671))
- A permanently blocked pin — disabled, no enabled workspace, invalidated token, policy block — reports no recovery time instead of a deadline that expires into another 503 ([#671](https://github.com/ndycode/codex-multi-auth/pull/671))
- That suppression now also holds when the request itself is what disabled the account, which previously surfaced as `already-attempted` and hid the block ([#671](https://github.com/ndycode/codex-multi-auth/pull/671))
- A corrupt timestamp in stored account state no longer turns the pinned 503 into a generic 500 carrying no account index, reason, or skip map ([#671](https://github.com/ndycode/codex-multi-auth/pull/671))

### Added

- `pin_source`, `reset_at`, and `retry_after_ms` on `codex_pinned_account_unavailable` responses ([#671](https://github.com/ndycode/codex-multi-auth/pull/671))

### Changed

- `docs/reference/error-contracts.md` documents the new fields, both pin kinds, and how `retry_after_ms` differs between the pinned and pool-exhausted codes ([#671](https://github.com/ndycode/codex-multi-auth/pull/671))

## [2.8.5] - 2026-08-13

Background rotation helpers never shut down — 183 of them at 5.58 GB on one machine, the oldest 33 hours past a 12-hour timeout. [Full notes](docs/releases/v2.8.5.md).

### Fixed

- Helpers no longer treat a reused process ID as a live launcher. Owner identity is now process ID plus start time ([#663](https://github.com/ndycode/codex-multi-auth/issues/663), [#664](https://github.com/ndycode/codex-multi-auth/pull/664))
- Each helper writes its own status file instead of all of them overwriting one, so `rotation status` no longer reports a random helper ([#663](https://github.com/ndycode/codex-multi-auth/issues/663), [#664](https://github.com/ndycode/codex-multi-auth/pull/664))
- Helper metadata is cleaned up on exit and swept on the next launch, instead of accumulating forever — 701 leftover files on one machine ([#663](https://github.com/ndycode/codex-multi-auth/issues/663), [#664](https://github.com/ndycode/codex-multi-auth/pull/664))
- Helpers left behind by a short-lived command are reaped in 15 minutes rather than 12 hours ([#665](https://github.com/ndycode/codex-multi-auth/pull/665))
- That reaper no longer kills a live `codex app` session that is simply idle between messages ([#669](https://github.com/ndycode/codex-multi-auth/pull/669))
- `rotation unbind-app` no longer strands owner files it can't pair with a status record ([#666](https://github.com/ndycode/codex-multi-auth/issues/666), [#669](https://github.com/ndycode/codex-multi-auth/pull/669))
- `rotation status` can no longer name one helper on its status line while marking a different helper's account as current ([#667](https://github.com/ndycode/codex-multi-auth/issues/667), [#669](https://github.com/ndycode/codex-multi-auth/pull/669))
- A stale status file with a reused process ID no longer counts as a running helper ([#667](https://github.com/ndycode/codex-multi-auth/issues/667), [#669](https://github.com/ndycode/codex-multi-auth/pull/669))
- Malformed process IDs in status files are rejected instead of being probed ([#667](https://github.com/ndycode/codex-multi-auth/issues/667), [#669](https://github.com/ndycode/codex-multi-auth/pull/669))

### Added

- `CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS` — hard cap on helper lifetime, default 24h, `0` disables ([#664](https://github.com/ndycode/codex-multi-auth/pull/664))
- `CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS` — shorter timeout for a helper whose launcher died and that never served a request, default 15m, `0` keeps the full idle timeout ([#665](https://github.com/ndycode/codex-multi-auth/pull/665), [#669](https://github.com/ndycode/codex-multi-auth/pull/669))

### Changed

- Helper status files are now per-process: `runtime-rotation-app-helper.<pid>.json`. The old shared path is still read but no longer written ([#664](https://github.com/ndycode/codex-multi-auth/pull/664))
- The stale-metadata sweep runs after the helper spawns, so it no longer delays `codex app` or TUI startup ([#669](https://github.com/ndycode/codex-multi-auth/pull/669))
- `rotation unbind-app` stops helpers in parallel instead of one at a time ([#669](https://github.com/ndycode/codex-multi-auth/pull/669))

### Security

- Removed the deprecated `@openauthjs/openauth` dependency. PKCE is now generated directly from `node:crypto` per RFC 7636 ([#661](https://github.com/ndycode/codex-multi-auth/pull/661))
- Test-only failure hooks in the published wrapper now require an explicit opt-in, so a stray environment variable can't arm one ([#668](https://github.com/ndycode/codex-multi-auth/issues/668), [#669](https://github.com/ndycode/codex-multi-auth/pull/669))

## [2.8.4] - 2026-08-12

`codex app-server` didn't work at all with rotation on, which is the default. [Full notes](docs/releases/v2.8.4.md).

### Fixed

- `app-server` refused to start on any machine that had run one before, and served a frozen thread list when it did start. It now uses your real Codex home rather than a mirrored copy ([#659](https://github.com/ndycode/codex-multi-auth/issues/659), [#662](https://github.com/ndycode/codex-multi-auth/pull/662))
- The CLI shim `app-server` didn't need was setting `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` on everything the server spawned, so nested commands ran unrotated and billed the wrong account ([#662](https://github.com/ndycode/codex-multi-auth/pull/662))
- A short-lived `app-server` left a helper process running for 12 hours after exit ([#662](https://github.com/ndycode/codex-multi-auth/pull/662))
- A helper that couldn't start surfaced as an unhandled-rejection stack trace, leaking a temporary directory. It's now a one-line error and exit 1 ([#662](https://github.com/ndycode/codex-multi-auth/pull/662))

### Changed

- A rotation proxy that can't start now fails `app-server` outright rather than silently running it unrotated — a wrong-account bill is invisible, a failed start isn't ([#662](https://github.com/ndycode/codex-multi-auth/pull/662))

## [2.8.3] - 2026-08-09

### Fixed

- Quota windows with no label, duration, or reset time are hidden instead of rendering as a permanent `100%` ([#657](https://github.com/ndycode/codex-multi-auth/pull/657))

## [2.8.2] - 2026-08-09

Five fixes across login, uninstall, diagnostics, and quota. [Full notes](docs/releases/v2.8.2.md).

### Fixed

- Manual and incognito login now show the complete authorization URL, so pasting the callback back no longer fails with a state-mismatch error ([#652](https://github.com/ndycode/codex-multi-auth/issues/652))
- Uninstall instructions pointed at the old scoped package name, which can't remove what's installed ([#653](https://github.com/ndycode/codex-multi-auth/issues/653))
- `why-selected` showed a winning account the rotation proxy would never have picked. It now runs the same gates as the real thing ([#654](https://github.com/ndycode/codex-multi-auth/issues/654))
- Accounts with a revoked token are marked `token-invalid — re-login needed` and stay out of rotation instead of rejoining after a cooldown ([#655](https://github.com/ndycode/codex-multi-auth/issues/655))
- Exhausted weekly and monthly quotas wait for the real reset instead of retrying after a flat two hours and hitting an immediate `429` ([#656](https://github.com/ndycode/codex-multi-auth/issues/656))
- Rotation helpers verify they own a process before shutting it down, so an unrelated process is never mistaken for one of ours ([#658](https://github.com/ndycode/codex-multi-auth/pull/658))

## [2.8.1] - 2026-08-02

### Fixed

- `mcodex resume` and `fork` hung on a blank screen. They were using a temporary copy of your Codex home that deliberately omits the session database, so the thread you asked for genuinely wasn't there ([#647](https://github.com/ndycode/codex-multi-auth/issues/647), [#648](https://github.com/ndycode/codex-multi-auth/pull/648))
- The shell prompt didn't always come back after an interrupted Codex exit ([#648](https://github.com/ndycode/codex-multi-auth/pull/648))
- `--help` no longer starts a rotation proxy and leaves a background helper behind ([#648](https://github.com/ndycode/codex-multi-auth/pull/648))

### Security

- `hono` 4.12.21 → 4.12.33: JSX context leaking between requests, XSS via the `cx()` escaping bypass ([#650](https://github.com/ndycode/codex-multi-auth/pull/650))
- `undici` 6.25.0 → 6.28.0: Set-Cookie injection, WebSocket fragment DoS, keep-alive queue poisoning, SameSite downgrade. Staying on 6.x deliberately — 7.x would raise the Node floor to 20 ([#650](https://github.com/ndycode/codex-multi-auth/pull/650))

## [2.8.0] - 2026-07-28

### Fixed

- macOS stopped asking for the login keychain on every launch. The official CLI reads `cli_auth_credentials_store` from `config.toml`, and we only wrote it during a login or switch — so a third-party front-end running the official binary kept hitting the keychain ([#641](https://github.com/ndycode/codex-multi-auth/issues/641), [#642](https://github.com/ndycode/codex-multi-auth/pull/642))
- Interactive sessions no longer reindex your session history on every launch. They run against your real Codex home instead of a temporary copy ([#639](https://github.com/ndycode/codex-multi-auth/pull/639), [#643](https://github.com/ndycode/codex-multi-auth/pull/643))
- `doctor --fix` can repair the credential store directly, and reports correctly on a machine with no accounts yet ([#642](https://github.com/ndycode/codex-multi-auth/pull/642))

### Changed

- `cli_auth_credentials_store` is written on first run and re-checked on startup, not just during a login or switch. Opt out with `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0` ([#642](https://github.com/ndycode/codex-multi-auth/pull/642))
- Two interactive sessions can now run at once against the same state, the same as running the official CLI twice ([#639](https://github.com/ndycode/codex-multi-auth/pull/639))

## [2.7.1] - 2026-07-24

A bug hunt. Two of these could route to the wrong account or stall refreshes machine-wide. [Full notes](docs/releases/v2.7.1.md).

### Fixed

- A manual pin could route to a different account than the one you pinned. Pins are held by position, and account removal only remapped the active index — so removing a revoked account silently shifted your pin ([#638](https://github.com/ndycode/codex-multi-auth/pull/638))
- One failed refresh blocked refreshes for every process for 20 seconds, because failures were cached alongside successes ([#637](https://github.com/ndycode/codex-multi-auth/pull/637))
- A refresh waiting on the shared lease could be evicted and start a second refresh for the same token, which fails with `invalid_grant` on a healthy account ([#637](https://github.com/ndycode/codex-multi-auth/pull/637))
- Monthly (Codex Business) windows were labelled `5h` ([#635](https://github.com/ndycode/codex-multi-auth/issues/635), [#636](https://github.com/ndycode/codex-multi-auth/pull/636))
- An account at 100% used with no reset time could still be recommended as your best option ([#637](https://github.com/ndycode/codex-multi-auth/pull/637))
- Exhaustion was decided on a rounded percentage, so `99.6%` used benched an account that still had quota ([#637](https://github.com/ndycode/codex-multi-auth/pull/637))
- `import` and legacy migration dropped your pin and reset the affinity counter ([#637](https://github.com/ndycode/codex-multi-auth/pull/637))
- Session trimming cut the leading instructions it had just decided to keep ([#637](https://github.com/ndycode/codex-multi-auth/pull/637))
- A timed-out request never got its token back, gradually starving the bucket ([#637](https://github.com/ndycode/codex-multi-auth/pull/637))
- Project- and profile-scoped budgets never applied — stored under a normalised key, looked up with the raw one ([#637](https://github.com/ndycode/codex-multi-auth/pull/637))

## [2.7.0] - 2026-07-23

### Added

- `check` now shows when each quota window resets, not just how much is left ([#633](https://github.com/ndycode/codex-multi-auth/issues/633))

### Fixed

- Quota percentages kept their red/yellow/green colouring once a reset time was appended ([#633](https://github.com/ndycode/codex-multi-auth/issues/633))

## [2.6.1] - 2026-07-14

### Fixed

- OAuth login on WSL. No browser ever opened, because WSL reports itself as Linux and `xdg-open` isn't installed there. It now opens the Windows browser ([#630](https://github.com/ndycode/codex-multi-auth/issues/630))
- The manual-paste clipboard copied to the distro's clipboard rather than the Windows one you paste from ([#630](https://github.com/ndycode/codex-multi-auth/issues/630))
- A lost OAuth callback now explains the Windows/WSL port conflict instead of just timing out ([#630](https://github.com/ndycode/codex-multi-auth/issues/630))

## [2.6.0] - 2026-07-11

### Added

- Diagnostics probe with GPT-5.6, falling back for accounts without access ([#627](https://github.com/ndycode/codex-multi-auth/issues/627))

### Fixed

- GPT-5.6 now appears in older Codex builds' model pickers ([#626](https://github.com/ndycode/codex-multi-auth/issues/626))
- Upgrades no longer miss newly shipped models — the config installer merged the provider block shallowly, so an upgraded config never gained anything new ([#626](https://github.com/ndycode/codex-multi-auth/issues/626))
- The wrapper understands GPT-5.6. It re-implements the model map and never got the v2.5.0 work, so `gpt-5.6-*` requests silently resolved to `gpt-5.5` ([#626](https://github.com/ndycode/codex-multi-auth/issues/626))

### Changed

- `pidOffsetEnabled` defaults on, so parallel agents spread across accounts instead of all picking the same one and cascading into `429`s ([#628](https://github.com/ndycode/codex-multi-auth/issues/628))

## [2.5.0] - 2026-07-10

### Added

- GPT-5.6 (Sol, Terra, Luna) as first-class models, plus the `max` and `ultra` reasoning tiers above `xhigh`. `ultra` is rewritten to `max` before the request is sent, matching upstream

### Fixed

- `gpt-5.1-codex-max` is a model id, not Codex at max effort — it was nearly rerouted onto plain `gpt-5.1-codex`
- Unrecognised `gpt-5.6-*` ids silently ran GPT-5.5

## [2.4.0] - 2026-07-09

### Added

- `codex-multi-auth-codex --account <index|email|id>` forces one invocation onto a single account. Ephemeral (never touches your saved pin) and fail-hard (never silently uses a different account) ([#623](https://github.com/ndycode/codex-multi-auth/issues/623), [#624](https://github.com/ndycode/codex-multi-auth/pull/624))

## [2.3.3] - 2026-06-19

Nine fixes across rate limiting, refresh, streaming, and storage. [Full notes](docs/releases/v2.3.3.md).

### Fixed

- A single bad `retry-after` could bench an account for 31 years. Windows are now clamped to 7 days ([#617](https://github.com/ndycode/codex-multi-auth/pull/617))
- A slow refresh could delete a lock it no longer owned, leaving two processes refreshing at once — and since refresh tokens are single-use, logging the account out ([#617](https://github.com/ndycode/codex-multi-auth/pull/617))
- A routine save could revert a freshly rotated token, permanently breaking that account's next refresh ([#617](https://github.com/ndycode/codex-multi-auth/pull/617))
- A transient `429` benched an account for hours by folding the healthy weekly window into the retry delay ([#617](https://github.com/ndycode/codex-multi-auth/pull/617))
- `forecast` recommended a strictly worse account, because it took the longest of both quota windows rather than the binding one ([#617](https://github.com/ndycode/codex-multi-auth/pull/617))
- Upstream streaming failures were reported to the client as success, with the account recorded as healthy and retry suppressed ([#617](https://github.com/ndycode/codex-multi-auth/pull/617), [#618](https://github.com/ndycode/codex-multi-auth/pull/618))
- The SSE parser required a space after `data:`, so a spec-valid line parsed as zero events ([#617](https://github.com/ndycode/codex-multi-auth/pull/617))
- The V1→V3 storage migration discarded migrated account bodies, so a rate-limited account read as available and could burst `429`s ([#619](https://github.com/ndycode/codex-multi-auth/pull/619))
- OAuth `expires_in` accepted zero and negative values, minting an already-expired token and driving a tight refresh loop ([#619](https://github.com/ndycode/codex-multi-auth/pull/619))

## [2.3.2] - 2026-06-16

### Fixed

- An orphaned app-bind left `config.toml` pointing at a dead proxy with no CLI way out. `rotation unbind-app` now self-heals without a backup, and `rotation status` reports "bound but unmanaged" instead of "not configured" ([#614](https://github.com/ndycode/codex-multi-auth/pull/614))

## [2.3.1] - 2026-06-16

### Added

- `codex-multi-auth history` lists every local Codex session regardless of provider. `codex resume` filters by the provider recorded in each session, so rotation hides sessions created under the native provider — the files were always there ([#612](https://github.com/ndycode/codex-multi-auth/issues/612))

## [2.3.0] - 2026-06-15

### Fixed

- A permanent `503` that wedged rotation even with healthy accounts. Recovery reloaded from disk, restoring the same state that had wedged the pool, and the guard refused to run in exactly the situation it existed for ([#606](https://github.com/ndycode/codex-multi-auth/issues/606), [#607](https://github.com/ndycode/codex-multi-auth/pull/607))
- Two cooldown paths changed account state without scheduling the write, so a restart dropped it ([#608](https://github.com/ndycode/codex-multi-auth/pull/608), [#609](https://github.com/ndycode/codex-multi-auth/pull/609))

## [2.3.0-beta.3] - 2026-06-11

### Fixed

- Streaming stalled indefinitely for slow clients, buffering without bound
- Account deduplication needed more than one pass; it now loops until stable

### Security

- Atomic writes use `crypto.randomBytes` for temporary filenames instead of `Math.random()` ([#517](https://github.com/ndycode/codex-multi-auth/issues/517))

## [2.3.0-beta.2] - 2026-06-11

### Added

- Opt-in `sequential` scheduling drains one account before moving to the next, so quota windows stagger instead of resetting together ([#509](https://github.com/ndycode/codex-multi-auth/issues/509))

### Fixed

- Drain-first mode advanced its pointer on a transient fallback, breaking the invariant it exists for
- An expired token could be forwarded after a successful refresh, producing a `401` and a wrong invalidation cooldown
- Flagged-account restore dropped workspaces, so a multi-workspace account lost its list permanently
- A transient disk failure during quota-cache reload wiped every other account's data
- Login reported `Added account` when it had updated or rebound an existing one ([#512](https://github.com/ndycode/codex-multi-auth/issues/512))
- `login --manual` reported every failure as `Cancelled`, including a malformed URL and a state mismatch ([#512](https://github.com/ndycode/codex-multi-auth/issues/512))

### Security

- CI workflow steps pinned to exact commit SHAs ([#519](https://github.com/ndycode/codex-multi-auth/issues/519))
- Response headers under our own namespace are blocked by prefix, so a header added later is blocked by default ([#546](https://github.com/ndycode/codex-multi-auth/issues/546))

## [2.2.2] - 2026-06-03

### Fixed

- `forecast` reported working accounts as unavailable. `token-exhausted` has no natural expiry and nothing cleared it, so it lingered indefinitely — a successful request now clears it

## [2.1.3] - 2026-05-01

### Fixed

- Wrapper-launched sessions repair `session_index.jsonl` after known thread-store write damage, serialised so concurrent sessions can't collide
- App-bind status warnings resolve the active status path before printing guidance

## [2.1.2] - 2026-04-30

### Removed

- The global `codex` bin, which collided with the official Codex npm, native, and Homebrew installs. `codex-multi-auth` and `codex-multi-auth-codex` are unchanged

## [2.1.1] - 2026-04-29

### Fixed

- `usage`, `account`, `budget`, `bridge`, `integrations`, `models`, and `monitor` were falling through to the official Codex CLI instead of being handled locally
- `bridge token list --json` returned invalid JSON on an empty store, and included token hashes

## [2.1.0] - 2026-04-29

### Added

- Local-only usage ledger, account policy metadata, routing profiles, and budget guards
- Model and account capability matrix, with policy evaluated before account selection
- Optional loopback-only bridge with `/health`, `/v1/models`, and `/v1/responses`
- `rotation reset-rate-limits` to clear stale runtime timers

## [2.0.1] - 2026-04-25

### Changed

- Runtime rotation is enabled by default. Opt out with `rotation disable`, `codexRuntimeRotationProxy=false`, or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0`

### Fixed

- Install and update self-heal the packaged app bind and launcher routing

## [2.0.0] - 2026-04-25

### Added

- The runtime rotation proxy: failover across accounts mid-session, without restarting Codex. Loopback-only with an authenticated local client key
- `rotation enable|disable|status|bind-app|unbind-app`, with app binding fully reversible

### Fixed

- The proxy left a stale `content-encoding` header on responses it had decoded

## [1.3.2] - 2026-04-24

### Fixed

- Interactive forwarded sessions were capturing output, which broke TTY use. TTY sessions now inherit terminal stdio; non-TTY runs still capture so model-fallback can inspect errors ([#437](https://github.com/ndycode/codex-multi-auth/pull/437))

## [1.3.1] - 2026-04-24

### Added

- GPT-5.5 and GPT-5.5 Pro as first-attempt models, with deterministic fallback for older runtimes and accounts without access ([#435](https://github.com/ndycode/codex-multi-auth/pull/435))

### Fixed

- Model fallback now only triggers on a real upstream unsupported-model or no-access response ([#435](https://github.com/ndycode/codex-multi-auth/pull/435))

## [1.3.0] - 2026-04-17

### Added

- `why-selected` explains which account rotation picked and why ([#410](https://github.com/ndycode/codex-multi-auth/pull/410))
- `verify --paths` for path-safety inspection ([#410](https://github.com/ndycode/codex-multi-auth/pull/410))
- A feature-flagged routing mutex for safer concurrent selection, off by default ([#412](https://github.com/ndycode/codex-multi-auth/pull/412))

### Fixed

- Post-audit hardening across OAuth URL redaction, redirect-URI handling, selector null handling, short-`429` retry ordering, recovery writes, and malformed SSE warnings

## [0.1.8] - 2026-03-11

### Added

- Codex CLI sync: target detection, import adapters, named backup wrappers, and sync orchestration. Codex CLI state stays mirror-only ([#72](https://github.com/ndycode/codex-multi-auth/pull/72))

### Fixed

- Cleared accounts could revive themselves when the initial delete partially failed ([#71](https://github.com/ndycode/codex-multi-auth/pull/71))

## [0.1.7] - 2026-03-03

### Added

- The first consolidated `codex-multi-auth` release, bringing runtime, TUI, account management, and docs into one package ([#4](https://github.com/ndycode/codex-multi-auth/pull/4), [#14](https://github.com/ndycode/codex-multi-auth/pull/14))
- Rotating backup fallback, and automatic promotion of a real backup when primary storage holds fixture data ([#29](https://github.com/ndycode/codex-multi-auth/pull/29))
- Hardened Windows command routing across `codex.bat`, `codex.cmd`, and `codex.ps1` ([#27](https://github.com/ndycode/codex-multi-auth/pull/27))

### Fixed

- Codex CLI account switching stabilised, and storage identity fixed across worktree branch changes ([#27](https://github.com/ndycode/codex-multi-auth/pull/27), [#28](https://github.com/ndycode/codex-multi-auth/pull/28))

## [0.1.6] - 2026-03-03

### Fixed

- Updates could reset your accounts when storage was only reachable through recovery artifacts
- Codex CLI sync wrote auth to a different profile directory than `CODEX_HOME`
- Account switches now fail fast when the required Codex auth write doesn't complete

## [0.1.5] - 2026-03-03

### Fixed

- A Windows crash (`UV_HANDLE_CLOSING`) on wrapper shutdown, after the command had already completed

## [0.1.4] - 2026-03-03

### Fixed

- Stuck refresh lanes and duplicate refresh churn, via token normalisation and stale/timeout recovery
- `switch <index>` keeps local selection deterministic and reports sync failures clearly

## [0.1.3] - 2026-03-03

### Fixed

- `switch <index>` reported failure when only the optional Codex host-state sync was unavailable — the local switch had succeeded

## [0.1.2] - 2026-03-03

### Added

- Rotating backup recovery across `.bak`, `.bak.1`, and `.bak.2`, staged then committed so a failure can't leave a partial history chain
- Startup cleanup for orphaned staging files from interrupted writes, which could otherwise sit around holding token material

### Fixed

- Windows home resolution now tries `USERPROFILE` → `HOME` → `HOMEDRIVE`+`HOMEPATH` → `homedir()`

## [0.1.1] - 2026-03-01

### Fixed

- The OAuth callback is pinned to `127.0.0.1:1455` rather than `localhost`, which never arrived on machines resolving IPv6 first
- A clean global install could fail at startup; the `codex` bin now lazy-loads the auth runtime

### Changed

- Account emails dedupe case-insensitively
- Per-project storage is shared across linked Git worktrees
- The settings hub was split into five focused modules; `Q` now cancels without saving

## [0.1.0] - 2026-02-27

### Added

- The first stable release: multi-account OAuth for Codex
- The `codex auth ...` command family for login, switching, diagnostics, and reporting
- Dashboard settings hub and backend reliability controls
- Rotation and resilience modules for refresh, quota deferral, and failover

## Legacy History

Pre-`0.1.0` iteration history is archived in [`docs/releases/legacy-pre-0.1-history.md`](docs/releases/legacy-pre-0.1-history.md).

---

[0.1.0]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.0
[0.1.1]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.1
[0.1.2]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.2
[0.1.3]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.3
[0.1.4]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.4
[0.1.5]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.5
[0.1.6]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.6
[0.1.7]: https://github.com/ndycode/codex-multi-auth/releases/tag/v0.1.7
[1.3.0]: https://github.com/ndycode/codex-multi-auth/releases/tag/v1.3.0
[1.3.1]: https://github.com/ndycode/codex-multi-auth/releases/tag/v1.3.1
[1.3.2]: https://github.com/ndycode/codex-multi-auth/releases/tag/v1.3.2
[2.0.1]: https://github.com/ndycode/codex-multi-auth/releases/tag/v2.0.1
[2.0.0]: https://github.com/ndycode/codex-multi-auth/releases/tag/v2.0.0
