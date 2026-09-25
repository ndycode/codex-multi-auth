# Earned subscription reset credits

Account usage snapshots expose reset-credit availability separately from paid token credit balances. Show the count (or unknown) with its observation time in status; refresh it during checks using bounded parallelism. Reading status must not launch network calls. Never infer a count from a capped details list.

Use the native app-server `account/rateLimits/read` and `account/rateLimitResetCredit/consume` methods in an isolated temporary home. Authenticate only the saved native credential workspace. Organization display aliases (`org-…`) are not native workspace IDs and cannot authorize resets. Preserve the display workspace preference. Do not change desktop login or saved workspace selection. No model inference is needed for these operations.

`resets list [--refresh]`, `resets redeem <account-number>`, and `resets auto manual|last-resort` provide explicit control. Default policy is manual. An unknown result remains pending under the same durable idempotency key; serialize redemptions across processes, re-read limits after every outcome, and never guess quota recovery. No real redemption is performed by tests.

Last-resort automatic redemption applies only to ordinary subscription routing, never API/ZDR requests. Consider it only when all otherwise eligible subscription workspaces are confirmed exhausted (including the reserve). Refresh all eligible limits before redemption: an already-reset account or unknown quota stops redemption. Revalidate policy and count under the redemption lock. Redeem at most one credit per request, preferring the configured routing order. Ambiguous failures remain pending and block further automatic spending until explicitly retried. Clear only quota-related blockers after confirmed available quota; retain authentication, policy and capability failures.

Verification: isolate native RPC transport, test failure/timeout cleanup, quota/count validation, workspace identity matching, retry idempotency, concurrency, manual-only default, reserve preservation, scheduled reset recovery, unknown quota refusal, and privacy-pool exclusion. Live verification is read-only.
