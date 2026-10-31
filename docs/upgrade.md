# Upgrade Guide

## GPT-6.1 Terra and Ultrafast pricing

`gpt-6.1-terra` (released 2026-10-26, in the Codex catalog since CLI 0.165.0) is
now a first-class model: `low`…`ultra` efforts with a `low` default, picker
entries in both config templates, and a $1 / $5 per 1M token pricing card
(cached input $0.05, Fast 2x, long context above 272K input at 2x input and
1.5x output). Before this, any `gpt-6.1-terra` request silently ran
`gpt-6.1-sol`. With `fallbackOnUnsupportedCodexModel` enabled (off by
default), an account without Terra retries `gpt-5.6-terra` and then the usual
staircase; with the default setting the unsupported-model error is returned.
The default model stays `gpt-6.1-sol`.

Responses billed at the `ultrafast` service tier (`gpt-6.1-sol` with
`service_tier: "ultrafast"`) are now priced at OpenAI's published 6x Standard
rate instead of being recorded without a cost. Ultrafast requests over 272K
input stay unpriced because OpenAI does not say whether the long-context
surcharge stacks with it.

## Luna Reserve fallback and limits

`gpt-6-luna` and `gpt-5.6-luna` can retry genuine quota 429 responses through
`gpt-reserve`. Model-capacity errors keep the existing capacity path and do not
consume Reserve. `limits --json --refresh` adds an additive per-account
`lunaReserve` field for the separately metered Reserve bucket when the backend
exposes it; an absent bucket means unknown/not currently offered, not 0%
remaining.

How to move an older install to the canonical `codex-multi-auth` package on the current `2.x` release line, and what changed along the way that you need to know about.

---

## What's Current

| Item | Value |
| --- | --- |
| Package | `codex-multi-auth` (npm, unscoped) |
| Command family | `codex-multi-auth …` |
| Wrapper | `codex-multi-auth-codex`, `mcodex` |
| Data root | `~/.codex/multi-auth` |
| Official CLI | `codex`, owned by `@openai/codex` — this package no longer publishes that name |

---

## Upgrade

This release requires Node.js `22.19.0` or later. If you run Node.js 18 or 20, upgrade Node.js first — those runtimes are unsupported, and while npm may still install the package when engine checks are not enforced, it cannot run there.

```bash
npm i -g @openai/codex        # if the official CLI isn't installed yet
npm i -g codex-multi-auth
codex-multi-auth status       # runs one-time first-run setup (see below)
```

Then rebuild a health baseline:

```bash
codex-multi-auth check
codex-multi-auth forecast --live
```

No storage migration step is needed — the account pool upgrades in place on first load, and older layouts migrate automatically.

### Migrate From The Legacy Package

The prerelease was published under the scoped name `@ndycode/codex-multi-auth`. If it is still installed:

```bash
npm uninstall -g @ndycode/codex-multi-auth
npm i -g codex-multi-auth
```

The account pool under `~/.codex/multi-auth` carries over.

---

## Changes To Know About

### Web search and voice through runtime rotation

Codex web search (`web.run`, `POST /alpha/search`) and native voice (`/voice`)
now work with runtime rotation on, instead of failing with
`runtime_rotation_proxy_not_found`. Voice also needs the sideband control socket
to reach the proxy, so the wrapper and both app-bind modes now set
`experimental_realtime_ws_base_url` to the local proxy (marked
`# codex-multi-auth realtime sideband` and removed on unbind). A value you set
yourself is left alone. Re-run `codex-multi-auth rotation bind-app` (or
`reset-runtime`) so an existing app bind picks this up.

### App bind upstream proxy

`codex-multi-auth rotation bind-app --upstream http://127.0.0.1:<port>` chains a
local proxy such as Headroom behind the packaged-app router. Previously only
wrapper sessions could do this, through
`CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL`.

### macOS app router is managed through launchd

