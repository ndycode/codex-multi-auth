# codex-multi-auth Architecture

How `codex-multi-auth` fits around the official Codex CLI: which binaries exist, what each one does, how a forwarded request travels through the loopback rotation proxy to a managed account, and where state lives.

For the maintainer-level module map, see [development/ARCHITECTURE.md](development/ARCHITECTURE.md).

---

## The Short Version

`codex-multi-auth` is a multi-account OAuth manager for the official `@openai/codex` CLI. It keeps a pool of ChatGPT-backed Codex accounts on disk, picks the healthiest one for each request, and keeps the official CLI in charge of everything else.

- `codex-multi-auth ...` runs the local account manager (login, switch, health, repair, governance).
- `codex-multi-auth-codex ...` is the opt-in forwarding wrapper: `auth ...` commands stay local, everything else is forwarded to the official Codex CLI with runtime rotation applied.
- `mcodex ...` is a convenience launcher over that same wrapper.
- The package does **not** publish a global `codex` binary; that name stays owned by the official Codex install.
- Runtime rotation is **default-on**: request-bearing sessions launched through the wrapper (or the packaged-app bind) send Responses traffic through a localhost-only proxy that selects a managed account per request.
- All state — accounts, settings, quota cache, usage ledger, policies, backups — lives under `~/.codex/multi-auth`. Official Codex state stays under `~/.codex`.

---

## Published Binaries

`package.json` publishes four bins:

| Binary | Script | Role |
| --- | --- | --- |
| `codex-multi-auth` | `scripts/codex-multi-auth.js` | Account manager only. Bare subcommands normalize to `auth` subcommands, so `codex-multi-auth status` and `codex-multi-auth auth status` are the same call. |
| `codex-multi-auth-codex` | `scripts/codex.js` | Wrapper/forwarder. `auth ...` runs locally; every other command resolves the real official Codex binary and forwards to it, with runtime rotation wired in when enabled. |
| `mcodex` | `scripts/mcodex.js` | Convenience launcher. Forwards to `codex.js`; adds `--monitor` (watch `codex-multi-auth list`) and `--tmux` / `-t` session helpers. Contains no account logic. |
| `codex-multi-auth-app-launcher` | `scripts/codex-app-launcher.js` | OS-level launcher routing: retargets supported user-level shortcuts or installs a managed wrapper app. |

A fifth shipped script, `scripts/codex-app-router.js`, is the persistent localhost router used by the packaged-app bind — it is spawned, not a bin.

---

## The Request Path, End to End

The default rotation path for a forwarded request-bearing command (for example `codex-multi-auth-codex exec "…"`):

```text
You
 |
 | codex-multi-auth-codex exec "..."      (or mcodex, or the bound Codex app)
 v
scripts/codex.js  ─── auth ...? ──yes──> local account manager (lib/codex-manager.ts)
 |
 | no: resolve official Codex binary
 | build shadow CODEX_HOME (or canonical home + -c overrides for TUI/resume/app-server)
 | model_provider = "codex-multi-auth-runtime-proxy", base_url = http://127.0.0.1:<port>
 | inject per-launch client key via OPENAI_API_KEY
 v
Official Codex CLI ──POST /responses──>
 |
 v
Runtime rotation proxy (loopback only)
 |
 | 1. authenticate client (per-launch key, timing-safe compare)
 | 2. gate method/path/body (Responses, models, images, transcription, web search, voice calls, thread-goal only)
 | 3. evaluateRuntimePolicy: model allow/deny, budgets, pause/drain, tags
 | 4. choose account: pin → priority → sequential|affinity → hybrid → scan
 | 5. refresh access token if inside the 60s skew window
 | 6. forward upstream (redirects never followed)
 | 7. on retryable failure mark + rotate to next eligible account
 v
https://chatgpt.com/backend-api (official upstream)
 |
 | stream back: strip hop-by-hop + private headers, scan usage, record ledger row
 v
Your terminal
```

Details worth knowing:

- **Loopback only.** The proxy refuses non-loopback binds and authenticates every request with a random per-launch key. Your account tokens are injected upstream; they never appear in client-facing responses.
- **Auth before routing.** An unauthenticated request gets `401 runtime_rotation_proxy_unauthorized` before the path is even inspected.
- **Redirects are never followed** (`redirect: "error"`), so a Bearer token cannot be exfiltrated to a redirected host.
- **Failure is never a silent hang.** Transient failures rotate to another account; true exhaustion returns `503 codex_runtime_rotation_pool_exhausted` with per-account skip reasons and `retry_after_ms`, and points at `codex-multi-auth rotation status`.
- **Two homes.** Non-interactive commands get a throwaway shadow `CODEX_HOME` (state synced back on exit). Interactive TUI, `resume`/`fork`, and `app-server` run against the canonical `CODEX_HOME` with the provider injected as `-c` overrides, so session history is not copied and reindexed on every launch. `codex app` also gets a shadow home through the app-helper context unless `CODEX_MULTI_AUTH_APP_ROTATION_USE_CANONICAL_HOME=1`.
- **Opt-out.** `codex-multi-auth rotation disable` or `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` returns to plain forwarding.

