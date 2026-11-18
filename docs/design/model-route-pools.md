# Explicit model routing pools

## Scope and design

Keep desktop authentication and native features separate from inference credentials.
Discover the union of enabled subscription account catalogs. Preserve the reference model metadata and aggregate advertised native effort and
speed choices. Check the requested combination against each credential.

API and ZDR credentials initially expose user-selected models, as `api/<model>` and
`zdr/<model>`. API-only models are first-class entries and require no subscription
counterpart. After a baseline discovery, newly discovered GPT text model IDs become visible automatically. Models hidden by the operator remain hidden.
Ordinary models never fall back to paid credentials. Each explicit pool fails
closed when exhausted. ZDR is an operator-declared credential classification;
discovery cannot verify an organization's retention approval.

Account capability eligibility precedes existing subscription health, quota,
affinity and weight selection. A stored `switch` pin and an explicit per-invocation pin are both hard constraints, in native mode as elsewhere.
API credentials use ascending priority, then stable credential ID; retries stay
within the selected pool and stop after response headers are accepted. Requests
use the official API endpoint, fresh API authorization headers and `store:false`.
Unknown server-side continuation ownership is rejected instead of guessed.

Credential configuration is a private atomic file separate from desktop auth.
Status reads cached discovery; check refreshes the running bound proxy, or performs standalone discovery when unbound. Catalog errors must be visible
and must not authorize stale access. No prompts or credentials belong in discovery
status. API model discovery identifies IDs. Public model documentation supplies explicitly documented effort levels; optional billable credential probes verify missing effort levels and speed tiers. Tool capabilities are not inferred.

## Verification gates

Policy, storage and API dispatch tests precede implementation. Integration tests
exercise the actual loopback proxy for catalog union, API-only dispatch, and
fail-closed boundaries. Follow with CLI tests, streaming/error tests, type checking,
focused security self-review and a complete native inference turn. Catalog visibility
alone does not verify credential routing.

Project/section routing, an in-app account indicator, and desktop binary changes
are excluded. Responses WebSocket transport is included. Editing this worktree
does not deploy changes.

## Operator workflow

Run `codex-multi-auth login --api`, or select **API credentials and models** in
`codex-multi-auth login`. Add a credential with a private label and
explicitly choose API or ZDR (approval is not detected from the key),
enter the key into the hidden prompt, set a failover priority from 1 to 9 (lower
first; 9 recommended; subscription accounts default to tier 1), and toggle
only the models to expose. Save applies the selection. Escape cancels without
saving. Existing credentials support model reselection, priority changes, and
enabling/disabling. API keys are stored in `api-routes.json` with mode 0600.

Native `/models` loads supply the union of enabled subscription and API catalogs,
using the caches and background refresh described below. Reference-account settings
influence duplicate metadata, not which IDs can appear. Selectable capabilities
are combined, context limits are clamped conservatively, and dispatch checks the
requested settings against each serving credential.
The app can reuse its own model cache between requests: opening the dropdown is
not guaranteed to fetch. Startup and periodic native catalog refreshes use the
proxy. New GPT text IDs are added to each credential’s visible list after its initial baseline; non-GPT IDs still require manual selection. Known media/audio/embedding endpoint families are excluded from the coding picker. This family filter does not prove that every future ID supports Responses.

`check` refreshes the live catalog and prints per-credential model IDs, visibility, reasoning levels, speed tiers, access programs and probe results. It fails visibly if the refreshed status cannot be saved. A changed union catalog ETag is included in inference responses so the native backend refreshes on its next response. An already-open idle picker can remain cached until that signal or the native periodic refresh. `status` and `status --json` read the last local discovery
snapshot; timestamps identify stale data. Availability is a catalog result, not a
paid inference test. The native client version learned during app discovery is
reused by check. If discovery requires a version and none has been learned, open
the bound app and run check again.

