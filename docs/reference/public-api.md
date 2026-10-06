# Public API Contract

Public API contract for `codex-multi-auth` (package `2.19.1`).

---

## Package surface

`codex-multi-auth` is an ESM package (`"type": "module"`, Node >= 18.17). Its
`exports` map exposes exactly these specifiers:

| Subpath | Target | Surface |
| --- | --- | --- |
| `codex-multi-auth` | `dist/index.js` | Plugin-host entry: `OpenAIOAuthPlugin`, `OpenAIAuthPlugin` (alias), default export |
| `codex-multi-auth/auth` | `dist/lib/auth/index.js` | OAuth flow, PKCE, JWT decode, device-auth flow |
| `codex-multi-auth/storage` | `dist/lib/storage.js` | Account storage facade (CRUD, transactions, backup/restore, import/export) |
| `codex-multi-auth/config` | `dist/lib/config.js` | `pluginConfig` defaults, loaders, per-field getters, `config explain` report |
| `codex-multi-auth/request` | `dist/lib/request/index.js` | Failure policy, fetch helpers, rate-limit backoff, request transformer |
| `codex-multi-auth/cli` | `dist/lib/codex-cli/index.js` | Codex CLI state sync, active-selection writer, observability |
| `codex-multi-auth/package.json` | `./package.json` | Package metadata |

