# Audit Forwarding

Forward local audit logs to a central SIEM endpoint.

---

## Purpose

- Export append-only audit events from local log files.
- Maintain checkpointed delivery (`audit-forwarder-checkpoint.json`) to avoid duplicate sends.
- Support dry-run validation before production rollout.

---

## Required Configuration

- `CODEX_SIEM_ENDPOINT` (HTTPS ingestion endpoint)
- `CODEX_SIEM_API_KEY` (bearer token; required when the SIEM endpoint enforces authentication)
- `CODEX_MULTI_AUTH_DIR` (optional runtime root override)

---

## Commands

Dry run:

```bash
npm run ops:audit-forwarder -- --dry-run
```

Send batch:

```bash
npm run ops:audit-forwarder -- --batch-size=500
```

Explicit endpoint:

```bash
node scripts/audit-log-forwarder.js --endpoint=https://siem.example.com/ingest --batch-size=500
```

---

## Delivery Contract

Payload fields:

- `source`
- `generatedAt`
- `count`
- `checksum` (SHA-256 over event payload)
- `entries` (JSON audit entries)

Checkpoint fields:

- `file`
- `line`
- `updatedAt`

### Failure & Retry Behavior

- Export delivery retries on HTTP `429` or `5xx`, plus timeout/network failures.
- Retry count and timeout are configurable:
  - `CODEX_AUDIT_FORWARDER_MAX_ATTEMPTS` (default `3`)
  - `CODEX_AUDIT_FORWARDER_TIMEOUT_MS` (default `15000`)
- Backoff is exponential with jitter (`250ms * 2^attempt + random(0..99ms)`).
- Non-retryable responses and terminal retry failures stop the run and return non-zero.
- Checkpoints are written only after a successful send batch. Failed sends keep the prior checkpoint (`file`, `line`, `updatedAt`) so operators can re-run safely.

---

## Alerting Recommendations

Configure SIEM alerts for:

1. `request.failure` spikes above baseline.
2. auth failures crossing incident threshold.
3. stale WAL detection events from scheduled health checks.
