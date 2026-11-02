# Native Decisions API routing

The runtime rotation proxy accepts `POST /v1/decisions` and `POST /decisions`.
Requests go to the selected credential's regional `/v1/decisions` endpoint;
they are never translated to Responses or chat completions.

Select `api/<model>` or `zdr/<model>` explicitly. Bare subscription models,
PSP routes, and speed-tier aliases are rejected before discovery or inference.
Existing PSP and Responses routing is unchanged. A `zdr/` selection uses only
operator-declared ZDR credentials; it does not independently certify the
provider project's retention configuration.

Eligibility requires all of the following for the selected credential:

- The route is enabled and belongs to the explicitly selected API/ZDR pool.
- Its discovered catalog includes the model, and its visibility policy allows it.
- The model's operator profile includes `supported_endpoints: ["/v1/decisions"]`.

Set that field in the credential's existing `modelProfiles[model]` configuration
only after verifying the provider supports Decisions for that account/model.
A model ID returned by `/models` alone does not grant endpoint capability.
This change neither edits existing profiles nor performs inference probes.

Typed predicate, choice (including boolean choices), and score questions are
forwarded with the original input and optional cache/safety fields. Only the
routing prefix is removed from `model`. No Responses-only `store`, `stream`,
or reasoning settings are injected. Native answers, refusals, and usage remain
intact. Provider rejection status and safe error code/type/parameter fields
are preserved; error messages are sanitized to avoid reflecting private input.

Unsupported endpoint responses (404/405/501) allow another eligible credential
in the same pool and region and are cached for five minutes per credential,
model, and endpoint. Responses capability state is unaffected. Confirmed
temporary `rate_limit_exceeded` 429 responses use Retry-After and shared
backoff. Unclassified/permanent quota rejections, network ambiguity, and other
server errors are not replayed. Discovery, admission, response-body reads, and
retries share a 60-second deadline and respect cancellation. Response buffering
is capped at 8 MiB.

The usage ledger records the `decisions` operation and actual provider token
counts, including for responses larger than the generic stream scanner's cap.
The full provider usage object is returned to the caller. Endpoint-specific
pricing is not configured: estimated cost remains unknown (`null`), never zero
or a Responses-model estimate. Existing cost-budget handling of unknown costs
continues to apply; callers must not present these requests as free.

Provider contract references:
[Decisions guide](https://developers.openai.com/api/docs/guides/decisions) and
[create endpoint](https://developers.openai.com/api/reference/resources/decisions/methods/create).