Any specifier not in this table fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` —
there is no `./dist/*` or `./lib` escape hatch.

---

## Stability tiers

This project uses tiered API stability.

### Tier A: Stable APIs

Stable APIs are covered by semver compatibility guarantees and must remain
backward-compatible inside the current `2.x` line unless explicitly documented.

- Package root plugin entrypoint exports:
  - `OpenAIOAuthPlugin`
  - `OpenAIAuthPlugin`
  - default export (alias of `OpenAIOAuthPlugin`)
- Installed binaries (published Tier A CLI surface):
  - `codex-multi-auth` — primary account-manager CLI
  - `codex-multi-auth-codex` — official Codex forwarding wrapper
  - `codex-multi-auth-app-launcher` — packaged-app launcher routing helper
  - `mcodex` — convenience launcher over the codex wrapper (`--monitor`, `--tmux`, or default forward)
- CLI surface:
  - `codex-multi-auth ...` command family
  - documented flags and aliases in [commands.md](commands.md)
  - default-on `codex-multi-auth rotation ...` command family for the runtime Responses proxy and app bind management
  - `mcodex` convenience modes documented in [commands.md](commands.md)
- Persistent user-facing config and storage contracts documented in:
  - [settings.md](settings.md)
  - [storage-paths.md](storage-paths.md)

### Tier B: Compatibility APIs

The five supported package subpath entrypoints are the compatibility surface —
exported for ecosystem continuity, not treated as first-class product
entrypoints:

- `codex-multi-auth/auth`
- `codex-multi-auth/storage`
- `codex-multi-auth/config`
- `codex-multi-auth/request`
- `codex-multi-auth/cli`

Compatibility policy for Tier B:

- Additive changes are allowed.
- Existing exported symbols must not be removed in this release line.
- Existing positional signatures remain supported; new options-object
  alternatives are preferred for new callers.
- Deprecated usage may be documented, but hard removals require a major
  version transition plan.

### Tier C: Internal APIs

Internal APIs are any modules and implementation details not reachable through
the exports-map specifiers above.

- The source-level barrel `lib/index.ts` (built to `dist/lib/index.js`)
  re-exports most of the library — including `startRuntimeRotationProxy` and
  `startLocalBridge` — but **no exports-map subpath reaches it**: a specifier
  like `codex-multi-auth/dist/lib/index.js` fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. Symbols that exist only on that barrel (the
  runtime proxy, local bridge, governance stores, UI helpers) are therefore not
  part of the supported package surface in this release line and are loadable
  only by direct file path or from a source checkout.
- No compatibility guarantee; internals may change at any time while Tier A /
  Tier B behavior remains intact.

---

## Preferred calling style

For exported functions with many positional parameters, use options-object
forms when available.

Examples of additive options-object alternatives:

- `selectHybridAccount({ ... })`
- `exponentialBackoff({ ... })`
- `getTopCandidates({ ... })`
- `createCodexHeaders({ ... })`
- `getRateLimitBackoffWithReason({ ... })`
- `transformRequestBody({ ... })`

Positional signatures are preserved for backward compatibility; see
[error-contracts.md](error-contracts.md#options-object-compatibility-contract)
for the call-shape contract.

---

## Responses contract notes

The request-transform layer intentionally preserves and/or normalizes modern
Responses API fields that callers may already send through the host SDK.

- The plugin preserves `previous_response_id` when explicitly provided and may
  auto-fill it from plugin continuation state when
  `pluginConfig.responseContinuation` is enabled, maintains `text.format` when
  verbosity defaults are applied, and honors `prompt_cache_retention` from the
  request body before falling back to `providerOptions.openai.promptCacheRetention`
  or user config defaults.
- `background` is typed as a first-class request field. It stays disabled by
  default and only passes through when `pluginConfig.backgroundResponses` or
  `CODEX_AUTH_BACKGROUND_RESPONSES=1` explicitly enables the stateful
  compatibility path.
- Background-mode requests force `store=true`, keep caller-supplied input item
  IDs, and skip stateless-only defaults such as `reasoning.encrypted_content`
  injection and fast-session trimming.
- Upgrade note: leave background mode disabled for existing stateless
  pipelines; enable it only for callers that intentionally send
  `background: true` and are ready for stateful `store=true` routing. See
  [../upgrade.md](../upgrade.md).
- Hosted built-in tool definitions are typed and supported for `tool_search`,
  remote `mcp`, `computer` / `computer_use_preview`, and `namespace` bundles
  containing nested tools; unsupported hosted search/computer tools are
  filtered before the upstream request when the selected model profile does not
  advertise that capability.
- Semantic SSE parsing synthesizes compatibility fields — `output_text`,
  `reasoning_summary_text`, `commentary_text`, `final_answer_text`,
  `phase_text` — only when the corresponding content is present in the stream.

These behaviors are compatibility guarantees for the current release line: they
protect caller intent while keeping the plugin stateless against the ChatGPT
Codex backend.

---

## Runtime rotation contract notes

Runtime rotation is a CLI/runtime feature, not a library transport API.

- Enabled by default for request-bearing wrapper-launched Codex sessions.
- `codex-multi-auth rotation enable` persists
  `pluginConfig.codexRuntimeRotationProxy=true`; `disable` persists `false`.
- `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` disables the proxy for the
  current process without changing settings.
- The local provider id is `codex-multi-auth-runtime-proxy`.
- The proxy accepts only authenticated loopback requests for Responses API,
  model discovery, and thread-goal paths.
- Account policy `pause`/`drain` (via `codex-multi-auth account ...`) is
  enforced by `evaluateRuntimePolicy` and blocks those accounts from hybrid
  selection.
- The packaged app bind is reversible and must not patch official app binaries.
- Client responses must not expose account emails, tokens, private account
  headers, hop-by-hop headers, or stale decoded `content-encoding`.

These details are documented for operator expectations. Internal helper process
arguments, shadow-home lock filenames, router status file shape, and retry
timing are implementation details unless explicitly documented in
[commands.md](commands.md) or [storage-paths.md](storage-paths.md).

---

## Local bridge contract notes

`startLocalBridge` opens the optional loopback bridge. There is no
`bridge start` CLI daemon, and — as covered under Tier C — the symbol is not
currently reachable through the exports map, so hosts load it from the
installed package's `dist/lib/local-bridge.js` file path or a source checkout.

- Bind host must be loopback; `runtimeBaseUrl` must also be loopback (the
  runtime rotation proxy).
- Default `requireAuth=true`; configuring `runtimeClientApiKey` **requires**
  `requireAuth=true`.
- Surfaces: `/health`, `/v1/models`, `/v1/responses` only.
- Client tokens are managed with `codex-multi-auth bridge token ...` (hashes
  on disk).
- Client snippets: `codex-multi-auth integrations ...`.

See [commands.md](commands.md#starting-the-local-bridge-hostapi) for the
operator checklist.

---

## Semver guidance

- Breaking Tier A change: `MAJOR`
- Additive Tier A change: `MINOR`
- Tier A bug fix or doc-only clarification: `PATCH`
- Tier B additive compatibility improvement: usually `PATCH` or `MINOR`
  depending on caller impact

This repository currently ships on a `2.x` line, and breaking changes still
require explicit migration documentation and review sign-off.

---

## Migration rules

For any future intentional contract break:

1. Identify affected callers and command workflows.
2. Provide a migration path with concrete before/after examples.
3. Update `README.md`, `docs/upgrade.md`, affected `docs/reference/*`, release
   notes, and the changelog.
4. Add tests proving both old and new behavior during transition windows when
   feasible.

---

## Related

- [commands.md](commands.md)
- [error-contracts.md](error-contracts.md)
- [settings.md](settings.md)
- [storage-paths.md](storage-paths.md)
- [../upgrade.md](../upgrade.md)