`reset-runtime`, `bind-app`, and `unbind-app` now load and unload the
LaunchAgent with `launchctl` instead of only rewriting its plist. Earlier
versions could leave a launchd-respawned router running with an outdated
identity token. The first `reset-runtime` after upgrading unloads that job by
label and starts a single router. If a router still cannot be stopped, the
command now prints a warning instead of reporting a clean restart.

### Live credential reload and refresh coordination

Restart existing routers once after installing this update. Subsequent saved
re-logins take effect in both native and provider mode without another restart.
Credential reload waits for refresh commits to finish, preserving the rotated
token while its disk write is pending. Local client authentication, strict pins,
account disablement, and independent quota limits remain enforced. Explicit
`api/` and `zdr/` requests remain available during OAuth-store lock failures.

With refresh leases enabled (the default outside tests), acquisition errors and
wait timeouts now block refresh instead of sending an uncoordinated request.
Expired locks are retained: neither elapsed time nor a dead process proves that
the provider did not consume the refresh token. A failed publication of rotated
credentials also retains the lock. Provider requests report
`refresh_coordination_unavailable` without invalidating the account or rotating
to another login. Resolve filesystem access problems or wait for a live owner;
if an owner died without publishing its result, sign in again to obtain fresh
credentials. Do not delete the lock to retry the old token. The explicit
`CODEX_AUTH_REFRESH_LEASE=0` opt-out remains available but disables this protection.

No account-storage migration or new npm script is required.

### Hourly rate-limit cache revalidation

Restart existing routers after installing this change. Legacy persisted routing
deadlines longer than an hour are bounded to one hour from the first load and
written back to the account pool then, or on the next normal save if that write
fails. Already-bounded deadlines are not extended on restart.
No account migration or reset-credit redemption is required.

### Compact `status` Output Is The Default

`codex-multi-auth status` and `codex-multi-auth list` now print a compact
table instead of the long diagnostic view. Pass `--details` to restore the
previous per-account output. `status --json` is unchanged and remains the
stable interface for scripts — migrate any parsing of the text output to
`--json` or `--details`.

### Local Web Dashboard (`codex-ma web`)

The package now ships a `codex-ma` alias for the account manager. Run
`codex-ma web` to open a loopback-only, live-refreshing pool dashboard in
your browser (`--host`, `--port`, `--token`, `--interval`, `--no-open` are
supported). This is a new package binary, not an npm script.

### Locale Selection

CLI output can be localized. Precedence: `--locale`, then
`CODEX_MULTI_AUTH_LOCALE`, then the saved `locale` setting
(`codex-multi-auth config`), then auto-detection. Accepted values are `en`,
`zh`, and `auto`; a blank `CODEX_MULTI_AUTH_LOCALE` is treated as unset.

### Proxy Environment Variables

OAuth, health, quota, and runtime requests now honor `HTTP_PROXY`,
`HTTPS_PROXY`, and `NO_PROXY` (lowercase wins when both cases are set).
Loopback destinations always bypass configured proxies.

### `resume --last` Stays On The Right Provider

`codex-multi-auth-codex resume --last` (and `fork`) now resolve the provider
from the session Codex will actually resume — the newest session for the
current working directory unless `--all` is passed — so native `openai`
sessions keep their native provider.

### Automatic API Checks And Disconnect Diagnostics

Enabled API/ZDR routes already configured with `probeCapabilities: true` receive
small billable checks daily while a CLI/app router runs. Disable capability
probing or the route to stop automatic probes. Live model discovery and scheduled
checks share persisted results; program evidence expires after 24 hours even
when other capabilities were checked recently. Each claimed daily pass refreshes
program evidence that would expire before its next run, so it can repeat a full
capability pass even after a recently completed live check. An overlapping probe completed after the daily pass
started is reused. The next run follows persisted daily claim deadlines rather
than waiting another day after a slow pass completes; overdue runs catch up
without overlapping. A route that fails preparation before claiming a pass is
retried after one minute; claimed passes retain their daily limit. Stopping the
router cancels queued probes and pending inventory saves without waiting for
unrelated work. Saving the same visible models in a different order neither
invalidates cached probe results nor skips a due daily check. Credential resets
also remove automatic-check history.
No credential, workspace,
subscription priming, or request-program setting is migrated.

