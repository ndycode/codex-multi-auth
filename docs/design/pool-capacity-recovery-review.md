# Pool capacity recovery review

## Problem and behavior

Account-specific 429 responses previously consumed the four-attempt transient failure budget, preventing selection of a usable fifth account. Pro Max native usage snapshots were excluded from reset eligibility. A rounded 100% usage value could also mask a fresh native ordinary-use permission.

Account-local 429 failover now traverses the distinct eligible accounts and workspace scopes. Network/server failures, hard pins, and model-wide capacity retain bounded retry behavior. One final quota-recovery pass handles explicit 429 rejections that invalidate a previously usable cache; it does not replay an ambiguous or streaming generation.

An optional `emergencyOnly` account policy reserves backup accounts until fresh native observations confirm all eligible regular scopes have no ordinary capacity and zero reset credits. Unknown, stale, future-dated, pending, or newer positive quota evidence keeps backups reserved. Automatic reset recovery considers regular accounts only. Background subscription priming also excludes emergency-only accounts. Explicit pins retain their documented behavior.

## Reproduction and verification

- RED: a usable fifth account was not reached; six exhausted accounts stopped at four attempts.
- RED: a Pro Max account with an available reset was not redeemed.
- RED: backup CLI operations were unknown and background priming selected reserved accounts.
- GREEN: distinct-account failover, bounded all-exhausted and server-failure paths, native usage producer-to-routing consumer integration, reset recovery after newly discovered exhaustion, and conservative backup admission.
- Final focused run: 9 files, 463 tests passed.
- Full suite: 7,937 tests passed, 9 existing skips across 440 files.
- Type checks, lint, build and production dependency audit passed; zero production vulnerabilities. Audit used an isolated npm user configuration because the local global allow-scripts setting conflicts with audit.

## Focused native security and operational self-review

This is self-review, not independent review.

- Account identities and workspace eligibility continue through existing catalog, authentication, policy and credential checks. No credentials, hosts, request headers, sandbox settings or model access policies change.
- Reset redemption retains its shared lock, idempotency and pending-outcome protections, native ordinary-use confirmation, scheduled-reset guard and throttles. Reset credits on reserved backups cannot be spent by automatic regular-pool recovery.
- New policy writes use the existing validated CAS store. Strict policy reads reject malformed emergency flags. The CLI changes only the requested flag and does not silently unpause accounts.
- Retry expansion is limited to explicit account-local rejection. Distinct account/workspace tracking and one final recovery pass bound selection; hard pins and transport/server retry ceilings remain intact.
- A newer quota observation that indicates available or unknown capacity prevents older native exhaustion snapshots from authorizing backup traffic.
- Older package versions ignore or drop the new flag. Downgrade instructions require pausing emergency accounts first and reapplying policy after upgrade.

No unresolved findings in this change. Live installation must preserve the existing binding and account identities, retain rollback files, then verify the installed build and exact backup policy. No private-history generation probe is needed.