### Account selection, in one breath

Per request the proxy tries, in order: a soft pin left by `codex-multi-auth switch`, policy priority tiers (lower `account priority` numbers first), a hard pin from `--account`/`CODEX_MULTI_AUTH_FORCE_ACCOUNT`, the sequential stick-until-exhausted cursor, session affinity (20-minute sticky sessions), a hybrid score (`health*2 + tokens*5 + hoursSinceUsed*2 + capability boost`), and finally a linear scan. An account is skipped when it is disabled, workspace-disabled, token-invalid, rate-limited, cooling down, or has an open circuit breaker.

When any policy priority differs from the default `1`, sequential scheduling uses saved account list order within the eligible tier instead of quota reset ranking or active-account preference. Runtime policy supplies priority `1` for every account by default; an all-default map preserves the healthy active cursor. Exhaustion and reserve filtering still apply before the tier is selected.

---

## Components

### 1. Account manager

`codex-multi-auth <command>` dispatches to `lib/codex-manager.ts` + `lib/codex-manager/commands/`:

| Area | Commands |
| --- | --- |
| Accounts | `login`, `list`, `status`, `switch <index>`, `unpin`, `workspace` |
| Health / selection | `check`, `forecast`, `best`, `report`, `why-selected` |
| Repair | `fix`, `doctor`, `verify`, `verify-flagged` |
| Rotation | `rotation status\|enable\|disable\|bind-app\|unbind-app\|reset-runtime` |
| Governance | `usage`, `budget`, `account` (tag/weight/priority/pause/drain/note), `models`, `monitor` |
| Bridge / integrations | `bridge token …`, `integrations` |
| Sessions / config | `history`, `config explain`, `init-config`, `debug bundle`, `uninstall` |

On an interactive terminal with a populated pool, bare `codex-multi-auth login` opens the dashboard instead of a bare sign-in; `--device-auth` covers headless/remote logins, and `--manual`/`--no-browser` prints a paste-back flow. The OAuth callback server binds port `1455` on both `::1` and `127.0.0.1` — the registered redirect URI is fixed, so a conflict on either family is fatal rather than silently degraded.

### 2. Wrapper and shadow `CODEX_HOME`

`codex-multi-auth-codex` resolves the real official Codex binary (env override → installed package → global npm root → `PATH`), then:

- reconciles `cli_auth_credentials_store = "file"` in `~/.codex/config.toml` so forwarded sessions use file-backed auth (opt out with `CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0`),
- resolves an ephemeral `--account <index|email|id>` / `CODEX_MULTI_AUTH_FORCE_ACCOUNT` pin (never mutates the persisted `switch` pin),
- starts the loopback rotation proxy and points the Codex provider config at it,
- spawns official Codex (with bounded retries and an unsupported-model fallback chain), and
- syncs refreshed official state back out of the shadow home on exit.

### 3. Runtime rotation proxy