`status`, `status --json`, and `rotation status` expose sanitized historical
WebSocket disconnect details. This helps investigate interruptions without
replaying a generation that may already have started upstream.

### Subscription Models In The Picker

When subscription discovery is still loading for a new client version, picker
requests wait up to two seconds before responding. If no subscription catalog is
ready by then, the router returns a temporary unavailable response rather than
letting a cached API-only list replace the native catalog. Discovery continues
in the background; a later request can return the subscription and API models
together. Successfully completed discovery with no eligible subscription models
still permits an API-only catalog. Failed discovery remains unknown and returns
temporary unavailability instead of replacing subscription entries.

### Concurrent Work On A Pinned Account

A temporary network-error cooldown from one request no longer rejects unrelated
requests on the same manually or explicitly pinned account. Each request keeps
its bounded retry budget and backoff. Server-error and authentication cooldowns,
quota limits, policy restrictions, and circuit admission still apply; unpinned
pools continue skipping accounts in a network cooldown. This avoids immediate
503 responses during concurrent main-session and subagent work.

### WebSocket Compatibility And Recovery

WebSocket forwarding preserves the native client's beta flags without adding the
HTTP-only Responses beta. Upstream connections offer `permessage-deflate`
compression with modest zlib settings and requested dictionary resets. Servers
that decline compression still use WebSockets; decompressed messages retain the
same size limits.

After an unexpected upstream disconnect, native Codex can retry on one fresh
WebSocket. A second disconnect within 60 seconds routes newly submitted creates
through HTTP for a 60-second cooldown while keeping the local WebSocket open.
After the cooldown, the next create tries upstream WebSockets automatically.
A completed upstream WebSocket generation clears the failure count; HTTP recovery
and warm-up completions do not. Refused API/ZDR WebSocket handshakes also get a
60-second cooldown before another attempt. The router never automatically replays
a request whose generation outcome is uncertain.

Creates larger than 8 MiB of serialized UTF-8, after connection-local delta
reduction, use HTTP for that request while retaining the local WebSocket. This
conservative guard is below observed upstream size rejections, not a statement of
the upstream's exact limit. A later request that fits can use WebSockets again.
During HTTP recovery, non-generating prewarm completes locally without inference;
its input remains available for the next create through the local response chain.

A native Codex session that already selected HTTP before this recovery behavior
was installed can keep that choice until the native session is reinitialized.
The router cannot reset the native client's transport flag.

At the 64-connection limit, a valid new connection can reclaim an idle setup or
warm-up connection. Queued work, active requests and generated response history
remain protected. If every slot is protected, the router requests immediate HTTP
recovery instead of five rejected WebSocket handshake retries.

