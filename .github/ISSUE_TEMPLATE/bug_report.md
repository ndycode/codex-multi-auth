---
name: Bug Report
about: Report a reproducible bug in codex-multi-auth
title: "[bug] "
labels: [bug]
assignees: ""
---

## Summary

Describe the bug in one paragraph.

## Reproduction

1.
2.
3.

## Expected Behavior

Describe the expected result.

## Actual Behavior

Describe the observed result.

## Environment

- `codex --version`:
- `codex auth status` output summary:
- `npm ls -g codex-multi-auth`:
- OS:
- Node.js:

## Diagnostic Outputs

Include relevant outputs from:

- `codex auth check`
- `codex auth report --json`
- `codex auth doctor --json`

## Logs (Optional)

If needed, include sanitized logs from `~/.codex/multi-auth/logs/codex-plugin/`.
Only enable logging temporarily: `ENABLE_PLUGIN_REQUEST_LOGGING=1`.

## Compliance Confirmation

- [ ] I am using this project for personal development workflows.
- [ ] This report does not request policy bypasses or prohibited usage.
- [ ] I removed any secrets/tokens from this report.
