# changelog

all notable changes to this project. dates are ISO format (YYYY-MM-DD).

## [unreleased]

### New Features
- Added a plugin-owned true hashline engine for plain host runtime by overriding the `edit` tool.
- Added `hashline_read` to emit deterministic `L<line>#<hash>` references for edit targeting.

### Improvements
- Bridge/remap prompt guidance now prefers hashline workflow (`hashline_read` -> `edit` with `lineRef`).
- README and configuration docs now include standard hashline usage for plain host runtime users.

## [5.2.3] - 2026-02-21

### Improvements
- Defaulted request transform mode to `native` so runtime tool schemas/payload shapes are preserved in current host runtime flows.
- Scoped bridge-style Codex remapping to explicit `legacy` mode only, reducing tool-name drift and invalid alias rewrites.
- Added config/env control for transform behavior: `requestTransformMode` and `CODEX_AUTH_REQUEST_TRANSFORM_MODE`.
- Updated bridge guidance to anchor on runtime tool manifests and avoid inventing/translating unavailable tool names.

### Chores
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm test
- Validation: npm run build
- Validation: host runtime smoke test (real auth state): successful file write/read tool flow (`filesystem_write_file`, `filesystem_read_text_file`)
- Validation: host runtime targeted `apply_patch` test: completed successfully (`apply_patch` tool part confirmed)

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v5.2.2...v5.2.3

- #27

## [5.2.2] - 2026-02-20

### Improvements
- Added stricter tool-call guardrails in host runtime bridge/remap prompts so the model only calls tools that actually exist in the active schema.
- Removed cross-environment path/tool assumptions that could trigger invalid tool calls.
- Hardened SSE response handling to convert terminal stream errors into structured JSON errors (`error`, `response.error`, `response.failed`, `response.incomplete`, and `data:` line variants).
- Prevented transformed non-OK responses from being counted/treated as successful turns.
- Added regression tests covering terminal SSE error paths and parser edge cases.

### Chores
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm test
- Validation: npm run build

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v5.2.1...v5.2.2

- #25

## [5.2.1] - 2026-02-20

### Improvements
- prompt fetch configurability: added `CODEX_PROMPT_SOURCE_URL` override support and source-aware cache metadata so ETag conditional requests stay bound to the same source.
- regression coverage + docs wording: updated prompt assertions/tests for the new `patch`+`edit` policy and refreshed architecture documentation text to match.

### Bug Fixes
- tool mapping conflicts in codex bridge/remap prompts: removed contradictory guidance that treated `patch` as forbidden and aligned instructions so `apply_patch` intent maps to `patch` (preferred) or `edit` for targeted replacements.
- host runtime codex prompt source brittleness: prompt fetch now retries across multiple upstream source URLs instead of relying on a single path that could return 404.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v5.2.0...v5.2.1

## [5.2.0] - 2026-02-13

### New Features
- gpt-5.3-codex-spark normalization + routing: added internal model mapping/family support for `gpt-5.3-codex-spark` and Spark reasoning variants.
- generic unsupported-model fallback engine: entitlement rejections now support configurable per-model fallback chains via `fallbackOnUnsupportedCodexModel` and `unsupportedCodexFallbackChain`.

### Improvements
- unsupported-model policy defaults: introduced `unsupportedCodexPolicy` (`strict`/`fallback`) with strict mode as default; legacy `fallbackOnUnsupportedCodexModel` now maps to policy behavior.
- entitlement handling flow: on unsupported-model errors, plugin now tries remaining accounts/workspaces before model fallback, improving Spark entitlement discovery across multi-account setups.
- fast-session reasoning summary: fast mode now uses `reasoning.summary = "auto"` (invalid/legacy summary values sanitize to `auto`).
- legacy fallback compatibility: `fallbackToGpt52OnUnsupportedGpt53` / `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` now act as a legacy edge toggle inside the generic fallback flow.
- documentation refresh: README, configuration, getting-started, troubleshooting, and config template docs now describe strict/fallback controls, Spark entitlement gating, and optional manual Spark template additions.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v5.1.1...v5.2.0

