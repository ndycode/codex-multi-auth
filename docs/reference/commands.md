# Command Reference

Complete command, flag, and hotkey reference for `codex-multi-auth` (package `2.19.1`).

---

## Published binaries

The package ships four `bin` entrypoints. It does **not** publish a global
`codex` bin; forwarding to the official CLI is opt-in through the wrapper.

| Binary | Role |
| --- | --- |
| `codex-multi-auth` | Primary account-manager CLI: all 31 subcommands listed below |
| `codex-multi-auth-codex` | Forwarding wrapper: `auth ...` commands run locally; every other command forwards to the official `@openai/codex` CLI with optional runtime rotation, `--account` pinning, and shadow `CODEX_HOME` handling |
| `codex-multi-auth-app-launcher` | User-level packaged Codex app launcher routing helper (Windows shortcuts, macOS wrapper app, Linux `.desktop`) |
| `mcodex` | Convenience launcher over `codex-multi-auth-codex` with optional `--monitor` and `--tmux` modes |

See [public-api.md](public-api.md) for the Tier A surface and stability policy.

---

## Command family and compatibility aliases

Canonical form: `codex-multi-auth <subcommand>`. The `auth` namespace is
optional on both bins — `codex-multi-auth auth status` and
`codex-multi-auth-codex auth status` run the same manager command as
`codex-multi-auth status`.

Compatibility forms, supported for migrations and wrapper-routed environments:

- `codex-multi-auth auth ...`
- `codex multi auth ...`
- `codex multi-auth ...`
- `codex multiauth ...`
- `codex auth ...` when this package's wrapper has explicitly been installed or aliased as `codex`

Every mutating account-manager command operates on the **global** account pool;
per-project pools are a runtime-proxy routing concern, not a CLI one.

---

## Subcommand inventory (31 commands)

### Accounts and access

| Command | Description |
| --- | --- |
| `codex-multi-auth login` | OAuth login; opens the interactive auth dashboard on a TTY when the pool is populated. Flags: `--device-auth`, `--manual`/`--no-browser`, `--org <org_id>`, `--preserve-selection`, `--account <index\|email\|account_id>` |
| `codex-multi-auth login --api` | Manage API/ZDR credentials, priority, and visible models in an interactive terminal (TTY only; use alone) |
| `codex-multi-auth status` | Account pool, pin, runtime metrics, storage summary, cached model discovery; `list` is the same command (`--json`) |
| `codex-multi-auth switch <index>` | Set the active account by 1-based index and pin it for runtime routing |
| `codex-multi-auth unpin` | Clear the manual pin set by `switch` and resume hybrid rotation |
| `codex-multi-auth workspace <account> [workspace]` | List an account's tracked workspaces, or set its active workspace |
| `codex-multi-auth best` | Pick the forecast-best account and switch to it; clears any manual pin. Flags: `--live`/`-l`, `--json`/`-j`, `--model`/`-m` |
| `codex-multi-auth resets` | Earned subscription reset credits: `list [--refresh]`, `redeem <account>`, `auto manual\|last-resort` |

