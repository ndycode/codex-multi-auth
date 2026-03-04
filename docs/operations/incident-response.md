# Incident Response Runbook

Operational incident workflow for `codex-multi-auth` deployments in enterprise environments.

---

## Severity Model

| Severity | Definition | Initial response |
| --- | --- | --- |
| `SEV-1` | Auth/token failures causing broad outage or data exposure risk | Acknowledge within 15 minutes |
| `SEV-2` | Partial degradation (intermittent auth, persistent retries, stale WAL) | Acknowledge within 30 minutes |
| `SEV-3` | Non-critical defects with workaround available | Acknowledge within 1 business day |

---

## Detection Commands

```bash
npm run ops:health-check
codex auth report --live --json
codex auth doctor --json
```

Required evidence:

- health-check JSON output
- `codex auth report --live --json`
- `codex auth doctor --json`
- current commit SHA and branch

---

## First 30 Minutes

1. Run `npm run ops:health-check` and capture output.
2. If status is `fail`, block release or rollback active release candidate.
3. If stale WAL is reported, run `codex auth doctor --fix --dry-run` first, then `codex auth doctor --fix`.
4. If auth failures persist, rotate account via `codex auth switch <index>` and re-run `codex auth check`.
5. If all accounts are exhausted/disabled, escalate immediately to `SEV-1`, stop automated retries, and switch to fallback credentials via incident commander approval.
6. Record timeline with absolute UTC timestamps.

Windows operator note:

- Default path is `%USERPROFILE%\\.codex\\multi-auth`; if `CODEX_HOME` is set, use `%CODEX_HOME%\\multi-auth`.
- When deleting WAL artifacts manually, close shells/editors first to avoid `EPERM`/`EBUSY` locks.

---

## Containment and Recovery

1. Disable debug body logging unless actively diagnosing:
   - ensure `CODEX_PLUGIN_LOG_BODIES` is unset
2. Run containment commands serially (do not run concurrently):
   - `npm run ops:retention-cleanup`
3. Re-run verification pack:
   - `npm run ops:health-check`
   - `npm run audit:ci`
   - `npm run test -- test/storage.test.ts test/fetch-helpers.test.ts`

Recovery exit criteria:

- `ops:health-check` status is `pass`
- no unresolved `SEV-1` findings
- CI checks green on remediation branch

---

## Post-Incident

1. Publish root-cause analysis with:
   - trigger
   - blast radius
   - remediation commit SHA
   - prevention tasks with owners and due dates
2. Add/adjust regression tests in `test/` for the failure mode.
3. Update this runbook if manual steps were required.

---

## Drill Cadence

- Run a tabletop drill monthly.
- Use [incident-drill-template.md](incident-drill-template.md) for drill evidence.
- Track unresolved drill actions as release blockers when severity is `SEV-1` equivalent.