## [5.1.1] - 2026-02-08

### Bug Fixes
- provider-prefixed model config resolution: `openai/<model>` ids now correctly resolve to their base model config instead of falling back to global defaults.
- codex variant option merging: variant suffixes like `-xhigh` now apply `models.<base>.variants.<variant>` options during request transformation.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v5.1.0...v5.1.1

## [5.1.0] - 2026-02-08

### Improvements
- workspace candidate selection hardened: OAuth workspace auto-selection now prefers org defaults, id-token-selected workspace IDs, and non-personal org candidates before falling back to token-derived personal IDs.

### Bug Fixes
- business workspace routing: explicit org/manual workspace bindings are now preserved at request time and no longer overwritten by token `chatgpt_account_id` values.
- gpt-5.3-codex on Business accounts: fixed a dual-workspace path where requests could be routed to personal/free workspace IDs and fail with unsupported-model errors.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.9.6...v5.1.0

## [5.0.0] - 2026-02-08

### Breaking Changes
- auth login interaction redesigned: `codex auth login` now defaults to the Codex-style dashboard flow (actions/accounts/danger zone) instead of the legacy add/fresh-only prompt.
- styled codex tool output default: `codex-list`, `codex-status`, `codex-health`, `codex-switch`, `codex-remove`, `codex-refresh`, `codex-export`, and `codex-import` now default to the new Codex TUI formatting; scripts parsing legacy plain output should update or set `codexTuiV2: false`.

### New Features
- codex tui runtime controls: new config + env options for UI behavior: `codexTuiV2`, `codexTuiColorProfile`, `codexTuiGlyphMode`, `CODEX_TUI_V2`, `CODEX_TUI_COLOR_PROFILE`, and `CODEX_TUI_GLYPHS`.
- full account dashboard actions: interactive login now supports add/check/deep-check/verify-flagged/start-fresh, plus account-level actions (enable/disable, refresh, delete).
- dedicated flagged storage: introduced `openai-codex-flagged-accounts.json` with automatic migration from legacy `openai-codex-blocked-accounts.json`.
- ui architecture + coverage: added shared terminal UI runtime/theme/format modules and parity documentation (`TUI_PARITY_CHECKLIST.md`) with focused tests.

### Bug Fixes
- disabled account safety: disabled accounts are now excluded from active/current selection and rotation paths.
- enabled-flag migration: `enabled` account state now survives v1->v3 storage migration and persists reliably across save/load cycles.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.14.2...v5.0.0

## [4.14.2] - 2026-02-08

### Improvements
- gpt-5.3 fallback default: fallback from `gpt-5.3-codex` to `gpt-5.2-codex` on ChatGPT entitlement rejection is now enabled by default for all users.
- strict-mode opt-out: strict behavior is now opt-out via `fallbackToGpt52OnUnsupportedGpt53: false` or `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52=0`.

### Bug Fixes
- unsupported-model handling: normalized the upstream 400 (`"not supported when using Codex with a ChatGPT account"`) to a clear entitlement-style error instead of generic bad-request handling.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.14.1...v4.14.2

## [4.14.1] - 2026-02-07

### New Features
- fast session mode: optional low-latency tuning (`fastSession`) with `hybrid`/`always` strategies and configurable history window (`fastSessionMaxInputItems`).

### Improvements
- prompt caching: codex + host runtime bridge prompts now use stale-while-revalidate + in-memory caching; startup prewarms instruction caches to reduce first-turn latency.
- request parsing: fetch pipeline now normalizes `Request` inputs and supports non-string bodies (Uint8Array/ArrayBuffer/Blob) without failing request transformations.

### Bug Fixes
- trivial-turn overhead: in fast session mode, trivial one-liners can omit tool definitions and compact instructions to reduce roundtrip time.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.14.0...v4.14.1

