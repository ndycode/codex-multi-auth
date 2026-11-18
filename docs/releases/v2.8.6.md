# v2.8.6

Fixes the commands that tell you whether an account is usable, and the error you get when a pinned account isn't. Nothing to migrate.

## Fixes
- `forecast`, `best` and `report` with `--model X` now check rate limits for that model's family and that exact model, the same way the proxy picks accounts. Before, they could call a rate-limited account `ready`.
- A limit on a different model in the same family no longer shows a delay for a model that isn't limited.
- When a family-wide and a model-specific limit overlap, you now get the later time, so coming back then actually works.
- A saved `rate-limited` state backed by a live limit is no longer thrown away as stale.
- Without `--model`, nothing changes. `status` and `fix` still count every limit in the family.
- The `codex_pinned_account_unavailable` 503 no longer tells you to run `codex-multi-auth unpin` for a pin set by `--account` or `CODEX_MULTI_AUTH_FORCE_ACCOUNT`. It tells you to relaunch instead.
- The 503 now says when the account recovers, using whichever of its rate limit, cooldown or circuit breaker holds it back longest.
- A permanent blocker (disabled account, no enabled workspace, invalidated token, policy block) now reports no recovery time instead of a fake deadline.
- A corrupt timestamp in saved account state no longer turns the response into a generic 500.

## Heads up
- `codex_pinned_account_unavailable` gained three fields. Existing fields are unchanged.
- `pin_source`: `"forced"`, `"manual"` or `null`. `manual` came from `switch` and clears with `unpin`. `forced` came from the launcher and doesn't.
- `reset_at`: ISO timestamp or `null`, when the account becomes selectable again.
- `retry_after_ms`: number or `null`, the same moment in milliseconds.
- If one backoff routine handles both 503 codes: `retry_after_ms` here is the *latest* bound for one pinned account, while `codex_runtime_rotation_pool_exhausted` reports the *earliest* recovery across the pool. It's advisory and not sent as a `Retry-After` header. Full contract in [reference/error-contracts.md](../reference/error-contracts.md).

## Upgrade
```bash
npm i -g codex-multi-auth
```

## Thanks
- Reported, diagnosed and fixed by [@possibilities](https://github.com/possibilities) in [#670](https://github.com/ndycode/codex-multi-auth/pull/670) and [#671](https://github.com/ndycode/codex-multi-auth/pull/671).
