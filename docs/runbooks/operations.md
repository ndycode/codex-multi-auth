# Operations Runbook

Routine operations checklist for maintainers.

---

## Daily

1. Review CI status for `main`:
   - `CI`
   - `CodeQL`
   - `Secret Scan`
   - `Supply Chain`
2. Check recent audit and plugin logs:
   - `~/.codex/multi-auth/logs/audit.log`
   - `~/.codex/multi-auth/logs/codex-plugin/`
3. Check dead-letter queue growth:
   - `~/.codex/multi-auth/background-job-dlq.jsonl`

---

## Weekly

1. Rotate encryption key material:
   - set `CODEX_AUTH_ENCRYPTION_KEY` (new key)
   - set `CODEX_AUTH_PREVIOUS_ENCRYPTION_KEY` (prior key)
   - run `codex auth rotate-secrets --json`
   - remove previous key after successful rotation validation
2. Review dependency and license policy reports:
   - `npm run audit:ci`
   - `npm run license:check`
3. Export SBOM from workflow artifacts (`sbom-cyclonedx`) and archive with release metadata.

---

## Monthly

1. Verify retention policy values:
   - `CODEX_AUTH_RETENTION_LOG_DAYS`
   - `CODEX_AUTH_RETENTION_CACHE_DAYS`
   - `CODEX_AUTH_RETENTION_FLAGGED_DAYS`
   - `CODEX_AUTH_RETENTION_QUOTA_CACHE_DAYS`
   - `CODEX_AUTH_RETENTION_DLQ_DAYS`
2. Validate RBAC defaults for deployment environments:
   - `CODEX_AUTH_ROLE=admin|operator|viewer`
   - `CODEX_AUTH_BREAK_GLASS=1` only for emergency windows
3. Validate ABAC guardrails for automation and production:
   - `CODEX_AUTH_ABAC_READ_ONLY=1` for read-only diagnostics environments
   - `CODEX_AUTH_ABAC_REQUIRE_INTERACTIVE=accounts:write,accounts:repair` for interactive-only mutation paths
   - `CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY=secrets:rotate` for safe retryable secret rotation
4. Run a restore drill with exported account backups.

---

## Pre-Release Checklist

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run coverage`
5. `npm run build`
6. `npm run audit:ci`
7. `npm run license:check`
8. Confirm branch protection required checks remain aligned with `.github/settings.yml`.

---

## Failure Triage

1. If auth operations fail repeatedly, inspect rate-limit diagnostics and account health:
   - `codex auth check`
   - `codex auth doctor --json`
2. If writes fail under filesystem lock contention:
   - check stale `*.lock` files under runtime root
   - inspect DLQ entries for repeated write failures
3. If CI secret scan fails:
   - rotate exposed secret
   - invalidate related tokens
   - scrub history or revoke access based on severity
   - document in incident report

---

## Related

- [incident-response.md](incident-response.md)
- [../reference/commands.md](../reference/commands.md)
- [../privacy.md](../privacy.md)
- [../../SECURITY.md](../../SECURITY.md)