API entries use conservative model metadata because the public
[Models API](https://developers.openai.com/api/reference/resources/models/methods/list)
does not provide the complete native tool/effort configuration. A model being
listed is not a guarantee that it supports Responses or every Codex tool.
Native catalog records also require an instruction template; synthetic API
records provide a generic coding template rather than borrowing another account's
private model instructions.

ZDR selection isolates inference credentials; it does not change desktop account
features, local history, or tool destinations. Approval and endpoint/tool retention
remain governed by the organization's
[API data controls](https://developers.openai.com/api/docs/guides/your-data).
The proxy rejects background requests and server-side conversation references on
these explicit routes, rather than guessing credential ownership. It does not
claim that labeling an API key as ZDR verifies that key's organization settings.

## Compressed native requests

The native first-party provider can send Zstandard-compressed Responses bodies.
The proxy decodes supported content encodings before model, privacy-pool, policy,
and account selection. Both wire and expanded body sizes are bounded. Invalid
JSON, missing models, malformed compression and unsupported encodings fail locally
without an upstream request. Forwarded decoded bodies omit stale encoding/length
headers. Zstandard needs a Node version that provides `zstdDecompress`; older Node
runtimes return HTTP 415 instead of forwarding an opaque request to an account.

## Capability-aware priority follow-up

Subscription accounts gain integer priority tiers (0 first, default 1) stored in
existing account policies. Filter model, requested reasoning/speed, policy, health
and previous attempts before finding the first usable tier. Affinity and weights
apply within that tier only. A stored `switch` pin bypasses tiers: it is strict and fails with
`codex_pinned_account_unavailable` rather than falling back. Explicit per-invocation
`--account` is also a hard constraint for callers who request isolation. Account
policy commands expose priority; status distinguishes preference from a hard pin.

Native speed controls derive from credential-specific live catalog metadata.
A chosen speed is part of routing eligibility. The proxy does not change it;
upstream capacity can still downgrade processing. Public API model ID
listing alone cannot establish a speed entitlement; OAuth speed capabilities must
not be copied onto API/ZDR credentials.

## API effort and speed verification

API picker effort levels come from the exact model’s public documentation support
statement, or successful opt-in probes for levels missing from documentation. Newly named
levels in an exact model support statement are accepted without a fixed enum. The
probe must echo the requested effort. Documentation fetches carry no credentials;
no subscription access programs or speed entitlements are copied into API records.

The API credential menu has **Enable small billable capability probes**. This is
opt-in per credential (`probeCapabilities`), uses a fixed benign prompt,
`store:false`, and a 16-token maximum output. Plain `check` and automatic refreshes reuse results for 15 minutes, including
across restarts through the hashed `api-capability-probes.json` cache.
`check capabilities` explicitly forces fresh probes. Concurrent checks in one
process share a probe. Independent probes run in parallel under a shared four-request
limit. Native model discovery has a five-second deadline, so automatic capability
checks run in the background and update the catalog/ETag when ready; explicit
CLI checks wait for the new results. Failed authentication, rate limiting and transport errors remain
unverified, rather than being reported as lack of entitlement. Probe costs are
separate from user-turn usage accounting.

Fast and Priority are equivalent. The native catalog uses `priority` for its Fast
control; API probes accept either returned spelling. A requested faster tier that
returns `default` is recorded as downgraded and is not advertised as verified.
Each pool/model has one picker entry. Native speed and effort controls expose
advertised settings; routing checks the requested combination against each
credential. Previously selected speed aliases remain accepted for conversation
compatibility, but are no longer listed.
Later upstream capacity downgrades remain possible; verification is a point-in-time
result, not a latency guarantee. New speed grants are picked up on an explicit check or when the automatic probe
cache expires. The probe candidates currently cover Fast and Ultrafast.

Ultra is a native Codex orchestration mode, not an API effort entitlement. For
models with supported High or greater effort, the catalog exposes Ultra and sets
`multi_agent_reasoning_effort` to a supported Max, XHigh or High value. The native
backend performs the translation; paid probes never send `ultra` to the API.
The public models endpoint does not enumerate effort/tier entitlements; discovery
uses exact model documentation plus opt-in probes of known candidate values.
A wholly new undocumented value cannot be discovered reliably by this method.

## Native voice

Native bind supplies separate realtime HTTP and WebSocket base URLs to the native
backend, preserving any explicit user overrides. Voice retains desktop account
authentication and the native backend protocol. Selecting a ZDR coding model does
not route voice through the ZDR API credential. Unbind removes only the managed
settings. Full voice audio still requires a desktop test after reopening the app.

## Responses WebSocket transport

WebSocket handshakes authenticate through the same local policy as HTTP. Model
selection is in response.create, so credential selection happens after the first
frame, never at handshake time. Reuse the existing HTTP routing, budget and usage
pipeline with a per-request async transport context, not a second account router.
Use persistent upstream WebSockets partitioned by endpoint and credential.

Keep a bounded in-memory response-chain cache per authenticated client connection.
Continuations use the original upstream connection when available; otherwise
replay complete accumulated input only before generation starts. Unknown response
IDs require a full-context retry, never a guessed account. Cross-pool continuation
is rejected. No replay after any upstream response event has been delivered.
Disconnect and cancellation abort upstream work; payload, queue and buffered-write
limits bound memory. No session prompts or response IDs persist to disk.

Tests must cover unauthorized handshakes, multiple turns on one upstream socket,
known/unknown continuation, pool isolation, model-aware fallback, mid-stream failure,
cancellation, malformed/oversized frames, native client compatibility and shutdown.
The initial native transport serializes response.create messages; additional client
control events must be supported or fail explicitly rather than being ignored.

### Deferred ZDR voice

Experimental voice adapter code is excluded from this change. A separate voice
change must verify endpoint access, credential and session ownership, protocol
translation, disconnect/revocation behavior, and end-to-end audio before release.
Selecting a ZDR text model does not imply that native voice uses that credential.

## Workspace discovery and routing

OAuth discovery enumerates each enabled saved workspace independently, using the
same credential with that workspace's account header. Checks and desktop model
refreshes share this path. Disabled workspaces are reported but never contacted.
A stored binding absent from the workspace list remains an explicit scope; scope
identities are hashes of the stable credential identity and workspace binding.
Discovery does not change the saved workspace or the native desktop login.

Native Responses routing first filters each account's workspaces by the exact
model, effort, and speed combination. Within a chosen account it prefers the
selected workspace, then its stored binding, then other enabled workspaces.
Existing account priority and account-policy restrictions still apply. A strict
account pin confines this search to that account. Structured runtime capability
rejections are remembered per workspace and may retry another eligible workspace
before another account; accepted generation is never replayed by this mechanism.
API and ZDR pools retain their separate credential routing and privacy boundaries.

The local report labels the stored binding, preferred workspace, and routing
eligibility. It highlights newly advertised models, removed models, capability
changes, and availability differences within each credential pool. The first
successful observation establishes a baseline. Failed discovery remains unknown
and preserves the previous successful baseline; it does not imply revoked access.
Recent changes survive repeated refreshes for 24 hours. Disabled or undiscovered
scopes are not used to claim exclusive access. Catalog observations are distinct
from live inference verification; workspace catalog checks do not run an inference
probe for every model/settings combination.

API/ZDR setup recommends tier 9 and offers tiers 1–9 within its own pool.
Legacy configured priorities remain readable. API/ZDR requests remain explicitly
selected (including API-only model entries); subscription requests never gain a
paid fallback merely because subscription accounts are unavailable.

## Subscription quota reset ordering

Native subscription Responses routing uses a 5% reserve. Filter model/settings,
workspace enablement, policy, health, exhaustion and request attempts first. If
any eligible subscription scope has quota above the reserve (or unmeasured quota),
reserve scopes wait. A stored `switch` pin is strict and skips this ordering; otherwise configured
priority tiers come first, then earliest reset, then greater remaining quota, then existing preference/health logic.
Only when no ordinary eligible subscription remains can reserve scopes be used.
Explicit invocation pins remain strict. No phase crosses into API/ZDR pools.

Reset ordering uses the earliest reset of each account’s most depleted active
reported window, with greater remaining quota breaking equal-reset ties. Both short and
long windows gate use; this avoids ranking a full short window ahead of an empty
weekly budget. Missing/expired or older-than-15-minute quota gets no urgency
bonus. Confirmed exhaustion remains blocked until its reset. Unknown information
never establishes paid/subscription billing status; plan names do not drive this
ordering. Percentages are scheduling hints, not comparable monetary balances.

The native path disables the old default near-exhaustion cooldown so the reserve
can actually be used as a last resort; explicit embedded threshold overrides
remain respected. Runtime response headers update per-workspace/model observations
in a bounded, per-proxy cache. Saved check observations seed only their bound
workspace, never sibling workspaces. Each request rereads the check cache, so new
checks affect selection immediately. Status shows a numbered estimate from the
last check, reserve membership and reset time, separate from configured tiers.
Model/workspace eligibility and fresher in-memory observations can change the
actual request order; this estimate is not a claim of a universal global rank.

`check --prime` completes one tiny probe for a personal subscription that reports exactly
zero usage and has no established reset countdown. A full relative window can
be an unused-account placeholder; receiving headers alone does not prove the
timer started. A completed probe is reported explicitly. Incomplete or timed-out
streams produce a warning, and no second model is tried after that first-use
request. Existing countdowns, fractional usage, API credentials and business
workspaces do not trigger extra consumption. Checks retain bounded parallelism.

Automatic first-use completion is configured separately with
`account auto-prime <index> on|off` (off by default). The CLI/app router checks
opted-in accounts every 15 minutes while running, without opening the login
dashboard. Only the saved subscription binding is checked. Disabled, paused,
drained, invalidated, or cooling accounts are skipped. Checks reuse canonical
model instructions and never redeem reset credits or use API/ZDR credentials.
A private `<accounts-file>.automatic-checks.json` file contains hashed account
keys and attempt timestamps; a cross-process lock prevents overlapping probes.
Attempts are recorded before network I/O, including failures, to limit retries
across router restarts. Manual `check` still requires `--prime`.

Ordinary inference has no special priority override for 100% accounts. It follows
configured tiers, capability eligibility, earliest reset and the
5% reserve. Remaining quota only breaks reset-time ties. There is no target to
consume 1% merely to change a rounded display. Explicit strict invocation pins
and API/ZDR privacy pool isolation remain intact.

### Streaming subscription quota feedback

The selector consumes native `codex.rate_limits` events as Responses stream data
arrives, including subsequent turns on a reused WebSocket. Previously only HTTP
response headers updated its quota observations, leaving WebSocket routing on
cached check results. Events update the dispatched account/workspace and model;
unrelated metered pools and malformed percentages cannot replace the ordinary
subscription balance. Missing windows preserve the last observation of that
window. A valid new window without a reset does not inherit an old reset date.
The next eligible request avoids the 5% reserve while another ordinary
subscription is available. Already-dispatched work is not interrupted.
`streamQuotaUpdates` and `lastStreamQuotaUpdateAt` in app-bind status distinguish
working quota feedback from transport connectivity alone.

### WebSocket warm-up controls

Native startup prewarm uses `generate:false` followed by an ordinary
`response.create` that omits `generate`. Reconstructed continuation history must
not inherit that request-local flag: omission means normal generation. Otherwise
both warm-up and user turns return `response.completed` with no output, so a
connectivity probe without prewarm and transport-success counters miss the bug.
The regression covers warm-up, omitted generation flags on subsequent turns,
and a later explicit warm-up on the same socket.

### Picker latency and discovery caching

Normal picker loads reuse five-minute account/workspace and API discovery caches;
they do not invalidate every credential. Up to four client versions keep separate
OAuth caches, preventing desktop/CLI version changes from repeatedly discarding
valid results. Credentials/inventory changes invalidate those caches. API/ZDR
visibility is reconciled against the current enabled credential configuration.

A cold picker read waits at most two seconds for discovery, then serves the models
already discovered while remaining workspaces finish. Warm picker reads can use
up to fifteen-minute-old OAuth metadata during background refresh; actual routing
still waits for fresh capability discovery and enforces pool boundaries. Failed
refreshes drop that scope's availability. API and OAuth catalog requests run in
parallel on picker reads. Explicit `check` (`refresh_capabilities=1`) waits for a
complete fresh scan and publishes the completed inventory as before. This avoids
the native backend's five-second catalog timeout and bundled-model fallback.

### Saved workspace preferences and request status

A saved workspace selection is a preference, not evidence of the workspace used
by a request. Status labels it `saved selection` and reports the latest outgoing
OAuth workspace scope separately; this scope is not an upstream billing receipt.
API routes clear the OAuth scope. Older telemetry reports `not recorded` rather
than inferring a scope from the saved preference.

Long-lived account managers reconcile external workspace selection changes by
account identity and workspace ID before routine saves and token-refresh writes.
Native reloads adopt these changes even when tokens have not changed. Re-enabling
an account preserves a valid selected workspace instead of resetting it to the
default. Local legacy rotation still persists when the disk preference has not
changed; health flags are not replaced by selection reconciliation.

### WebSocket tool-history resilience

Continuation replay retains completed `response.output_item.done` items in output
index order, including tool calls and opaque reasoning fields. Terminal output
items are reconciled by item ID rather than assuming `response.completed.output`
contains the full stream. Unfinished or oversized history is not cached for
replay. A cross-account/connection replay validates that custom/function tool
results have preceding matching calls; otherwise it returns
`previous_response_not_found` requesting full input instead of sending a broken
conversation upstream. Response ownership is tied to the actual upstream socket,
so reopening a connection with identical credentials cannot reuse an old
connection's response IDs. Existing privacy-pool boundaries and the prohibition
on replay after generation has begun remain in effect.