## [4.14.0] - 2026-02-05

### New Features
- gpt-5.3-codex model support: added end-to-end normalization and routing for `gpt-5.3-codex` with `low`, `medium`, `high`, and `xhigh` variants.
- new codex family key: account rotation/storage now tracks `gpt-5.3-codex` independently in `activeIndexByFamily`.

### Improvements
- reasoning defaults: `gpt-5.3-codex` now defaults to `xhigh` effort (matching the current codex-family behavior), and `none`/`minimal` are normalized to supported codex levels.
- prompt fetch/cache mapping: prompt family detection now recognizes `gpt-5.3-codex`; cache files are keyed to `gpt-5.3-codex-instructions.md`.
- config templates + docs refreshed: modern/legacy config examples and model reference docs now advertise `gpt-5.3-codex` instead of `gpt-5.2-codex`.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.13.0...v4.14.0

## [4.13.0] - 2026-02-04

### New Features
- runtime metrics tool: added `codex-metrics` to inspect live request/error/latency counters for the current plugin process.
- 401 diagnostics payload: normalized 401 errors now include `diagnostics` (for example `requestId`, `cfRay`, `correlationId`, `threadId`) to speed up debugging.
- stream watchdog controls: new `fetchTimeoutMs` and `streamStallTimeoutMs` config options (and env overrides) for upstream timeout tuning.

### Improvements
- request correlation: each upstream fetch now sets a correlation id, reuses `CODEX_THREAD_ID`/`prompt_cache_key` when available, and clears scope after each request.
- plan-mode tool gating: `request_user_input` is automatically stripped from tool definitions when collaboration mode is Default (kept in Plan mode).
- safety prompt hardening: bridge/remap prompts now explicitly block destructive git commands unless the user asks for them.
- gpt-5.2-codex default effort: default reasoning now prefers `xhigh` when no explicit effort/variant is provided.
- gitignore hygiene: local planning/release scratch artifacts are now ignored to keep working trees clean.

### Bug Fixes
- non-stream SSE hangs: non-streaming SSE parsing now aborts stalled reads instead of waiting indefinitely.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.12.5...v4.13.0

## [4.12.5] - 2026-02-04

### New Features
- legacy migration: when the new project-scoped path is empty, the plugin now auto-migrates legacy `<project>/.host runtime/openai-codex-accounts.json` data on first load.

### Improvements
- per-project storage location: project-scoped account files now live under `~/.host runtime/projects/<project-key>/openai-codex-accounts.json` instead of writing into `<project>/.host runtime/`.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.12.4...v4.12.5

## [4.12.4] - 2026-02-03

### New Features
- Empty response retry - Automatically retries when the API returns empty/malformed responses. Configurable via `emptyResponseMaxRetries` (default: 2) and `emptyResponseRetryDelayMs` (default: 1000ms)
- PID offset for parallel agents - When multiple host runtime instances run in parallel, each process now gets a deterministic offset for account selection, reducing contention. Enable with `pidOffsetEnabled: true`

### Improvements
- Environment variables:
- `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES`
- `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS`
- `CODEX_AUTH_PID_OFFSET_ENABLED`
- Test coverage - 1516 tests across 49 files (up from 1498)
- npm publish status: not published on npm (tag/release only).

### Bug Fixes
- PID offset formula - Fixed bug where all accounts received the same offset (now uses `account.index * 0.131 + pidBonus` for unique distribution)
- Empty response detection - Hardened `isEmptyResponse()` to correctly identify empty choice objects (`[{}]`) and whitespace-only content as empty
- Test mocks - Fixed `index.test.ts` mocks for `createLogger` and new config getters (55 tests were failing)

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.12.3...v4.12.4

## [4.12.3] - 2026-02-03

### Improvements
- Test coverage - Up to 89% coverage (1498 tests)
- Code quality - Various improvements from audit