`lib/runtime-rotation-proxy.ts`, provider id `codex-multi-auth-runtime-proxy`. It forwards only these routes: `POST /responses` (+ `/codex/`, `/v1/` aliases), `GET /models` (+ `/v1`), [image generation/edit routes](reference/image-routes.md), `POST /transcribe`, `POST /alpha/search` (Codex web search, forwarded to `/codex/alpha/search`), native voice call creation (`POST /live`, `/realtime/calls`, + `/v1` and `/codex` aliases, translated from Codex's multipart shape to the ChatGPT backend JSON shape at `/codex/realtime/calls`), and `GET|POST /thread/goal/*`. The voice call's sideband WebSocket (`/v1/live/<call_id>` or `/v1/realtime?call_id=`) is relayed to the OpenAI realtime API with the account that created the call; the bound config points `experimental_realtime_ws_base_url` at the proxy for this. Everything else is a 404. `/transcribe` forwards the multipart audio bytes and original `Content-Type` boundary unchanged while replacing local client credentials with managed ChatGPT OAuth; ambiguous transport/upstream failures are not replayed across accounts. Bodies are capped at 64 MiB — for `/transcribe` the cap applies to the encoded multipart upload. gzip/deflate/br/zstd request encodings are decoded on the JSON routes only; `/transcribe` forwards the original bytes and `Content-Encoding` untouched.

Per request it applies policy before picking an account, refreshes tokens through a deduplicating queue (one in-flight refresh per token, cross-process leases so two CLIs do not double-refresh), classifies upstream responses into rotation marks (rate-limit, cooldown, circuit breaker, workspace disable, token invalidation), and streams successful bytes back with stall detection and backpressure. Runtime counters land in `runtime-observability.json` for `status`, `report`, `monitor`, `rotation status`, and `why-selected`.

For API/ZDR routes, live catalog discovery and the daily opt-in checker share persisted capability evidence through `lib/runtime/persisted-api-capabilities.ts`. A credential/model lock covers reload, bounded probes, and atomic persistence, so competing consumers reuse the completed result. General capability evidence lasts 15 minutes; confirmed program evidence has its own 24-hour expiry. Request policy remains separate from probe evidence.

Each stored route has an internal capability epoch that changes when its credential or explicit probe policy changes, or when it is removed and re-added. Discovery and unrelated route edits preserve it. Legacy records receive an epoch before paid checks; read-only fallbacks can use matching cached evidence without a migration write. Results are revalidated before persistence or retention, so an in-flight check cannot restore evidence after a credential wipe. Explicit forced checks may atomically replace a parse-invalid probe cache; access errors and automatic checks never authorize that repair.

### 4. Local governance

File-backed, local-only, and enforced on the rotation path by `evaluateRuntimePolicy` (`lib/policy/runtime-policy.ts`):

| Concern | Storage under `~/.codex/multi-auth` | CLI |
| --- | --- | --- |
| Usage ledger | `usage/usage-ledger.jsonl` (+ rotated archives) | `codex-multi-auth usage` |
| Budget guards | `budget-guards.json` | `codex-multi-auth budget` |
| Account policy (tags, weight, priority, pause/drain, notes) | `account-policies.json` | `codex-multi-auth account …` |
| Routing profiles (per-project allow/deny, tag weights, budget key) | `routing-profiles.json` | file-only writes; `monitor` reads |
| Quota snapshots | `quota-cache.json` | `limits`, `check`, `forecast --live`, `report` |
| Operator view | runtime observability + all of the above | `codex-multi-auth monitor` |

Budgets are **advisory**: evaluations read a pre-request ledger snapshot, so racing requests can briefly overshoot a limit. Ledger rows are redacted — hashed account identity and request metadata, never prompts or credentials.

### 5. Local bridge (optional)

`lib/local-bridge.ts` exposes a loopback-only OpenAI-compatible surface (`/health`, `/v1/models`, `/v1/responses`) that forwards to a runtime proxy base URL. Client tokens are `cma_local_*` values; only SHA-256 hashes and prefixes are stored in `local-client-tokens.json`, and the plaintext is shown once at `codex-multi-auth bridge token create|rotate`.

### 6. Storage and project pools

Account storage uses the V3 format (`AccountStorageV3`) under the multi-auth root:

- Global pool: `~/.codex/multi-auth/openai-codex-accounts.json`
- Per-project pools: `~/.codex/multi-auth/projects/<project-key>/openai-codex-accounts.json`, keyed by repo identity root so linked Git worktrees share one pool
- Durability: write-ahead journal (`.wal`), temp-file-then-rename writes `0600`, and a throttled `.bak`/`.bak.1`/`.bak.2` rotation, plus named backups under `backups/`
- Recovery: flagged-account sidecar (`openai-codex-flagged-accounts.json`), pending-auth journal, and `verify`/`fix`/`doctor` repair commands

The active selection is mirrored into the official `~/.codex/auth.json` / `accounts.json` so plain forwarded Codex commands keep the intended account.

### 7. Reversible packaged-app bind

`codex-multi-auth rotation bind-app` backs up the real `~/.codex/config.toml`, points the packaged Codex desktop app at a persistent localhost router (`scripts/codex-app-router.js`), and installs a user-level startup entry. `rotation unbind-app` / `rotation disable` restores the backup. Official app binaries are never patched.

### 8. Lazy first-run setup

`npm` postinstall is notice-only. On the first `codex-multi-auth` invocation from a durable global install, `lib/runtime/first-run.ts` claims `first-run-setup.json` once and runs three best-effort steps: app bind, launcher install, and the `cli_auth_credentials_store` pin. Skipped under CI, `npx`, and project-local installs; failures never block the command.

### 9. Plugin-host entry (compatibility)

The package root still exports a plugin-host runtime (`index.ts`) for hosts that load plugins: it reuses the same pool, refresh queue, request transformer, and policy evaluation. Normal `codex-multi-auth ...` use does not require it.

---

## Design Constraints

- The official OAuth flow remains the source of authentication; the callback port stays `1455`.
- The canonical command family is `codex-multi-auth ...`; no global `codex` bin is published.
- Runtime rotation is default-on, loopback-only, and authenticated with a per-launch client key.
- Proxied Responses requests are forced to `stream: true` and `store: false` (stateless compatibility), with `reasoning.encrypted_content` included, unless background-response compatibility is explicitly enabled.
- Credentials and governance state stay local under `~/.codex/multi-auth`.
- The desktop app bind is reversible and does not patch official app files.
- Default general model routing uses `gpt-6.1-sol`; diagnostic live/quota probes lead with `gpt-5.6-sol`.

---

## Related

- [getting-started.md](getting-started.md)
- [features.md](features.md)
- [configuration.md](configuration.md)
- [faq.md](faq.md)
- [reference/commands.md](reference/commands.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
