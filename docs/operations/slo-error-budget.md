# SLO and Error Budget Policy

Reliability policy for enterprise operation of `codex-multi-auth`.

---

## Measurement Window

- Rolling window: 30 days
- Data source:
  - audit logs (`request.success`, `request.failure`)
  - `ops:health-check` findings
- Policy file: `config/slo-policy.json`

---

## SLO Objectives

| Objective | Target |
| --- | --- |
| Request success rate | `>= 99.5%` |
| Health-check status | `pass` |
| Stale WAL findings | `0` |

---

## Error Budget

- Request error budget: `0.5%` per 30-day window.
- Budget burn:
  - `100 - requestSuccessRatePercent`
- Trigger thresholds:
  - `>= 50%` burn: freeze non-critical feature work for reliability review.
  - `>= 100%` burn: incident review required before next release.

---

## Reporting

Generate report:

```bash
npm run ops:slo-report
```

Enforce gate (non-zero exit on violations):

```bash
node scripts/slo-budget-report.js --enforce --output=.tmp/slo-report.json
```

---

## Governance

1. Review SLO report weekly.
2. Review error budget during release readiness.
3. If budget is exhausted, require remediation plan and owner sign-off.
