# Image routes through runtime rotation

The runtime proxy accepts POST `/images/generations` and `/images/edits`, plus their `/v1` aliases. Both use the existing local bearer authentication, managed account selection, OAuth refresh, policy gate, and quota cooldowns. Bodies are forwarded unchanged to `/codex/images/generations` or `/codex/images/edits` under the configured upstream base (normally `https://chatgpt.com/backend-api`).

Image requests have a minimum five-minute upstream-header timeout. Explicit quota/auth rejection uses existing bounded pool handling. Ambiguous transport failures and other image errors, including 5xx, are not retried within the proxy request. Responses behavior is unchanged.

The usage ledger records operation `images`, outcome, model and redacted account identity through the existing recorder. This does not introduce image-price estimates or store prompts, image bodies or credentials.

This transport support alone does not expose the built-in tool on clients that gate image generation by provider capabilities. Client capability compatibility is a separate change. Upstream subscription entitlements and moderation still apply. The proxy does not rewrite the image model or establish which server-side model revision is used.

## Retry limitation

An independent client request can still repeat an operation after an ambiguous outcome. This change does not promise cross-request deduplication or exactly-once generation. A replay/idempotency contract requires separate design.

## Migration and rollback

No account migration, reauthentication, or new configuration is required. Reverting the route change restores the previous route allowlist without changing account storage.
