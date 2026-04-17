# Dimensions J+N — Error Handling + Code Health

HEAD 1f6da97, v1.2.7.

**Composed by Atlas** from evidence + architectural patterns + inventory. Redo subagent produced skeleton only.

| ID | Severity | Claim | Evidence | Confidence |
|----|----------|-------|----------|------------|
| JN-01 | LOW | StorageError preserves original stack via `cause` parameter per AGENTS.md §NOTES — good pattern; preserve | AGENTS.md §NOTES; `lib/storage.ts` | confirmed |
| JN-02 | LOW | `saveToDiskDebounced` logs errors but does not crash per AGENTS.md — good resilience pattern; preserve | AGENTS.md §NOTES | confirmed |
| JN-03 | MEDIUM | `settings-hub.ts` ~2100 LOC (cross-ref G-01) — biggest overgrown file | inventory.txt | confirmed |
| JN-04 | MEDIUM | Bifurcation `lib/codex-cli/` and `lib/codex-manager/` coexist without documented boundary (cross-ref G-06) — duplicate-helper + naming drift risk | AGENTS.md §STRUCTURE | probable |
| JN-05 | MEDIUM | Error taxonomy appears implicit — no central `CodexError`/`AuthError`/`NetworkError` base class confirmed; `StorageError` exists as named class; others likely ad-hoc `Error` constructors | Needs ast-grep verification | probable |
| JN-06 | MEDIUM | Logging: `lib/logger.ts` present but structured log schema (trace ID + account ID + attempt #) not uniform across request retry/failover branches (cross-ref H-05) | `lib/logger.ts`, dim-H H-05 | probable |
| JN-07 | LOW | Dead code candidates — no full static scan completed; inventory.txt would seed a ts-prune pass | inventory.txt | probable |
| JN-08 | MEDIUM | Duplicate constants: `1455` port duplicated across auth, server, copy, html (cross-ref C-AUTH-04) | dim-C-auth.md C-AUTH-04 | confirmed |
| JN-09 | MEDIUM | 6 tmp files at repo root (tmp-flagged.json.*.tmp, tmp-accounts.marker) — test-cleanup leakage (cross-ref E-02) | Wave 1 `clean-repo-check.txt` footer; dim-E E-02 | confirmed |
| JN-10 | LOW | Recovery/session readers silently skip unreadable files (cross-ref E-09) — low visibility for operators | dim-E E-09 | confirmed |

## Verdicts
- **Biggest code-health risks**: settings-hub split (JN-03), codex-cli/manager duplication (JN-04), logging schema (JN-06)
- **Biggest error-handling gap**: ad-hoc error construction without taxonomy (JN-05)
- **Positive findings (preserve)**: StorageError `cause`, saveToDiskDebounced pattern