> Sticky session affinity: `switch`, `unpin`, and `best` all bump an
> `affinityGeneration` counter in storage. When the runtime proxy observes a
> higher generation it drops every session-affinity entry, so a manual change
> reaches the next request even mid-conversation instead of being shadowed for
> up to 20 minutes by the per-thread account lock (issue #474).

### Health and diagnostics

| Command | Description |
| --- | --- |
| `codex-multi-auth check` | Live-probe account health, reset credits, and model/capability discovery: `check [accounts\|resets\|capabilities] [--prime]` |
| `codex-multi-auth limits` | Machine-readable quota windows; `--json` required, `--refresh` is a five-minute age-gated live probe |
| `codex-multi-auth forecast` | Forecast the best account by readiness/risk without switching: `--live --json --explain --model --no-runtime-overlay` |
| `codex-multi-auth report` | Full health report: `--live --json --explain --model --max-accounts <n> --max-probes <n> --cached-only --out <path>` |
| `codex-multi-auth fix` | Apply safe account storage fixes: `--dry-run`/`-n`, `--json`, `--live`, `--model` |
| `codex-multi-auth doctor` | Diagnostics plus optional repairs: `--json --fix --dry-run` (`--dry-run` requires `--fix`) |
| `codex-multi-auth verify` | Installation self-tests: `--paths`, `--flagged`, or `--all`; `--json --dry-run --no-restore` |
| `codex-multi-auth verify-flagged` | Verify flagged accounts and optionally restore healthy ones; back-compat alias of `verify --flagged` |
| `codex-multi-auth why-selected` | Explain the rotation selector's pick: `--now`/`-n` (default) or `--last`/`-l`, `--json`; exit 1 when nothing is selectable |
| `codex-multi-auth debug bundle` | Sanitized runtime/debug snapshot: `--json` |
| `codex-multi-auth history` | List local Codex sessions across all providers, bypassing `model_provider` filtering: `history [list\|show <id>] [--json]` |

### Local governance

All governance state is file-backed under `~/.codex/multi-auth`.

| Command | Description |
| --- | --- |
| `codex-multi-auth usage` | Summarize the local usage ledger: `--since --by --json\|--csv --out`; `usage rotate [--if-larger-than-bytes N]` archives the ledger |
| `codex-multi-auth budget` | Budget guard limits: `limit <key> --window <w>`, `check <key>`, `list` — all `--json` |
| `codex-multi-auth account` | Local account policy: `tag/untag`, `weight`, `priority`, `auto-prime`, `pause/unpause`, `drain/undrain`, `note`, `policy list [--json]` |
| `codex-multi-auth models` | Model/capability matrix per account: `--json --model <m>` (repeatable) |
| `codex-multi-auth monitor` | Aggregate runtime, usage, policy, routing-profile, quota, model, and project state: `--json` |
| `codex-multi-auth bridge token` | Local bridge bearer tokens: `create [--label]`, `list`, `rotate <id>`, `revoke <id>`; `--json` |
| `codex-multi-auth integrations` | Local bridge client snippets: `--kind opencode\|openclaw\|python\|curl\|env` (repeatable), `--base-url`, `--model`, `--json` |

### Runtime rotation

| Command | Description |
| --- | --- |
| `codex-multi-auth rotation` | Manage the default-on runtime Responses proxy: `enable`, `disable`, `status`, `bind-app [--native [--catalog-account <idx>] \| --custom-provider]`, `unbind-app`, `reset-runtime`, `reset-rate-limits [--all \| --account <idx>] [--dry-run] [--json]` |

### Configuration and maintenance

| Command | Description |
| --- | --- |
| `codex-multi-auth config explain` | Print effective config values and their sources (`--json`) |
| `codex-multi-auth config template` | Print a starter config: `[modern\|legacy\|minimal] [--write <path>] [--stdout]`; `init-config` is the same command |
| `codex-multi-auth features` | Built-in feature checklist (partial; see [../features.md](../features.md) for the full product map) |
| `codex-multi-auth uninstall` | Reverse first-run setup and residual artifacts: `--dry-run --json --clear-accounts` (run before `npm uninstall`) |

---

## Common flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--account <index\|email\|id>` | `codex-multi-auth-codex` (forwarded Codex runs) | Force one account for this invocation only; the session never rotates and persisted `switch` state is untouched. Requires the runtime rotation proxy. See [Force an account for one invocation](#force-an-account-for-one-invocation) |
| `--device-auth` | login | OpenAI Codex device-code flow for remote/headless login (mutually exclusive with `--manual` / `--no-browser`) |
| `--manual`, `--no-browser` | login | Skip browser launch and use the manual callback flow (mutually exclusive with `--device-auth`) |
| `--org <org_id>` | login | Bind this login to a specific ChatGPT workspace/org id (the same seat can be registered as personal vs team/business) |
| `--preserve-selection` | login | Add or refresh credentials without changing active selections or the manual pin; performs one sign-in and exits |
| `--account <index\|email\|account_id>` | login | Re-authenticate exactly one saved account. Implies `--preserve-selection`, refuses a different OAuth identity before writing, keeps a disabled account disabled, and cannot be combined with `--org` |
| `--api` | login | Open API credential and model visibility setup; use alone |
| `--json` | limits, verify-flagged, verify, why-selected, best, forecast, report, usage, budget, models, monitor, integrations, fix, doctor, config explain, debug bundle, history | Print machine-readable output |
| `--csv` | usage | Print or write CSV bucket output |
| `--explain` | forecast, report | Include reasoning details (forecast text/JSON, report text) |
| `--live` | best, forecast, report, fix | Use live probes before decisions/output. On `fix` this also rebinds an org-sourced account id the backend no longer authorizes and syncs a rebound active account into `~/.codex/auth.json` (see [the workspace note](#codex-multi-auth-workspace)) |
| `--model <model>` | best, forecast, report, fix | Specify model for live probe paths |
| `--no-runtime-overlay` | forecast | Score from stored account state only; skip the runtime observability overlay |
| `--max-accounts <n>` | report | Cap how many accounts a live report walk inspects |
| `--max-probes <n>` | report | Cap live probes during report |
| `--cached-only` | report | Prefer cached quota/health data over live probes |
| `--dry-run` | verify-flagged, verify (with `--flagged`/`--all`), fix, doctor, uninstall | Preview without writing storage (`-n` also accepted on fix/doctor/verify-flagged) |
| `--out <path>` | report, usage | Write output to file (`report --out` always writes JSON) |
| `--since <time>` | usage | Filter rows by Unix milliseconds, ISO date, or relative duration (`24h`, `7d`, `2w`) |
| `--by <group>` | usage | Group by model, account, project, outcome, or day (default: model) |
| `--kind <name>` | integrations | Snippet kind: opencode, openclaw, python, curl, or env (repeatable) |
| `--write <path>` | init-config, config template | Write template output to a file instead of stdout |
| `--stdout` | init-config | Force template output to stdout |
| `--fix` | doctor | Apply safe repairs |
| `--no-restore` | verify-flagged, verify (with `--flagged`/`--all`) | Verify only; do not restore healthy flagged accounts |
| `--paths` | verify | Run the storage-path resolution chain and sandbox-probe self-test |
| `--flagged` | verify | Delegate to flagged-account verification (alias of `verify-flagged`) |
| `--all` | verify | Run both `--paths` and `--flagged` together |
| `--now`, `-n` | why-selected | Recompute the current selection from live state (default). On fix/doctor/verify-flagged, `-n` means `--dry-run` instead |
| `--last`, `-l` | why-selected | Recompute selection and attach the last persisted runtime snapshot |
| `--clear-accounts` | uninstall | Also remove stored account credentials and API keys (irreversible) |
| `--refresh` | limits, resets list | Age-gated live refresh (five-minute floor) |
| `--prime` | check | Also send the tiny first-use request to genuinely unused Personal subscriptions |
| `--remove` / `--dry-run` | `codex-multi-auth-app-launcher` | Remove managed launcher routing, or preview without writing |

`--json` is also accepted by `list`/`status`, `bridge token *`, `uninstall`,
`account policy list`, `resets`, and `rotation reset-rate-limits` /
`rotation reset-runtime`; the row above is the documentation-test anchor list.

Default live-probe model when `--model` is omitted is `gpt-5.6-sol`
(`DEFAULT_PROBE_MODEL`); request routing defaults to `gpt-6.1-sol` (`DEFAULT_MODEL`).

---

## `codex-multi-auth check`

Run `check` for the full check, or select one portion:

| Command | Work performed |
| --- | --- |
| `check accounts` | Account authentication and live quota checks; skips reset-credit and model discovery checks |
| `check resets` | Refresh available subscription reset credits (shows account number and email); does not redeem credits or run inference/model probes |
| `check capabilities` | Refresh model/capability discovery for enabled subscription workspaces and API credentials, forcing the configured capability probes even inside the 15-minute cache; updates the running router catalog |
| `check --prime`, `check accounts --prime` | Also send a tiny first-use request to genuinely unused Personal subscriptions (Plus/Pro/Pro Max (Pro 500), every window at 0%, full-length reset). Starts their 5-hour and weekly windows and uses subscription quota |

Plain `check` refreshes model discovery but reuses API capability probe results
younger than 15 minutes, including results from an earlier `check` process
(stored as hashes in `api-capability-probes.json`). Only `check capabilities`
sends the billable probes regardless of age. No check sends the first-use
request without `--prime`; the dashboard's Quick and Deep Check do not prime.
`account auto-prime <index> on` instead authorizes periodic priming by a running
CLI/app router.

Unlike `fix`, `check` does not skip disabled accounts: an account whose token
is still usable is re-enabled as part of the run. With `showQuotaDetails` on
(the default, see [settings.md](settings.md)) healthy lines carry a compact
quota summary — percentage **left** per window plus the absolute reset time:

```console
$ codex-multi-auth check
Checking 2 account(s) with quick check + live check...
Model probe: gpt-5.6-sol | prompt family gpt-5.2 | tool search yes | computer use yes
  ✓ Account 1 (Personal, 1@example.com) | live session OK (5h 100%, resets 18:10 | 7d 93%, resets 13:50 on Jul 29)
```

Reset-time details:

- Times render in the local system timezone on a 24-hour clock: `HH:MM` for a
  reset later today, `HH:MM on <date>` past midnight (locale-shaped; not a
  stable output contract; year omitted because windows are at most 7 days).
- Window labels come from the backend (`5h`, `7d`, …) and fall back to `quota`.
- A missing/malformed reset timestamp keeps the percentage and omits the reset
  clause; it never fails the check.
- Reset times are shown only by `check`; the dashboard, account menu, and
  `forecast` keep percentage-only summaries. `showQuotaDetails` off reduces the
  line to `live session OK`.

Concurrency: valid-token account probes run with up to three requests in
flight; token refreshes and account-state commits stay ordered, and model
discovery refills free worker slots rather than waiting for whole batches. API
capability probes keep the same three-request concurrency limit; explicit
checks still request fresh capability results. Redirected output uses
occasional plain progress lines.

`check --prime` completes one tiny probe for a Personal subscription that
reports exactly zero usage and has no established reset countdown; a completed
probe is reported explicitly, and no second model is tried after that request.
Existing countdowns, fractional usage, API credentials, and business workspaces
do not trigger extra consumption. An ambiguous attempt is not proof of priming —
an advancing reset countdown is the confirmation.

`check --help` prints usage without network requests; unknown arguments exit 1.

---

## `codex-multi-auth limits`

Stable, machine-readable quota snapshot for local integrations:

```console
codex-multi-auth limits --json
codex-multi-auth limits --json --refresh
codex-multi-auth auth limits --json          # supported namespaced alias
```

The default command reads the local quota cache only. `--refresh` reuses the
dashboard's sequential quota refresh and its five-minute freshness floor for
ordinary quota, then asks the native Codex app-server for
`account/rateLimits/read` with Luna Reserve support for each usable account.
Reserve reads reuse the existing isolated native-usage bridge; credentials are
not added to the JSON output.

The top-level object has `schemaVersion: 1`, a millisecond `generatedAt`, a
`mode` of `cached` or `refresh`, `selection`, and `accounts`. Each account
includes `index`, `label` (email masked as in `forecast --json`), `enabled`,
`current`, either a `quota` object or `null`, and an additive `lunaReserve`
field. Ordinary quota objects contain `updatedAt`, HTTP `status`, `planType`,
and `primary`/`secondary` windows with `usedPercent`, `windowMinutes`, and
`resetAtMs`. On `--refresh`, `lunaReserve` reports the separately metered
`gpt-reserve` bucket when the backend exposes it: `observedAt`, `offered`,
`available`, `limitId`, `limitName`, `normalModelSlug`, and primary/secondary
windows with `usedPercent`,
`remainingPercent`, `windowMinutes`, and `resetAtMs`. If the backend explicitly
returns no Reserve bucket, `offered` is `false` and availability/percentages are
not invented; cached mode leaves `lunaReserve` as `null`. Unavailable values are
explicit JSON `null`; internal credentials and orphan cache entries are never
emitted. Compute countdowns from `resetAtMs`; no locale-formatted dates are
emitted.

Luna Reserve is backend-controlled and is **not unlimited**. Runtime routing
recognizes `gpt-reserve` as a first-class Luna-compatible model. A genuine quota
429 from `gpt-6-luna` or `gpt-5.6-luna` may retry as `gpt-reserve`; model
capacity errors keep their existing retry path. Reserve cooldowns are tracked
independently from ordinary Luna/Codex quota, and a manual account pin remains
a hard account constraint during fallback.

`selection` reports the configured routing target: `pinnedIndex` (the `switch`
pin or `null`), `activeIndexByFamily`, and `routedIndex` (`pinnedIndex` when
pinned, else the `codex` active index). `current` is true when `index` equals
`routedIndex`. This is configuration, not liveness: the proxy may still skip an
account that is disabled, rate-limited, cooling down, or circuit-open, and
applies session affinity and the ephemeral `--account` override. Use
`why-selected --json` for the live pick.

`--json` (`-j`) is required. Unknown flags exit 1 without reading storage.

---

## `codex-multi-auth workspace`

```bash
codex-multi-auth workspace <account>             # list the account's tracked workspaces
codex-multi-auth workspace <account> <workspace> # set the active workspace for that account
```

Both arguments are 1-based indexes as shown by `codex-multi-auth list` and the
workspace listing. With only an account index, prints the workspaces the
account can rotate between (for example a personal Plus seat and a
business/team seat under the same email, issue #491); with a workspace index,
persists that selection.

> Authorization vs membership: tracked workspaces come from the token's claims,
> which advertise **membership**. Codex CLI 0.156.0+ additionally checks
> `GET /backend-api/wham/accounts/check` before every request and refuses the
> run when the selected account is absent (`selected workspace missing from
> routing discovery`). A fresh `login` without `--org` asks the same question
> and, when the automatically chosen workspace is not authorized, falls back to
> the backend's default account with a warning; the check fails open on error.
> An explicit `login --org` (or `CODEX_AUTH_ACCOUNT_ID`) binding is saved as
> chosen, but when the backend does not authorize it, `~/.codex/auth.json` gets
> the backend's default account instead and the login warns. The account
> remembers that substitute id, so `switch`, `best`, `check`, `doctor`,
> rotation, and the dashboard keep writing it rather than the refused id; it is
> dropped when the account is bound to a different id. `fix --live` re-checks
> it: removed once the explicit id is authorized, set again while it is not.
> `login --account` is untouched — it is identity-checked before the write.
>
> **Already-saved accounts**: `login` only guards new selections. An org-sourced
> id saved earlier (or set by `workspace`, which has no live check of its own)
> is migrated by `codex-multi-auth fix --live`: when the saved id is not
> authorized it is rebound to the backend's default and reported as
> `rebound-unauthorized-workspace`. When the rebound account is the active one,
> `fix --live` also rewrites `~/.codex/auth.json` and reports
> `codexActiveSynced` in `--json` (`null` when no sync was needed). `fix`
> without `--live` makes no network calls and does not check this.

---

## `codex-multi-auth account`

Local account-policy metadata used by runtime selection and budget governance.
Policy keys are hashed from account identity; raw account ids and emails are
not stored in the policy file.

```bash
codex-multi-auth account tag|untag <index> <tag>
codex-multi-auth account weight <index> <0..10>
codex-multi-auth account priority <index> <0..9>
codex-multi-auth account auto-prime <index> on|off
codex-multi-auth account pause|unpause|drain|undrain <index>
codex-multi-auth account note <index> <text>        # ≤500 chars
codex-multi-auth account policy list [--json]
```

- `pause`/`drain` are enforced by `evaluateRuntimePolicy`: blocked accounts are
  skipped by hybrid selection and rotation. A manual pin can still target them;
  they surface as unavailable when selection would choose them.
- `weight` (0–10, default 1) adds a small score boost in hybrid selection.
- `priority` (0–9) is configured routing policy, not a unique ranking — multiple
  accounts can share a tier, lower tiers are tried first within the applicable
  privacy pool, and tier 0 is reserved for subscriptions (API/ZDR credentials
  pick tiers 1–9, 9 recommended). A stored `switch` pin is strict and overrides
  tiers entirely. Eligibility (requested model/reasoning/speed) is filtered
  before priority applies. `account policy list` and `status` show priorities.
- `tag` values normalize to lowercase filesystem-safe labels and interact with
  routing-profile preferred/avoid tags.

### Automatic subscription priming

`status` and `check accounts` show the selected workspace, observed plan (for
example **Pro 500**), automatic-priming setting, and first-use state.
`status --json` adds a `subscription` object per account with `planType`,
`planLabel`, `selectedWorkspace`, `autoPrime`, `primingState`,
`primingFailure`, `automaticBlock`, `freshness`, and `observedAt`. Status
remains local and does not run network probes.

States distinguish awaiting first use, a running reset timer, recorded usage,
completed first use (timer not yet verified), failure, and unknown/not
applicable. A displayed 0% usage can still have a running timer. Observations
older than 30 minutes, or dated in the future, are marked stale and show an
unknown priming state; an unrecognized plan is labeled unknown rather than
guessed. Run `check accounts` to refresh. `check accounts --prime`
additionally allows a tiny first-use completion. Checks honor the saved
workspace selection, and do not fall back from a disabled or invalid selected
workspace to the stored binding.

`account auto-prime <index> on|off` (default off) authorizes automatic
first-use completion for that account; `account policy list` and `status` show
the setting and include `autoPrime` in JSON.

While a CLI/app router runs, it checks opted-in subscription accounts every 15
minutes. Each saved account + selected workspace has an independent attempt
limit, including accounts sharing an organization; a disabled workspace
selection is skipped, not replaced. Quota observations cache per saved
credential and workspace, so Personal quota never stands in for organization
quota and existing observations survive Personal checks.

Priming completes the tiny response only for a Personal subscription with zero
usage and no established reset countdown; it consumes subscription quota.
Paused, drained, disabled, invalidated, and cooling accounts are skipped;
API/ZDR credentials and reset credits are never used. The private
`<accounts-file>.automatic-checks.json` stores hashed keys and attempt times
(older organization-keyed attempts are discarded on upgrade). Stopping the
router stops the checks — no OS scheduled task is created — and manual `check`
still needs `--prime`.

### Reading `priority` vs `forecast risk`

`forecast risk` is a separate health estimate (0–100, lower is better), not a
prediction for every model/setting combination and not the runtime scheduling
score. `status --json` exposes `forecastRiskScore`/`forecastRiskLevel` for
subscription accounts. The heuristic adds 10/20/35/55 points at 70/80/90/98%
used (more consumed window), plus penalties for auth failures, cooldowns, rate
limits and other blockers, and a 5-point preference for the selected account,
clamped to 0–100. In native app-bind mode with no pin, the active account is a
soft preference inside its first eligible tier; a stored `switch` pin is strict.

For native subscription requests, `automatic order` estimates routing order
from the last check: eligible accounts above a 5% quota reserve go first, then
configured tiers, earliest limiting-window reset, and remaining percentage as
tie-breaker. API/ZDR pools are never automatic paid fallbacks for subscription
requests, and explicit strict invocation pins bypass the whole order.

---

## `codex-multi-auth resets`

Earned subscription reset credits — separate from paid API credits:

```bash
codex-multi-auth resets list [--refresh]
codex-multi-auth resets redeem <account-number>
codex-multi-auth resets auto manual|last-resort      # default: manual
```

`status` includes cached counts and observation age; `check` refreshes them.
Unknown availability is not zero. Organization display aliases stay separate
from the native credential workspace used by the usage endpoint; reset
operations never change saved display preferences.

Last-resort mode first rechecks all eligible subscription workspaces and spends
a credit only when every read confirms included usage is blocked. Remaining
reserves, a scheduled reset that recovered or is due within a minute, unknown
usage, API/ZDR routes, and explicit single-account invocation pins all prevent
automatic redemption; network failures never authorize one. An ambiguous
redemption stays pending under the same idempotency key — retry the same
account explicitly. Concurrent redemptions are serialized with a five-minute
minimum interval.

`check resets` and `resets list --refresh` report how many eligible accounts
could not be read and exit 1 on a partial or complete refresh failure. A
successful read with an unavailable count remains `unknown`, not zero.
Duplicate record/workspace identities are marked ambiguous rather than sharing
a cached count or selecting the first credential; repair duplicate imported
records before checking or redeeming for them.

The installed native Codex backend must support the earned-reset RPC methods;
`CODEX_MULTI_AUTH_USAGE_CODEX_BIN` overrides the executable. On macOS,
discovery checks the current `ChatGPT.app/Contents/Resources/codex-cli/bin/codex`
layout, then the previous `Resources/codex` layout, before the npm fallback,
skipping candidates that are not executable files. Usage reads run in
a private temporary home without changing the desktop login or saved workspace
preferences, and no refresh tokens are given to that process.

---

## `codex-multi-auth rotation`

Manages the default-on runtime Responses proxy used by forwarded official Codex
sessions — separate from `switch`: the proxy can rotate managed accounts
between backend Responses requests while a Codex session stays open.

```bash
codex-multi-auth rotation enable
codex-multi-auth rotation disable
codex-multi-auth rotation status
codex-multi-auth rotation bind-app [--native [--catalog-account <idx>] | --custom-provider]
codex-multi-auth rotation unbind-app
codex-multi-auth rotation reset-rate-limits [--all | --account <idx>] [--dry-run] [--json]
codex-multi-auth rotation reset-runtime [--json]
```

- `enable` persists `codexRuntimeRotationProxy=true`, binds the packaged
  desktop app to the same persistent localhost router, and routes supported
  user-level app shortcuts when possible.
- `disable` persists `codexRuntimeRotationProxy=false` and removes the
  persistent packaged-app bind.
- `status` prints the effective setting, env override state, app-helper state,
  app-bind state, account counts, disabled accounts, cooldowns, and rate-limit
  waits.
- `bind-app` repairs or installs the persistent packaged-app bind without
  changing the stored rotation setting; `unbind-app` removes it and restores
  the backed-up Codex config.
- `reset-rate-limits` clears local rate-limit cooldowns for every account
  (`--all`) or one 1-based index (`--account`).
- `reset-runtime` clears volatile rotation state and restarts the packaged app bind when helpers are available — it (1) unbinds and rebinds the
  packaged Codex app so the router picks up the reset state, (2) resets the
  process-global rotation trackers and circuit breakers, and (3) clears the
  persisted runtime-observability fields used by status/report — pool-exhaustion
  reason, per-account skip reasons, policy-blocked entries — stamping a reset
  timestamp and reason. When app-bind helpers are unavailable it still performs
  (2) and (3) and reports that new wrapper sessions pick up the reset state; a
  failed bind restart exits non-zero.
- `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` disables the proxy for the
  current process without changing settings.

When enabled, the wrapper starts a `127.0.0.1` proxy on a random port with the
custom provider `codex-multi-auth-runtime-proxy` and forwards official Codex
Responses traffic through it — CLI request commands plus `codex app-server` and
`codex app` launched through the wrapper. For CLI request commands and
`codex app` the provider is written into a temporary shadow
`CODEX_HOME/config.toml`; interactive TUI sessions, `resume`/`fork`, and
`codex app-server` run against the canonical `CODEX_HOME` and receive `-c`
overrides instead, leaving the real `config.toml` untouched. If every managed
account is temporarily unavailable the proxy returns
`codex_runtime_rotation_pool_exhausted` with a hint to `rotation status`.

Packaged desktop-app support uses a reversible bind rather than patching app
files: it backs up the real `config.toml`, writes the custom provider to the
real Codex home, starts a localhost-only router, and installs a user login
startup entry (Startup `.cmd` on Windows, LaunchAgent on macOS). The provider
uses a local app-bind client token and `requires_openai_auth=false`, keeping
the selected multi-auth account out of the runtime composer while preserving
router last-account telemetry. Install/update runs the same bind by default
when rotation is enabled and a Codex desktop app is detected:
`CODEX_MULTI_AUTH_APP_BIND_INSTALL=0` skips that self-heal, `=1` forces it;
`CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0` skips user-level launcher routing.
Installed wrappers may run a best-effort daily npm version check on forwarded
startup; they only print `npm install -g codex-multi-auth@latest` and never
mutate the package.

### Native provider binding (opt-in)

`rotation bind-app --native` keeps the built-in OpenAI provider and the real
desktop login while routing inference through the local account pool — the
native auth path used by Remote Control pairing and other account-dependent
desktop features stays intact (pairing still needs a supported native app and
its normal account setup). `codex-multi-auth switch <index>` pins the inference
account exactly as elsewhere: requests go only to that account, a model it does
not advertise is refused with 403 `model_not_available_in_account_catalog`, and
an unavailable pin fails with 503 `codex_pinned_account_unavailable` instead of
rotating. Automatic reset-credit redemption never moves traffic off the pin;
`unpin` resumes rotation. Desktop sign-in/out stays app-owned — an auth-sync
warning after a CLI switch can reflect this intentional separation.

`--native --catalog-account <index>` prefers an enabled reference account's
model metadata. Discovery unions enabled accounts and their enabled workspaces;
each request needs one workspace supporting the complete model + reasoning +
speed combination, preferring the selected workspace, then the stored binding,
then other enabled workspaces. Workspace choice is per request and never
changes the desktop login or saved selection. Catalogs refresh on demand after
5 minutes (failed discovery retries after 5 seconds; a throttled catalog honors
`Retry-After` capped at 15 minutes; `check capabilities` retries at once). A
workspace whose catalog was never fetched is unknown and stays routable; once
one fetch succeeds, the last successful catalog decides regardless of age.
`check` reports each credential/workspace separately, labels the stored binding
and preferred workspace, highlights new/changed/removed capabilities for 24
hours, and reports catalog access separately from live inference verification;
disabled workspaces are never contacted.

Native mode requires file-backed desktop credentials
(`cli_auth_credentials_store = "file"`) in the same Codex home as the router —
keyring-only credentials are unsupported. The proxy authenticates the exact,
unexpired local desktop token or a current enabled managed-account token, does
not modify the app binary, and applies the same auth, model/workspace
eligibility, and privacy-pool routing to Responses WebSockets as to HTTP.
Desktop profile/quota displays describe the desktop login; use multi-auth
status for inference routing.

**Upgrade notes:** existing binds keep their recorded provider mode on upgrade
and on `reset-runtime`; legacy binds without a recorded mode stay on the custom
provider; new binds default to custom unless `CODEX_MULTI_AUTH_NATIVE_OPENAI=1`
opts into native. `bind-app --custom-provider` returns to the custom provider;
`unbind-app` restores the previous routing config; restart the desktop app
after changing modes.

Because the bind changes the real Codex `model_provider` to
`codex-multi-auth-runtime-proxy`, current Codex Desktop builds can hide older
threads indexed under the original provider — a visibility limitation, not data
loss (rollout files, `session_index.jsonl`, and SQLite state remain under
`~/.codex`). Run `rotation unbind-app` or `rotation disable` to browse old
Desktop history, then re-bind. Model speed/reasoning controls stay Codex-owned:
set `model_reasoning_effort` in `~/.codex/config.toml` or pass `-c` for
wrapper-launched CLI sessions.

---

## `codex-multi-auth uninstall`

Reverses first-run setup and residual host artifacts. Run **before**
`npm uninstall -g codex-multi-auth` — npm@7+ does not fire `preuninstall`
lifecycle scripts reliably, so cleanup is operator-driven.

```bash
codex-multi-auth uninstall [--dry-run] [--json] [--clear-accounts]
```

- Unbinds the persistent packaged-app rotation bind when present
- Removes managed OS launcher routing (`codex-multi-auth-app-launcher --remove` path)
- Strips this package from Codex plugin config (`Codex.json`) when present
- Clears the package cache under the Codex cache tree when safe
- `--clear-accounts` also removes stored credentials and API keys (irreversible)
- `--dry-run` previews; `--json` prints a machine-readable removed/would-remove summary

---

## `codex-multi-auth usage`

Summarizes the local usage ledger. Rows are local-only metadata: no prompts,
tokens, auth headers, raw account emails, or raw sensitive account ids.

```bash
codex-multi-auth usage [--since <time|duration>] [--by <model|account|project|outcome|day>] [--json|--csv] [--out <path>]
codex-multi-auth usage rotate [--if-larger-than-bytes <bytes>] [--json]
```

`--since` accepts Unix ms, ISO dates, or relative durations (`24h`, `7d`,
`2w`); `--by` groups by model/account/project/outcome/day (default `model`);
`rotate` moves the current ledger to a timestamped archive, optionally gated on
`--if-larger-than-bytes`. Exit `0` on success, `1` on invalid options or write
failures.

Note: CLI `usage` and `budget check` read only the current ledger file, while
the runtime proxy evaluates budgets across the current file plus archives —
expect rotated history to be under-counted by the CLI summary.

---

## Local governance commands

```bash
codex-multi-auth budget limit <key> --window <hour|day|week|month> [--requests N] [--tokens N] [--cost USD]
codex-multi-auth budget check <key> [--json]
codex-multi-auth budget list [--json]
codex-multi-auth models [--json] [--model <model>]
codex-multi-auth monitor [--json]
```

`budget limit` requires at least one of `--requests`, `--tokens`, or `--cost`.
Windows are UTC-aligned. Example:

```bash
codex-multi-auth budget limit personal --window day --requests 100 --tokens 500000 --cost 10
```

`--cost` can only be enforced for models with a known price. Some routable
models have no published rate (`UNPRICED_ROUTABLE_MODELS` in
`lib/usage/pricing.ts`, currently covering every `pro`, `mini`, and `nano`
tier); their spend is recorded as unknown, and a `--cost` limit over a window
containing them **fails closed** (`cost limit cannot be evaluated` blocks,
because treating unknown spend as `$0.00` would let the cap be exceeded without
firing). Budget on `--requests`/`--tokens` for unpriced models, or add a rate
to `MODEL_PRICING`. Budgets are advisory: racing requests can overshoot before
the ledger reflects them.

`monitor` aggregates runtime observability, usage, policy, routing profile,
budget, model matrix, quota cache, and current project context; routing
profiles themselves are file-only (`routing-profiles.json`, keyed by
`getProjectStorageKey`) — there is no write command. `models` reports neutral
account labels and never exposes raw account emails.

---

## Local bridge commands

The optional local bridge exposes only `/health`, `/v1/models`, and
`/v1/responses` on loopback; forwarded requests require a bearer token. When a
runtime client API key is configured for the bridge, inbound auth must stay
enabled (`requireAuth=true`); the bridge rewrites outbound auth for the
rotation proxy and strips inbound cookie/proxy-auth headers.

```bash
codex-multi-auth bridge token create [--label <label>] [--json]
codex-multi-auth bridge token list [--json]
codex-multi-auth bridge token rotate <id> [--json]
codex-multi-auth bridge token revoke <id> [--json]
codex-multi-auth integrations [--kind <opencode|openclaw|python|curl|env>] [--base-url <url>] [--model <model>] [--json]
```

Plaintext tokens (`cma_local_...`) are printed only on `create` and `rotate`;
the store persists SHA-256 hashes plus prefixes and labels. Generated snippets
use `CODEX_MULTI_AUTH_LOCAL_KEY`; the Python snippet uses
`client.responses.create`.

### Starting the local bridge (host/API)

There is **no** `codex-multi-auth bridge start` CLI daemon. The bridge is a
library server, `startLocalBridge`, started by a host process (or a small Node
script) against a running runtime rotation proxy:

```ts
import { startLocalBridge } from "<path-to>/codex-multi-auth/dist/lib/local-bridge.js";

const bridge = await startLocalBridge({
  // Loopback only, and must point at a running runtime rotation proxy.
  runtimeBaseUrl: "http://127.0.0.1:<proxy-port>",
  // Optional: the proxy's per-process client API key, for upstream auth.
  // The wrapper generates it per launch (OPENAI_API_KEY on the child); a host
  // that calls startRuntimeRotationProxy itself supplies its own.
  runtimeClientApiKey: clientApiKey,
  // Default true. Required true when runtimeClientApiKey is set.
  requireAuth: true,
  host: "127.0.0.1",
  port: 0, // ephemeral; read bridge.baseUrl after start
});

console.log(bridge.baseUrl); // e.g. http://127.0.0.1:43123
// Clients: Authorization: Bearer <cma_local_...> from `bridge token create`
```

Note the import path: the published `exports` map covers only `.`, `./auth`,
`./storage`, `./config`, `./request`, `./cli`, and `./package.json`
(`startLocalBridge` is **not** re-exported by the package root or any subpath),
so the bridge entry must be loaded from the installed package's dist file path
(or a source checkout). See [public-api.md](public-api.md) for the subpath map.

Operator checklist:

1. Ensure runtime rotation is available (`codex-multi-auth rotation status`, or a wrapper session that owns a proxy).
2. `codex-multi-auth bridge token create --label my-client` and store the plaintext once.
3. Start `startLocalBridge` against the **loopback** proxy `baseUrl`.
4. Point clients at `/v1/models` and `/v1/responses` with the bearer token.
5. Generate glue with `codex-multi-auth integrations --kind python|curl|env|...`.

Security invariants match the library: loopback-only bind, loopback-only
`runtimeBaseUrl`, and `requireAuth=true` whenever a runtime client key is
injected.

---

## `codex-multi-auth history`

Lists local Codex sessions by reading rollout files under
`<codex-home>/sessions` (default `~/.codex/sessions`, honoring `CODEX_HOME`)
directly. Codex's own `codex resume` filters threads by the `model_provider`
recorded in each session, so while runtime rotation or app bind is active —
provider `codex-multi-auth-runtime-proxy` — sessions created under the native
`openai` provider (or vice versa) are hidden from `resume` even though the
files still exist. This command shows every session regardless of provider:
the "history not shared across accounts" split is by provider name, not by
account.

```bash
codex-multi-auth history [list] [--json]
codex-multi-auth history show <session-id> [--json]
```

`list` (default) prints `updated_at`, `model_provider`, id, thread name, and
cwd, most-recent first; `show <id>` prints provider/originator metadata and the
first few user messages. Reopen any session with `codex resume <id>`.
Read-only, no network calls, never mutates state.

---

## `codex-multi-auth why-selected`

Explains which account the rotation selector would pick right now, with
per-candidate scoring — for reproducing rotation decisions from support bundles
or scripted diagnostics.

```bash
codex-multi-auth why-selected [--now | --last] [--json]
```

- `--now`/`-n` (default): recompute from live state.
- `--last`/`-l`: recompute and attach the last persisted runtime observability
  snapshot as `runtimeSnapshot` on the JSON payload.
- `--json`/`-j`: machine-readable output; otherwise a selected-account summary
  plus a sorted candidate list.

Exit codes: `0` when an account is selected, `1` when none can be (empty pool,
all cooled down, etc.). `selected` is `null` when `ok` is `false`.

JSON shape (abridged): `{ command, mode, ok, availableCount, totalCount,
quotaKey, config, selected: { index, oneBasedIndex, enabled, available, health,
tokens, hoursSinceUsed, capabilityBoost, pidBonus, score, selectionReason, ...
}, candidates: [...], runtimeSnapshot? }`.

---

## `codex-multi-auth verify`

Single entry point for installation self-tests; supersedes `verify-flagged`
(kept as a back-compat alias).

```bash
codex-multi-auth verify --paths [--json]
codex-multi-auth verify --flagged [--json] [--dry-run] [--no-restore]
codex-multi-auth verify --all [--json] [--dry-run] [--no-restore]
```

- `--paths`: run the storage-path resolution chain (`process.cwd`,
  `findProjectRoot`, `resolveProjectStorageIdentityRoot`,
  `getProjectStorageKey`, `getProjectConfigDir`,
  `getProjectGlobalConfigDir`) plus a sandbox self-test proving `resolvePath`
  accepts home/temp paths and rejects a synthetic outside-sandbox escape.
- `--flagged`: delegate to flagged-account verification (same behavior/flags as
  `verify-flagged`).
- `--all`: run `--paths` then `--flagged`.
- `--dry-run`/`--no-restore` forward to `verify-flagged` under `--flagged`/`--all`.

`--paths` and `--flagged` cannot be combined directly — use `--all`. Exit `0`
when all selected modes pass, `1` otherwise (the exit code is the AND of the
sub-reports). JSON output nests per-mode payloads under `paths`/`flaggedExitCode`
with `mode` of `"paths"`, `"flagged"`, or `"all"`.

The `sandbox-reject-escape` probe resets storage-path state first and builds its
escape candidate outside home, temp, and project roots, so it stays robust from
pathological working directories (for example POSIX `cwd=/`); when no
guaranteed-outside candidate exists, the probe records `skipped` with
`ok: true` rather than a spurious failure.

---

## Force an account for one invocation

`codex-multi-auth-codex --account <selector>` pins a single account for that
one forwarded Codex run — for example when driving Codex from another tool or
keeping separate personal/work pools. The selector is:

- a **1-based index** (`--account 2`, matching `codex-multi-auth list`),
- an **email** (`--account work@example.com`), or
- an **account id** (`--account acc_...`).

An all-digit selector is always treated as a 1-based index, so an account whose
id is purely numeric cannot be targeted by id — use its index or email.

`CODEX_MULTI_AUTH_FORCE_ACCOUNT=<selector>` has the same effect for tools that
set environment variables more easily than flags; `--account` wins when both
are present.

The pin is **ephemeral and fail-hard**:

- It applies only to this invocation, never touches the persisted `switch` pin,
  so concurrent sessions with different `--account` values do not interfere.
- The session never rotates: if the chosen account is rate-limited or otherwise
  unavailable, the request fails rather than silently using another account.
- It requires the [runtime rotation proxy](../configuration.md#runtime-rotation-proxy).
  If the proxy is disabled (or `CODEX_MULTI_AUTH_BYPASS=1`), or the selector
  matches no configured account, the wrapper exits non-zero without launching
  Codex.

---

## `mcodex`

Convenience launcher published as the `mcodex` bin; it spawns the sibling
`codex-multi-auth-codex` wrapper (`scripts/codex.js`) with no shell dependency
and implements no account logic of its own.

```bash
mcodex [codex-args...]                 # default: forward to codex-multi-auth-codex
mcodex --monitor                       # live-refresh account list via `watch`
mcodex --tmux [-t] [--live-accounts] [codex-args...]
```

- **Default**: forward all remaining args to `scripts/codex.js`.
- **`--monitor`**: run `watch -n <interval> codex-multi-auth list`; interval
  defaults to 5 seconds, override with `MCODEX_MONITOR_INTERVAL` (positive
  number only). Missing `watch` exits 1 with an install hint.
- **`--tmux` / `-t`**: open or attach a tmux session (default name `mcodex`,
  override `MCODEX_TMUX_SESSION`) running the wrapper. Optional
  `--live-accounts` (only after `--tmux`/`-t`) opens a split that refreshes the
  account list when `watch` is available. History limit defaults to 50000
  (`MCODEX_TMUX_HISTORY_LIMIT`). Missing `tmux` warns and forwards without it.

---

## `codex-multi-auth-app-launcher`

User-level app launcher routing helper:

```bash
codex-multi-auth-app-launcher [--remove] [--dry-run] [--help]
```

- **Windows**: retargets existing user-level `Codex` shortcuts and taskbar pins
  to the wrapper, backing up original targets for restore. If Codex is exposed
  only as a packaged `shell:AppsFolder` entry there may be no retargetable
  `.lnk` — the persistent app bind is the path that makes packaged entries use
  rotation.
- **macOS**: creates/removes a user-level `Codex Multi Auth.app` wrapper
  (Dock entries cannot safely launch a shell command directly).
- **Linux**: installs a managed `codex-multi-auth.desktop` under the user
  applications directory.

It never patches official app files; `--remove` restores backed-up Windows
shortcuts or removes the managed macOS/Linux launcher.

---

## Compatibility and non-TTY behavior

- `codex-multi-auth` is the primary account-manager entrypoint and accepts bare
  subcommands (`status`, `login`, `rotation status`, …).
- `codex-multi-auth-codex` handles `auth ...` locally and forwards everything
  else to the official `@openai/codex` CLI.
- `codex --version` reports the official CLI version when the official CLI owns
  the `codex` name; `codex-multi-auth --version`/`-v` reports the manager
  package version.
- In non-TTY or host-managed sessions (`CODEX_TUI=1`, `CODEX_DESKTOP=1`,
  `TERM_PROGRAM=codex`, `ELECTRON_RUN_AS_NODE=1`), auth flows degrade to
  deterministic text behavior: `login` defaults to add-account mode, skips the
  "add another account" prompt, and auto-picks the default workspace when a
  follow-up choice is needed.
- `login --device-auth` is the preferred remote/headless path — it needs only a
  browser on any device plus the printed one-time code, prints
  `https://auth.openai.com/codex/device`, and polls without a browser or local
  callback server.
- `login --manual`/`--no-browser` prints the OAuth URL and accepts manual
  callback input; `CODEX_AUTH_NO_BROWSER=1` suppresses browser launch for
  automation (false-like values do not). In non-TTY/manual shells, pass the
  full redirect URL on stdin, e.g.
  `echo "http://127.0.0.1:1455/auth/callback?code=..." | codex-multi-auth login --manual`.

---

## Dashboard hotkeys

The settings screens are TTY-only; `Q` cancels without saving on every panel,
and the theme panel live-previews then restores the baseline on cancel.

### Main dashboard

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move selection |
| `Enter` | Select/open |
| `1-9` | Quick switch visible/source account |
| `/` | Search accounts |
| `?` | Toggle help |
| `Q` | Back/cancel |

### Account details

| Key | Action |
| --- | --- |
| `S` | Set current account |
| `R` | Refresh/re-login account |
| `E` | Enable/disable account |
| `D` | Delete account |
| `Q` | Back |

### Settings screens

- Account List View: `Enter Toggle | Number Toggle | M Sort | L Layout | S Save | Q Back (No Save)`
- Summary Line: `Enter Toggle | 1-3 Toggle | [ ] Reorder | S Save | Q Back (No Save)`
- Menu Behavior: `Enter Select | 1-3 Delay | P Pause | L AutoFetch | F Status | T TTL | S Save | Q Back (No Save)`
- Color Theme: `Enter Select | 1-2 Base | S Save | Q Back (No Save)`
- Backend Controls: `Enter Open | 1-4 Category | S Save | R Reset | Q Back (No Save)`

---

## Reading status and check output

Terminal reports highlight account headings, successful probes, warnings, and
new/changed capabilities using the configured UI theme; text labels remain
available without color. Redirected output is plain by default; `NO_COLOR=1`
disables color and `FORCE_COLOR=1` enables it; `status --json` is never
colored.

`status` also lists API/ZDR accounts with configured priority, enabled state,
visible-model count, and last inference request time. The old `lastUsed` field
includes selection and refresh activity, so it is labeled **account activity**,
not inference usage; **last inference request** is recorded when the proxy
dispatches a Responses or image request (it does not claim the request
completed), and health/model checks do not update it. `status --json` preserves
`accounts[].lastUsed` and adds `accounts[].lastInferenceRequestAt`,
`apiAccounts`, `totalAccountCount`, `selectionMode`, `modelInventory`, and
per-account priority/forecast/reset-credit fields.

API model entries require explicit selection and never serve as automatic paid
fallbacks; see [model route pools](../design/model-route-pools.md) for setup
and refresh behavior. Credential-scoped access programs can be configured per
API route (`accessPrograms`, `modelAccessPrograms`) when model discovery omits
that metadata — they describe server-granted access and never grant it.

---

## Workflow packs

Health and planning:

```bash
codex-multi-auth check
codex-multi-auth forecast --live --explain --model gpt-5.6-sol
codex-multi-auth report --live --json
```

Repair and recovery:

```bash
codex-multi-auth fix --dry-run
codex-multi-auth fix --live --model gpt-6.1-sol
codex-multi-auth doctor --fix
```

---

## Related

- [../features.md](../features.md)
- [public-api.md](public-api.md)
- [error-contracts.md](error-contracts.md)
- [settings.md](settings.md)
- [../troubleshooting.md](../troubleshooting.md)