New disconnect records include sanitized request counts and TCP transport flags;
local send completion does not prove upstream receipt. Compression reduces
request bytes but does not establish the cause of an earlier `1006` close.
No credential or configuration migration is required. See the
[status and transport reference](reference/commands.md#reading-status-and-check-output)
for diagnostic fields and recovery details.

### `codex` Is No Longer Ours (v2.1.2)

The package stopped publishing a global `codex` binary — that name belongs to the official Codex install path (npm, Homebrew, or a release binary). Use `codex-multi-auth …` for account management, and `codex-multi-auth-codex`/`mcodex` when you intentionally want the forwarding wrapper. If a stale shim still answers to `codex`, reinstall the official CLI.

### First-Run Setup Moved Out Of `npm install`

Postinstall is notice-only — installing the package no longer touches your desktop or config. The first `codex-multi-auth` command from a durable global install performs the one-time setup instead, then claims the marker at `~/.codex/multi-auth/first-run-setup.json`:

- best-effort bind of a detected Codex desktop app to the local rotation router
- user-level app launcher routing where supported
- `cli_auth_credentials_store="file"` enforcement in `~/.codex/config.toml`

A failure never blocks the command. `npx` runs, project-local installs, and CI always skip this. Opt-outs, set before first run:

| Variable | Effect |
| --- | --- |
| `CODEX_MULTI_AUTH_APP_BIND=0` / `CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` | Skip the packaged-app bind |
| `CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` | Skip launcher routing install |

### Runtime Rotation Is Default-On

On the current `2.x` release line, request-bearing sessions launched through `codex-multi-auth-codex`, `mcodex`, or an installed app bind route through the loopback rotation proxy. Official app binaries are never patched, and pause/drain/budget policies are enforced on this path.

- `codex-multi-auth rotation disable` turns the proxy off and removes the app bind; `rotation enable` restores both.
- `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` disables it per environment.

Validate after upgrading:

```bash
codex-multi-auth rotation status
codex-multi-auth forecast --live
```

### Transcription Route Through Managed OAuth

`POST /transcribe` on the runtime rotation proxy now forwards Codex multipart audio through the managed OAuth account pool instead of bypassing it. The multipart body and the original `Content-Type` boundary are forwarded untouched; ambiguous transport/upstream failures are not replayed across accounts.

- Usage rows land in the ledger with operation `transcribe` — `codex-multi-auth usage` filters or budgets keyed by operation will start seeing them, and per-account transcription rate-limit backoff is tracked separately from the Responses cooldown path.
- Explicit auth/workspace invalidation still applies account-wide.
- No new npm scripts were added.

### Model Defaults

- General routing default (`DEFAULT_MODEL`): `gpt-6.1-sol`. The `gpt-5` alias targets `gpt-5.6-sol`, the newest 5.x generation still served.
- Retired ids are rewritten before the request is sent: `gpt-5.5` → `gpt-6-sol`, `gpt-5.5-pro` → `gpt-6-astra`, `gpt-6-astra-aeon` → `gpt-6-astra`. The replacement's reasoning ladder and rate card apply, so `none` coerces to `low`, and new ledger rows are priced at the replacement rate.
- Live diagnostic probes (`check`, `report`, `forecast`, `best`, `fix`) lead with `gpt-5.6-sol`, then fall through a chain for accounts without entitlement.

```bash
codex-multi-auth forecast --live --model gpt-5.6-sol
codex-multi-auth fix --live --model gpt-6.1-sol
```

### Login Flow

- `codex-multi-auth login` stays browser-first. `--device-auth` is the headless path (prints `https://auth.openai.com/codex/device` and a code valid 15 minutes); `--manual` / `--no-browser` paste the callback by hand. `CODEX_AUTH_NO_BROWSER=1` suppresses the browser launch.
- Codex CLI now refuses workspaces the backend doesn't authorize. `login` verifies its automatic workspace pick against `wham/accounts/check` (one extra request; fails open) and swaps an unauthorized auto-pick for the backend's default. Accounts saved before this check need one pass of `codex-multi-auth fix --live` to rebind org-sourced ids.
- `login` on an empty pool opens the sign-in menu directly; when a valid named backup exists under `~/.codex/multi-auth/backups/`, the menu offers to restore it.

### Config Precedence

1. File from `CODEX_MULTI_AUTH_CONFIG_PATH`, when set and present.
2. `pluginConfig` inside `~/.codex/multi-auth/settings.json`.
3. Legacy config paths (one-time migrate warning).
4. Built-in defaults — then environment variables override individual settings.

`codex-multi-auth config explain [--json]` shows where each live value came from. See [configuration.md](configuration.md) for stable overrides and [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md) for the full resolution flow.

### Governance Commands Shipped On 2.x

`usage`, `budget`, `account` (pause/drain/tag/weight/note/priority/auto-prime), `models`, `monitor`, `resets`, `bridge token`, `history`, plus the `mcodex` launcher. All local and file-backed under `~/.codex/multi-auth` — no hosted service was added.

### Uninstall Behavior

`preuninstall.js` ships in the package but is **not** an npm lifecycle hook on modern npm, so `npm uninstall -g` alone leaves residue. Run `codex-multi-auth uninstall` *before* removing the package — see [troubleshooting.md](troubleshooting.md#uninstall-completely).

### Subscription Status And Pro Max Priming

Unused Pro Max (Pro 500) subscriptions now qualify for opted-in first-use priming. `status` and `check accounts` show the observed plan, selected workspace, auto-prime setting, and first-use state; `status --json` adds a per-account `subscription` object (`planType`, `planLabel`, `selectedWorkspace`, `autoPrime`, `primingState`, `primingFailure`, `automaticBlock`, `freshness`, `observedAt`). Policy read failures show an unknown auto-prime setting rather than off.

- Checks use the saved selected workspace; disabled or invalid selections do not fall back to the stored binding.
- Status reads cached observations without network calls. Observations older than 30 minutes are stale, and 0% usage can still have a running reset timer.
- Use `check accounts` to refresh observations, or add `--prime` to allow first-use completion. Existing priming policies are preserved.

### Sequential Scheduling With Customized Priorities

When `schedulingStrategy` is `sequential` and any account priority differs from
`1`, routing now follows saved account order within each eligible tier. Quota
reset ranking and the current active account no longer override that order.
Pools with all priorities at `1` keep the healthy active cursor. Strict pins,
eligibility checks, exhausted-account skipping, and reserve fallback still apply.
Hybrid scheduling keeps its quota ranking.

Restart the router or session after upgrading to load the new behavior. Native
`status` uses the running router's reported strategy; older routers without this
metadata fall back to the current settings, which may differ until restart.

No new npm scripts or manual storage migration are required.

---

## Downgrading Past 2.17.0

Account priority tiers (`codex-multi-auth account priority <index> <0..9>`) are stored as a `priority` field in `account-policies.json`. Versions before 2.17.0 drop the unknown field on their next policy write, returning every account to the default tier — re-run `account priority` after upgrading again. The newer `api-routes.json`, `reset-credits.json`, and model-discovery files are ignored by older versions and left in place.

---

## Worktree Storage Migration

Automatic on first load: legacy worktree-keyed pools merge into the repo-shared `projects/<project-key>/` file. Legacy files are removed only after a successful canonical write; if the write fails, they stay in place to avoid data loss.

---

## Common Upgrade Problems

| Problem | Fix |
| --- | --- |
| `codex-multi-auth` not found | `npm ls -g codex-multi-auth`; check npm's global bin is on `PATH` |
| Old scoped package still active | Uninstall `@ndycode/codex-multi-auth`, reinstall `codex-multi-auth` |
| Pool looks stale | `codex-multi-auth doctor --fix`, then re-login affected accounts |
| Still expecting this package to own `codex` | Use `codex-multi-auth-codex`/`mcodex`; `codex` is the official CLI |
| Newest models missing from the app model picker after upgrade | Re-run the config install you originally used (it merges new template models into your config), restart the app, then `codex-multi-auth rotation bind-app` if you use the bind |
| Residue after `npm uninstall -g` | Run `codex-multi-auth uninstall` before removing the package next time; see [troubleshooting.md](troubleshooting.md#uninstall-completely) |

---

## Emergency-only account policy compatibility

The new `account emergency-only` command reserves an account from automatic rotation until regular capacity and reset credits are exhausted.

The `emergencyOnly` account flag reserves subscription accounts until regular
pool capacity and reset credits are confirmed exhausted. Older policy writers
do not preserve this flag. Before downgrading, pause reserved accounts or remove
them from the enabled pool; reapply `account emergency-only <index> on` after
upgrading. Existing pause and drain flags remain independent.

## Related

- [getting-started.md](getting-started.md)
- [troubleshooting.md](troubleshooting.md)
- [features.md](features.md)
- [reference/storage-paths.md](reference/storage-paths.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)

## Selected workspace routing

Native pool requests, model discovery, and reset targets now honor the selected
workspace only. Unselected siblings and stored bindings are not fallback routes.
A disabled selected workspace makes the account unavailable until an enabled
workspace is selected. Use `workspace <account> <workspace> enable` or `disable`
to control availability without changing selection.

Saved Personal organization aliases retain their native client identity mapping.
The selected entry still controls enablement; disabling it never falls back to
the token entry or another workspace.