### Bug Fixes
- Account persistence fix - Accounts were being saved to the wrong location when `perProjectAccounts` was enabled (default). The issue was that `setStoragePath()` only ran in the loader, but authorize runs before that. So accounts got written to the global path, then the loader looked in the per-project path and found nothing. Both OAuth methods (browser and manual URL paste) now init storage path before saving. (#19)

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.12.2...v4.12.3

## [4.12.2] - 2026-01-30

### Bug Fixes
- TUI crash on workspace prompt - Removed redundant workspace selection prompt (auto-selects default now). Added `isNonInteractiveMode()` to detect TUI/Desktop environments. (#17)
- Web UI validation error - Added validate function to manual OAuth flow for proper error messages instead of `[object Object]`.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.12.1...v4.12.2

## [4.12.1] - 2026-01-30

### Improvements
- Audit logging - Rotating file audit log with structured entries
- Auth rate limiting - Token bucket rate limiting (5 req/min/account)
- Proactive token refresh - Refreshes tokens 5 minutes before expiry
- Zod schemas - Runtime validation as single source of truth
- ### Stats
- Tests: 580 â†’ 631 (+51)
- All passing on Windows with `--pool=forks`

### Bug Fixes
- Business plan workspace fix - Fixed the "usage not included" errors some Business plan users were hitting. Turns out we were sending a stale stored accountId instead of pulling the fresh one from the token - problematic when you've got multiple workspaces. (#17, h/t @alanzchen for the detailed trace)
- Persistence errors actually visible now - Storage failures used to fail silently unless you had debug mode on. Now you get a proper error toast with actionable hints (antivirus exclusions on Windows, chmod suggestions on Unix). (#19)
- Atomic writes for account storage - Switched to temp file + rename to avoid corrupted state if a write gets interrupted mid-flight.
- Fixed a reader lock leak - The SSE response handler wasn't releasing its lock in the finally block. Small thing but could cause issues over time.
- Debug logging for rotation - Added some visibility into which account gets picked and why during rotation.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.12.0...v4.12.1

## [4.12.0] - 2026-01-30

### Breaking Changes
- tool rename: all `openai-accounts-*` tools renamed to shorter `codex-*` prefix:
- `openai-accounts` → `codex-list`
- `openai-accounts-switch` → `codex-switch`
- `openai-accounts-status` → `codex-status`
- `openai-accounts-health` → `codex-health`
- `openai-accounts-refresh` → `codex-refresh`
- `openai-accounts-remove` → `codex-remove`

### New Features
- codex-export: export all accounts to a portable JSON file for backup or migration
- codex-import: import accounts from a JSON file, merges with existing accounts (skips duplicates)

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.11.2...v4.12.0

## [4.11.2] - 2026-01-30

### Bug Fixes
- windows account persistence: fixed silent failure when saving accounts on Windows. errors are now logged at WARN level with storage path in message, and a toast notification appears if persistence fails.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.11.1...v4.11.2

## [4.11.1] - 2026-01-29

### Improvements
- This plugin provides 6 built-in tools for managing your OpenAI accounts. Just ask the agent or type the tool name directly.
- | Tool | What It Does | Example Prompt |
- |------|--------------|----------------|
- | `openai-accounts` | List all accounts | "list my accounts" |
- | `openai-accounts-switch` | Switch active account | "switch to account 2" |
- | `openai-accounts-status` | Show rate limits & health | "show account status" |
- | `openai-accounts-health` | Validate tokens (read-only) | "check account health" |
- | `openai-accounts-refresh` | Refresh & save tokens | "refresh my tokens" |
- | `openai-accounts-remove` | Remove an account | "remove account 3" |

### Bug Fixes
- Zod validation error - Fixed crash when calling `openai-accounts-status` with no accounts configured

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.11.0...v4.11.1

## [4.11.0] - 2026-01-29

### New Features
- Subdirectory detection - Per-project accounts now work from subdirectories. The plugin walks up the directory tree to find the project root (identified by `.git`, `package.json`, `pyproject.toml`, etc.)
- Live countdown timer - Rate limit waits now show a live countdown that updates every 5 seconds: `Waiting for rate limit reset (2m 35s remaining)`
- Auto-remove on auth failure - Accounts are automatically removed after 3 consecutive auth failures, with a notification explaining what happened. No more manual cleanup of dead accounts.
- openai-accounts-refresh tool - Manually refresh all OAuth tokens to verify they're still valid

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.10.0...v4.11.0

## [4.10.0] - 2026-01-29

### New Features
- per-project accounts: each project gets its own account storage now. no more conflicts when working across different repos with different chatgpt accounts. auto-detects project directories (looks for .git, package.json, etc). falls back to global storage if you're not in a project folder.
- configurable toast duration: rate limit notifications stick around longer now (5s default). set `toastDurationMs` in config if you want them longer/shorter.
- account removal tool: new `openai-accounts-remove` tool to delete accounts by index. finally.
- token masking in logs: all tokens, api keys, and bearer headers are now masked in debug logs. no more accidentally leaking creds.

### Improvements
- account limit bumped to 20: was 10, now 20. add more accounts if you need them.
- per-project accounts default on: `perProjectAccounts` defaults to `true` now. disable with `perProjectAccounts: false` in config if you want the old global behavior.
- new options in `~/.host runtime/codex-multi-auth-config.json`:
- env vars:
- `CODEX_AUTH_PER_PROJECT_ACCOUNTS=1` - enable per-project accounts
- `CODEX_AUTH_TOAST_DURATION_MS=8000` - set toast duration in ms

### Bug Fixes
- token refresh race condition: added `tokenRotationMap` to prevent concurrent refresh requests from stepping on each other.
- rate limit retry jitter: 20% jitter on retry delays to prevent thundering herd.
- apply_patch infinite loop: removed apply_patch references from codex bridge that caused loops in some edge cases.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.9.7...v4.10.0

## [4.9.7] - 2026-01-29

### New Features
- `CODEX_AUTH_ACCOUNT_ID` override to force a specific workspace id (non-interactive login).
- troubleshooting guidance for "usage not included in your plan".

### Bug Fixes
- business/team workspace selection: detect multiple workspace account IDs from oauth tokens and prompt for the correct one.
- prevent refresh/hydration from overwriting selected workspace ids (org/manual choices remain stable).
- persist workspace labels and sources for clearer account listings.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.9.5...v4.9.7

## [4.9.5] - 2026-01-28

### Improvements
- When your ChatGPT subscription didn't include Codex access, the plugin kept rotating through all accounts and retrying forever because it thought it was a temporary rate limit.
- You get an immediate, clear error: "This model is not included in your ChatGPT subscription."

### Bug Fixes
- Account error handling - Fixes infinite retry loop when account doesn't have access to Codex models. `usage_not_included` errors now return 403 Forbidden instead of being treated as rate limits. Clear error message explaining the subscription issue. Prevents pointless account rotation for non-recoverable errors. (#16, thanks @rainmeter33-jpg!)

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.9.4...v4.9.5

## [4.9.6] - 2026-02-08

### Improvements
- tui auth gating: non-tty/ui auth attempts now return a clear instruction to run `codex auth login` in a terminal shell.
- error-mapping simplification: consolidated entitlement/rate-limit mapping in fetch helpers for a single handling path.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v5.0.0...v4.9.6

## [4.9.4] - 2026-01-27

### New Features
- TUI auth flow disabled - We now strictly enforce using `codex auth login` in the terminal for authentication. The UI-based 'Connect' flow is disabled with a clear message to prevent issues with non-interactive environments.

### Improvements
- Strict tool schema validation - Added filtering of required fields, flattening enums for compatibility with strict models like Claude/Gemini

### Bug Fixes
- Manual login fixed - Parsing of OAuth URLs with fragments (`#code=`) is fixed
- Account switching - Manual selection is now strictly prioritized over rotation logic
- apply_patch enabled - The bridge prompt now allows `apply_patch`

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.9.3...v4.9.4

## [4.9.3] - 2026-01-27

### Improvements
- Strict schema validation - Ported robust tool cleaning logic from `antigravity-auth`. Automatically normalizes tool definitions to prevent errors with strict models (like Claude or Gemini):
- Filters out `required` fields that are not defined in `properties`
- Flattens `anyOf` schemas with `const` values into standard `enum` arrays
- Converts nullable array types into single types with a description note
- Injects placeholder properties for empty object parameters
- Enabled apply_patch - Updated the Codex bridge prompt to allow the `apply_patch` tool

### Bug Fixes
- Manual login fixed - The plugin now correctly parses OAuth redirect URLs that use fragments (e.g., `#code=...`). Previously, it only looked for query parameters, which caused manual copy-paste logins to fail with a redirection error.
- Account switching logic - Changed account selection logic to strictly respect your manual choice. Before this fix, the hybrid rotation algorithm would sometimes override your selection based on account health or token scores.
- TUI integration - Implemented the missing event handler for the TUI. When you click an account in the interface, it now triggers the `openai.account.select` event, saves the new active index to disk, and shows a confirmation toast.
- Removed API key option - Removed the 'API Key' authentication method from the list because this plugin is designed for OAuth only.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.9.2...v4.9.3

## [4.9.2] - 2026-01-27

### Improvements
- npm publish status: not published on npm (tag/release only).

### Bug Fixes
- Auth prompts moved to TUI - Avoids readline input conflicts
- Error payload normalization - Improves rate-limit handling and rotation

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.9.1...v4.9.2

## [4.9.1] - 2026-01-26

### Improvements
- When `codex auth login` called the authorize function, `inputs` was `undefined`. The code had a conditional check that only entered the multi-account while loop if `inputs` existed with keys. This caused only single-account flow to run.

### Bug Fixes
- Multi-account flow always runs - authorize() now always uses multi-account flow regardless of inputs parameter. (#12)
- Removed the conditional check so multi-account flow always runs, allowing users to add multiple ChatGPT accounts.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.9.0...v4.9.1

## [4.9.0] - 2026-01-26

### Improvements
- breaking: package renamed from `host runtime-openai-codex-auth-multi` to `codex-multi-auth`
- package renamed to bypass host runtime's plugin blocking. host runtime skips any plugin with `host runtime-openai-codex-auth` in the name. the new name `codex-multi-auth` works correctly.
- updated all documentation, configs, and references to use new package name.
- added `multiAccount` flag check in loader to coexist with host runtime's built-in auth.
- fix node esm plugin load by importing tool from `@host runtime-ai/plugin/tool` and ensuring runtime dependency is installed.
- correct package metadata (repository links, update-check package name) and add troubleshooting guidance for plugin install/load.
- update your `~/.config/host runtime/host runtime.json`:
- ## Legacy 4.8.2 (Package-Only) - 2026-01-25
- npm package line: published under `host runtime-openai-codex-auth-multi` (legacy package), not `codex-multi-auth`.

### Bug Fixes
- removed debug console.log statements from loader.
- plugin now properly detects when it should handle auth vs deferring to built-in.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.7.0...v4.9.0

## [4.7.0] - 2026-01-25

### New Features
- session recovery system: automatic recovery from common api errors that would previously crash sessions:
- `tool_result_missing`: handles interrupted tool executions (esc during tool run)
- `thinking_block_order`: fixes corrupted thinking blocks in message history
- `thinking_disabled_violation`: strips thinking blocks when switching to non-thinking models
- new recovery module (`lib/recovery/`):
- `types.ts` - type definitions for stored messages, parts, and recovery
- `constants.ts` - storage paths (xdg-compliant) and type sets
- `storage.ts` - filesystem operations for reading/writing host runtime session data
- `index.ts` - module re-exports
- main recovery logic (`lib/recovery.ts`):
- `detectErrorType()` - identifies recoverable error patterns from api responses
- `isRecoverableError()` - quick check for recovery eligibility
- `createSessionRecoveryHook()` - creates hook for session-level error recovery
- toast notifications during recovery attempts
- new configuration options:
- `sessionRecovery` (default: `true`) - enable/disable session recovery
- `autoResume` (default: `true`) - auto-resume session after thinking block recovery
- environment variables: `CODEX_AUTH_SESSION_RECOVERY`, `CODEX_AUTH_AUTO_RESUME`
- 26 new unit tests for recovery system

### Improvements
- feature release: full session recovery system ported from host runtime-antigravity-auth.
- account label format: changed from `Account N (email)` to `N. email` for cleaner display
- error response handling: `handleErrorResponse()` now returns `errorBody` for recovery detection
- enhanced error logging with recoverable error detection in fetch flow
- npm package line: published under `host runtime-openai-codex-auth-multi` (legacy package), not `codex-multi-auth`.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.6.0...v4.7.0

## [4.6.0] - 2026-01-25

### New Features
- context overflow handler: gracefully handles "prompt too long" / context length exceeded errors:
- returns synthetic sse response with helpful instructions instead of raw 400 error
- suggests `/compact`, `/clear`, or `/undo` commands to reduce context size
- prevents host runtime session from getting locked on context overflow
- new module: `lib/context-overflow.ts`
- missing tool result injection: automatically handles cancelled tool calls (esc mid-execution):
- detects orphaned `function_call` items (calls without matching outputs)
- injects synthetic output: `"Operation cancelled by user"`
- prevents "missing tool_result" api errors when user cancels mid-tool
- new function: `injectMissingToolOutputs()` in `lib/request/helpers/input-utils.ts`
- 34 new unit tests for context overflow and tool injection

### Improvements
- feature release: context overflow handling and missing tool result injection.
- npm package line: published under `host runtime-openai-codex-auth-multi` (legacy package), not `codex-multi-auth`.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.5.0...v4.6.0

## [4.5.0] - 2026-01-25

### New Features
- strict tool validation: automatically cleans tool schemas for compatibility with strict models (claude, gemini)
- auto-update notifications: get notified when a new version is available
- 22 model presets: full variant system with reasoning levels (none/low/medium/high/xhigh)
- health scoring: tracks success/failure per account
- token bucket: prevents hitting rate limits
- always retries when all accounts are rate-limited (waits for reset)

### Improvements
- health-aware account rotation with automatic failover
- hybrid selection prefers healthy accounts with available tokens
- npm package line: published under `host runtime-openai-codex-auth-multi` (legacy package), not `codex-multi-auth`.
- ## Legacy 4.4.0 (Package-Only) - 2026-01-23
- npm publish status: not published on npm (tag/release only).
- new retry options:
- `retryAllAccountsRateLimited` (default: `true`)
- `retryAllAccountsMaxWaitMs` (default: `0` = unlimited)
- `retryAllAccountsMaxRetries` (default: `Infinity`)

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/compare/v4.3.1...v4.5.0

## [4.3.1] - 2026-01-23

### New Features
- openai-accounts-status --json - Scriptable status output with email/ID labels

### Improvements
- Account labels - Now prefer email and show ID suffix when available; list/status outputs are columnized for readability
- Email normalization - Stored account emails are trimmed/lowercased when present
- @host runtime-ai plugin/sdk 1.1.34
- hono 4.11.5
- vitest 4.0.18
- @types/node 25.0.10
- @typescript-eslint 8.53.1
- @andremxmx for reporting the multi-account ID issue (#4)
- npm package line: published under `host runtime-openai-codex-auth-multi` (legacy package), not `codex-multi-auth`.

### Changelog

Full Changelog: https://github.com/ndycode/codex-multi-auth/commits/v4.3.1


