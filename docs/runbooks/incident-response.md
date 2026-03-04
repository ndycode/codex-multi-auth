# Incident Response Playbook

Incident response workflow for `codex-multi-auth`.

---

## Severity Levels

- `SEV-1`: active secret exposure, auth bypass, or broad production outage.
- `SEV-2`: major functionality degraded, high failure rate, or persistent data corruption risk.
- `SEV-3`: contained bug with workaround, no ongoing security impact.

---

## Response Timeline

### 1. Detect and Declare (0-15 min)

1. Open an internal incident channel.
2. Assign incident commander and communications lead.
3. Record:
   - first detection timestamp
   - affected command flows
   - impacted storage paths/environment variables

### 2. Contain (15-60 min)

1. For credential exposure:
   - rotate affected OAuth/session credentials
   - set new `CODEX_AUTH_ENCRYPTION_KEY`
   - run `codex auth rotate-secrets`
2. For unauthorized command execution:
   - downgrade role to `CODEX_AUTH_ROLE=viewer` where possible
   - enable `CODEX_AUTH_ABAC_READ_ONLY=1` until containment is complete
   - deny high-risk commands with `CODEX_AUTH_ABAC_DENY_COMMANDS=rotate-secrets,fix`
   - reserve `CODEX_AUTH_BREAK_GLASS=1` for explicit emergency changes
3. For filesystem instability:
   - pause mutation commands (`login`, `switch`, `fix`)
   - inspect lock files and dead-letter entries

### 3. Eradicate and Recover (within 24h)

1. Patch root cause and merge behind required CI checks.
2. Validate:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run audit:ci`
3. Re-enable normal command paths and monitor audit logs.

---

## Communication Template

Use this internal status template:

```text
Incident: <short title>
Severity: <SEV-1|SEV-2|SEV-3>
Start Time: <ISO-8601>
Current Status: <investigating|contained|mitigated|resolved>
Impact: <who/what is affected>
Mitigation: <actions in progress>
Next Update: <time>
```

---

## Evidence Collection

Capture and retain:

1. `audit.log` entries for the affected window.
2. relevant `codex-plugin` logs.
3. dead-letter entries from `background-job-dlq.jsonl`.
4. CI run links for failing and fixed pipelines.

Do not include raw refresh/access tokens in incident artifacts.

---

## Post-Incident Review (within 5 business days)

1. Build a timeline with concrete timestamps.
2. Document root cause and contributing factors.
3. Add at least one prevention control:
   - new test
   - CI gate
   - runbook update
   - config default hardening
4. Publish remediation status and owner commitments.

---

## Related

- [operations.md](operations.md)
- [../../SECURITY.md](../../SECURITY.md)
- [../troubleshooting.md](../troubleshooting.md)
