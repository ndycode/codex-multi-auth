# Incident Drill Template

Use this template for monthly incident-response tabletop drills.

---

## Drill Metadata

- Drill date (UTC):
- Facilitator:
- Participants:
- Scenario ID:
- Related runbook version:

---

## Scenario Setup

1. Trigger condition:
2. Initial symptoms:
3. Assumed blast radius:
4. Detection source:

---

## Timeline (UTC)

| Timestamp | Event | Owner |
| --- | --- | --- |
| | | |
| | | |
| | | |

---

## Required Command Evidence

```bash
npm run ops:health-check
codex auth report --live --json
codex auth doctor --json
```

Attach:

- command outputs
- branch and commit SHA
- incident severity classification

---

## Decision Log

| Decision | Reason | Approver |
| --- | --- | --- |
| | | |
| | | |

---

## Exit Criteria Review

- [ ] health check returned `pass`
- [ ] no unresolved `SEV-1` conditions
- [ ] rollback decision documented (if applicable)
- [ ] prevention tasks created with owners and due dates

---

## Follow-ups

| Action | Owner | Due date |
| --- | --- | --- |
| | | |
| | | |
